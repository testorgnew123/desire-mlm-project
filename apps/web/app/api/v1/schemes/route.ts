// Commission scheme creation -- POST /schemes. Closes the backend gap named
// in the Phase 3.5 plan (Slice 7): createScheme has existed since Phase 3
// with zero HTTP route. Thin handler; every real guard (permission,
// maker-checker, duplicate rates, version allocation) lives in
// packages/services/src/schemes.ts, untouched here.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import {
  DuplicateGradeRateError,
  DuplicateLevelRateError,
  SchemeProjectNotFoundError,
  SchemeVersionConflictError,
  createScheme,
  type GradeRateInput,
  type LevelRateInput,
} from "@desire/services/schemes";
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

interface CreateSchemeBody {
  projectId?: unknown;
  name?: unknown;
  validFrom?: unknown;
  baseDefinition?: unknown;
  maxLevel?: unknown;
  compressionMode?: unknown;
  maxTotalPct?: unknown;
  eligibilityRules?: unknown;
  gradeRates?: unknown;
  levelRates?: unknown;
}

function parseGradeRates(value: unknown): GradeRateInput[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parsed: GradeRateInput[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const { gradeId, rateType, rateValue } = item as Record<string, unknown>;
    if (typeof gradeId !== "string" || typeof rateValue !== "string") return null;
    if (rateType !== undefined && rateType !== "PCT_OF_BASE" && rateType !== "PER_SQFT" && rateType !== "FLAT") {
      return null;
    }
    parsed.push({ gradeId, rateValue, rateType });
  }
  return parsed;
}

function parseLevelRates(value: unknown): LevelRateInput[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const parsed: LevelRateInput[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const { level, pctOfSellerCommission } = item as Record<string, unknown>;
    if (typeof level !== "number" || typeof pctOfSellerCommission !== "string") return null;
    parsed.push({ level, pctOfSellerCommission });
  }
  return parsed;
}

export async function POST(request: Request) {
  const url = new URL(request.url);

  const token = readSessionToken(request);
  if (token === null) {
    return problemResponse({
      status: 401,
      type: "unauthenticated",
      title: "Unauthenticated",
      detail: "A session cookie or bearer token is required.",
      instance: url.pathname,
    });
  }

  const db = getPrismaClient();

  let session;
  try {
    session = await validateSession(db, token);
  } catch (error) {
    if (error instanceof SessionInvalidError) {
      return problemResponse({
        status: 401,
        type: "session-invalid",
        title: "Unauthenticated",
        detail: "The session is unknown, revoked or expired.",
        instance: url.pathname,
      });
    }
    throw error;
  }

  let body: CreateSchemeBody;
  try {
    body = (await request.json()) as CreateSchemeBody;
  } catch {
    return problemResponse({
      status: 400,
      type: "invalid-body",
      title: "Invalid request body",
      detail: "Request body must be valid JSON.",
      instance: url.pathname,
    });
  }

  const gradeRates = parseGradeRates(body.gradeRates);
  const levelRates = parseLevelRates(body.levelRates);

  if (
    typeof body.projectId !== "string" ||
    typeof body.name !== "string" ||
    typeof body.validFrom !== "string" ||
    typeof body.maxTotalPct !== "string" ||
    typeof body.baseDefinition !== "object" ||
    body.baseDefinition === null ||
    gradeRates === null ||
    levelRates === null
  ) {
    return problemResponse({
      status: 400,
      type: "invalid-body",
      title: "Invalid request body",
      detail:
        "projectId, name, validFrom, maxTotalPct, baseDefinition (object) and a non-empty gradeRates array (each {gradeId, rateValue, rateType?}) are required; levelRates, if present, is an array of {level, pctOfSellerCommission}.",
      instance: url.pathname,
    });
  }

  try {
    const result = await createScheme(db, {
      projectId: body.projectId,
      name: body.name,
      validFrom: new Date(body.validFrom),
      baseDefinition: body.baseDefinition as Record<string, unknown>,
      maxLevel: typeof body.maxLevel === "number" ? body.maxLevel : undefined,
      compressionMode: body.compressionMode === "ROLL_UP" ? "ROLL_UP" : undefined,
      maxTotalPct: body.maxTotalPct,
      eligibilityRules:
        typeof body.eligibilityRules === "object" && body.eligibilityRules !== null
          ? (body.eligibilityRules as Record<string, unknown>)
          : undefined,
      gradeRates,
      levelRates,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });

    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403,
        type: "forbidden",
        title: "Forbidden",
        detail: error.message,
        instance: url.pathname,
      });
    }
    if (error instanceof SchemeProjectNotFoundError) {
      return problemResponse({
        status: 404,
        type: "project-not-found",
        title: "Not Found",
        detail: error.message,
        instance: url.pathname,
      });
    }
    if (error instanceof DuplicateGradeRateError || error instanceof DuplicateLevelRateError) {
      return problemResponse({
        status: 422,
        type: "duplicate-rate",
        title: "Duplicate rate",
        detail: error.message,
        instance: url.pathname,
      });
    }
    if (error instanceof SchemeVersionConflictError) {
      return problemResponse({
        status: 409,
        type: "version-conflict",
        title: "Conflict",
        detail: error.message,
        instance: url.pathname,
      });
    }
    throw error;
  }
}
