// Shared session-token reading for Route Handler / API context.
//
// This is the exact Bearer-header-or-cookie precedence that was duplicated
// across 30+ routes before this file existed (see e.g.
// apps/web/app/api/v1/projects/[projectId]/units/deltas/route.ts). Existing
// routes are NOT retrofitted to import from here -- that is a separate
// cleanup, out of scope for Phase 3.5. Only new routes added in this phase
// use this module.

/** The cookie name every route in apps/web has pinned as the convention. */
export const SESSION_COOKIE_NAME = "desire_session";

/** Reads the session token from the Authorization header (Bearer scheme) or
 *  the session cookie, in that order. The bearer header wins when both are
 *  present: a caller that sent one asked to be authenticated as that token,
 *  and silently preferring a stale cookie would authenticate the wrong
 *  actor (docs/07-API.md, Auth conventions table). */
export function readSessionToken(request: Request): string | null {
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
