// Grade master creation -- POST /grades. Closes the backend gap named in
// the Phase 3.5 plan (Slice 12): createGrade has existed since Phase 3 with
// zero HTTP route. Thin handler; every real guard (permission, unique code)
// lives in packages/services/src/grades.ts, untouched here.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import { DuplicateGradeCodeError, createGrade, type Grade } from "@desire/services/grades";
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

interface CreateGradeBody {
  code?: unknown;
  name?: unknown;
  rank?: unknown;
  description?: unknown;
  minCumulativeSalesValue?: unknown;
  minBookingsInPeriod?: unknown;
  minTeamSize?: unknown;
  minTenureMonths?: unknown;
  holdQuota?: unknown;
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

  let body: CreateGradeBody;
  try {
    body = (await request.json()) as CreateGradeBody;
  } catch {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "Request body must be valid JSON.", instance: url.pathname,
    });
  }
  if (typeof body.code !== "string" || typeof body.name !== "string" || typeof body.rank !== "number") {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "code (string), name (string) and rank (number) are required.", instance: url.pathname,
    });
  }

  try {
    const grade = await createGrade(db, {
      code: body.code,
      name: body.name,
      rank: body.rank,
      description: typeof body.description === "string" ? body.description : undefined,
      minCumulativeSalesValue: typeof body.minCumulativeSalesValue === "string" ? body.minCumulativeSalesValue : undefined,
      minBookingsInPeriod: typeof body.minBookingsInPeriod === "number" ? body.minBookingsInPeriod : undefined,
      minTeamSize: typeof body.minTeamSize === "number" ? body.minTeamSize : undefined,
      minTenureMonths: typeof body.minTenureMonths === "number" ? body.minTenureMonths : undefined,
      holdQuota: typeof body.holdQuota === "number" ? body.holdQuota : undefined,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json(serialize(grade), { status: 201 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof DuplicateGradeCodeError) {
      return problemResponse({
        status: 409, type: "duplicate-grade-code", title: "Conflict", detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
