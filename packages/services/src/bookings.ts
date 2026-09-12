// Booking core -- Phase 2 Slice 1 (PROGRESS.md, docs/06-INVENTORY-SPEC.md §5).
// "The pivot of the whole system" per the schema's own comment on Booking:
// agreementValue and commissionableValue are frozen at confirmation and never
// recomputed. Draft is a preview; confirm is the one moment those numbers
// become permanent.
//
// Deliberately excluded from this slice (see the plan's Context section):
// discount routing (fixed at 0 -- BLOCKED#10, no approvals.ts exists yet),
// cancellation/clawback, and anything CRM (Booking.leadId is nullable, so
// none of this needs a Lead to exist).
import { Prisma } from "@desire/db";
import type { PrismaClient, Prisma as PrismaNS, Booking, CostSheetLine, HoldReleaseReason } from "@desire/db";
// Re-exported so route files (which import narrow subpaths, never the
// barrel -- see the file header of any route in this slice) can type their
// response serializers without a separate @desire/db import.
export type { Booking, CostSheetLine };
import { writeAuditLog, type AuditContext } from "./audit";
import { assertPermission, ForbiddenError, getAccessibleAssociateIds } from "./rbac";
import { effectiveUnitStatus, isHoldLive } from "./holds";
import { assertValidTransition } from "./unit-transitions";
import { resolveUnitAreas, type UnitTypeAreas } from "./projects";
import {
  computeCostSheet,
  type ChargeHeadSpec,
  type CostSheetLineResult,
  type FixedChargeInput,
} from "./cost-sheet";
import { computeClawback } from "@desire/commission";
import Decimal from "decimal.js";

const CREATE_PERMISSION = "booking.create";
const CONFIRM_PERMISSION = "booking.confirm";
const CANCEL_PERMISSION = "booking.cancel";

// ── Errors ─────────────────────────────────────────────────────────────

export class UnitNotHeldError extends Error {
  constructor(public readonly unitId: string) {
    super(`Unit ${unitId} is not currently held; a booking can only be drafted from a held unit.`);
    this.name = "UnitNotHeldError";
  }
}

/** Carries both ids -- same reason MakerCheckerViolationError does in
 *  price-lists.ts -- so the caller can say who actually holds it, not just
 *  "not you". */
export class HeldByAnotherAssociateError extends Error {
  constructor(
    public readonly unitId: string,
    public readonly holderAssociateId: string,
    public readonly requestedAssociateId: string,
  ) {
    super(
      `Unit ${unitId} is held by associate ${holderAssociateId}, not ${requestedAssociateId}; ` +
        `only the associate holding a unit may book it.`,
    );
    this.name = "HeldByAnotherAssociateError";
  }
}

export class InvalidPriceListError extends Error {
  constructor(public readonly priceListId: string) {
    super(`Price list ${priceListId} is not a usable ACTIVE list for this unit's project.`);
    this.name = "InvalidPriceListError";
  }
}

export class BookingNotFoundError extends Error {
  constructor(public readonly bookingId: string) {
    super(`Booking ${bookingId} not found.`);
    this.name = "BookingNotFoundError";
  }
}

export class InvalidBookingStateError extends Error {
  constructor(
    public readonly bookingId: string,
    public readonly currentStatus: string,
    public readonly expected: string,
  ) {
    super(`Booking ${bookingId} is ${currentStatus}, not ${expected}.`);
    this.name = "InvalidBookingStateError";
  }
}

/** Unlike InvalidBookingStateError, this names the ONE state cancellation is
 *  legal from (CONFIRMED), not an arbitrary "expected" state a caller
 *  chose -- the unit state machine (unit-transitions.ts) only has a
 *  BOOKED -> AVAILABLE path back, and nothing in this codebase yet moves a
 *  booking past CONFIRMED (no AGREEMENT_SIGNED/REGISTERED/POSSESSION_GIVEN
 *  transition exists), so CONFIRMED is not just "the current rule" but the
 *  only status this can ever legally apply to today. */
export class BookingNotCancellableError extends Error {
  constructor(
    public readonly bookingId: string,
    public readonly currentStatus: string,
  ) {
    super(`Booking ${bookingId} is ${currentStatus}, not CONFIRMED; only a confirmed booking can be cancelled.`);
    this.name = "BookingNotCancellableError";
  }
}

export class CancellationReasonRequiredError extends Error {
  constructor(public readonly bookingId: string) {
    super(`Booking ${bookingId} cancellation requires a reason.`);
    this.name = "CancellationReasonRequiredError";
  }
}

// ── Shared helpers (duplicated per file by this codebase's own convention --
//    see projects.ts/price-lists.ts/charge-heads.ts, each carries its own
//    copy rather than importing a shared one) ────────────────────────────

function requireActor(audit: AuditContext): string {
  if (!audit.actorId) {
    throw new ForbiddenError("Booking mutations require a user actor, not a system actor.");
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

/** Resolves who a booking.create caller is allowed to name as the selling
 *  associate. Defaults to the caller's own Associate row; naming someone else
 *  requires an admin-shaped role (or, for TEAM_LEAD, a downline associate --
 *  resolved through the ONE existing scope resolver, never a hand-rolled
 *  check). docs/09-RBAC-MATRIX.md shows booking.create as a flat grant with no
 *  (O)/(T) annotation, unlike lead.read -- taken literally that would let any
 *  associate book under any other associate's name, which is treated here as
 *  a documentation gap rather than intended behaviour. */
async function resolveSellingAssociateId(
  tx: PrismaNS.TransactionClient,
  params: { callerUserId: string; orgId: string; requested?: string | null },
): Promise<string> {
  const caller = await tx.associate.findUnique({
    where: { userId: params.callerUserId },
    select: { id: true },
  });
  if (!caller) {
    throw new ForbiddenError("This account has no associate profile; only associates can be credited on a booking.");
  }
  if (!params.requested || params.requested === caller.id) {
    return caller.id;
  }

  const callerRoles = await tx.userRole.findMany({
    where: { userId: params.callerUserId },
    select: { role: { select: { code: true } } },
  });
  const roleCodes = new Set(callerRoles.map((r) => r.role.code));

  if (roleCodes.has("SUPER_ADMIN") || roleCodes.has("SALES_HEAD") || roleCodes.has("SALES_ADMIN")) {
    return params.requested;
  }
  if (roleCodes.has("TEAM_LEAD")) {
    const accessible = await getAccessibleAssociateIds(tx, caller.id, "OWN_AND_DOWNLINE");
    if (accessible.includes(params.requested)) return params.requested;
  }
  throw new ForbiddenError(
    `This session may not credit associate ${params.requested} on a booking; only their own team, if they lead one.`,
  );
}

/** Assembles computeCostSheet's inputs from a locked PriceListItem + the
 *  org's ChargeHead catalogue. Both draft and confirm call this identically --
 *  confirm's whole point is that it does NOT trust draft's cached preview, so
 *  this is re-run, not read back. */
async function buildCostSheetInput(
  tx: PrismaNS.TransactionClient,
  params: { orgId: string; unitId: string; priceListId: string; discount: Prisma.Decimal },
) {
  const unit = await tx.unit.findUniqueOrThrow({
    where: { id: params.unitId },
    select: {
      unitTypeId: true,
      plcTags: true,
      carpetAreaOverride: true,
      saleableAreaOverride: true,
      unitType: { select: { carpetArea: true, builtUpArea: true, saleableArea: true } },
    },
  });
  const areas: UnitTypeAreas = resolveUnitAreas(
    { carpetAreaOverride: unit.carpetAreaOverride, saleableAreaOverride: unit.saleableAreaOverride },
    unit.unitType,
  );

  // Exactly one of unitTypeId/unitId is set on a PriceListItem (schema
  // comment). Prefer a per-unit override item; fall back to the
  // unit-type-wide item. Two queries rather than one OR, so "prefer" is
  // explicit rather than left to whatever row order Postgres happens to
  // return for an OR match.
  const item =
    (await tx.priceListItem.findFirst({
      where: { priceListId: params.priceListId, unitId: params.unitId },
    })) ??
    (await tx.priceListItem.findFirst({
      where: { priceListId: params.priceListId, unitTypeId: unit.unitTypeId },
    }));
  if (!item) throw new InvalidPriceListError(params.priceListId);

  const plcChargesByTag = (item.plcCharges ?? {}) as Record<string, number | string>;
  const otherChargesRaw = (item.otherCharges ?? []) as Array<{ chargeHeadCode: string; amount: number | string }>;

  const chargeHeadRows = await tx.chargeHead.findMany({ where: { orgId: params.orgId } });
  const chargeHeads: ChargeHeadSpec[] = chargeHeadRows.map((h) => ({
    code: h.code,
    name: h.name,
    category: h.category,
    isTaxable: h.isTaxable,
    gstRatePct: h.gstRatePct,
    countsTowardCommission: h.countsTowardCommission,
    displayOrder: h.displayOrder,
  }));

  const otherCharges: FixedChargeInput[] = otherChargesRaw.map((c) => ({
    chargeHeadCode: c.chargeHeadCode,
    amount: D(c.amount),
  }));

  return {
    input: {
      saleableArea: areas.saleableArea,
      carpetArea: areas.carpetArea,
      baseRatePerSqft: item.baseRatePerSqft,
      plcTags: unit.plcTags,
      plcChargesByTag: Object.fromEntries(
        Object.entries(plcChargesByTag).map(([tag, amount]) => [tag, D(amount)]),
      ),
      otherCharges,
      discount: params.discount,
      chargeHeads,
    },
    areas,
  };
}

// ── Draft ──────────────────────────────────────────────────────────────

export interface CreateDraftBookingParams {
  unitId: string;
  priceListId: string;
  customerId: string;
  /** Defaults to the caller's own Associate row -- see resolveSellingAssociateId. */
  sellingAssociateId?: string;
  paymentPlanId?: string | null;
  bookingDate?: Date;
  audit: AuditContext;
}

export async function createDraftBooking(
  db: PrismaClient,
  params: CreateDraftBookingParams,
): Promise<Booking> {
  const actorId = requireActor(params.audit);
  const now = params.bookingDate ?? new Date();

  return db.$transaction(async (tx) => {
    await assertPermission(tx, actorId, CREATE_PERMISSION);

    const sellingAssociateId = await resolveSellingAssociateId(tx, {
      callerUserId: actorId,
      orgId: params.audit.orgId,
      requested: params.sellingAssociateId,
    });

    // Lock-then-read: a stale read here would race the hold-liveness check
    // below, the same reasoning holds.ts documents for its own unit lock.
    await tx.$queryRaw`SELECT "id" FROM "units" WHERE "id" = ${params.unitId} FOR UPDATE`;

    const unit = await tx.unit.findUnique({
      where: { id: params.unitId },
      select: { id: true, orgId: true, projectId: true, status: true, currentHoldId: true },
    });
    if (!unit) throw new ForbiddenError(`Unit ${params.unitId} not found.`);
    if (unit.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Unit ${params.unitId} belongs to another organisation.`);
    }

    const hold = unit.currentHoldId
      ? await tx.unitHold.findUnique({ where: { id: unit.currentHoldId } })
      : null;
    const status = effectiveUnitStatus(unit, hold, now);
    if (status !== "HELD" || !hold || !isHoldLive(hold, now)) {
      throw new UnitNotHeldError(unit.id);
    }
    if (hold.associateId !== sellingAssociateId) {
      throw new HeldByAnotherAssociateError(unit.id, hold.associateId, sellingAssociateId);
    }

    const priceList = await tx.priceList.findFirst({
      where: { id: params.priceListId, orgId: params.audit.orgId, projectId: unit.projectId, status: "ACTIVE" },
      select: { id: true },
    });
    if (!priceList) throw new InvalidPriceListError(params.priceListId);

    const { input, areas } = await buildCostSheetInput(tx, {
      orgId: params.audit.orgId,
      unitId: unit.id,
      priceListId: params.priceListId,
      discount: D(0), // fixed at 0 this slice -- see the file header.
    });
    const preview = computeCostSheet(input);

    const project = await tx.project.findUniqueOrThrow({
      where: { id: unit.projectId },
      select: { code: true },
    });

    // No sequence/counter model exists in the schema. bookingNumber is a
    // format placeholder (like the grade ladder's placeholder rates) --
    // {project.code}-{4-digit sequence scoped to the project}, with the
    // @@unique([orgId, bookingNumber]) constraint as the real correctness
    // backstop against the count-then-insert race: a collision retries
    // rather than needing a project-wide lock (same shape as
    // withUniqueCode/projects.ts's P2002-to-typed-error pattern, applied to
    // a generated value instead of a caller-supplied one).
    let booking: Booking | null = null;
    for (let attempt = 0; attempt < 5 && !booking; attempt++) {
      const count = await tx.booking.count({ where: { projectId: unit.projectId } });
      const bookingNumber = `${project.code}-${String(count + 1 + attempt).padStart(4, "0")}`;
      try {
        booking = await tx.booking.create({
          data: {
            orgId: params.audit.orgId,
            projectId: unit.projectId,
            unitId: unit.id,
            customerId: params.customerId,
            bookingNumber,
            bookingDate: now,
            status: "DRAFT",
            sellingAssociateId,
            priceListId: params.priceListId,
            baseAmount: preview.baseAmount,
            plcAmount: preview.plcAmount,
            otherChargesAmount: preview.otherChargesAmount,
            discountAmount: preview.discountAmount,
            gstAmount: preview.gstAmount,
            stampDutyAmount: preview.stampDutyAmount,
            registrationAmount: preview.registrationAmount,
            agreementValue: preview.agreementValue,
            commissionableValue: preview.commissionableValue,
            saleableAreaAtBooking: areas.saleableArea,
            carpetAreaAtBooking: areas.carpetArea,
            paymentPlanId: params.paymentPlanId ?? undefined,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
        throw err;
      }
    }
    if (!booking) throw new Error(`Could not allocate a unique bookingNumber for project ${unit.projectId}.`);

    await tx.bookingStatusHistory.create({
      data: {
        bookingId: booking.id,
        fromStatus: null,
        toStatus: "DRAFT",
        actorId: params.audit.actorId,
        actorLabel: params.audit.actorLabel,
      },
    });
    await writeAuditLog(tx, params.audit, {
      action: "CREATE",
      entity: "Booking",
      entityId: booking.id,
      after: auditSnapshot(booking),
    });

    return booking;
  });
}

// ── Confirm (the GATE) ───────────────────────────────────────────────────

export interface ConfirmBookingResult extends Booking {
  costSheetLines: CostSheetLine[];
}

const HOLD_RELEASE_REASON_CONFIRMED: HoldReleaseReason = "CONVERTED_TO_BOOKING";

export async function confirmBooking(
  db: PrismaClient,
  params: { bookingId: string; audit: AuditContext; now?: Date },
): Promise<ConfirmBookingResult> {
  const actorId = requireActor(params.audit);
  const now = params.now ?? new Date();

  return db.$transaction(async (tx) => {
    // Lock order for this slice: Booking, then Unit. No existing code in
    // this codebase locks both in one transaction yet (holds.ts only ever
    // locks a single Unit) -- this is the precedent, chosen so a caller
    // reasoning about "what am I holding" reads top-down from the entity the
    // request is actually about.
    await tx.$queryRaw`SELECT "id" FROM "bookings" WHERE "id" = ${params.bookingId} FOR UPDATE`;

    const booking = await tx.booking.findUnique({ where: { id: params.bookingId } });
    if (!booking) throw new BookingNotFoundError(params.bookingId);
    if (booking.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Booking ${params.bookingId} belongs to another organisation.`);
    }

    await assertPermission(tx, actorId, CONFIRM_PERMISSION, { projectId: booking.projectId });

    if (booking.status !== "DRAFT") {
      throw new InvalidBookingStateError(booking.id, booking.status, "DRAFT");
    }

    await tx.$queryRaw`SELECT "id" FROM "units" WHERE "id" = ${booking.unitId} FOR UPDATE`;
    const unit = await tx.unit.findUniqueOrThrow({
      where: { id: booking.unitId },
      select: { id: true, status: true, currentHoldId: true },
    });

    // Re-verify, never trust the draft's premise: the hold can have expired
    // (or been force-released) in the time between draft and confirm.
    const hold = unit.currentHoldId
      ? await tx.unitHold.findUnique({ where: { id: unit.currentHoldId } })
      : null;
    const status = effectiveUnitStatus(unit, hold, now);
    if (status !== "HELD" || !hold || !isHoldLive(hold, now)) {
      throw new UnitNotHeldError(unit.id);
    }
    if (hold.associateId !== booking.sellingAssociateId) {
      throw new HeldByAnotherAssociateError(unit.id, hold.associateId, booking.sellingAssociateId);
    }

    // The freeze. Re-run against the PINNED price list -- never trust the
    // draft's cached preview (docs/06-INVENTORY-SPEC.md §5: "regenerating
    // from the price list later would not reproduce what the customer
    // signed" -- true from this instant, not before it).
    const { input } = await buildCostSheetInput(tx, {
      orgId: booking.orgId,
      unitId: booking.unitId,
      priceListId: booking.priceListId,
      discount: booking.discountAmount,
    });
    const final = computeCostSheet(input);

    const before = auditSnapshot(booking);

    const confirmed = await tx.booking.update({
      where: { id: booking.id },
      data: {
        status: "CONFIRMED",
        confirmedAt: now,
        confirmedById: params.audit.actorId,
        baseAmount: final.baseAmount,
        plcAmount: final.plcAmount,
        otherChargesAmount: final.otherChargesAmount,
        discountAmount: final.discountAmount,
        gstAmount: final.gstAmount,
        stampDutyAmount: final.stampDutyAmount,
        registrationAmount: final.registrationAmount,
        agreementValue: final.agreementValue,
        commissionableValue: final.commissionableValue,
      },
    });

    const costSheetLines = await Promise.all(
      final.lines.map((line: CostSheetLineResult) =>
        tx.costSheetLine.create({
          data: {
            bookingId: booking.id,
            chargeHeadCode: line.chargeHeadCode,
            description: line.description,
            quantity: line.quantity,
            rate: line.rate,
            amount: line.amount,
            gstRatePct: line.gstRatePct,
            gstAmount: line.gstAmount,
            countsTowardCommission: line.countsTowardCommission,
            displayOrder: line.displayOrder,
          },
        }),
      ),
    );

    // Inlined rather than calling holds.ts's releaseHold: that function
    // unconditionally sets Unit.status back to AVAILABLE (correct for a
    // manual release, wrong here -- this unit is going to BOOKED, not back
    // to the pool) and opens its own db.$transaction, which cannot compose
    // with this one. HoldReleaseReason.CONVERTED_TO_BOOKING exists in the
    // schema specifically for this path and was unused until now.
    await tx.unitHold.update({
      where: { id: hold.id },
      data: { releasedAt: now, releaseReason: HOLD_RELEASE_REASON_CONFIRMED, releasedById: params.audit.actorId },
    });
    assertValidTransition("HELD", "BOOKED");
    await tx.unit.update({
      where: { id: unit.id },
      data: { status: "BOOKED", currentHoldId: null },
    });
    await tx.unitStatusHistory.create({
      data: {
        unitId: unit.id,
        fromStatus: "HELD",
        toStatus: "BOOKED",
        reason: `booking ${booking.bookingNumber} confirmed`,
        actorId: params.audit.actorId,
        actorLabel: params.audit.actorLabel,
      },
    });

    await tx.bookingStatusHistory.create({
      data: {
        bookingId: booking.id,
        fromStatus: "DRAFT",
        toStatus: "CONFIRMED",
        actorId: params.audit.actorId,
        actorLabel: params.audit.actorLabel,
      },
    });
    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "Booking",
      entityId: booking.id,
      before,
      after: auditSnapshot({ ...confirmed, costSheetLines: costSheetLines.length }),
    });

    return { ...confirmed, costSheetLines };
  });
}

// ── Cancellation + clawback ──────────────────────────────────────────────

export interface ClawbackPreviewLine {
  commissionEntryId: string;
  beneficiaryAssociateId: string;
  role: string;
  level: number;
  grossAmount: string;
  releasedTotal: string;
  contraAmount: string;
  nettedAgainstPending: string;
  recoveryAmount: string;
}

/** Shared by previewCancellation (read-only) and cancelBooking (which
 *  persists this same computation) -- one place computing "what would the
 *  clawback be", so preview can never drift from what confirming actually
 *  does. Takes a bare db/tx (PrismaClient or TransactionClient) since the
 *  preview runs outside any transaction while cancelBooking runs inside
 *  one. REVERSED entries are excluded -- a booking can only be cancelled
 *  once (guarded by BookingNotCancellableError), so they would only appear
 *  here if a previous clawback already superseded them. */
async function computeClawbackLines(db: PrismaClient | PrismaNS.TransactionClient, bookingId: string) {
  const entries = await db.commissionEntry.findMany({
    where: { bookingId, status: { not: "REVERSED" } },
  });

  const lines: Array<{ entry: (typeof entries)[number]; result: ReturnType<typeof computeClawback> }> = [];
  for (const entry of entries) {
    const releases = await db.commissionRelease.findMany({
      where: { entryId: entry.id, reversedAt: null },
    });
    const releasedTotal = releases.reduce(
      (sum, r) => sum.plus(new Decimal(r.amount.toString())),
      new Decimal(0),
    );

    const otherPayable = await db.commissionEntry.aggregate({
      where: { beneficiaryAssociateId: entry.beneficiaryAssociateId, status: "PAYABLE", id: { not: entry.id } },
      _sum: { grossAmount: true },
    });
    const beneficiaryPendingPayable = new Decimal((otherPayable._sum.grossAmount ?? 0).toString());

    const result = computeClawback({ releasedTotal, beneficiaryPendingPayable });
    lines.push({ entry, result });
  }
  return lines;
}

function serializeClawbackLine(line: Awaited<ReturnType<typeof computeClawbackLines>>[number]): ClawbackPreviewLine {
  return {
    commissionEntryId: line.entry.id,
    beneficiaryAssociateId: line.entry.beneficiaryAssociateId,
    role: line.entry.role,
    level: line.entry.level,
    grossAmount: line.entry.grossAmount.toString(),
    releasedTotal: line.result.contraAmount.negated().toFixed(2),
    contraAmount: line.result.contraAmount.toFixed(2),
    nettedAgainstPending: line.result.nettedAgainstPending.toFixed(2),
    recoveryAmount: line.result.recoveryAmount.toFixed(2),
  };
}

/** Read-only: no transaction, no mutation, no lock -- shows the UI "who
 *  loses how much" before the irreversible cancelBooking call
 *  (docs/08-SCREENS.md: "cancellation shows a clawback preview before
 *  confirming"). */
export async function previewCancellation(
  db: PrismaClient,
  params: { bookingId: string; orgId: string },
): Promise<ClawbackPreviewLine[]> {
  const booking = await db.booking.findFirst({ where: { id: params.bookingId, orgId: params.orgId } });
  if (!booking) throw new BookingNotFoundError(params.bookingId);

  const lines = await computeClawbackLines(db, params.bookingId);
  return lines.map(serializeClawbackLine);
}

export interface CancelBookingResult extends Booking {
  clawback: ClawbackPreviewLine[];
}

export async function cancelBooking(
  db: PrismaClient,
  params: { bookingId: string; reason: string; audit: AuditContext },
): Promise<CancelBookingResult> {
  const actorId = requireActor(params.audit);
  const now = new Date();

  if (!params.reason || !params.reason.trim()) {
    throw new CancellationReasonRequiredError(params.bookingId);
  }

  return db.$transaction(async (tx) => {
    // Same lock order as confirmBooking: Booking, then Unit.
    await tx.$queryRaw`SELECT "id" FROM "bookings" WHERE "id" = ${params.bookingId} FOR UPDATE`;

    const booking = await tx.booking.findUnique({ where: { id: params.bookingId } });
    if (!booking) throw new BookingNotFoundError(params.bookingId);
    if (booking.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Booking ${params.bookingId} belongs to another organisation.`);
    }

    await assertPermission(tx, actorId, CANCEL_PERMISSION, { projectId: booking.projectId });

    if (booking.status !== "CONFIRMED") {
      throw new BookingNotCancellableError(booking.id, booking.status);
    }

    await tx.$queryRaw`SELECT "id" FROM "units" WHERE "id" = ${booking.unitId} FOR UPDATE`;
    const unit = await tx.unit.findUniqueOrThrow({
      where: { id: booking.unitId },
      select: { id: true, status: true },
    });
    // A CONFIRMED booking's unit must be BOOKED -- this asserts that
    // invariant rather than silently no-op-ing if it somehow isn't.
    assertValidTransition(unit.status, "AVAILABLE");

    const before = auditSnapshot(booking);

    const cancelled = await tx.booking.update({
      where: { id: booking.id },
      data: {
        status: "CANCELLED",
        cancelledAt: now,
        cancelledById: actorId,
        cancellationReason: params.reason,
      },
    });

    await tx.unit.update({ where: { id: unit.id }, data: { status: "AVAILABLE" } });
    await tx.unitStatusHistory.create({
      data: {
        unitId: unit.id,
        fromStatus: unit.status,
        toStatus: "AVAILABLE",
        reason: `booking ${booking.bookingNumber} cancelled: ${params.reason}`,
        actorId: params.audit.actorId,
        actorLabel: params.audit.actorLabel,
      },
    });

    await tx.bookingStatusHistory.create({
      data: {
        bookingId: booking.id,
        fromStatus: "CONFIRMED",
        toStatus: "CANCELLED",
        actorId: params.audit.actorId,
        actorLabel: params.audit.actorLabel,
      },
    });

    const lines = await computeClawbackLines(tx, booking.id);
    for (const { entry, result } of lines) {
      // The original is superseded by the contra row created below --
      // CommissionEntryStatus.REVERSED's own schema comment. ADR-0006 (see
      // clawback.ts) says never edit the original's amount; this only
      // moves its status, the row's money fields are untouched.
      await tx.commissionEntry.update({ where: { id: entry.id }, data: { status: "REVERSED" } });

      // The contra is ALSO marked REVERSED, not PAYABLE: its whole effect
      // (nettedAgainstPending + recoveryAmount) is fully disposed of right
      // here -- against the beneficiary's other pending entries and via the
      // Recovery row below -- not something a future payout batch should
      // re-discover by summing PAYABLE rows. This is a genuine
      // interpretation call (no payout-batch code exists yet to confirm
      // against); revisit if Phase 3's batch logic reads status differently.
      const contra = await tx.commissionEntry.create({
        data: {
          orgId: entry.orgId,
          bookingId: entry.bookingId,
          schemeId: entry.schemeId,
          beneficiaryAssociateId: entry.beneficiaryAssociateId,
          role: entry.role,
          level: entry.level,
          baseAmount: entry.baseAmount,
          grossAmount: D(result.contraAmount.toFixed(2)),
          status: "REVERSED",
          snapshot: entry.snapshot as Prisma.InputJsonValue,
          sourceEntryId: entry.id,
          reversalReason: `Booking ${booking.bookingNumber} cancelled: ${params.reason}`,
          idempotencyKey: `${entry.idempotencyKey}:CANCEL:${booking.id}`,
        },
      });

      if (result.recoveryAmount.gt(0)) {
        await tx.recovery.create({
          data: {
            orgId: booking.orgId,
            associateId: entry.beneficiaryAssociateId,
            sourceEntryId: entry.id,
            amount: D(result.recoveryAmount.toFixed(2)),
            outstandingAmount: D(result.recoveryAmount.toFixed(2)),
            reason: `Booking ${booking.bookingNumber} cancelled -- clawback recovery (contra ${contra.id})`,
          },
        });
      }
    }

    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "Booking",
      entityId: booking.id,
      before,
      after: auditSnapshot(cancelled),
      reason: params.reason,
    });

    return { ...cancelled, clawback: lines.map(serializeClawbackLine) };
  });
}

// ── Read ───────────────────────────────────────────────────────────────

export async function getBooking(
  db: PrismaClient,
  params: { orgId: string; bookingId: string },
): Promise<(Booking & { costSheetLines: CostSheetLine[] }) | null> {
  return db.booking.findFirst({
    where: { id: params.bookingId, orgId: params.orgId },
    include: { costSheetLines: { orderBy: { displayOrder: "asc" } } },
  });
}
