// Request a discount on a DRAFT booking -- POST /bookings/:id/discount-request
// in docs/07-API.md ("Routed by the approval matrix"). Thin route; every real
// guard (band resolution, DRAFT-only, permission) lives in
// packages/services/src/discounts.ts.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import {
  BookingNotDraftForDiscountError,
  InvalidDiscountBandError,
  requestDiscount,
  type DiscountRequest,
} from "@desire/services/discounts";

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

function serialize(request: DiscountRequest) {
  return {
    id: request.id,
    bookingId: request.bookingId,
    requestedById: request.requestedById,
    amount: request.amount.toString(),
    pctOfBase: request.pctOfBase.toString(),
    justification: request.justification,
    status: request.status,
    approverRoleCode: request.approverRoleCode,
    createdAt: request.createdAt.toISOString(),
  };
}

interface RequestDiscountBody {
  amount?: unknown;
  pctOfBase?: unknown;
  justification?: unknown;
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

  let body: RequestDiscountBody;
  try {
    body = (await request.json()) as RequestDiscountBody;
  } catch {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "Request body must be valid JSON.", instance: url.pathname,
    });
  }
  if (typeof body.amount !== "string" || typeof body.pctOfBase !== "string" || typeof body.justification !== "string") {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "amount, pctOfBase and justification are required strings.", instance: url.pathname,
    });
  }

  try {
    const created = await requestDiscount(db, {
      bookingId,
      amount: body.amount,
      pctOfBase: body.pctOfBase,
      justification: body.justification,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json(serialize(created), { status: 201 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof BookingNotDraftForDiscountError) {
      return problemResponse({
        status: 409, type: "booking-not-draft", title: "Booking not in DRAFT",
        detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof InvalidDiscountBandError) {
      return problemResponse({
        status: 422, type: "invalid-discount-band", title: "Invalid discount",
        detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
