// Payout batches: GET list, POST prepare a new one -- docs/07-API.md's
// "Opens a period; freezes tree and grade changes". Closes the backend gap
// named in the Phase 3.5 plan (Slice 14): prepareBatch has existed since
// Phase 3 with zero HTTP route, and no list ever existed at all. Thin
// handlers; every real guard lives in packages/services/src/payouts.ts.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import {
  DuplicatePayoutPeriodError,
  NoTaxRateConfiguredError,
  type PayoutBatch,
  listPayoutBatches,
  prepareBatch,
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

function serialize(batch: PayoutBatch) {
  return {
    id: batch.id,
    batchNumber: batch.batchNumber,
    periodStart: batch.periodStart.toISOString(),
    periodEnd: batch.periodEnd.toISOString(),
    status: batch.status,
    totalNetPayable: batch.totalNetPayable.toString(),
    preparedById: batch.preparedById,
    approvedById: batch.approvedById,
  };
}

export async function GET(request: Request) {
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
    const batches = await listPayoutBatches(db, { orgId: session.user.orgId, actorId: session.userId });
    return Response.json(batches.map(serialize), { status: 200 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}

interface PrepareBatchBody {
  periodStart?: unknown;
  periodEnd?: unknown;
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

  let body: PrepareBatchBody;
  try {
    body = (await request.json()) as PrepareBatchBody;
  } catch {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "Request body must be valid JSON.", instance: url.pathname,
    });
  }
  if (typeof body.periodStart !== "string" || typeof body.periodEnd !== "string") {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "periodStart and periodEnd (ISO 8601 strings) are required.", instance: url.pathname,
    });
  }

  try {
    const result = await prepareBatch(db, {
      orgId: session.user.orgId,
      periodStart: new Date(body.periodStart),
      periodEnd: new Date(body.periodEnd),
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json(
      { batchId: result.batchId, batchNumber: result.batchNumber, lineCount: result.lineCount, totalNetPayable: result.totalNetPayable.toString() },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof DuplicatePayoutPeriodError) {
      return problemResponse({
        status: 409, type: "duplicate-payout-period", title: "Conflict", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof NoTaxRateConfiguredError) {
      return problemResponse({
        status: 422, type: "no-tax-rate-configured", title: "Unprocessable", detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
