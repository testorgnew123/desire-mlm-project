// Enter a receipt -- POST /receipts in docs/07-API.md. Thin; every real
// guard lives in packages/services/src/receipts.ts.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import { enterReceipt, type Receipt } from "@desire/services/receipts";

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
    bookingId: receipt.bookingId,
    receiptNumber: receipt.receiptNumber,
    amount: receipt.amount.toString(),
    mode: receipt.mode,
    status: receipt.status,
    instrumentNumber: receipt.instrumentNumber,
    drawnOnBank: receipt.drawnOnBank,
    depositedToBank: receipt.depositedToBank,
    receivedOn: receipt.receivedOn.toISOString(),
    enteredById: receipt.enteredById,
    createdAt: receipt.createdAt.toISOString(),
  };
}

interface EnterReceiptBody {
  bookingId?: unknown;
  amount?: unknown;
  mode?: unknown;
  instrumentNumber?: unknown;
  instrumentDate?: unknown;
  drawnOnBank?: unknown;
  depositedToBank?: unknown;
  receivedOn?: unknown;
  remarks?: unknown;
}

export async function POST(request: Request) {
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

  let body: EnterReceiptBody;
  try {
    body = (await request.json()) as EnterReceiptBody;
  } catch {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "Request body must be valid JSON.", instance: url.pathname,
    });
  }
  if (
    typeof body.bookingId !== "string" ||
    typeof body.amount !== "string" ||
    typeof body.mode !== "string" ||
    typeof body.receivedOn !== "string"
  ) {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "bookingId, amount, mode and receivedOn are required strings.", instance: url.pathname,
    });
  }

  try {
    const receipt = await enterReceipt(db, {
      bookingId: body.bookingId,
      amount: body.amount,
      mode: body.mode as Receipt["mode"],
      instrumentNumber: typeof body.instrumentNumber === "string" ? body.instrumentNumber : undefined,
      instrumentDate: typeof body.instrumentDate === "string" ? new Date(body.instrumentDate) : undefined,
      drawnOnBank: typeof body.drawnOnBank === "string" ? body.drawnOnBank : undefined,
      depositedToBank: typeof body.depositedToBank === "string" ? body.depositedToBank : undefined,
      receivedOn: new Date(body.receivedOn),
      remarks: typeof body.remarks === "string" ? body.remarks : undefined,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json(serialize(receipt), { status: 201 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
