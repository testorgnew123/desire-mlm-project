// Approve a payout batch -- POST /payout-batches/:id/approve. "Rejects if
// actor is the preparer" (docs/07-API.md). Closes the backend gap named in
// the Phase 3.5 plan (Slice 14): approveBatch has existed since Phase 3
// with zero HTTP route.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import {
  PayoutBatchNotApprovableError,
  PayoutBatchNotFoundError,
  PayoutMakerCheckerViolationError,
  approveBatch,
} from "@desire/services/payouts";
import { readSessionToken } from "@/lib/api-session";

export const dynamic = "force-dynamic";

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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> },
) {
  const { batchId } = await params;
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
    const batch = await approveBatch(db, {
      batchId,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json({ id: batch.id, status: batch.status, approvedById: batch.approvedById }, { status: 200 });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof PayoutMakerCheckerViolationError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof PayoutBatchNotFoundError) {
      return problemResponse({
        status: 404, type: "batch-not-found", title: "Not Found", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof PayoutBatchNotApprovableError) {
      return problemResponse({
        status: 409, type: "batch-not-approvable", title: "Conflict", detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
