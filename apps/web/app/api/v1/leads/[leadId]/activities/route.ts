// Log a lead activity -- POST /leads/:id/activities in docs/07-API.md.
// type: STAGE_CHANGE also moves Lead.stage (the activity log IS the stage
// history). Thin; every real guard lives in packages/services/src/leads.ts.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import {
  LeadNotFoundError,
  StageChangeRequiresToStageError,
  logActivity,
  type ActivityType,
  type LeadActivity,
  type LeadStage,
} from "@desire/services/leads";

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

function serialize(activity: LeadActivity) {
  return {
    id: activity.id,
    leadId: activity.leadId,
    associateId: activity.associateId,
    type: activity.type,
    subject: activity.subject,
    notes: activity.notes,
    outcome: activity.outcome,
    fromStage: activity.fromStage,
    toStage: activity.toStage,
    dueAt: activity.dueAt?.toISOString() ?? null,
    completedAt: activity.completedAt?.toISOString() ?? null,
    createdAt: activity.createdAt.toISOString(),
  };
}

interface LogActivityBody {
  type?: unknown;
  subject?: unknown;
  notes?: unknown;
  outcome?: unknown;
  toStage?: unknown;
  dueAt?: unknown;
  completedAt?: unknown;
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

  let body: LogActivityBody;
  try {
    body = (await request.json()) as LogActivityBody;
  } catch {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "Request body must be valid JSON.", instance: url.pathname,
    });
  }
  if (typeof body.type !== "string") {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "type (string) is required.", instance: url.pathname,
    });
  }

  try {
    const activity = await logActivity(db, {
      leadId,
      type: body.type as ActivityType,
      subject: typeof body.subject === "string" ? body.subject : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      outcome: typeof body.outcome === "string" ? body.outcome : undefined,
      toStage: typeof body.toStage === "string" ? (body.toStage as LeadStage) : undefined,
      dueAt: typeof body.dueAt === "string" ? new Date(body.dueAt) : undefined,
      completedAt: typeof body.completedAt === "string" ? new Date(body.completedAt) : undefined,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json(serialize(activity), { status: 201 });
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
    if (error instanceof StageChangeRequiresToStageError) {
      return problemResponse({
        status: 422, type: "stage-change-requires-to-stage", title: "toStage required",
        detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
