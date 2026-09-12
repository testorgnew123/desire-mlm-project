// Schedule a site visit -- POST /leads/:id/site-visits in docs/07-API.md.
// Thin; every real guard lives in packages/services/src/leads.ts. There is
// no completion route yet -- see completeSiteVisit's own doc comment.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import { LeadNotFoundError, scheduleSiteVisit, type SiteVisit } from "@desire/services/leads";

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

function serialize(visit: SiteVisit) {
  return {
    id: visit.id,
    leadId: visit.leadId,
    projectId: visit.projectId,
    associateId: visit.associateId,
    scheduledAt: visit.scheduledAt.toISOString(),
    createdAt: visit.createdAt.toISOString(),
  };
}

interface ScheduleSiteVisitBody {
  projectId?: unknown;
  scheduledAt?: unknown;
  assignToAssociateId?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ leadId: string }> },
) {
  const { leadId } = await params;
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

  let body: ScheduleSiteVisitBody;
  try {
    body = (await request.json()) as ScheduleSiteVisitBody;
  } catch {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "Request body must be valid JSON.", instance: url.pathname,
    });
  }
  if (typeof body.projectId !== "string" || typeof body.scheduledAt !== "string") {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "projectId and scheduledAt (ISO date string) are required.", instance: url.pathname,
    });
  }

  try {
    const visit = await scheduleSiteVisit(db, {
      leadId,
      projectId: body.projectId,
      scheduledAt: new Date(body.scheduledAt),
      assignToAssociateId: typeof body.assignToAssociateId === "string" ? body.assignToAssociateId : undefined,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json(serialize(visit), { status: 201 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof LeadNotFoundError) {
      return problemResponse({
        status: 404, type: "lead-not-found", title: "Not Found", detail: "No such lead.", instance: url.pathname,
      });
    }
    throw error;
  }
}
