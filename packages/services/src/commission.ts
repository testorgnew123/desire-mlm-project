// Wiring the pure @desire/commission engine to real Prisma data -- Phase 3
// Slice 2 (PROGRESS.md's Accrual GATE). packages/commission knows nothing
// about Prisma or dates: this file fetches raw rows, converts
// Prisma.Decimal -> decimal.js via .toString(), assembles the plain-object
// shapes accrue() expects, and converts results back to Prisma.Decimal for
// persistence -- the exact bridging receipts.ts's releaseCommissionForBooking
// already proved safe for computeRelease.
import Decimal from "decimal.js";
import { accrue, CommissionSchemeMisconfiguredError } from "@desire/commission";
import type {
  AccrualInput,
  AssociateSnapshot,
  GradeAssignmentRecord,
  HierarchyAssignmentRecord,
  OrgSnapshot,
  SchemeConfig,
} from "@desire/commission";
import { Prisma } from "@desire/db";
import type { PrismaClient, Prisma as PrismaNS, CommissionEntry } from "@desire/db";
import { writeAuditLog, type AuditContext } from "./audit";
import { assertPermission, ForbiddenError, getAccessibleAssociateIds, type ScopeMode } from "./rbac";
import { getActiveScheme, getSchemeById, SchemeNotFoundError, type ActiveScheme } from "./schemes";

export { CommissionSchemeMisconfiguredError, SchemeNotFoundError };

const READ_PERMISSION = "commission.read";
const SIMULATE_PERMISSION = "scheme.simulate";
// commission.read's own role set (permission-matrix.ts) minus TEAM_LEAD/
// ASSOCIATE, who get scoped via getAccessibleAssociateIds instead -- same
// split associates.ts's ADMIN_ROLE_CODES already uses for associate.read.
const UNRESTRICTED_ROLE_CODES: ReadonlySet<string> = new Set(["SUPER_ADMIN", "FINANCE_ADMIN", "SALES_HEAD", "AUDITOR"]);

const D = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v);

// ── Errors ─────────────────────────────────────────────────────────────

export class CommissionBookingNotFoundError extends Error {
  constructor(bookingId: string) {
    super(`Booking ${bookingId} not found.`);
    this.name = "CommissionBookingNotFoundError";
  }
}

/** Defense-in-depth backstop for the idempotencyKey unique constraint --
 *  reachable only if this function were somehow invoked twice for the same
 *  booking, which confirmBooking's own DRAFT->CONFIRMED state guard already
 *  prevents at the caller. */
export class DuplicateAccrualError extends Error {
  constructor(public readonly bookingId: string) {
    super(`Commission entries for booking ${bookingId} already exist.`);
    this.name = "DuplicateAccrualError";
  }
}

// ── Org snapshot ───────────────────────────────────────────────────────

/** Fetches every AssociateGrade/AssociateHierarchy row for the org (small-org
 *  simplicity; revisit at scale -- not solved here) and assembles the Maps
 *  gradeAsOf/uplineChainAsOf need. Prisma.Decimal has no place in an
 *  OrgSnapshot -- there isn't one; only dates need ISO-string conversion. */
export async function buildOrgSnapshot(
  tx: PrismaClient | PrismaNS.TransactionClient,
  orgId: string,
): Promise<OrgSnapshot> {
  const [associateRows, gradeRows, hierarchyRows] = await Promise.all([
    tx.associate.findMany({ where: { orgId }, select: { id: true, code: true, status: true } }),
    tx.associateGrade.findMany({
      where: { associate: { orgId } },
      select: {
        associateId: true,
        validFrom: true,
        validTo: true,
        grade: { select: { code: true, rank: true } },
      },
      orderBy: { validFrom: "asc" },
    }),
    tx.associateHierarchy.findMany({
      where: { associate: { orgId } },
      select: { associateId: true, parentId: true, validFrom: true, validTo: true },
      orderBy: { validFrom: "asc" },
    }),
  ]);

  const associates = new Map<string, AssociateSnapshot>(
    associateRows.map((a) => [a.id, { associateId: a.id, code: a.code, status: a.status }]),
  );

  const gradeHistory = new Map<string, GradeAssignmentRecord[]>();
  for (const row of gradeRows) {
    const list = gradeHistory.get(row.associateId) ?? [];
    list.push({
      gradeCode: row.grade.code,
      gradeRank: row.grade.rank,
      validFrom: row.validFrom.toISOString(),
      validTo: row.validTo ? row.validTo.toISOString() : null,
    });
    gradeHistory.set(row.associateId, list);
  }

  const hierarchyHistory = new Map<string, HierarchyAssignmentRecord[]>();
  for (const row of hierarchyRows) {
    const list = hierarchyHistory.get(row.associateId) ?? [];
    list.push({
      parentAssociateId: row.parentId,
      validFrom: row.validFrom.toISOString(),
      validTo: row.validTo ? row.validTo.toISOString() : null,
    });
    hierarchyHistory.set(row.associateId, list);
  }

  return { associates, gradeHistory, hierarchyHistory };
}

// ── Scheme -> SchemeConfig ─────────────────────────────────────────────

function toSchemeConfig(scheme: ActiveScheme): SchemeConfig {
  return {
    schemeId: scheme.id,
    schemeVersion: scheme.version,
    maxLevel: scheme.maxLevel,
    compressionMode: scheme.compressionMode,
    maxTotalPct: new Decimal(scheme.maxTotalPct.toString()),
    gradeRates: scheme.gradeRates.map((r) => ({
      gradeCode: r.grade.code,
      rateType: r.rateType,
      rateValue: new Decimal(r.rateValue.toString()),
    })),
    levelRates: scheme.levelRates.map((r) => ({
      level: r.level,
      pctOfSellerCommission: new Decimal(r.pctOfSellerCommission.toString()),
    })),
    eligibilityRules: (scheme.eligibilityRules as SchemeConfig["eligibilityRules"] | null) ?? undefined,
  };
}

// ── Accrual ────────────────────────────────────────────────────────────

export interface AccrueCommissionParams {
  bookingId: string;
  audit: AuditContext;
  now?: Date;
}

export interface AccrueCommissionResult {
  schemeId: string;
  entryCount: number;
  breakage: Prisma.Decimal;
}

/** Resolves the booking's active scheme as of its bookingDate, builds the
 *  OrgSnapshot and AccrualInput, calls accrue(), and persists each result row
 *  as a CommissionEntry. Called from confirmBooking's own transaction, right
 *  beside generateDemandSchedule -- accrue() is a late, all-or-nothing guard
 *  (it computes everything, sums it, and throws CommissionSchemeMisconfiguredError
 *  BEFORE returning if maxTotalPct would be breached), so nothing is persisted
 *  before it returns successfully, and a throw here rolls back the whole
 *  confirmBooking transaction -- a misconfigured scheme blocks the booking
 *  from confirming at all, by design.
 *
 *  A project with no ACTIVE scheme accrues nothing and returns null: Phase 1/2
 *  bookings must remain confirmable in projects that haven't set up commission
 *  yet -- the same reasoning holds.ts already applies to "no active price
 *  list" not being an accrual precondition. */
export async function accrueCommission(
  tx: PrismaNS.TransactionClient,
  params: AccrueCommissionParams,
): Promise<AccrueCommissionResult | null> {
  const now = params.now ?? new Date();

  const booking = await tx.booking.findUnique({ where: { id: params.bookingId } });
  if (!booking) throw new CommissionBookingNotFoundError(params.bookingId);

  const activeScheme = await getActiveScheme(tx, { projectId: booking.projectId, asOf: booking.bookingDate });
  if (!activeScheme) return null;

  const org = await buildOrgSnapshot(tx, booking.orgId);
  const scheme = toSchemeConfig(activeScheme);

  const input: AccrualInput = {
    bookingId: booking.id,
    bookingDate: booking.bookingDate.toISOString(),
    commissionableValue: new Decimal(booking.commissionableValue.toString()),
    saleableAreaAtBooking: new Decimal(booking.saleableAreaAtBooking.toString()),
    scheme,
    seller: { associateId: booking.sellingAssociateId },
    computedAt: now.toISOString(),
  };

  // Throws CommissionSchemeMisconfiguredError before returning if the
  // maxTotalPct ceiling would be breached -- nothing below has run yet.
  const result = accrue(input, org);
  // ON_BOOKING releases 100% immediately, in this SAME transaction as the
  // accrual -- there is no later event to wait for (docs/04-COMMISSION-SPEC.md's
  // ReleaseTriggerType.BOOKING_CONFIRMED is fired by the confirm itself).
  // MILESTONE's DEMAND_PAID trigger is wired separately, into
  // receipts.ts's syncDemandStatus, since it depends on a later event.
  const isOnBooking = activeScheme.schedules[0]?.mode === "ON_BOOKING";

  try {
    for (const entry of result.entries) {
      const created = await tx.commissionEntry.create({
        data: {
          orgId: booking.orgId,
          bookingId: entry.bookingId,
          schemeId: entry.schemeId,
          beneficiaryAssociateId: entry.beneficiaryAssociateId,
          role: entry.role,
          level: entry.level,
          baseAmount: D(entry.baseAmount.toFixed(2)),
          grossAmount: D(entry.grossAmount.toFixed(2)),
          status: isOnBooking ? "PAYABLE" : "ACCRUED",
          snapshot: entry.snapshot as unknown as Prisma.InputJsonValue,
          idempotencyKey: entry.idempotencyKey,
        },
      });
      await writeAuditLog(tx, params.audit, {
        action: "CREATE",
        entity: "CommissionEntry",
        entityId: created.id,
        after: {
          bookingId: entry.bookingId,
          beneficiaryAssociateId: entry.beneficiaryAssociateId,
          role: entry.role,
          level: entry.level,
          grossAmount: entry.grossAmount.toString(),
        },
      });

      if (isOnBooking) {
        await tx.commissionRelease.create({
          data: {
            entryId: created.id,
            triggerType: "BOOKING_CONFIRMED",
            triggerRef: booking.id,
            cumulativePct: D("100"),
            amount: D(entry.grossAmount.toFixed(2)),
          },
        });
      }
    }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new DuplicateAccrualError(booking.id);
    }
    throw err;
  }

  // Breakage (override money nobody qualified for) has no dedicated ledger
  // table in the schema -- this audit row is the honest capture mechanism,
  // not a silently-dropped number, whether or not it is zero.
  await writeAuditLog(tx, params.audit, {
    action: "CREATE",
    entity: "CommissionAccrual",
    entityId: booking.id,
    after: {
      schemeId: scheme.schemeId,
      schemeVersion: scheme.schemeVersion,
      entryCount: result.entries.length,
      breakage: result.breakage.toFixed(2),
    },
  });

  return {
    schemeId: scheme.schemeId,
    entryCount: result.entries.length,
    breakage: D(result.breakage.toFixed(2)),
  };
}

// ── Reads -- Phase 3 Slice 5 (PROGRESS.md's scheme simulator, explain
// drill-down, earnings screen) ─────────────────────────────────────────

export class CommissionEntryNotFoundError extends Error {
  constructor(public readonly entryId: string) {
    super(`Commission entry ${entryId} not found.`);
    this.name = "CommissionEntryNotFoundError";
  }
}

async function resolveActorRoleCodes(db: PrismaClient, actorId: string): Promise<Set<string>> {
  const roles = await db.userRole.findMany({ where: { userId: actorId }, select: { role: { select: { code: true } } } });
  return new Set(roles.map((r) => r.role.code));
}

/** The O/T/admin scope rule every read below shares: an unrestricted role
 *  sees everything in the org; anyone else sees only associate ids
 *  resolveAccessibleAssociateIds (via the caller's own Associate row) would
 *  return them -- own record, or own + downline for a TEAM_LEAD. */
async function assertAssociateInScope(db: PrismaClient, actorId: string, targetAssociateId: string): Promise<void> {
  const roleCodes = await resolveActorRoleCodes(db, actorId);
  if ([...roleCodes].some((r) => UNRESTRICTED_ROLE_CODES.has(r))) return;

  const caller = await db.associate.findUnique({ where: { userId: actorId }, select: { id: true } });
  if (!caller) throw new ForbiddenError("This account has no associate profile.");
  const mode: ScopeMode = roleCodes.has("TEAM_LEAD") ? "OWN_AND_DOWNLINE" : "OWN";
  const accessible = await getAccessibleAssociateIds(db, caller.id, mode);
  if (!accessible.includes(targetAssociateId)) {
    throw new ForbiddenError(`Associate ${targetAssociateId} is outside this session's scope.`);
  }
}

// ── Scheme simulator (no writes) ────────────────────────────────────────

export interface SimulateSchemeParams {
  schemeId: string;
  hypotheticalBooking: {
    bookingDate: string; // ISO 8601
    commissionableValue: Prisma.Decimal | string;
    saleableAreaAtBooking: Prisma.Decimal | string;
    sellerAssociateId: string;
  };
  audit: AuditContext;
}

/** No writes -- the route's own contract (docs/07-API.md). Calls accrue()
 *  directly against a caller-supplied hypothetical and returns the entries
 *  it WOULD create; nothing is persisted, whether or not the scheme is
 *  ACTIVE (a DRAFT scheme can be simulated before it is ever published). */
export async function simulateScheme(db: PrismaClient, params: SimulateSchemeParams) {
  if (!params.audit.actorId) {
    throw new ForbiddenError("Simulating a scheme requires a user actor, not a system actor.");
  }

  const scheme = await getSchemeById(db, params.schemeId);
  if (!scheme) throw new SchemeNotFoundError(params.schemeId);
  if (scheme.orgId !== params.audit.orgId) {
    throw new ForbiddenError(`Commission scheme ${params.schemeId} belongs to another organisation.`);
  }

  await assertPermission(db, params.audit.actorId, SIMULATE_PERMISSION, { projectId: scheme.projectId });

  const org = await buildOrgSnapshot(db, scheme.orgId);
  const config = toSchemeConfig(scheme);

  return accrue(
    {
      bookingId: "SIMULATED",
      bookingDate: params.hypotheticalBooking.bookingDate,
      commissionableValue: new Decimal(params.hypotheticalBooking.commissionableValue.toString()),
      saleableAreaAtBooking: new Decimal(params.hypotheticalBooking.saleableAreaAtBooking.toString()),
      scheme: config,
      seller: { associateId: params.hypotheticalBooking.sellerAssociateId },
      computedAt: params.hypotheticalBooking.bookingDate,
    },
    org,
  );
}

// ── Explain drill-down ───────────────────────────────────────────────────

/** Powers docs/08-SCREENS.md §2's drill-down -- the entry with its snapshot
 *  JSON (grade, rates, upline chain, scheme version) already attached,
 *  since Prisma returns Json columns already parsed. */
export async function explainEntry(db: PrismaClient, params: { entryId: string; audit: AuditContext }): Promise<CommissionEntry> {
  if (!params.audit.actorId) {
    throw new ForbiddenError("Explaining a commission entry requires a user actor, not a system actor.");
  }

  const entry = await db.commissionEntry.findUnique({ where: { id: params.entryId } });
  if (!entry) throw new CommissionEntryNotFoundError(params.entryId);
  if (entry.orgId !== params.audit.orgId) {
    throw new ForbiddenError(`Commission entry ${params.entryId} belongs to another organisation.`);
  }

  await assertPermission(db, params.audit.actorId, READ_PERMISSION);
  await assertAssociateInScope(db, params.audit.actorId, entry.beneficiaryAssociateId);

  return entry;
}

// ── Earnings screen ──────────────────────────────────────────────────────

export interface EarningsSummary {
  associateId: string;
  accrued: Prisma.Decimal;
  payable: Prisma.Decimal;
  paid: Prisma.Decimal;
  /** grossAmount - Σ(non-reversed releases), summed over ACCRUED/PAYABLE
   *  entries -- the money not yet released because collection hasn't
   *  happened. */
  blocked: Prisma.Decimal;
  /** The SAME entries' bookings' outstanding demand balance -- the exact
   *  canonical query docs/05-COLLECTIONS-SPEC.md already defines
   *  (demand.amount + gstAmount - Σ non-reversed allocations), reusing
   *  receipts.ts's allocatedTotalForDemand shape rather than re-deriving it. */
  pendingCollections: Prisma.Decimal;
}

/** "₹X of your commission is blocked by ₹Y in pending collections"
 *  (docs/04-COMMISSION-SPEC.md §6), computed from real numbers, not a
 *  hardcoded string. Same O/T/admin scope rule as explainEntry. */
export async function getEarnings(db: PrismaClient, params: { associateId: string; audit: AuditContext }): Promise<EarningsSummary> {
  if (!params.audit.actorId) {
    throw new ForbiddenError("Reading earnings requires a user actor, not a system actor.");
  }

  await assertPermission(db, params.audit.actorId, READ_PERMISSION);
  await assertAssociateInScope(db, params.audit.actorId, params.associateId);

  const entries = await db.commissionEntry.findMany({
    where: { beneficiaryAssociateId: params.associateId, status: { not: "REVERSED" } },
    include: { releases: { where: { reversedAt: null }, select: { amount: true } } },
  });

  let accrued = D(0);
  let payable = D(0);
  let paid = D(0);
  let blocked = D(0);
  const bookingIdsToCheck = new Set<string>();

  for (const entry of entries) {
    if (entry.status === "ACCRUED") accrued = accrued.plus(entry.grossAmount);
    if (entry.status === "PAYABLE") payable = payable.plus(entry.grossAmount);
    if (entry.status === "PAID") paid = paid.plus(entry.grossAmount);

    if (entry.status === "ACCRUED" || entry.status === "PAYABLE") {
      const released = entry.releases.reduce((sum, r) => sum.plus(r.amount), D(0));
      const entryBlocked = D(entry.grossAmount).minus(released);
      if (entryBlocked.greaterThan(0)) {
        blocked = blocked.plus(entryBlocked);
        bookingIdsToCheck.add(entry.bookingId);
      }
    }
  }

  let pendingCollections = D(0);
  if (bookingIdsToCheck.size > 0) {
    const demands = await db.demand.findMany({
      where: { bookingId: { in: [...bookingIdsToCheck] }, status: { not: "WAIVED" } },
      include: { allocations: { where: { reversedAt: null }, select: { amount: true } } },
    });
    for (const demand of demands) {
      const allocated = demand.allocations.reduce((sum, a) => sum.plus(a.amount), D(0));
      const owed = D(demand.amount).plus(demand.gstAmount).minus(allocated);
      if (owed.greaterThan(0)) pendingCollections = pendingCollections.plus(owed);
    }
  }

  return { associateId: params.associateId, accrued, payable, paid, blocked, pendingCollections };
}
