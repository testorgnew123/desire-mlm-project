// Log a payment follow-up -- POST /demands/:id/follow-up in docs/07-API.md
// ("Outcome + optional promise date"). Thin; every real guard lives in
// packages/services/src/collections-sweep.ts's promiseToPay.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import {
  FollowUpDemandNotFoundError,
  promiseToPay,
  type PaymentFollowUp,
} from "@desire/services/collections-sweep";

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

function serialize(followUp: PaymentFollowUp) {
  return {
    id: followUp.id,
    demandId: followUp.demandId,
    associateId: followUp.associateId,
    contactedOn: followUp.contactedOn.toISOString(),
    outcome: followUp.outcome,
    promiseToPayDate: followUp.promiseToPayDate?.toISOString() ?? null,
    notes: followUp.notes,
    createdAt: followUp.createdAt.toISOString(),
  };
}

interface FollowUpBody {
  contactedOn?: unknown;
  outcome?: unknown;
  promiseToPayDate?: unknown;
  notes?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ demandId: string }> },
) {
  const { demandId } = await params;
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

  let body: FollowUpBody;
  try {
    body = (await request.json()) as FollowUpBody;
  } catch {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "Request body must be valid JSON.", instance: url.pathname,
    });
  }
  if (typeof body.contactedOn !== "string" || typeof body.outcome !== "string") {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "contactedOn (ISO date string) and outcome are required.", instance: url.pathname,
    });
  }

  try {
    const followUp = await promiseToPay(db, {
      demandId,
      contactedOn: new Date(body.contactedOn),
      outcome: body.outcome as PaymentFollowUp["outcome"],
      promiseToPayDate: typeof body.promiseToPayDate === "string" ? new Date(body.promiseToPayDate) : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json(serialize(followUp), { status: 201 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof FollowUpDemandNotFoundError) {
      return problemResponse({
        status: 404, type: "demand-not-found", title: "Not Found", detail: "No such demand.", instance: url.pathname,
      });
    }
    throw error;
  }
}
