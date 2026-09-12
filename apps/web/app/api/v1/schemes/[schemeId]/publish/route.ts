// Commission scheme publish (maker-checker) -- POST /schemes/:id/publish.
// Closes the other half of the backend gap named in the Phase 3.5 plan
// (Slice 7): publishScheme has existed since Phase 3 with zero HTTP route.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import {
  EmptySchemeError,
  SchemeMakerCheckerViolationError,
  SchemeNotFoundError,
  SchemeNotPublishableError,
  publishScheme,
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

export async function POST(request: Request, { params }: { params: Promise<{ schemeId: string }> }) {
  const { schemeId } = await params;
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

  try {
    const result = await publishScheme(db, {
      schemeId,
      audit: { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
    });

    return Response.json(
      { ...result, publishedAt: result.publishedAt.toISOString() },
      { status: 200 },
    );
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
    if (error instanceof SchemeNotFoundError) {
      return problemResponse({
        status: 404,
        type: "scheme-not-found",
        title: "Not Found",
        detail: error.message,
        instance: url.pathname,
      });
    }
    if (error instanceof SchemeMakerCheckerViolationError) {
      return problemResponse({
        status: 403,
        type: "maker-checker-violation",
        title: "Forbidden",
        detail: error.message,
        instance: url.pathname,
      });
    }
    if (error instanceof SchemeNotPublishableError || error instanceof EmptySchemeError) {
      return problemResponse({
        status: 422,
        type: "not-publishable",
        title: "Unprocessable",
        detail: error.message,
        instance: url.pathname,
      });
    }
    throw error;
  }
}
