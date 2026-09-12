// List / create leads -- GET POST /leads in docs/07-API.md ("Create runs
// dedup on phoneHash; returns a conflict if a live claim exists"). Thin;
// every real guard (dedup, scope, the claim itself) lives in
// packages/services/src/leads.ts.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import {
  LiveClaimConflictError,
  createLead,
  listLeads,
  type Lead,
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

function serialize(lead: Lead) {
  return {
    id: lead.id,
    projectId: lead.projectId,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    altPhone: lead.altPhone,
    source: lead.source,
    sourceDetail: lead.sourceDetail,
    campaignRef: lead.campaignRef,
    stage: lead.stage,
    lostReason: lead.lostReason,
    budgetMin: lead.budgetMin?.toString() ?? null,
    budgetMax: lead.budgetMax?.toString() ?? null,
    preferredTypes: lead.preferredTypes,
    requirementNote: lead.requirementNote,
    assignedAssociateId: lead.assignedAssociateId,
    assignedAt: lead.assignedAt?.toISOString() ?? null,
    createdAt: lead.createdAt.toISOString(),
    lastContactAt: lead.lastContactAt?.toISOString() ?? null,
  };
}

async function authenticate(request: Request, url: URL) {
  const token = readSessionToken(request);
  if (token === null) {
    return {
      error: problemResponse({
        status: 401, type: "unauthenticated", title: "Unauthenticated",
        detail: "A session cookie or bearer token is required.", instance: url.pathname,
      }),
    };
  }
  const db = getPrismaClient();
  try {
    const session = await validateSession(db, token);
    return { db, session };
  } catch (error) {
    if (error instanceof SessionInvalidError) {
      return {
        error: problemResponse({
          status: 401, type: "session-invalid", title: "Unauthenticated",
          detail: "The session is unknown, revoked or expired.", instance: url.pathname,
        }),
      };
    }
    throw error;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const auth = await authenticate(request, url);
  if (auth.error) return auth.error;
  const { db, session } = auth;

  const stage = url.searchParams.get("stage");
  const projectId = url.searchParams.get("projectId");

  try {
    const leads = await listLeads(db, {
      orgId: session.user.orgId,
      actorId: session.userId,
      stage: stage ? (stage as Lead["stage"]) : undefined,
      projectId: projectId ?? undefined,
    });
    return Response.json({ leads: leads.map(serialize) }, { status: 200 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}

interface CreateLeadBody {
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  altPhone?: unknown;
  source?: unknown;
  sourceDetail?: unknown;
  campaignRef?: unknown;
  projectId?: unknown;
  budgetMin?: unknown;
  budgetMax?: unknown;
  preferredTypes?: unknown;
  requirementNote?: unknown;
  assignToAssociateId?: unknown;
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const auth = await authenticate(request, url);
  if (auth.error) return auth.error;
  const { db, session } = auth;

  let body: CreateLeadBody;
  try {
    body = (await request.json()) as CreateLeadBody;
  } catch {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "Request body must be valid JSON.", instance: url.pathname,
    });
  }
  if (typeof body.name !== "string" || typeof body.phone !== "string" || typeof body.source !== "string") {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "name, phone and source are required strings.", instance: url.pathname,
    });
  }

  try {
    const lead = await createLead(db, {
      name: body.name,
      phone: body.phone,
      email: typeof body.email === "string" ? body.email : undefined,
      altPhone: typeof body.altPhone === "string" ? body.altPhone : undefined,
      source: body.source as Lead["source"],
      sourceDetail: typeof body.sourceDetail === "string" ? body.sourceDetail : undefined,
      campaignRef: typeof body.campaignRef === "string" ? body.campaignRef : undefined,
      projectId: typeof body.projectId === "string" ? body.projectId : undefined,
      budgetMin: typeof body.budgetMin === "string" ? body.budgetMin : undefined,
      budgetMax: typeof body.budgetMax === "string" ? body.budgetMax : undefined,
      preferredTypes: Array.isArray(body.preferredTypes) ? (body.preferredTypes as string[]) : undefined,
      requirementNote: typeof body.requirementNote === "string" ? body.requirementNote : undefined,
      assignToAssociateId: typeof body.assignToAssociateId === "string" ? body.assignToAssociateId : undefined,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json(serialize(lead), { status: 201 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof LiveClaimConflictError) {
      return problemResponse({
        status: 409, type: "live-claim-conflict", title: "A live claim already exists",
        detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
