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
import type { Prisma as PrismaNS } from "@desire/db";
import { writeAuditLog, type AuditContext } from "./audit";
import { getActiveScheme, type ActiveScheme } from "./schemes";

export { CommissionSchemeMisconfiguredError };

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
  tx: PrismaNS.TransactionClient,
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
          status: "ACCRUED",
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
