// The drill-down -- GET /commission/entries/:id/explain. "Returns the
// snapshot, expanded" (docs/07-API.md). Thin; scoping lives in
// packages/services/src/commission.ts's explainEntry.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import { CommissionEntryNotFoundError, explainEntry } from "@desire/services/commission";

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

export async function GET(
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

  try {
    const entry = await explainEntry(db, { entryId, audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name } });
    return Response.json(
      {
        id: entry.id,
        bookingId: entry.bookingId,
        beneficiaryAssociateId: entry.beneficiaryAssociateId,
        role: entry.role,
        level: entry.level,
        baseAmount: entry.baseAmount.toString(),
        grossAmount: entry.grossAmount.toString(),
        status: entry.status,
        snapshot: entry.snapshot,
        accruedAt: entry.accruedAt.toISOString(),
      },
      { status: 200 },
    );
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
    throw error;
  }
}
