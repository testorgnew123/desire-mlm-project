// Approve or reject a discount request -- the maker-checker + band-membership
// GATE lives entirely in packages/services/src/discounts.ts's decideDiscount.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import {
  DiscountRequestNotFoundError,
  DiscountRequestNotPendingError,
  SelfApprovalError,
  decideDiscount,
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
    status: request.status,
    decidedById: request.decidedById,
    decidedAt: request.decidedAt?.toISOString() ?? null,
    decisionNote: request.decisionNote,
  };
}

interface DecideBody {
  approve?: unknown;
  decisionNote?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ discountRequestId: string }> },
) {
  const { discountRequestId } = await params;
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

  let body: DecideBody;
  try {
    body = (await request.json()) as DecideBody;
  } catch {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "Request body must be valid JSON.", instance: url.pathname,
    });
  }
  if (typeof body.approve !== "boolean") {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "approve (boolean) is required.", instance: url.pathname,
    });
  }

  try {
    const decided = await decideDiscount(db, {
      discountRequestId,
      approve: body.approve,
      decisionNote: typeof body.decisionNote === "string" ? body.decisionNote : undefined,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json(serialize(decided), { status: 200 });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof SelfApprovalError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof DiscountRequestNotFoundError) {
      return problemResponse({
        status: 404, type: "discount-request-not-found", title: "Not Found",
        detail: "No such discount request.", instance: url.pathname,
      });
    }
    if (error instanceof DiscountRequestNotPendingError) {
      return problemResponse({
        status: 409, type: "discount-request-not-pending", title: "Already decided",
        detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
