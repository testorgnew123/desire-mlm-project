// Discount request + approval routing -- Phase 2 Slice 1b (PROGRESS.md,
// docs/09-RBAC-MATRIX.md "Approval matrix (discounts)"). Bands are
// PLACEHOLDER (BLOCKED#10) -- the mechanism below is real, only the numeric
// thresholds and role assignments in the doc await client confirmation.
//
// Maker-checker modeled directly on price-lists.ts's publishPriceList, not
// the generic ApprovalRequest model: DiscountRequest already carries its own
// approverRoleCode/decidedById/decidedAt/decisionNote, ApprovalRequest is
// unused by any service or route in this codebase, and duplicating a working
// pattern this codebase already trusts is safer than reaching for an unused
// generic one for the first real caller.
import { Prisma } from "@desire/db";
import type { PrismaClient, DiscountRequest, ApprovalStatus } from "@desire/db";
export type { DiscountRequest };
import { writeAuditLog, type AuditContext } from "./audit";
import { assertPermission, ForbiddenError } from "./rbac";

const REQUEST_PERMISSION = "discount.request";
const APPROVE_PERMISSION = "discount.approve";

// ── Errors ─────────────────────────────────────────────────────────────

export class BookingNotDraftForDiscountError extends Error {
  constructor(
    public readonly bookingId: string,
    public readonly currentStatus: string,
  ) {
    super(`Booking ${bookingId} is ${currentStatus}, not DRAFT; a discount can only be requested pre-confirmation.`);
    this.name = "BookingNotDraftForDiscountError";
  }
}

export class InvalidDiscountBandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDiscountBandError";
  }
}

export class DiscountRequestNotFoundError extends Error {
  constructor(public readonly discountRequestId: string) {
    super(`Discount request ${discountRequestId} not found.`);
    this.name = "DiscountRequestNotFoundError";
  }
}

/** Carries both ids, same reason MakerCheckerViolationError does in
 *  price-lists.ts -- the requester can never be their own approver
 *  (docs/09-RBAC-MATRIX.md separation-of-duties: "Approve a discount / The
 *  requesting associate / Self-approval"). */
export class SelfApprovalError extends Error {
  constructor(
    public readonly discountRequestId: string,
    public readonly requestedById: string,
  ) {
    super(`Discount request ${discountRequestId} was requested by ${requestedById}; they cannot decide it themselves.`);
    this.name = "SelfApprovalError";
  }
}

export class DiscountRequestNotPendingError extends Error {
  constructor(
    public readonly discountRequestId: string,
    public readonly status: ApprovalStatus,
  ) {
    super(`Discount request ${discountRequestId} is ${status}, not PENDING.`);
    this.name = "DiscountRequestNotPendingError";
  }
}

// ── Shared helpers (duplicated per file -- this codebase's own convention,
//    see projects.ts/price-lists.ts/charge-heads.ts/bookings.ts) ─────────

function requireActor(audit: AuditContext): string {
  if (!audit.actorId) {
    throw new ForbiddenError("Discount mutations require a user actor, not a system actor.");
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

/** Resolves the approving role(s) for a discount purely from its percentage
 *  of base -- a small pure function so the PLACEHOLDER bands
 *  (docs/09-RBAC-MATRIX.md) can be swapped later without touching the
 *  transaction logic around it. "3-5%: SALES_HEAD or FINANCE_ADMIN" is one
 *  decider, not dual sign-off -- DiscountRequest has a single decidedById.
 *  Exported so a test can assert the band table directly without spinning
 *  up a whole request/decide cycle per band. */
export function resolveApproverRoles(pctOfBase: Prisma.Decimal): readonly string[] {
  if (pctOfBase.lt(0)) {
    throw new InvalidDiscountBandError(`Discount percentage ${pctOfBase.toFixed(2)}% cannot be negative.`);
  }
  if (pctOfBase.lte(1)) return ["TEAM_LEAD"];
  if (pctOfBase.lte(3)) return ["SALES_HEAD"];
  if (pctOfBase.lte(5)) return ["SALES_HEAD", "FINANCE_ADMIN"];
  return ["SUPER_ADMIN"];
}

// ── Request ────────────────────────────────────────────────────────────

export interface RequestDiscountParams {
  bookingId: string;
  amount: Prisma.Decimal | string;
  pctOfBase: Prisma.Decimal | string;
  justification: string;
  audit: AuditContext;
}

export async function requestDiscount(
  db: PrismaClient,
  params: RequestDiscountParams,
): Promise<DiscountRequest> {
  const actorId = requireActor(params.audit);
  const pctOfBase = new Prisma.Decimal(params.pctOfBase);
  const amount = new Prisma.Decimal(params.amount);
  // Resolved (and validated) before the transaction: a caller submitting an
  // impossible band should learn that before anything is locked.
  const approverRoles = resolveApproverRoles(pctOfBase);

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "bookings" WHERE "id" = ${params.bookingId} FOR UPDATE`;

    const booking = await tx.booking.findUnique({ where: { id: params.bookingId } });
    if (!booking) throw new ForbiddenError(`Booking ${params.bookingId} not found.`);
    if (booking.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Booking ${params.bookingId} belongs to another organisation.`);
    }

    await assertPermission(tx, actorId, REQUEST_PERMISSION, { projectId: booking.projectId });

    if (booking.status !== "DRAFT") {
      throw new BookingNotDraftForDiscountError(booking.id, booking.status);
    }

    const request = await tx.discountRequest.create({
      data: {
        bookingId: booking.id,
        requestedById: actorId,
        amount,
        pctOfBase,
        justification: params.justification,
        status: "PENDING",
        // Multiple bands (3-5%) resolve to more than one eligible role;
        // the first is recorded as the nominal target for display, but
        // decideDiscount checks membership in the full resolved set, not
        // equality against this one string.
        approverRoleCode: approverRoles[0]!,
      },
    });

    await writeAuditLog(tx, params.audit, {
      action: "CREATE",
      entity: "DiscountRequest",
      entityId: request.id,
      after: auditSnapshot(request),
    });

    return request;
  });
}

// ── Decide ─────────────────────────────────────────────────────────────

export interface DecideDiscountParams {
  discountRequestId: string;
  approve: boolean;
  decisionNote?: string;
  audit: AuditContext;
}

export async function decideDiscount(
  db: PrismaClient,
  params: DecideDiscountParams,
): Promise<DiscountRequest> {
  const actorId = requireActor(params.audit);
  const now = new Date();

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "discount_requests" WHERE "id" = ${params.discountRequestId} FOR UPDATE`;

    const request = await tx.discountRequest.findUnique({ where: { id: params.discountRequestId } });
    if (!request) throw new DiscountRequestNotFoundError(params.discountRequestId);

    const booking = await tx.booking.findUniqueOrThrow({ where: { id: request.bookingId } });
    if (booking.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Discount request ${request.id} belongs to another organisation.`);
    }

    // Permission first ("may you approve discounts on this project at
    // all"), then band membership ("may you approve THIS SIZE of
    // discount"), then the separation-of-duties assertion ("may you approve
    // THIS one") -- same ordering price-lists.ts's publishPriceList uses
    // for its own two checks, extended here with the extra band step since
    // discount.approve alone does not imply "for every band" (a TEAM_LEAD
    // holds discount.approve at all, but only for <=1% requests).
    await assertPermission(tx, actorId, APPROVE_PERMISSION, { projectId: booking.projectId });

    const actorRoles = await tx.userRole.findMany({
      where: { userId: actorId },
      select: { role: { select: { code: true } } },
    });
    const actorRoleCodes = new Set(actorRoles.map((r) => r.role.code));
    const eligibleRoles = resolveApproverRoles(request.pctOfBase);
    if (!eligibleRoles.some((role) => actorRoleCodes.has(role))) {
      throw new ForbiddenError(
        `This session's role is not eligible to decide a ${request.pctOfBase.toFixed(2)}% discount ` +
          `(requires one of: ${eligibleRoles.join(", ")}).`,
      );
    }

    if (request.requestedById === actorId) {
      throw new SelfApprovalError(request.id, request.requestedById);
    }
    if (request.status !== "PENDING") {
      throw new DiscountRequestNotPendingError(request.id, request.status);
    }

    const decidedStatus: ApprovalStatus = params.approve ? "APPROVED" : "REJECTED";
    const before = auditSnapshot(request);

    const decided = await tx.discountRequest.update({
      where: { id: request.id },
      data: {
        status: decidedStatus,
        decidedById: actorId,
        decidedAt: now,
        decisionNote: params.decisionNote,
      },
    });

    // Approval writes the amount onto the booking. confirmBooking already
    // reads booking.discountAmount off the row at confirm time (it re-runs
    // computeCostSheet against whatever is there, never a cached value) --
    // no change needed there, this is the only place discountAmount moves.
    if (params.approve) {
      await tx.booking.update({
        where: { id: booking.id },
        data: { discountAmount: request.amount },
      });
    }

    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "DiscountRequest",
      entityId: decided.id,
      before,
      after: auditSnapshot(decided),
      reason: params.decisionNote,
    });

    return decided;
  });
}

// ── Read ───────────────────────────────────────────────────────────────

export interface PendingDiscountRequestRow extends DiscountRequest {
  booking: { id: string; bookingNumber: string; projectId: string };
}

export interface ListPendingDiscountRequestsParams {
  orgId: string;
  actorId: string;
}

/** Phase 3.5 Slice 10 -- confirmed gap, no queue view existed (decideDiscount
 *  only acts on a request whose id you already have). Returns exactly the
 *  requests this actor could act on: PENDING, not their own request
 *  (decideDiscount throws SelfApprovalError otherwise), and within the band
 *  resolveApproverRoles resolves for that request's pctOfBase -- the same
 *  three checks decideDiscount itself enforces, applied here as a filter
 *  instead of a thrown error. */
export async function listPendingDiscountRequests(
  db: PrismaClient,
  params: ListPendingDiscountRequestsParams,
): Promise<PendingDiscountRequestRow[]> {
  await assertPermission(db, params.actorId, APPROVE_PERMISSION);

  const roles = await db.userRole.findMany({
    where: { userId: params.actorId },
    select: { role: { select: { code: true } } },
  });
  const actorRoleCodes = new Set(roles.map((r) => r.role.code));

  const requests = await db.discountRequest.findMany({
    where: { status: "PENDING", requestedById: { not: params.actorId }, booking: { orgId: params.orgId } },
    include: { booking: { select: { id: true, bookingNumber: true, projectId: true } } },
    orderBy: { createdAt: "asc" },
  });

  return requests.filter((request) => resolveApproverRoles(request.pctOfBase).some((role) => actorRoleCodes.has(role)));
}
