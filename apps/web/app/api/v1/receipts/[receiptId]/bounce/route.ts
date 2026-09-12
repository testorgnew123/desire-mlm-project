// Bounce a receipt -- POST /receipts/:id/bounce. Reverses allocations and
// released commission (docs/07-API.md). Thin; every real guard lives in
// packages/services/src/receipts.ts's bounceReceipt.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import {
  BounceReasonRequiredError,
  InvalidReceiptStateError,
  ReceiptNotFoundError,
  bounceReceipt,
  type Receipt,
} from "@desire/services/receipts";

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

function serialize(receipt: Receipt) {
  return {
    id: receipt.id,
    status: receipt.status,
    bouncedOn: receipt.bouncedOn?.toISOString() ?? null,
    bounceReason: receipt.bounceReason,
  };
}

interface BounceReceiptBody {
  bounceReason?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ receiptId: string }> },
) {
  const { receiptId } = await params;
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

  let body: BounceReceiptBody;
  try {
    body = (await request.json()) as BounceReceiptBody;
  } catch {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "Request body must be valid JSON.", instance: url.pathname,
    });
  }
  if (typeof body.bounceReason !== "string") {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "bounceReason (string) is required.", instance: url.pathname,
    });
  }

  try {
    const bounced = await bounceReceipt(db, {
      receiptId,
      bounceReason: body.bounceReason,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json(serialize(bounced), { status: 200 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof ReceiptNotFoundError) {
      return problemResponse({
        status: 404, type: "receipt-not-found", title: "Not Found", detail: "No such receipt.", instance: url.pathname,
      });
    }
    if (error instanceof InvalidReceiptStateError) {
      return problemResponse({
        status: 409, type: "invalid-receipt-state", title: "Receipt cannot be bounced",
        detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof BounceReasonRequiredError) {
      return problemResponse({
        status: 422, type: "bounce-reason-required", title: "Reason required",
        detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
