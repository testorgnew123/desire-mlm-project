// Resolve a dispute -- POST /commission/disputes/:id/resolve. Closes the
// same backend gap as the dispute-raise route (Phase 3.5 Slice 13):
// resolveDispute has existed since Phase 3 with zero HTTP route. Thin
// handler; every real guard (restore-prior-status, the one Adjustment row
// an approval creates) lives in packages/services/src/commission.ts.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import { CommissionDisputeNotFoundError, DisputeAlreadyResolvedError, resolveDispute } from "@desire/services/commission";
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

interface ResolveDisputeBody {
  resolution?: unknown;
  resolutionNote?: unknown;
  adjustmentAmount?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ disputeId: string }> },
) {
  const { disputeId } = await params;
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

  let body: ResolveDisputeBody;
  try {
    body = (await request.json()) as ResolveDisputeBody;
  } catch {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "Request body must be valid JSON.", instance: url.pathname,
    });
  }
  if (body.resolution !== "APPROVED" && body.resolution !== "REJECTED") {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: 'resolution ("APPROVED" or "REJECTED") is required.', instance: url.pathname,
    });
  }

  try {
    const result = await resolveDispute(db, {
      disputeId,
      resolution: body.resolution,
      resolutionNote: typeof body.resolutionNote === "string" ? body.resolutionNote : undefined,
      adjustmentAmount: typeof body.adjustmentAmount === "string" ? body.adjustmentAmount : undefined,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof CommissionDisputeNotFoundError) {
      return problemResponse({
        status: 404, type: "dispute-not-found", title: "Not Found", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof DisputeAlreadyResolvedError) {
      return problemResponse({
        status: 409, type: "dispute-already-resolved", title: "Conflict", detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
