// Payout batch detail -- GET /payout-batches/:id (docs/07-API.md). Not
// named in the Phase 3.5 plan's own route list for this slice, but the
// screen list ("Batches list/detail") and the documented API surface both
// need it, so it is added alongside the three the plan did name.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import { getPayoutBatch } from "@desire/services/payouts";
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

export async function GET(
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

  let batch;
  try {
    batch = await getPayoutBatch(db, { batchId, orgId: session.user.orgId, actorId: session.userId });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }

  if (batch === null) {
    return problemResponse({
      status: 404, type: "batch-not-found", title: "Not Found", detail: "No such payout batch.", instance: url.pathname,
    });
  }

  return Response.json(
    {
      id: batch.id,
      batchNumber: batch.batchNumber,
      periodStart: batch.periodStart.toISOString(),
      periodEnd: batch.periodEnd.toISOString(),
      status: batch.status,
      totalNetPayable: batch.totalNetPayable.toString(),
      lines: batch.lines.map((line) => ({
        associateId: line.associateId,
        associateCode: line.associate.code,
        associateName: line.associate.user.name,
        grossAmount: line.grossAmount.toString(),
        tdsAmount: line.tdsAmount.toString(),
        gstAmount: line.gstAmount.toString(),
        netPayable: line.netPayable.toString(),
      })),
    },
    { status: 200 },
  );
}
