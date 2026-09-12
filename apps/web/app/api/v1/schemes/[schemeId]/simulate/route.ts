// Dry-run a hypothetical sale against a scheme -- POST /schemes/:id/simulate.
// "No writes" (docs/07-API.md). Thin; every real guard lives in
// packages/services/src/commission.ts's simulateScheme.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import { CommissionSchemeMisconfiguredError, SchemeNotFoundError, simulateScheme } from "@desire/services/commission";

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

interface SimulateBody {
  bookingDate?: unknown;
  commissionableValue?: unknown;
  saleableAreaAtBooking?: unknown;
  sellerAssociateId?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ schemeId: string }> },
) {
  const { schemeId } = await params;
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

  let body: SimulateBody;
  try {
    body = (await request.json()) as SimulateBody;
  } catch {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "Request body must be valid JSON.", instance: url.pathname,
    });
  }
  if (
    typeof body.bookingDate !== "string" ||
    (typeof body.commissionableValue !== "string" && typeof body.commissionableValue !== "number") ||
    (typeof body.saleableAreaAtBooking !== "string" && typeof body.saleableAreaAtBooking !== "number") ||
    typeof body.sellerAssociateId !== "string"
  ) {
    return problemResponse({
      status: 400, type: "invalid-body", title: "Invalid request body",
      detail: "bookingDate (string), commissionableValue, saleableAreaAtBooking and sellerAssociateId (string) are required.",
      instance: url.pathname,
    });
  }

  try {
    const result = await simulateScheme(db, {
      schemeId,
      hypotheticalBooking: {
        bookingDate: body.bookingDate,
        commissionableValue: String(body.commissionableValue),
        saleableAreaAtBooking: String(body.saleableAreaAtBooking),
        sellerAssociateId: body.sellerAssociateId,
      },
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });
    return Response.json(
      {
        entries: result.entries.map((e) => ({
          beneficiaryAssociateId: e.beneficiaryAssociateId,
          role: e.role,
          level: e.level,
          grossAmount: e.grossAmount.toString(),
        })),
        breakage: result.breakage.toString(),
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof SchemeNotFoundError) {
      return problemResponse({
        status: 404, type: "scheme-not-found", title: "Not Found", detail: error.message, instance: url.pathname,
      });
    }
    if (error instanceof CommissionSchemeMisconfiguredError) {
      return problemResponse({
        status: 422, type: "scheme-misconfigured", title: "Scheme misconfigured", detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
