// Board refresh read -- GET /projects/:id/units/deltas?since= in the Inventory
// table of docs/07-API.md. Thin by design (docs/07-API.md, "Both are thin"):
// resolve the actor, assert the permission, parse the cursor, call
// getUnitDeltas, shape the response. The effective-status rule that makes an
// expired-but-unswept hold read as AVAILABLE lives in
// packages/services/src/units.ts, not here -- but note that rule only applies
// to units the delta query already returned, and a hold expiring does not
// touch Unit.updatedAt, so a unit whose hold expired between two polls is
// absent from the response entirely. Tracked against getUnitDeltas.
//
// OPEN GAP, reported and not fixable from this file: getUnitDeltas filters on
// projectId alone with no orgId predicate (packages/services/src/units.ts), so
// a valid session for org A can still read org B's project by id. The
// assertPermission call below does NOT close that -- an org-wide role grant
// (UserRole.projectId IS NULL) satisfies the check for any projectId at all.
// The filter belongs next to the query, in the service.
import { getPrismaClient } from "@desire/db";
// Narrow subpath imports, not the "@desire/services" barrel: the barrel pulls
// auth.ts -> @node-rs/argon2, a native .node addon webpack cannot parse, and
// that fails `next build` outright. Import only the module each symbol lives in.
import { ForbiddenError, assertPermission } from "@desire/services/rbac";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { getUnitDeltas } from "@desire/services/units";

// The board polls this on a timer (docs/21-TIER-LIMITS.md section 1 -- 60s on
// the free tier). A cached response would hand associates stale inventory,
// which is the exact failure this endpoint exists to prevent.
export const dynamic = "force-dynamic";

/** No login route exists yet to set this, so the name is pinned here as the
 *  convention for the rest of apps/web. The value is the raw token returned
 *  once by createSession (packages/services/src/auth.ts); the httpOnly /
 *  secure / sameSite=lax attributes in docs/10-SECURITY.md are the setter's
 *  concern, not the reader's. */
const SESSION_COOKIE_NAME = "desire_session";

/** RFC 7807 problem+json (docs/07-API.md, "Error shape"). Duplicated in
 *  apps/web/app/api/jobs/holds/expire/route.ts rather than shared: apps/web has
 *  no API helper module yet, and two call sites do not justify inventing one. */
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

/** Session cookie (web) or bearer token (PWA), per the Auth row of the
 *  conventions table in docs/07-API.md. The bearer header wins when both are
 *  present: a PWA that sent one asked to be authenticated as that token, and
 *  silently preferring a stale cookie would authenticate the wrong actor. */
function readSessionToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const separator = authorization.indexOf(" ");
    // Scheme is case-insensitive (RFC 7235 section 2.1).
    if (separator !== -1 && authorization.slice(0, separator).toLowerCase() === "bearer") {
      const token = authorization.slice(separator + 1).trim();
      if (token !== "") return token;
    }
  }

  const cookieHeader = request.headers.get("cookie");
  if (cookieHeader === null) return null;
  for (const pair of cookieHeader.split(";")) {
    // Split on the FIRST "=" only. Base64url tokens contain none, but a cookie
    // value is allowed to, and truncating one produces a token that fails to
    // validate for a reason nothing in the logs would explain.
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    // Not percent-decoded: createSession's token is base64url, whose alphabet
    // is entirely unreserved, so any encoder round-trips it unchanged.
    // decodeURIComponent would only add a throw path on a malformed cookie,
    // turning a bad request into a 500.
    const value = pair.slice(separator + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

export async function GET(
  request: Request,
  // Next.js 15 changed route params to a promise. Typing this as a plain object
  // is a build error, not a runtime one.
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const url = new URL(request.url);

  // Authentication runs before the ?since parse on purpose: an anonymous
  // caller should not get to probe query-parameter validation, and should
  // learn nothing about whether this projectId exists.
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

  // Actor resolved ONCE per request (docs/07-API.md, Auth row). validateSession
  // writes lastActiveAt, so a second call would be both a wasted write and a
  // second idle-timeout refresh. Authorization itself stays in the service
  // layer (docs/10-SECURITY.md, "Handlers never authorize") -- this handler
  // only calls assertPermission and maps its error to a status code.
  try {
    const session = await validateSession(db, token);
    await assertPermission(db, session.userId, "unit.read", { projectId });
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
    if (error instanceof ForbiddenError) {
      // Deliberately does not echo the user id or the project id back.
      return problemResponse({
        status: 403,
        type: "forbidden",
        title: "Forbidden",
        detail: 'This session lacks the "unit.read" permission on this project.',
        instance: url.pathname,
      });
    }
    throw error;
  }

  const rawSince = url.searchParams.get("since");

  let since: Date | undefined;
  if (rawSince !== null) {
    // Absent means "full snapshot". Present-but-unparseable -- including the
    // empty string from a bare `?since=` -- is a client bug and must say so.
    // Falling back to a full snapshot here would look like it worked while
    // quietly costing the client a whole-project payload on every poll.
    const parsed = new Date(rawSince);
    if (Number.isNaN(parsed.getTime())) {
      return problemResponse({
        status: 400,
        type: "invalid-query-parameter",
        title: "Invalid since parameter",
        detail: `"since" must be an ISO 8601 timestamp; received ${JSON.stringify(rawSince)}.`,
        instance: url.pathname,
      });
    }
    since = parsed;
  }

  const { units, serverTime } = await getUnitDeltas(db, { projectId, since });

  return Response.json({
    units: units.map((unit) => ({
      id: unit.id,
      unitNumber: unit.unitNumber,
      floor: unit.floor,
      status: unit.status,
      currentHoldExpiresAt: unit.currentHoldExpiresAt?.toISOString() ?? null,
      updatedAt: unit.updatedAt.toISOString(),
    })),
    // THE POLLING CONTRACT: the client stores this and sends it back verbatim
    // as the next ?since. It is the server's clock on purpose -- a client that
    // used its own would silently skip changes if its clock ran fast, and
    // silently refetch the same rows forever if it ran slow. Neither shows up
    // as an error anywhere. ISO 8601 UTC per docs/07-API.md.
    serverTime: serverTime.toISOString(),
  });
}
