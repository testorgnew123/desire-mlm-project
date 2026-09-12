// Payment plans + demand generation -- Phase 2 Slice 4 (PROGRESS.md,
// docs/05-COLLECTIONS-SPEC.md section 1: "At booking confirmation the plan
// expands into a DemandSchedule of concrete Demand rows against that
// booking.").
//
// PaymentPlan/PaymentPlanMilestone are master/config data with the same
// shape as ChargeHead -- no maker-checker columns on the model, gated by
// project.write exactly like charge-heads.ts's CRUD_PERMISSION, not a new
// permission.
import { Prisma } from "@desire/db";
import type { PrismaClient, Prisma as PrismaNS, PaymentPlan, PaymentPlanMilestone, Demand } from "@desire/db";
export type { PaymentPlan, PaymentPlanMilestone, Demand };
import { writeAuditLog, type AuditContext } from "./audit";
import { assertPermission, ForbiddenError } from "./rbac";
import { applyCreditBalanceToNewDemand } from "./receipts";

const PLAN_WRITE_PERMISSION = "project.write";
const RAISE_PERMISSION = "demand.raise";
const WAIVE_PERMISSION = "demand.waive";

// ── Errors ─────────────────────────────────────────────────────────────

export class PaymentPlanNotFoundError extends Error {
  constructor(public readonly paymentPlanId: string) {
    super(`Payment plan ${paymentPlanId} not found.`);
    this.name = "PaymentPlanNotFoundError";
  }
}

export class DuplicatePaymentPlanCodeError extends Error {
  constructor(public readonly code: string) {
    super(`Payment plan code "${code}" is already in use for this organisation.`);
    this.name = "DuplicatePaymentPlanCodeError";
  }
}

/** A misconfigured plan is exactly the kind of realistic risk this codebase
 *  guards against elsewhere (CommissionScheme's maxTotalPct assertion) --
 *  milestones that do not sum to 100% would leave a booking permanently
 *  under- or over-scheduled against its agreementValue. */
export class InvalidMilestoneScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMilestoneScheduleError";
  }
}

export class DemandNotFoundError extends Error {
  constructor(public readonly demandId: string) {
    super(`Demand ${demandId} not found.`);
    this.name = "DemandNotFoundError";
  }
}

export class DemandNotScheduledError extends Error {
  constructor(
    public readonly demandId: string,
    public readonly status: string,
  ) {
    super(`Demand ${demandId} is ${status}, not SCHEDULED; only a scheduled demand can be raised.`);
    this.name = "DemandNotScheduledError";
  }
}

export class WaiveReasonRequiredError extends Error {
  constructor(public readonly demandId: string) {
    super(`Waiving demand ${demandId} requires a reason.`);
    this.name = "WaiveReasonRequiredError";
  }
}

// ── Shared helpers (duplicated per file -- this codebase's own convention)

function requireActor(audit: AuditContext): string {
  if (!audit.actorId) {
    throw new ForbiddenError("Payment plan / demand mutations require a user actor, not a system actor.");
  }
  return audit.actorId;
}

function toAuditValue(value: unknown): unknown {
  if (value instanceof Prisma.Decimal) return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

function auditSnapshot(data: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) out[key] = toAuditValue(value);
  return out;
}

const D = (v: string | number) => new Prisma.Decimal(v);

/** The one rounding rule, matching cost-sheet.ts's/packages/commission's
 *  round2: half up at 2dp. The residual belongs to the LAST milestone (same
 *  discipline as the commission engine and the cost sheet), so the sum of
 *  generated demands matches agreementValue exactly, never off by a paisa. */
function round2(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

// ── Payment plans ──────────────────────────────────────────────────────

export interface CreatePaymentPlanMilestoneInput {
  sequence: number;
  label: string;
  pctOfAgreementValue: Prisma.Decimal | string;
  /** Days after booking confirmation before the demand falls due. Defaults
   *  to the schema's own default of 15. */
  dueDaysOffset?: number;
  /** Construction-linked plans trigger on site progress rather than a pure
   *  date -- this is descriptive only; no site-progress tracking exists in
   *  this codebase, so dueDate is still generated from dueDaysOffset. */
  triggerNote?: string | null;
}

export interface CreatePaymentPlanParams {
  code: string;
  name: string;
  description?: string | null;
  projectId?: string | null;
  milestones: CreatePaymentPlanMilestoneInput[];
  audit: AuditContext;
}

export async function createPaymentPlan(
  db: PrismaClient,
  params: CreatePaymentPlanParams,
): Promise<PaymentPlan & { milestones: PaymentPlanMilestone[] }> {
  const actorId = requireActor(params.audit);

  const totalPct = params.milestones.reduce((sum, m) => sum.plus(new Prisma.Decimal(m.pctOfAgreementValue)), D(0));
  if (!totalPct.equals(100)) {
    throw new InvalidMilestoneScheduleError(
      `Milestones must sum to exactly 100% of agreement value; got ${totalPct.toFixed(4)}%.`,
    );
  }

  return db.$transaction(async (tx) => {
    await assertPermission(tx, actorId, PLAN_WRITE_PERMISSION, { projectId: params.projectId ?? undefined });

    let plan;
    try {
      plan = await tx.paymentPlan.create({
        data: {
          orgId: params.audit.orgId,
          projectId: params.projectId ?? undefined,
          code: params.code,
          name: params.name,
          description: params.description ?? undefined,
          milestones: {
            create: params.milestones.map((m) => ({
              sequence: m.sequence,
              label: m.label,
              pctOfAgreementValue: new Prisma.Decimal(m.pctOfAgreementValue),
              dueDaysOffset: m.dueDaysOffset ?? undefined,
              triggerNote: m.triggerNote ?? undefined,
            })),
          },
        },
        include: { milestones: { orderBy: { sequence: "asc" } } },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new DuplicatePaymentPlanCodeError(params.code);
      }
      throw err;
    }

    await writeAuditLog(tx, params.audit, {
      action: "CREATE",
      entity: "PaymentPlan",
      entityId: plan.id,
      after: auditSnapshot({ ...plan, milestoneCount: plan.milestones.length }),
    });

    return plan;
  });
}

export interface AddMilestoneParams {
  paymentPlanId: string;
  sequence: number;
  label: string;
  pctOfAgreementValue: Prisma.Decimal | string;
  dueDaysOffset?: number;
  triggerNote?: string | null;
  audit: AuditContext;
}

/** Appends one milestone and re-validates the WHOLE plan sums to 100% --
 *  the invariant belongs to the plan, not to any single milestone insert. */
export async function addMilestone(db: PrismaClient, params: AddMilestoneParams): Promise<PaymentPlanMilestone> {
  const actorId = requireActor(params.audit);

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "payment_plans" WHERE "id" = ${params.paymentPlanId} FOR UPDATE`;

    const plan = await tx.paymentPlan.findUnique({
      where: { id: params.paymentPlanId },
      include: { milestones: true },
    });
    if (!plan) throw new PaymentPlanNotFoundError(params.paymentPlanId);
    if (plan.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Payment plan ${params.paymentPlanId} belongs to another organisation.`);
    }

    await assertPermission(tx, actorId, PLAN_WRITE_PERMISSION, { projectId: plan.projectId ?? undefined });

    const newPct = new Prisma.Decimal(params.pctOfAgreementValue);
    const totalPct = plan.milestones.reduce((sum, m) => sum.plus(m.pctOfAgreementValue), newPct);
    if (!totalPct.equals(100)) {
      throw new InvalidMilestoneScheduleError(
        `Milestones must sum to exactly 100% of agreement value; adding this one gives ${totalPct.toFixed(4)}%.`,
      );
    }

    const milestone = await tx.paymentPlanMilestone.create({
      data: {
        paymentPlanId: plan.id,
        sequence: params.sequence,
        label: params.label,
        pctOfAgreementValue: newPct,
        dueDaysOffset: params.dueDaysOffset ?? undefined,
        triggerNote: params.triggerNote ?? undefined,
      },
    });

    await writeAuditLog(tx, params.audit, {
      action: "CREATE",
      entity: "PaymentPlanMilestone",
      entityId: milestone.id,
      after: auditSnapshot(milestone),
    });

    return milestone;
  });
}

// ── Demand generation ────────────────────────────────────────────────────

/** Called from confirmBooking right after the freeze, IN THE SAME
 *  transaction (a confirmed booking with no demand schedule -- when it has
 *  a payment plan at all -- is an inconsistent state worth preventing
 *  atomically). Takes a bare db/tx so confirmBooking can pass its own `tx`
 *  directly rather than opening a nested transaction. Reads the booking
 *  fresh from the SAME transaction, so it sees confirmBooking's own
 *  just-written agreementValue/paymentPlanId, not a stale pre-confirm read.
 *
 *  A booking with no paymentPlanId gets no schedule -- nothing to
 *  generate, not an error (paymentPlanId is nullable on Booking). */
export async function generateDemandSchedule(
  db: PrismaClient | PrismaNS.TransactionClient,
  params: { bookingId: string; audit: AuditContext; now?: Date },
): Promise<Demand[]> {
  const now = params.now ?? new Date();
  const booking = await db.booking.findUniqueOrThrow({ where: { id: params.bookingId } });
  if (!booking.paymentPlanId) return [];

  const milestones = await db.paymentPlanMilestone.findMany({
    where: { paymentPlanId: booking.paymentPlanId },
    orderBy: { sequence: "asc" },
  });
  if (milestones.length === 0) return [];

  const demands: Demand[] = [];
  let allocated = D(0);
  for (let i = 0; i < milestones.length; i++) {
    const milestone = milestones[i]!;
    const isLast = i === milestones.length - 1;
    const amount = isLast
      ? booking.agreementValue.minus(allocated)
      : round2(booking.agreementValue.times(milestone.pctOfAgreementValue).dividedBy(100));
    allocated = allocated.plus(amount);

    const dueDate = new Date(now.getTime() + milestone.dueDaysOffset * 24 * 60 * 60_000);

    const demand = await db.demand.create({
      data: {
        orgId: booking.orgId,
        bookingId: booking.id,
        sequence: milestone.sequence,
        milestoneRef: milestone.id,
        description: milestone.label,
        amount,
        dueDate,
        status: "SCHEDULED",
      },
    });
    demands.push(demand);
  }

  await writeAuditLog(db, params.audit, {
    action: "CREATE",
    entity: "Booking",
    entityId: booking.id,
    after: { demandSchedule: demands.map((d) => ({ id: d.id, sequence: d.sequence, amount: d.amount.toString(), dueDate: d.dueDate.toISOString() })) },
  });

  return demands;
}

// ── Demand mutations ─────────────────────────────────────────────────────

export async function raiseDemand(db: PrismaClient, params: { demandId: string; audit: AuditContext; now?: Date }): Promise<Demand> {
  const actorId = requireActor(params.audit);
  const now = params.now ?? new Date();

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "demands" WHERE "id" = ${params.demandId} FOR UPDATE`;

    const demand = await tx.demand.findUnique({ where: { id: params.demandId }, include: { booking: { select: { projectId: true } } } });
    if (!demand) throw new DemandNotFoundError(params.demandId);
    if (demand.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Demand ${params.demandId} belongs to another organisation.`);
    }

    await assertPermission(tx, actorId, RAISE_PERMISSION, { projectId: demand.booking.projectId });

    if (demand.status !== "SCHEDULED") {
      throw new DemandNotScheduledError(demand.id, demand.status);
    }

    const before = auditSnapshot(demand);
    let updated = await tx.demand.update({ where: { id: demand.id }, data: { status: "RAISED", raisedAt: now } });

    // "Auto-applied to the next demand raised" (docs/05-COLLECTIONS-SPEC.md
    // rule 3) -- any credit sitting on the booking from a prior receipt's
    // overflow is applied against THIS demand immediately, same transaction.
    await applyCreditBalanceToNewDemand(tx, { bookingId: updated.bookingId, demandId: updated.id });
    updated = await tx.demand.findUniqueOrThrow({ where: { id: updated.id } });

    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "Demand",
      entityId: updated.id,
      before,
      after: auditSnapshot(updated),
    });

    return updated;
  });
}

export async function waiveDemand(
  db: PrismaClient,
  params: { demandId: string; reason: string; audit: AuditContext },
): Promise<Demand> {
  const actorId = requireActor(params.audit);
  const now = new Date();

  if (!params.reason || !params.reason.trim()) {
    throw new WaiveReasonRequiredError(params.demandId);
  }

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "demands" WHERE "id" = ${params.demandId} FOR UPDATE`;

    const demand = await tx.demand.findUnique({ where: { id: params.demandId }, include: { booking: { select: { projectId: true } } } });
    if (!demand) throw new DemandNotFoundError(params.demandId);
    if (demand.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Demand ${params.demandId} belongs to another organisation.`);
    }

    await assertPermission(tx, actorId, WAIVE_PERMISSION, { projectId: demand.booking.projectId });

    const before = auditSnapshot(demand);
    const updated = await tx.demand.update({
      where: { id: demand.id },
      data: { status: "WAIVED", waivedById: actorId, waivedAt: now, waiveReason: params.reason },
    });

    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "Demand",
      entityId: updated.id,
      before,
      after: auditSnapshot(updated),
      reason: params.reason,
    });

    return updated;
  });
}

// ── Read ───────────────────────────────────────────────────────────────

/** Gated by booking.read, not a separate demand.read -- a demand schedule is
 *  a view of its booking's payment plan, not an independent resource. */
export async function getDemandsForBooking(
  db: PrismaClient,
  params: { bookingId: string; orgId: string; actorId: string },
): Promise<Demand[]> {
  await assertPermission(db, params.actorId, "booking.read");
  return db.demand.findMany({
    where: { bookingId: params.bookingId, orgId: params.orgId },
    orderBy: { sequence: "asc" },
  });
}
