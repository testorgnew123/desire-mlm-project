// Escalation ladder, follow-up, collections console, interest accrual --
// Phase 2 Slice 6 (PROGRESS.md, docs/05-COLLECTIONS-SPEC.md sections 3-7).
//
// runCollectionsSweep copies expireStaleHolds's exact shape (holds.ts): one
// transaction per item needing attention, so a failure on one demand can
// never roll back another's alert or interest update; guarded mutations;
// only records what actually fired. CHEQUE_BOUNCED fires from
// bounceReceipt directly (receipts.ts), not from this sweep.
import { Prisma } from "@desire/db";
import type { PrismaClient, Prisma as PrismaNS, AlertRung, CollectionAlert, PaymentFollowUp, FollowUpOutcome } from "@desire/db";
export type { CollectionAlert, PaymentFollowUp };
import { writeAuditLog, type AuditContext } from "./audit";
import { assertPermission, ForbiddenError, getAccessibleAssociateIds, type ScopeMode } from "./rbac";

// Duplicated per file, this codebase's own convention (see payment-plans.ts's
// DemandNotFoundError / receipts.ts's AllocationDemandNotFoundError) -- also
// avoids a receipts.ts <-> collections-sweep.ts <-> payment-plans.ts import
// cycle that importing payment-plans.ts's version here would create.
export class FollowUpDemandNotFoundError extends Error {
  constructor(public readonly demandId: string) {
    super(`Demand ${demandId} not found.`);
    this.name = "FollowUpDemandNotFoundError";
  }
}

const FOLLOW_UP_PERMISSION = "demand.follow_up";
const CONSOLE_PERMISSION = "report.read";

const D = (v: string | number) => new Prisma.Decimal(v);
const DAY_MS = 24 * 60 * 60_000;

function round2(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

async function allocatedTotalForDemand(tx: PrismaNS.TransactionClient, demandId: string): Promise<Prisma.Decimal> {
  const rows = await tx.receiptAllocation.findMany({ where: { demandId, reversedAt: null }, select: { amount: true } });
  return rows.reduce((sum, r) => sum.plus(r.amount), D(0));
}

/** Ascending distance from due date, in days (negative = overdue). Every
 *  rung whose threshold has been reached fires -- a sweep that missed
 *  several days backfills every rung it owes, not just the current one,
 *  the same catch-up-safe posture expireStaleHolds already established. */
const RUNG_THRESHOLDS: ReadonlyArray<{ rung: AlertRung; daysUntilDueAtMost: number }> = [
  { rung: "DUE_MINUS_7", daysUntilDueAtMost: 7 },
  { rung: "DUE_MINUS_3", daysUntilDueAtMost: 3 },
  { rung: "DUE_MINUS_1", daysUntilDueAtMost: 1 },
  { rung: "DUE_TODAY", daysUntilDueAtMost: 0 },
  { rung: "OVERDUE_1", daysUntilDueAtMost: -1 },
  { rung: "OVERDUE_7", daysUntilDueAtMost: -7 },
  { rung: "OVERDUE_15", daysUntilDueAtMost: -15 },
  { rung: "OVERDUE_30", daysUntilDueAtMost: -30 },
];

/** PLACEHOLDER offsets/audiences/channels per BLOCKED#12 -- the mechanism
 *  (fire-at-most-once via @@unique([demandId, rung]), the ladder shape) is
 *  real, the numbers are docs/05-COLLECTIONS-SPEC.md's own placeholder
 *  table. Recipients are recorded as {associateIds, roleCodes} -- exactly
 *  what the schema's own comment on CollectionAlert.recipients names --
 *  resolved as far as structurally possible (the selling associate, their
 *  L1 upline) without inventing the role->user resolution Slice 7's
 *  notification queue actually owns. */
async function recipientsFor(
  tx: PrismaNS.TransactionClient,
  rung: AlertRung,
  sellingAssociateId: string,
): Promise<{ associateIds: string[]; roleCodes: string[] }> {
  const associateIds = [sellingAssociateId];
  const roleCodes: string[] = [];

  if (rung === "OVERDUE_7" || rung === "OVERDUE_15" || rung === "OVERDUE_30" || rung === "PROMISE_BREACHED") {
    const uplineRow = await tx.associateHierarchy.findFirst({ where: { associateId: sellingAssociateId, validTo: null } });
    if (uplineRow?.parentId) associateIds.push(uplineRow.parentId);
  }
  if (rung === "DUE_TODAY") roleCodes.push("SALES_ADMIN");
  if (rung === "OVERDUE_15") roleCodes.push("SALES_HEAD", "FINANCE_ADMIN");
  if (rung === "OVERDUE_30") roleCodes.push("FINANCE_ADMIN");

  return { associateIds, roleCodes };
}

/** Exported so bounceReceipt (receipts.ts) can fire CHEQUE_BOUNCED directly
 *  on bounce, exactly as docs/05-COLLECTIONS-SPEC.md's ladder table says --
 *  "the last one fires from bounceReceipt directly, not the sweep." Every
 *  other rung goes through runCollectionsSweep below. */
export async function fireCollectionAlert(
  tx: PrismaNS.TransactionClient,
  params: { orgId: string; demandId: string; rung: AlertRung; sellingAssociateId: string },
): Promise<boolean> {
  return fireAlert(tx, params);
}

async function fireAlert(
  tx: PrismaNS.TransactionClient,
  params: { orgId: string; demandId: string; rung: AlertRung; sellingAssociateId: string },
): Promise<boolean> {
  // Check-first, not insert-and-catch: a caught P2002 leaves a Postgres
  // transaction ABORTED for every statement after it (unlike SQLite/MySQL,
  // there is no implicit recovery without a SAVEPOINT), and this function
  // runs inside a shared per-demand transaction that keeps doing real work
  // afterward (more rungs, interest, promises) -- a caught-and-ignored
  // P2002 here would silently poison every later statement in that same
  // transaction. @@unique([demandId, rung]) stays as the structural
  // backstop; this is just no longer how a normal re-run is expected to
  // discover "already fired".
  const existing = await tx.collectionAlert.findUnique({ where: { demandId_rung: { demandId: params.demandId, rung: params.rung } } });
  if (existing) return false;

  const recipients = await recipientsFor(tx, params.rung, params.sellingAssociateId);
  await tx.collectionAlert.create({
    data: { orgId: params.orgId, demandId: params.demandId, rung: params.rung, recipients },
  });
  return true;
}

export interface CollectionsSweepResult {
  alertsFired: number;
  promisesBreached: number;
  interestUpdated: number;
}

export async function runCollectionsSweep(db: PrismaClient, params: { now?: Date } = {}): Promise<CollectionsSweepResult> {
  const now = params.now ?? new Date();
  let alertsFired = 0;
  let promisesBreached = 0;
  let interestUpdated = 0;

  const openDemands = await db.demand.findMany({
    where: { status: { in: ["RAISED", "PARTIALLY_PAID"] } },
    select: { id: true, orgId: true, dueDate: true, amount: true, gstAmount: true, interestRatePctPerAnnum: true, bookingId: true },
    take: 2000,
  });

  for (const demand of openDemands) {
    // One transaction per demand: a failure on one must not roll back the
    // rest (same reasoning expireStaleHolds documents for its own loop).
    await db.$transaction(async (tx) => {
      const fresh = await tx.demand.findUnique({ where: { id: demand.id } });
      if (!fresh || (fresh.status !== "RAISED" && fresh.status !== "PARTIALLY_PAID")) return; // moved on since the outer read

      const booking = await tx.booking.findUniqueOrThrow({ where: { id: fresh.bookingId }, select: { sellingAssociateId: true } });
      const daysUntilDue = Math.floor((fresh.dueDate.getTime() - now.getTime()) / DAY_MS);

      for (const { rung, daysUntilDueAtMost } of RUNG_THRESHOLDS) {
        if (daysUntilDue > daysUntilDueAtMost) continue;
        const fired = await fireAlert(tx, { orgId: fresh.orgId, demandId: fresh.id, rung, sellingAssociateId: booking.sellingAssociateId });
        if (fired) alertsFired++;
      }

      // Interest: never commissionable (docs/05-COLLECTIONS-SPEC.md section
      // 7) -- this never touches commissionableValue or CommissionEntry.
      // Recomputed in full from the current outstanding principal and days
      // overdue each run, not incremented, so a repeated or delayed sweep
      // is idempotent without needing a separate "last accrued" field.
      if (fresh.interestRatePctPerAnnum && daysUntilDue < 0) {
        const allocated = await allocatedTotalForDemand(tx, fresh.id);
        const outstanding = fresh.amount.plus(fresh.gstAmount).minus(allocated);
        if (outstanding.greaterThan(0)) {
          const daysOverdue = -daysUntilDue;
          const accrued = round2(outstanding.times(fresh.interestRatePctPerAnnum).dividedBy(100).times(daysOverdue).dividedBy(365));
          if (!accrued.equals(fresh.interestAccrued)) {
            await tx.demand.update({ where: { id: fresh.id }, data: { interestAccrued: accrued } });
            interestUpdated++;
          }
        }
      }

      // A promise that has passed unpaid fires PROMISE_BREACHED, checked
      // every run rather than as a separate job.
      const openPromises = await tx.paymentFollowUp.findMany({
        where: { demandId: fresh.id, promiseToPayDate: { lt: now }, promiseBrokenAt: null },
      });
      if (openPromises.length > 0) {
        const allocated = await allocatedTotalForDemand(tx, fresh.id);
        const outstanding = fresh.amount.plus(fresh.gstAmount).minus(allocated);
        if (outstanding.greaterThan(0)) {
          for (const promise of openPromises) {
            await tx.paymentFollowUp.update({ where: { id: promise.id }, data: { promiseBrokenAt: now } });
          }
          const fired = await fireAlert(tx, { orgId: fresh.orgId, demandId: fresh.id, rung: "PROMISE_BREACHED", sellingAssociateId: booking.sellingAssociateId });
          if (fired) {
            alertsFired++;
            promisesBreached++;
          }
        }
      }
    });
  }

  return { alertsFired, promisesBreached, interestUpdated };
}

// ── Follow-up ──────────────────────────────────────────────────────────

export interface PromiseToPayParams {
  demandId: string;
  contactedOn: Date;
  outcome: FollowUpOutcome;
  promiseToPayDate?: Date | null;
  notes?: string | null;
  audit: AuditContext;
}

export async function promiseToPay(db: PrismaClient, params: PromiseToPayParams): Promise<PaymentFollowUp> {
  const actorId = requireActor(params.audit);

  return db.$transaction(async (tx) => {
    const demand = await tx.demand.findUnique({ where: { id: params.demandId }, include: { booking: { select: { projectId: true } } } });
    if (!demand) throw new FollowUpDemandNotFoundError(params.demandId);
    if (demand.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Demand ${params.demandId} belongs to another organisation.`);
    }

    await assertPermission(tx, actorId, FOLLOW_UP_PERMISSION, { projectId: demand.booking.projectId });

    const associate = await tx.associate.findUnique({ where: { userId: actorId }, select: { id: true } });
    if (!associate) throw new ForbiddenError("This account has no associate profile; only associates can log a follow-up.");

    const followUp = await tx.paymentFollowUp.create({
      data: {
        demandId: demand.id,
        associateId: associate.id,
        contactedOn: params.contactedOn,
        outcome: params.outcome,
        promiseToPayDate: params.promiseToPayDate ?? undefined,
        notes: params.notes ?? undefined,
      },
    });

    await writeAuditLog(tx, params.audit, { action: "CREATE", entity: "PaymentFollowUp", entityId: followUp.id, after: toAuditValues(followUp) });

    return followUp;
  });
}

function requireActor(audit: AuditContext): string {
  if (!audit.actorId) {
    throw new ForbiddenError("Follow-up logging requires a user actor, not a system actor.");
  }
  return audit.actorId;
}

function toAuditValues(data: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = value instanceof Prisma.Decimal ? value.toString() : value instanceof Date ? value.toISOString() : (value ?? null);
  }
  return out;
}

// ── Collections console ───────────────────────────────────────────────

export interface CollectionsConsoleRow {
  demandId: string;
  bookingId: string;
  bookingNumber: string;
  customerName: string;
  projectId: string;
  unitNumber: string;
  amount: string;
  outstanding: string;
  dueDate: string;
  daysOverdue: number;
  sellingAssociateId: string;
  lastFollowUpAt: string | null;
  promiseToPayDate: string | null;
}

export interface CollectionsConsoleParams {
  orgId: string;
  actorId: string;
  projectId?: string;
  associateId?: string;
  now?: Date;
}

/** One row per open demand -- docs/05-COLLECTIONS-SPEC.md section 5. Scoped
 *  through the ONE resolver (getAccessibleAssociateIds), same as every other
 *  row-scoped read in this codebase, gated by report.read (already O for
 *  ASSOCIATE / T for TEAM_LEAD in docs/09-RBAC-MATRIX.md -- exactly the
 *  split this console needs, so no new permission). Default sort: amount
 *  descending within the worst overdue bucket -- chase the money, not the
 *  row count. */
export async function getCollectionsConsole(db: PrismaClient, params: CollectionsConsoleParams): Promise<CollectionsConsoleRow[]> {
  await assertPermission(db, params.actorId, CONSOLE_PERMISSION, { projectId: params.projectId });
  const now = params.now ?? new Date();

  const roles = await db.userRole.findMany({ where: { userId: params.actorId }, select: { role: { select: { code: true } } } });
  const roleCodes = new Set(roles.map((r) => r.role.code));
  const isUnrestricted = ["SUPER_ADMIN", "FINANCE_ADMIN", "PROJECT_MANAGER", "SALES_HEAD", "SALES_ADMIN", "AUDITOR"].some((r) => roleCodes.has(r));

  let accessibleAssociateIds: string[] | null = null;
  if (!isUnrestricted) {
    const caller = await db.associate.findUnique({ where: { userId: params.actorId }, select: { id: true } });
    if (!caller) return [];
    const mode: ScopeMode = roleCodes.has("TEAM_LEAD") ? "OWN_AND_DOWNLINE" : "OWN";
    accessibleAssociateIds = await getAccessibleAssociateIds(db, caller.id, mode);
  }

  // Three independent conditions can all apply to the SAME `booking`
  // relation filter (project, scope, and an explicit associate override) --
  // spreading three separate `{ booking: {...} }` objects into one `where`
  // would have the last one silently clobber the others instead of
  // merging, since object spread overwrites same-named keys rather than
  // combining them. Built as one object instead.
  const bookingWhere: Prisma.BookingWhereInput = {};
  if (params.projectId) bookingWhere.projectId = params.projectId;
  if (params.associateId) {
    // An explicit associateId filter must still be INSIDE the caller's own
    // scope, not just applied instead of it -- otherwise a scoped caller
    // could name any associateId and see outside their own team.
    if (accessibleAssociateIds && !accessibleAssociateIds.includes(params.associateId)) return [];
    bookingWhere.sellingAssociateId = params.associateId;
  } else if (accessibleAssociateIds) {
    bookingWhere.sellingAssociateId = { in: accessibleAssociateIds };
  }

  const demands = await db.demand.findMany({
    where: {
      orgId: params.orgId,
      status: { in: ["RAISED", "PARTIALLY_PAID"] },
      ...(Object.keys(bookingWhere).length > 0 ? { booking: bookingWhere } : {}),
    },
    include: {
      booking: { select: { id: true, bookingNumber: true, projectId: true, sellingAssociateId: true, customer: { select: { name: true } }, unit: { select: { unitNumber: true } } } },
      allocations: { where: { reversedAt: null }, select: { amount: true } },
      followUps: { orderBy: { contactedOn: "desc" }, take: 1, select: { contactedOn: true, promiseToPayDate: true } },
    },
  });

  const rows = demands.map((d) => {
    const allocated = d.allocations.reduce((sum, a) => sum.plus(a.amount), D(0));
    const outstanding = d.amount.plus(d.gstAmount).minus(allocated);
    const daysOverdue = Math.max(0, Math.floor((now.getTime() - d.dueDate.getTime()) / DAY_MS));
    const lastFollowUp = d.followUps[0];
    return {
      demandId: d.id,
      bookingId: d.booking.id,
      bookingNumber: d.booking.bookingNumber,
      customerName: d.booking.customer.name,
      projectId: d.booking.projectId,
      unitNumber: d.booking.unit.unitNumber,
      amount: d.amount.toString(),
      outstanding: outstanding.toString(),
      dueDate: d.dueDate.toISOString(),
      daysOverdue,
      sellingAssociateId: d.booking.sellingAssociateId,
      lastFollowUpAt: lastFollowUp?.contactedOn.toISOString() ?? null,
      promiseToPayDate: lastFollowUp?.promiseToPayDate?.toISOString() ?? null,
    };
  });

  const bucketOf = (daysOverdue: number) => (daysOverdue > 30 ? 2 : daysOverdue >= 8 ? 1 : 0);
  rows.sort((a, b) => {
    const bucketDiff = bucketOf(b.daysOverdue) - bucketOf(a.daysOverdue);
    if (bucketDiff !== 0) return bucketDiff;
    return new Prisma.Decimal(b.outstanding).minus(new Prisma.Decimal(a.outstanding)).toNumber();
  });

  return rows;
}
