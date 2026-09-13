// Receipts: entry, the maker-checker verify GATE, clearance triggering
// commission release, allocation, bounce reversal -- Phase 2 Slice 5
// (PROGRESS.md, docs/05-COLLECTIONS-SPEC.md, docs/10-SECURITY.md). "The
// highest-value control in the system": commission releases pro-rata on
// collection, so whoever can mark money as received can unlock their own or
// their team's pay.
import { Prisma } from "@desire/db";
import type { PrismaClient, Prisma as PrismaNS, Receipt, ReceiptAllocation, ReceiptMode, ReceiptStatus } from "@desire/db";
export type { Receipt, ReceiptAllocation };
import { computeRelease, resolveMilestoneCumulativePct } from "@desire/commission";
import type { ReleaseScheduleSlab } from "@desire/commission";
import Decimal from "decimal.js";
import { writeAuditLog, type AuditContext } from "./audit";
import { assertPermission, ForbiddenError, isInScope } from "./rbac";
import { fireCollectionAlert } from "./collections-sweep";

const ENTER_PERMISSION = "receipt.enter";
// clearReceipt/allocateReceipt/bounceReceipt are gated by the SAME
// receipt.verify permission, not new codes -- they are the continuation of
// the same trusted finance workflow the maker-checker gate already put a
// wall around (SUPER_ADMIN/FINANCE_ADMIN only), not a new capability.
const VERIFY_PERMISSION = "receipt.verify";
// Same read gate collections-sweep.ts's getCollectionsConsole already uses
// for viewing collections data -- a list of receipts is that same kind of
// view, not a new capability.
const READ_PERMISSION = "report.read";

// ── Errors ─────────────────────────────────────────────────────────────

export class ReceiptNotFoundError extends Error {
  constructor(public readonly receiptId: string) {
    super(`Receipt ${receiptId} not found.`);
    this.name = "ReceiptNotFoundError";
  }
}

export class InvalidReceiptStateError extends Error {
  constructor(
    public readonly receiptId: string,
    public readonly currentStatus: string,
    public readonly expected: string,
  ) {
    super(`Receipt ${receiptId} is ${currentStatus}, not ${expected}.`);
    this.name = "InvalidReceiptStateError";
  }
}

/** docs/10-SECURITY.md's first assertion: assert(receipt.enteredById !== actor.id). */
export class SameEntererVerifierError extends Error {
  constructor(public readonly receiptId: string) {
    super(`Receipt ${receiptId} cannot be verified by the same person who entered it.`);
    this.name = "SameEntererVerifierError";
  }
}

/** docs/10-SECURITY.md's second and third assertions, combined via isInScope
 *  the same way the plan describes: true means the verifier IS the seller or
 *  an ancestor (upline) of them. */
export class SellerOrUplineVerifyError extends Error {
  constructor(public readonly receiptId: string) {
    super(`Receipt ${receiptId} cannot be verified by the booking's selling associate or anyone in their upline.`);
    this.name = "SellerOrUplineVerifyError";
  }
}

export class AllocationDemandNotFoundError extends Error {
  constructor(public readonly demandId: string) {
    super(`Demand ${demandId} not found.`);
    this.name = "AllocationDemandNotFoundError";
  }
}

/** Allocating against a demand that has not even been raised is treated as
 *  illegal -- you cannot collect against a bill that has not been sent. */
export class DemandNotRaisedError extends Error {
  constructor(
    public readonly demandId: string,
    public readonly status: string,
  ) {
    super(`Demand ${demandId} is ${status}; only a raised (or already partially/fully paid) demand can receive an allocation.`);
    this.name = "DemandNotRaisedError";
  }
}

export class AllocationExceedsReceiptError extends Error {
  constructor(
    public readonly receiptId: string,
    public readonly receiptAmount: string,
    public readonly attempted: string,
  ) {
    super(`Allocating ${attempted} against receipt ${receiptId} (amount ${receiptAmount}) would exceed the receipt's own amount.`);
    this.name = "AllocationExceedsReceiptError";
  }
}

export class AllocationExceedsDemandError extends Error {
  constructor(
    public readonly demandId: string,
    public readonly outstanding: string,
    public readonly attempted: string,
  ) {
    super(`Allocating ${attempted} against demand ${demandId} would exceed its outstanding balance (${outstanding}).`);
    this.name = "AllocationExceedsDemandError";
  }
}

export class BounceReasonRequiredError extends Error {
  constructor(public readonly receiptId: string) {
    super(`Bouncing receipt ${receiptId} requires a reason.`);
    this.name = "BounceReasonRequiredError";
  }
}

// ── Shared helpers (duplicated per file -- this codebase's own convention)

function requireActor(audit: AuditContext): string {
  if (!audit.actorId) {
    throw new ForbiddenError("Receipt mutations require a user actor, not a system actor.");
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

const D = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v);

/** Sum of a demand's non-reversed allocations -- the spec's own canonical
 *  "how much has been paid" query (docs/05-COLLECTIONS-SPEC.md section 1),
 *  never a denormalised counter. */
async function allocatedTotalForDemand(
  tx: PrismaNS.TransactionClient,
  demandId: string,
): Promise<Prisma.Decimal> {
  const rows = await tx.receiptAllocation.findMany({ where: { demandId, reversedAt: null }, select: { amount: true } });
  return rows.reduce((sum, r) => sum.plus(r.amount), D(0));
}

/** After any allocation change (new allocation or a bounce reversal), the
 *  demand's stored status is brought in line with what it actually owes --
 *  never a status the caller sets directly. WAIVED is left alone: a waiver
 *  is a deliberate terminal decision, not something an allocation should
 *  silently undo. */
async function syncDemandStatus(tx: PrismaNS.TransactionClient, demandId: string): Promise<void> {
  const demand = await tx.demand.findUniqueOrThrow({ where: { id: demandId } });
  if (demand.status === "WAIVED") return;

  const allocated = await allocatedTotalForDemand(tx, demandId);
  const owed = demand.amount.plus(demand.gstAmount);
  const nextStatus = allocated.greaterThanOrEqualTo(owed) && owed.greaterThan(0) ? "PAID" : allocated.greaterThan(0) ? "PARTIALLY_PAID" : "RAISED";
  if (nextStatus !== demand.status) {
    await tx.demand.update({ where: { id: demand.id }, data: { status: nextStatus } });
    if (nextStatus === "PAID") {
      await releaseMilestoneCommission(tx, { bookingId: demand.bookingId, triggerDemandId: demand.id });
    }
  }
}

/** MILESTONE release, fired when a demand reaches PAID (the one
 *  ReleaseTriggerType.DEMAND_PAID case that is genuinely fireable today --
 *  no code anywhere moves Booking.status past CONFIRMED, so
 *  AGREEMENT_SIGNED/REGISTRATION/POSSESSION slabs cannot fire yet, a future
 *  phase's booking-lifecycle work, not invented here).
 *
 *  A PayoutScheduleSlab's triggerRef for a DEMAND_PAID slab is a
 *  PaymentPlanMilestone id, the exact value payment-plans.ts's
 *  generateDemandSchedule already stamps onto Demand.milestoneRef -- so
 *  "which triggers have fired" is just every PAID demand's own
 *  milestoneRef, org-wide history not required since this only ever reads
 *  the CURRENT status of this booking's own demands. */
async function releaseMilestoneCommission(
  tx: PrismaNS.TransactionClient,
  params: { bookingId: string; triggerDemandId: string },
): Promise<void> {
  const entries = await tx.commissionEntry.findMany({ where: { bookingId: params.bookingId, status: { not: "REVERSED" } } });
  if (entries.length === 0) return;

  const paidDemands = await tx.demand.findMany({
    where: { bookingId: params.bookingId, status: "PAID", milestoneRef: { not: null } },
    select: { milestoneRef: true },
  });
  const firedTriggerRefs = new Set(paidDemands.map((d) => d.milestoneRef!));

  for (const entry of entries) {
    const scheme = await tx.commissionScheme.findUnique({ where: { id: entry.schemeId }, include: { schedules: { include: { slabs: true } } } });
    const schedule = scheme?.schedules[0];
    if (!schedule || schedule.mode !== "MILESTONE") continue;

    const slabs: ReleaseScheduleSlab[] = schedule.slabs
      .filter((s) => s.triggerType === "DEMAND_PAID")
      .map((s) => ({ sequence: s.sequence, triggerType: s.triggerType, triggerRef: s.triggerRef, releasePct: new Decimal(s.releasePct.toString()) }));
    // A scheme with no matching PayoutSchedule slabs is skipped, not
    // half-computed -- same posture as PRO_RATA_COLLECTION's own guard above.
    if (slabs.length === 0) continue;

    const cumulativePct = resolveMilestoneCumulativePct(slabs, firedTriggerRefs);
    if (cumulativePct.isZero()) continue;

    const releases = await tx.commissionRelease.findMany({ where: { entryId: entry.id, reversedAt: null }, select: { amount: true } });
    const alreadyReleased = releases.reduce((sum, r) => sum.plus(new Decimal(r.amount.toString())), new Decimal(0));

    const delta = computeRelease({
      entryGrossAmount: new Decimal(entry.grossAmount.toString()),
      entryAlreadyReleased: alreadyReleased,
      cumulativeReleasePct: cumulativePct,
    });
    if (delta.lessThanOrEqualTo(0)) continue;

    // Idempotent on (entryId, triggerType, triggerRef): a re-sync of the
    // same demand (e.g. a bounce-then-reallocate cycle landing back on PAID)
    // must not release the same delta twice.
    await tx.commissionRelease.create({
      data: {
        entryId: entry.id,
        triggerType: "DEMAND_PAID",
        triggerRef: params.triggerDemandId,
        cumulativePct: D(cumulativePct.toFixed(4)),
        amount: D(delta.toFixed(2)),
      },
    });

    if (entry.status === "ACCRUED") {
      await tx.commissionEntry.update({ where: { id: entry.id }, data: { status: "PAYABLE" } });
    }
  }
}

// ── Entry ──────────────────────────────────────────────────────────────

export interface EnterReceiptParams {
  bookingId: string;
  amount: Prisma.Decimal | string;
  mode: ReceiptMode;
  instrumentNumber?: string | null;
  instrumentDate?: Date | null;
  drawnOnBank?: string | null;
  depositedToBank?: string | null;
  receivedOn: Date;
  remarks?: string | null;
  audit: AuditContext;
}

export async function enterReceipt(db: PrismaClient, params: EnterReceiptParams): Promise<Receipt> {
  const actorId = requireActor(params.audit);

  return db.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({ where: { id: params.bookingId }, select: { id: true, orgId: true, projectId: true } });
    if (!booking) throw new ForbiddenError(`Booking ${params.bookingId} not found.`);
    if (booking.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Booking ${params.bookingId} belongs to another organisation.`);
    }

    await assertPermission(tx, actorId, ENTER_PERMISSION, { projectId: booking.projectId });

    // Same generated-with-retry-on-collision pattern as bookings.ts's
    // bookingNumber: @@unique([orgId, receiptNumber]) is the real backstop.
    let receipt: Receipt | null = null;
    for (let attempt = 0; attempt < 5 && !receipt; attempt++) {
      const count = await tx.receipt.count({ where: { orgId: params.audit.orgId } });
      const receiptNumber = `RCPT-${String(count + 1 + attempt).padStart(6, "0")}`;
      try {
        receipt = await tx.receipt.create({
          data: {
            orgId: params.audit.orgId,
            bookingId: booking.id,
            receiptNumber,
            amount: D(params.amount),
            mode: params.mode,
            status: "ENTERED",
            instrumentNumber: params.instrumentNumber ?? undefined,
            instrumentDate: params.instrumentDate ?? undefined,
            drawnOnBank: params.drawnOnBank ?? undefined,
            depositedToBank: params.depositedToBank ?? undefined,
            receivedOn: params.receivedOn,
            remarks: params.remarks ?? undefined,
            enteredById: actorId,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
        throw err;
      }
    }
    if (!receipt) throw new Error(`Could not allocate a unique receiptNumber for org ${params.audit.orgId}.`);

    await writeAuditLog(tx, params.audit, { action: "CREATE", entity: "Receipt", entityId: receipt.id, after: auditSnapshot(receipt) });

    return receipt;
  });
}

// ── Verify (the GATE) ────────────────────────────────────────────────────

export async function verifyReceipt(db: PrismaClient, params: { receiptId: string; audit: AuditContext; now?: Date }): Promise<Receipt> {
  const actorId = requireActor(params.audit);
  const now = params.now ?? new Date();

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "receipts" WHERE "id" = ${params.receiptId} FOR UPDATE`;

    const receipt = await tx.receipt.findUnique({ where: { id: params.receiptId } });
    if (!receipt) throw new ReceiptNotFoundError(params.receiptId);
    if (receipt.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Receipt ${params.receiptId} belongs to another organisation.`);
    }

    const booking = await tx.booking.findUniqueOrThrow({ where: { id: receipt.bookingId } });
    await assertPermission(tx, actorId, VERIFY_PERMISSION, { projectId: booking.projectId });

    if (receipt.status !== "ENTERED") {
      throw new InvalidReceiptStateError(receipt.id, receipt.status, "ENTERED");
    }

    // GATE. All three assertions before status changes, exactly as
    // docs/10-SECURITY.md states them.
    if (receipt.enteredById === actorId) {
      throw new SameEntererVerifierError(receipt.id);
    }
    const actorAssociate = await tx.associate.findUnique({ where: { userId: actorId }, select: { id: true } });
    if (actorAssociate) {
      const sellerHierarchy = await tx.associateHierarchy.findFirst({
        where: { associateId: booking.sellingAssociateId, validTo: null },
      });
      if (sellerHierarchy && isInScope(actorAssociate.id, sellerHierarchy)) {
        throw new SellerOrUplineVerifyError(receipt.id);
      }
    }

    const before = auditSnapshot(receipt);
    const updated = await tx.receipt.update({
      where: { id: receipt.id },
      data: { status: "VERIFIED", verifiedById: actorId, verifiedAt: now },
    });

    await writeAuditLog(tx, params.audit, { action: "UPDATE", entity: "Receipt", entityId: updated.id, before, after: auditSnapshot(updated) });

    return updated;
  });
}

// ── Clear (triggers commission release) ──────────────────────────────────

export async function clearReceipt(db: PrismaClient, params: { receiptId: string; clearedOn: Date; audit: AuditContext }): Promise<Receipt> {
  const actorId = requireActor(params.audit);

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "receipts" WHERE "id" = ${params.receiptId} FOR UPDATE`;

    const receipt = await tx.receipt.findUnique({ where: { id: params.receiptId } });
    if (!receipt) throw new ReceiptNotFoundError(params.receiptId);
    if (receipt.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Receipt ${params.receiptId} belongs to another organisation.`);
    }

    const booking = await tx.booking.findUniqueOrThrow({ where: { id: receipt.bookingId } });
    await assertPermission(tx, actorId, VERIFY_PERMISSION, { projectId: booking.projectId });

    if (receipt.status !== "VERIFIED") {
      throw new InvalidReceiptStateError(receipt.id, receipt.status, "VERIFIED");
    }

    const before = auditSnapshot(receipt);
    const cleared = await tx.receipt.update({
      where: { id: receipt.id },
      data: { status: "CLEARED", clearedOn: params.clearedOn },
    });

    await releaseCommissionForBooking(tx, { booking, triggerReceiptId: receipt.id });

    await writeAuditLog(tx, params.audit, { action: "UPDATE", entity: "Receipt", entityId: cleared.id, before, after: auditSnapshot(cleared) });

    return cleared;
  });
}

/** clearedOn, never receivedOn (docs/05-COLLECTIONS-SPEC.md). Cumulative
 *  release percentage is resolved ONCE per booking (Σ cleared, non-reversed
 *  allocations / agreementValue) and applied to every PRO_RATA_COLLECTION
 *  entry on it -- MILESTONE/ON_BOOKING schemes are real enum values but out
 *  of this slice's scope (no payout-schedule code exists anywhere yet to
 *  resolve them against), so entries under those modes are simply skipped,
 *  not half-computed. */
async function releaseCommissionForBooking(
  tx: PrismaNS.TransactionClient,
  params: { booking: { id: string; orgId: string; agreementValue: Prisma.Decimal }; triggerReceiptId: string },
): Promise<void> {
  if (params.booking.agreementValue.lessThanOrEqualTo(0)) return;

  const clearedAllocations = await tx.receiptAllocation.findMany({
    where: { reversedAt: null, receipt: { bookingId: params.booking.id, status: "CLEARED" } },
    select: { amount: true },
  });
  const clearedTotal = clearedAllocations.reduce((sum, a) => sum.plus(a.amount), D(0));
  const cumulativeReleasePct = clearedTotal.dividedBy(params.booking.agreementValue).times(100);

  const entries = await tx.commissionEntry.findMany({ where: { bookingId: params.booking.id, status: { not: "REVERSED" } } });

  for (const entry of entries) {
    const scheme = await tx.commissionScheme.findUnique({ where: { id: entry.schemeId }, include: { schedules: true } });
    const schedule = scheme?.schedules[0];
    if (!schedule || schedule.mode !== "PRO_RATA_COLLECTION") continue;

    const releases = await tx.commissionRelease.findMany({ where: { entryId: entry.id, reversedAt: null }, select: { amount: true } });
    const alreadyReleased = releases.reduce((sum, r) => sum.plus(new Decimal(r.amount.toString())), new Decimal(0));

    const delta = computeRelease({
      entryGrossAmount: new Decimal(entry.grossAmount.toString()),
      entryAlreadyReleased: alreadyReleased,
      cumulativeReleasePct: new Decimal(cumulativeReleasePct.toString()),
    });
    if (delta.lessThanOrEqualTo(0)) continue;

    await tx.commissionRelease.create({
      data: {
        entryId: entry.id,
        triggerType: "COLLECTION_PCT",
        triggerRef: params.triggerReceiptId,
        cumulativePct: D(cumulativeReleasePct.toFixed(4)),
        amount: D(delta.toFixed(2)),
      },
    });

    if (entry.status === "ACCRUED") {
      await tx.commissionEntry.update({ where: { id: entry.id }, data: { status: "PAYABLE" } });
    }
  }
}

// ── Allocation ───────────────────────────────────────────────────────────

export interface AllocateReceiptParams {
  receiptId: string;
  /** Explicit overrides. Omit to auto-allocate oldest-unpaid-first
   *  (docs/05-COLLECTIONS-SPEC.md rule 1) up to the receipt's unallocated
   *  amount. */
  allocations?: Array<{ demandId: string; amount: Prisma.Decimal | string }>;
  audit: AuditContext;
}

export async function allocateReceipt(db: PrismaClient, params: AllocateReceiptParams): Promise<ReceiptAllocation[]> {
  const actorId = requireActor(params.audit);

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "receipts" WHERE "id" = ${params.receiptId} FOR UPDATE`;

    const receipt = await tx.receipt.findUnique({ where: { id: params.receiptId } });
    if (!receipt) throw new ReceiptNotFoundError(params.receiptId);
    if (receipt.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Receipt ${params.receiptId} belongs to another organisation.`);
    }

    const booking = await tx.booking.findUniqueOrThrow({ where: { id: receipt.bookingId } });
    await assertPermission(tx, actorId, VERIFY_PERMISSION, { projectId: booking.projectId });

    if (receipt.status !== "VERIFIED" && receipt.status !== "CLEARED") {
      throw new InvalidReceiptStateError(receipt.id, receipt.status, "VERIFIED or CLEARED");
    }

    const existingReceiptAllocations = await tx.receiptAllocation.findMany({ where: { receiptId: receipt.id, reversedAt: null }, select: { amount: true } });
    const alreadyAllocatedOnReceipt = existingReceiptAllocations.reduce((sum, a) => sum.plus(a.amount), D(0));
    let receiptRoom = receipt.amount.minus(alreadyAllocatedOnReceipt);

    const targets = params.allocations
      ? params.allocations.map((a) => ({ demandId: a.demandId, amount: D(a.amount) }))
      : await resolveOldestUnpaidFirst(tx, { bookingId: booking.id, upTo: receiptRoom });

    const created: ReceiptAllocation[] = [];
    for (const target of targets) {
      if (target.amount.lessThanOrEqualTo(0)) continue;

      if (target.amount.greaterThan(receiptRoom)) {
        throw new AllocationExceedsReceiptError(receipt.id, receipt.amount.toString(), target.amount.toString());
      }

      const demand = await tx.demand.findUnique({ where: { id: target.demandId } });
      if (!demand) throw new AllocationDemandNotFoundError(target.demandId);
      if (demand.status !== "RAISED" && demand.status !== "PARTIALLY_PAID") {
        throw new DemandNotRaisedError(demand.id, demand.status);
      }

      const demandAllocated = await allocatedTotalForDemand(tx, demand.id);
      const demandOutstanding = demand.amount.plus(demand.gstAmount).minus(demandAllocated);
      if (target.amount.greaterThan(demandOutstanding)) {
        throw new AllocationExceedsDemandError(demand.id, demandOutstanding.toString(), target.amount.toString());
      }

      const allocation = await tx.receiptAllocation.create({
        data: { receiptId: receipt.id, demandId: demand.id, amount: target.amount },
      });
      created.push(allocation);
      receiptRoom = receiptRoom.minus(target.amount);

      await syncDemandStatus(tx, demand.id);
    }

    // Overflow becomes credit, auto-applied to the next demand raised.
    if (receiptRoom.greaterThan(0)) {
      await tx.booking.update({ where: { id: booking.id }, data: { creditBalance: { increment: receiptRoom } } });
    }

    await writeAuditLog(tx, params.audit, {
      action: "CREATE",
      entity: "ReceiptAllocation",
      entityId: receipt.id,
      after: { allocations: created.map((a) => ({ id: a.id, demandId: a.demandId, amount: a.amount.toString() })), overflowToCredit: receiptRoom.toFixed(2) },
    });

    return created;
  });
}

async function resolveOldestUnpaidFirst(
  tx: PrismaNS.TransactionClient,
  params: { bookingId: string; upTo: Prisma.Decimal },
): Promise<Array<{ demandId: string; amount: Prisma.Decimal }>> {
  const demands = await tx.demand.findMany({
    where: { bookingId: params.bookingId, status: { in: ["RAISED", "PARTIALLY_PAID"] } },
    orderBy: { dueDate: "asc" },
  });

  const targets: Array<{ demandId: string; amount: Prisma.Decimal }> = [];
  let remaining = params.upTo;
  for (const demand of demands) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const allocated = await allocatedTotalForDemand(tx, demand.id);
    const outstanding = demand.amount.plus(demand.gstAmount).minus(allocated);
    if (outstanding.lessThanOrEqualTo(0)) continue;
    const take = Prisma.Decimal.min(outstanding, remaining);
    targets.push({ demandId: demand.id, amount: take });
    remaining = remaining.minus(take);
  }
  return targets;
}

// ── Credit balance auto-apply (called from payment-plans.ts's raiseDemand) ─

/** When a demand is newly raised, any credit sitting on the booking from a
 *  prior receipt's overflow is applied against it immediately -- "auto-
 *  applied to the next demand raised" (docs/05-COLLECTIONS-SPEC.md rule 3).
 *  Pulls room from the booking's own CLEARED receipts, oldest-cleared-first,
 *  so Σ(allocations per receipt) ≤ receipt.amount still holds per receipt --
 *  credit is not a receipt-less allocation, it is unspent room on a real
 *  receipt that has not been assigned to a demand yet. */
export async function applyCreditBalanceToNewDemand(tx: PrismaNS.TransactionClient, params: { bookingId: string; demandId: string }): Promise<void> {
  const booking = await tx.booking.findUniqueOrThrow({ where: { id: params.bookingId } });
  if (booking.creditBalance.lessThanOrEqualTo(0)) return;

  const demand = await tx.demand.findUniqueOrThrow({ where: { id: params.demandId } });
  const demandAllocated = await allocatedTotalForDemand(tx, demand.id);
  let remaining = Prisma.Decimal.min(booking.creditBalance, demand.amount.plus(demand.gstAmount).minus(demandAllocated));
  if (remaining.lessThanOrEqualTo(0)) return;

  const clearedReceipts = await tx.receipt.findMany({
    where: { bookingId: booking.id, status: "CLEARED" },
    orderBy: { clearedOn: "asc" },
  });

  let applied = D(0);
  for (const receipt of clearedReceipts) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const receiptAllocated = await tx.receiptAllocation
      .findMany({ where: { receiptId: receipt.id, reversedAt: null }, select: { amount: true } })
      .then((rows) => rows.reduce((sum, r) => sum.plus(r.amount), D(0)));
    const room = receipt.amount.minus(receiptAllocated);
    if (room.lessThanOrEqualTo(0)) continue;

    const take = Prisma.Decimal.min(room, remaining);
    await tx.receiptAllocation.create({ data: { receiptId: receipt.id, demandId: demand.id, amount: take } });
    remaining = remaining.minus(take);
    applied = applied.plus(take);
  }

  if (applied.greaterThan(0)) {
    await tx.booking.update({ where: { id: booking.id }, data: { creditBalance: { decrement: applied } } });
    await syncDemandStatus(tx, demand.id);
  }
}

// ── Bounce ─────────────────────────────────────────────────────────────

export async function bounceReceipt(db: PrismaClient, params: { receiptId: string; bounceReason: string; audit: AuditContext; now?: Date }): Promise<Receipt> {
  const actorId = requireActor(params.audit);
  const now = params.now ?? new Date();

  if (!params.bounceReason || !params.bounceReason.trim()) {
    throw new BounceReasonRequiredError(params.receiptId);
  }

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "receipts" WHERE "id" = ${params.receiptId} FOR UPDATE`;

    const receipt = await tx.receipt.findUnique({ where: { id: params.receiptId } });
    if (!receipt) throw new ReceiptNotFoundError(params.receiptId);
    if (receipt.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Receipt ${params.receiptId} belongs to another organisation.`);
    }

    const booking = await tx.booking.findUniqueOrThrow({ where: { id: receipt.bookingId } });
    await assertPermission(tx, actorId, VERIFY_PERMISSION, { projectId: booking.projectId });

    if (receipt.status !== "VERIFIED" && receipt.status !== "CLEARED") {
      throw new InvalidReceiptStateError(receipt.id, receipt.status, "VERIFIED or CLEARED");
    }

    const activeAllocations = await tx.receiptAllocation.findMany({ where: { receiptId: receipt.id, reversedAt: null } });
    const allocatedTotal = activeAllocations.reduce((sum, a) => sum.plus(a.amount), D(0));

    const affectedDemandIds = new Set<string>();
    for (const allocation of activeAllocations) {
      await tx.receiptAllocation.update({
        where: { id: allocation.id },
        data: { reversedAt: now, reversedReason: params.bounceReason },
      });
      await syncDemandStatus(tx, allocation.demandId);
      affectedDemandIds.add(allocation.demandId);
    }

    // CHEQUE_BOUNCED fires from here directly, not the sweep
    // (docs/05-COLLECTIONS-SPEC.md's escalation table says so explicitly)
    // -- one per demand this receipt had touched.
    for (const demandId of affectedDemandIds) {
      await fireCollectionAlert(tx, { orgId: receipt.orgId, demandId, rung: "CHEQUE_BOUNCED", sellingAssociateId: booking.sellingAssociateId });
    }

    // Whatever of this receipt had flowed into creditBalance (never
    // allocated to any demand) never really existed either -- clawed back
    // the same way, clamped at zero since a later receipt's overflow may
    // already share the same pooled column.
    const neverAllocated = receipt.amount.minus(allocatedTotal);
    if (neverAllocated.greaterThan(0)) {
      const clawback = Prisma.Decimal.min(neverAllocated, booking.creditBalance);
      if (clawback.greaterThan(0)) {
        await tx.booking.update({ where: { id: booking.id }, data: { creditBalance: { decrement: clawback } } });
      }
    }

    // Every commission release THIS receipt triggered, reversed -- the
    // spec's own invariant verbatim. Not a cascading recompute of releases
    // that happened on later receipts; those are out of this literal scope.
    const releases = await tx.commissionRelease.findMany({
      where: { triggerType: "COLLECTION_PCT", triggerRef: receipt.id, reversedAt: null },
    });
    for (const release of releases) {
      await tx.commissionRelease.update({
        where: { id: release.id },
        data: { reversedAt: now, reversalReason: params.bounceReason },
      });
    }

    const before = auditSnapshot(receipt);
    const bounced = await tx.receipt.update({
      where: { id: receipt.id },
      data: { status: "BOUNCED", bouncedOn: now, bounceReason: params.bounceReason },
    });

    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "Receipt",
      entityId: bounced.id,
      before,
      after: auditSnapshot(bounced),
      reason: params.bounceReason,
    });

    return bounced;
  });
}

// ── Read ───────────────────────────────────────────────────────────────

export interface ReceiptListRow extends Receipt {
  booking: { id: string; bookingNumber: string; customer: { name: string } };
}

export interface ListReceiptsParams {
  orgId: string;
  actorId: string;
  status?: ReceiptStatus;
}

/** Phase 3.5 Slice 11 -- confirmed gap, no list existed (every function above
 *  acts on a receiptId you already have). Org-wide, gated the same way the
 *  console already is -- a receipts list and the verification queue are the
 *  same view of the same data at two different status filters, not two
 *  separate reads. */
export async function listReceipts(db: PrismaClient, params: ListReceiptsParams): Promise<ReceiptListRow[]> {
  await assertPermission(db, params.actorId, READ_PERMISSION);
  return db.receipt.findMany({
    where: { orgId: params.orgId, ...(params.status ? { status: params.status } : {}) },
    include: { booking: { select: { id: true, bookingNumber: true, customer: { select: { name: true } } } } },
    orderBy: { receivedOn: "desc" },
  });
}
