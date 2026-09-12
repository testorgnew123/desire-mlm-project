// The maker-checker verify GATE -- POST /receipts/:id/verify. "The highest-
// value control in the system" (docs/10-SECURITY.md). Thin; every real
// assertion lives in packages/services/src/receipts.ts's verifyReceipt.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import {
  InvalidReceiptStateError,
  ReceiptNotFoundError,
  SameEntererVerifierError,
  SellerOrUplineVerifyError,
  verifyReceipt,
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
    verifiedById: receipt.verifiedById,
    verifiedAt: receipt.verifiedAt?.toISOString() ?? null,
  };
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

  try {
    const verified = await verifyReceipt(db, {
      receiptId,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json(serialize(verified), { status: 200 });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof SameEntererVerifierError || error instanceof SellerOrUplineVerifyError) {
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
        status: 409, type: "invalid-receipt-state", title: "Receipt cannot be verified",
        detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
