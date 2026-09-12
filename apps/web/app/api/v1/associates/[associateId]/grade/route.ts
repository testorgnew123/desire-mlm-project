// Assign a grade -- POST /associates/:id/grade. "Effective-dated. Approval
// required" (docs/07-API.md). Thin; every real guard (close-and-insert,
// never update) lives in packages/services/src/grades.ts's assignGrade.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import {
  AssociateNotFoundError,
  GradeNotFoundError,
  assignGrade,
  type AssociateGrade,
} from "@desire/services/grades";

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

function serialize(assignment: AssociateGrade) {
  return {
    id: assignment.id,
    associateId: assignment.associateId,
    gradeId: assignment.gradeId,
    validFrom: assignment.validFrom.toISOString(),
    reason: assignment.reason,
  };
}

interface AssignGradeBody {
  gradeId?: unknown;
  reason?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ associateId: string }> },
) {
  const { associateId } = await params;
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

  let body: AssignGradeBody;
  try {
    body = (await request.json()) as AssignGradeBody;
  } catch {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "Request body must be valid JSON.", instance: url.pathname,
    });
  }
  if (typeof body.gradeId !== "string") {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "gradeId (string) is required.", instance: url.pathname,
    });
  }

  try {
    const assignment = await assignGrade(db, {
      associateId,
      gradeId: body.gradeId,
      reason: typeof body.reason === "string" ? body.reason : undefined,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json(serialize(assignment), { status: 201 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof AssociateNotFoundError || error instanceof GradeNotFoundError) {
      return problemResponse({
        status: 404, type: "not-found", title: "Not Found", detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
