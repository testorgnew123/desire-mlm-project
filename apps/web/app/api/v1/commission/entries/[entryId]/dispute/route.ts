// Raise a dispute -- POST /commission/entries/:id/dispute (docs/07-API.md).
// Closes the backend gap named in the Phase 3.5 plan (Slice 13):
// raiseDispute has existed since Phase 3 with zero HTTP route. Thin
// handler; every real guard (scope, ON_HOLD transition) lives in
// packages/services/src/commission.ts, untouched here.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import { CommissionEntryNotFoundError, DuplicateDisputeError, raiseDispute } from "@desire/services/commission";
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

interface RaiseDisputeBody {
  description?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ entryId: string }> },
) {
  const { entryId } = await params;
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

  let body: RaiseDisputeBody;
  try {
    body = (await request.json()) as RaiseDisputeBody;
  } catch {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "Request body must be valid JSON.", instance: url.pathname,
    });
  }
  if (typeof body.description !== "string" || body.description.trim() === "") {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "description (non-empty string) is required.", instance: url.pathname,
    });
  }

  try {
    const result = await raiseDispute(db, {
      entryId,
      description: body.description,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof CommissionEntryNotFoundError) {
      return problemResponse({
        status: 404, type: "entry-not-found", title: "Not Found", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof DuplicateDisputeError) {
      return problemResponse({
        status: 409, type: "duplicate-dispute", title: "Conflict", detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
