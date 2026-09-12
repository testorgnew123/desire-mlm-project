// The confirm GATE -- POST /bookings/:id/confirm in docs/07-API.md ("Freezes
// cost sheet, agreement value, commissionable value. Triggers accrual" --
// accrual itself is Phase 3 territory and not wired here yet). Thin route;
// every real guard lives in packages/services/src/bookings.ts's confirmBooking.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import {
  BookingNotFoundError,
  HeldByAnotherAssociateError,
  InvalidBookingStateError,
  UnitNotHeldError,
  confirmBooking,
  type ConfirmBookingResult,
} from "@desire/services/bookings";

export const dynamic = "force-dynamic";

const SESSION_COOKIE_NAME = "desire_session";

function problemResponse(params: {
  status: number;
  type: string;
  title: string;
  detail: string;
  instance: string;
}): Response {
  return Response.json(
    {
      type: `https://docs.internal/errors/${params.type}`,
      title: params.title,
      status: params.status,
      detail: params.detail,
      instance: params.instance,
    },
    { status: params.status, headers: { "content-type": "application/problem+json" } },
  );
}

function readSessionToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const separator = authorization.indexOf(" ");
    if (separator !== -1 && authorization.slice(0, separator).toLowerCase() === "bearer") {
      const token = authorization.slice(separator + 1).trim();
      if (token !== "") return token;
    }
  }

  const cookieHeader = request.headers.get("cookie");
  if (cookieHeader === null) return null;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = pair.slice(separator + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

function serializeConfirmed(booking: ConfirmBookingResult) {
  return {
    id: booking.id,
    projectId: booking.projectId,
    unitId: booking.unitId,
    customerId: booking.customerId,
    bookingNumber: booking.bookingNumber,
    bookingDate: booking.bookingDate.toISOString(),
    status: booking.status,
    sellingAssociateId: booking.sellingAssociateId,
    priceListId: booking.priceListId,
    baseAmount: booking.baseAmount.toString(),
    plcAmount: booking.plcAmount.toString(),
    otherChargesAmount: booking.otherChargesAmount.toString(),
    discountAmount: booking.discountAmount.toString(),
    gstAmount: booking.gstAmount.toString(),
    stampDutyAmount: booking.stampDutyAmount.toString(),
    registrationAmount: booking.registrationAmount.toString(),
    agreementValue: booking.agreementValue.toString(),
    commissionableValue: booking.commissionableValue.toString(),
    confirmedAt: booking.confirmedAt?.toISOString() ?? null,
    costSheetLines: booking.costSheetLines.map((line) => ({
      chargeHeadCode: line.chargeHeadCode,
      description: line.description,
      quantity: line.quantity?.toString() ?? null,
      rate: line.rate?.toString() ?? null,
      amount: line.amount.toString(),
      gstRatePct: line.gstRatePct?.toString() ?? null,
      gstAmount: line.gstAmount.toString(),
      countsTowardCommission: line.countsTowardCommission,
      displayOrder: line.displayOrder,
    })),
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookingId: string }> },
) {
  const { bookingId } = await params;
  const url = new URL(request.url);

  const token = readSessionToken(request);
  if (token === null) {
    return problemResponse({
      status: 401,
      type: "unauthenticated",
      title: "Unauthenticated",
      detail: "A session cookie or bearer token is required.",
      instance: url.pathname,
    });
  }

  const db = getPrismaClient();

  let session;
  try {
    session = await validateSession(db, token);
  } catch (error) {
    if (error instanceof SessionInvalidError) {
      return problemResponse({
        status: 401,
        type: "session-invalid",
        title: "Unauthenticated",
        detail: "The session is unknown, revoked or expired.",
        instance: url.pathname,
      });
    }
    throw error;
  }

  try {
    const confirmed = await confirmBooking(db, {
      bookingId,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });

    const auditId = await db.auditLog
      .findFirst({
        where: { entity: "Booking", entityId: confirmed.id, action: "UPDATE" },
        select: { id: true },
        orderBy: { createdAt: "desc" },
      })
      .then((row) => row?.id ?? null);

    return Response.json({ ...serializeConfirmed(confirmed), auditId }, { status: 200 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403,
        type: "forbidden",
        title: "Forbidden",
        detail: error.message,
        instance: url.pathname,
      });
    }
    if (error instanceof BookingNotFoundError) {
      return problemResponse({
        status: 404,
        type: "booking-not-found",
        title: "Not Found",
        detail: "No such booking.",
        instance: url.pathname,
      });
    }
    if (error instanceof InvalidBookingStateError) {
      return problemResponse({
        status: 409,
        type: "invalid-booking-state",
        title: "Booking cannot be confirmed",
        detail: error.message,
        instance: url.pathname,
      });
    }
    if (error instanceof UnitNotHeldError || error instanceof HeldByAnotherAssociateError) {
      return problemResponse({
        status: 409,
        type: "unit-not-available-for-booking",
        title: "Unit no longer available",
        detail: error.message,
        instance: url.pathname,
      });
    }
    throw error;
  }
}
