// Update a lead -- PATCH /leads/:id in docs/07-API.md. phone/stage are
// deliberately not patchable here (see leads.ts's updateLead comment). Thin;
// every real guard lives in packages/services/src/leads.ts.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import { LeadNotFoundError, updateLead, type Lead } from "@desire/services/leads";

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
    name: lead.name,
    email: lead.email,
    altPhone: lead.altPhone,
    budgetMin: lead.budgetMin?.toString() ?? null,
    budgetMax: lead.budgetMax?.toString() ?? null,
    preferredTypes: lead.preferredTypes,
    requirementNote: lead.requirementNote,
    updatedAt: lead.updatedAt.toISOString(),
  };
}

interface UpdateLeadBody {
  name?: unknown;
  email?: unknown;
  altPhone?: unknown;
  budgetMin?: unknown;
  budgetMax?: unknown;
  preferredTypes?: unknown;
  requirementNote?: unknown;
}

export async function PATCH(
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

  let body: UpdateLeadBody;
  try {
    body = (await request.json()) as UpdateLeadBody;
  } catch {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "Request body must be valid JSON.", instance: url.pathname,
    });
  }

  try {
    const updated = await updateLead(db, {
      leadId,
      name: typeof body.name === "string" ? body.name : undefined,
      email: body.email === null ? null : typeof body.email === "string" ? body.email : undefined,
      altPhone: body.altPhone === null ? null : typeof body.altPhone === "string" ? body.altPhone : undefined,
      budgetMin: body.budgetMin === null ? null : typeof body.budgetMin === "string" ? body.budgetMin : undefined,
      budgetMax: body.budgetMax === null ? null : typeof body.budgetMax === "string" ? body.budgetMax : undefined,
      preferredTypes: Array.isArray(body.preferredTypes) ? (body.preferredTypes as string[]) : undefined,
      requirementNote:
        body.requirementNote === null ? null : typeof body.requirementNote === "string" ? body.requirementNote : undefined,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json(serialize(updated), { status: 200 });
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
