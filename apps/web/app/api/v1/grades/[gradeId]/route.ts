// Grade master update -- PATCH /grades/:gradeId. Closes the same backend gap
// as POST /grades (Phase 3.5 Slice 12): updateGrade has existed since Phase
// 3 with zero HTTP route. code and rank are not patchable, same as
// updateGrade itself (both are stable identifiers other rows key off).
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import { GradeNotFoundError, updateGrade, type Grade } from "@desire/services/grades";
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

function serialize(grade: Grade) {
  return {
    id: grade.id,
    code: grade.code,
    name: grade.name,
    rank: grade.rank,
    isActive: grade.isActive,
    holdQuota: grade.holdQuota,
  };
}

interface UpdateGradeBody {
  name?: unknown;
  description?: unknown;
  isActive?: unknown;
  minCumulativeSalesValue?: unknown;
  minBookingsInPeriod?: unknown;
  minTeamSize?: unknown;
  minTenureMonths?: unknown;
  holdQuota?: unknown;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ gradeId: string }> },
) {
  const { gradeId } = await params;
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

  let body: UpdateGradeBody;
  try {
    body = (await request.json()) as UpdateGradeBody;
  } catch {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "Request body must be valid JSON.", instance: url.pathname,
    });
  }

  try {
    const grade = await updateGrade(db, {
      gradeId,
      name: typeof body.name === "string" ? body.name : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
      minCumulativeSalesValue: typeof body.minCumulativeSalesValue === "string" ? body.minCumulativeSalesValue : undefined,
      minBookingsInPeriod: typeof body.minBookingsInPeriod === "number" ? body.minBookingsInPeriod : undefined,
      minTeamSize: typeof body.minTeamSize === "number" ? body.minTeamSize : undefined,
      minTenureMonths: typeof body.minTenureMonths === "number" ? body.minTenureMonths : undefined,
      holdQuota: typeof body.holdQuota === "number" ? body.holdQuota : undefined,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json(serialize(grade), { status: 200 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof GradeNotFoundError) {
      return problemResponse({
        status: 404, type: "grade-not-found", title: "Not Found", detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
