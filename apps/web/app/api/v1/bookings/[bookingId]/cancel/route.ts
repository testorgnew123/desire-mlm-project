// Cancel a CONFIRMED booking -- POST /bookings/:id/cancel (docs/06-INVENTORY-SPEC.md).
// "Approval required" is booking.cancel's already-narrow SUPER_ADMIN/SALES_HEAD
// grant plus a mandatory reason -- not a separate approval workflow. Every real
// guard (permission, status, the clawback itself) lives in
// packages/services/src/bookings.ts's cancelBooking.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import {
  BookingNotCancellableError,
  BookingNotFoundError,
  CancellationReasonRequiredError,
  cancelBooking,
  type CancelBookingResult,
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

function serialize(booking: CancelBookingResult) {
  return {
    id: booking.id,
    status: booking.status,
    cancelledAt: booking.cancelledAt?.toISOString() ?? null,
    cancelledById: booking.cancelledById,
    cancellationReason: booking.cancellationReason,
    clawback: booking.clawback,
  };
}

interface CancelBody {
  reason?: unknown;
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
      status: 401, type: "unauthenticated", title: "Unauthenticated",
      detail: "A session cookie or bearer token is required.", instance: url.pathname,
    });
  }

  const db = getPrismaClient();

  let session;
  try {
    session = await validateSession(db, token);
  } catch (error) {
    if (error instanceof SessionInvalidError) {
      return problemResponse({
        status: 401, type: "session-invalid", title: "Unauthenticated",
        detail: "The session is unknown, revoked or expired.", instance: url.pathname,
      });
    }
    throw error;
  }

  let body: CancelBody;
  try {
    body = (await request.json()) as CancelBody;
  } catch {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "Request body must be valid JSON.", instance: url.pathname,
    });
  }
  if (typeof body.reason !== "string") {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "reason (string) is required.", instance: url.pathname,
    });
  }

  try {
    const cancelled = await cancelBooking(db, {
      bookingId,
      reason: body.reason,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json(serialize(cancelled), { status: 200 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof BookingNotFoundError) {
      return problemResponse({
        status: 404, type: "booking-not-found", title: "Not Found",
        detail: "No such booking.", instance: url.pathname,
      });
    }
    if (error instanceof BookingNotCancellableError) {
      return problemResponse({
        status: 409, type: "booking-not-cancellable", title: "Booking cannot be cancelled",
        detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof CancellationReasonRequiredError) {
      return problemResponse({
        status: 422, type: "cancellation-reason-required", title: "Reason required",
        detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
