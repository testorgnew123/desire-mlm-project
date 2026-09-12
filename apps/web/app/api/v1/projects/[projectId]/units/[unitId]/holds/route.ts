// Hold acquisition -- POST /units/:id/hold in docs/07-API.md, adapted to this
// repo's project-nested convention (see the deltas route in the sibling
// directory). Thin by design (docs/07-API.md, "Both are thin"): resolve the
// actor, resolve the acting associate, scope the unit, call acquireHold, shape
// the response. Every real guard -- the row lock, RERA validity, active price
// list, hold quota, the partial unique index backstop -- lives in
// packages/services/src/holds.ts, which is GATE-tested (a 50-way concurrency
// proof) and is not touched here.
//
// ASSOCIATE RESOLUTION: strictly the caller's OWN Associate record
// (Associate.userId -> session.userId). There is no "hold on behalf of
// another associate" here -- docs/08-SCREENS.md ("Hold button shows the
// associate's remaining quota") describes a self-action, not a delegated one,
// and no request body is even parsed in this handler. A caller with hold.create
// but no Associate row (SUPER_ADMIN, SALES_HEAD, SALES_ADMIN in the seed --
// deliberately not sellers) gets a clear 403, not a 500 on a null associateId.
//
// IDEMPOTENCY (docs/07-API.md: "Idempotent. 409 if lost the race"): a caller
// retrying against a unit they ALREADY hold must get 200 with the existing
// hold back, not a 409 naming themselves as the winner they already are.
// acquireHold does not special-case this -- it throws UnitNotAvailableError
// unconditionally whenever status is not AVAILABLE. Handled here instead of
// in holds.ts, via a read-only lookup after the catch, so the GATE-tested
// function stays untouched.
//
// auditId (docs/07-API.md: "Audit: every mutation response includes auditId"):
// writeAuditLog (packages/services/src/audit.ts) returns void, so acquireHold
// cannot hand one back directly. Rather than omit the field, this handler
// looks up the CREATE row it just caused by (entity, entityId, action) --
// holdId is unique per hold, so exactly one row ever matches. Read-only,
// no second write, no change to holds.ts.
import { getPrismaClient } from "@desire/db";
// Narrow subpath imports, not the "@desire/services" barrel: the barrel pulls
// auth.ts -> @node-rs/argon2, a native .node addon webpack cannot parse, and
// that fails `next build` outright. Import only the module each symbol lives in.
import { ForbiddenError, assertPermission } from "@desire/services/rbac";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import {
  HoldGuardError,
  HoldQuotaExceededError,
  UnitNotAvailableError,
  UnitNotFoundError,
  acquireHold,
} from "@desire/services/holds";

// This handler mutates and must run per request; never statically optimised.
export const dynamic = "force-dynamic";

/** No login route exists yet to set this, so the name is pinned here as the
 *  convention for the rest of apps/web -- same constant as the deltas route. */
const SESSION_COOKIE_NAME = "desire_session";

/** RFC 7807 problem+json (docs/07-API.md, "Error shape"). Duplicated rather
 *  than shared: apps/web still has no API helper module, and three call sites
 *  (this one, deltas, jobs/holds/expire) do not yet justify inventing one. */
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

/** Session cookie (web) or bearer token (PWA) -- identical to the deltas
 *  route's reader, duplicated for the same reason as problemResponse above. */
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

/** Looks up the audit row acquireHold's transaction just wrote for this hold.
 *  holdId is unique per hold (cuid, never reused), so (entity, entityId,
 *  action) always matches exactly one row -- there is no ordering ambiguity
 *  to resolve. Thrown if missing, because a hold with no audit row is a real
 *  bug in the write path, not something to paper over with a null field. */
async function findHoldAuditId(
  db: ReturnType<typeof getPrismaClient>,
  holdId: string,
): Promise<string> {
  const row = await db.auditLog.findFirstOrThrow({
    where: { entity: "UnitHold", entityId: holdId, action: "CREATE" },
    select: { id: true },
  });
  return row.id;
}

export async function POST(
  request: Request,
  // Next.js 15 changed route params to a promise.
  { params }: { params: Promise<{ projectId: string; unitId: string }> },
) {
  const { projectId, unitId } = await params;
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
    // Actor resolved ONCE per request (docs/07-API.md, Auth row). Authorization
    // itself stays out of the service layer for this call -- acquireHold does
    // no permission checking of its own, by the same convention the deltas
    // route follows for getUnitDeltas -- so it is asserted here, before any
    // Unit or Associate lookup, so a caller lacking hold.create learns nothing
    // about whether this unit or project exists.
    session = await validateSession(db, token);
    await assertPermission(db, session.userId, "hold.create", { projectId });
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
      return problemResponse({
        status: 403,
        type: "forbidden",
        title: "Forbidden",
        detail: 'This session lacks the "hold.create" permission on this project.',
        instance: url.pathname,
      });
    }
    throw error;
  }

  // The acting associate is always the caller's own record -- never a
  // client-supplied id. An admin-shaped role holding hold.create but no
  // Associate row (SUPER_ADMIN, SALES_HEAD, SALES_ADMIN per seed.ts -- they
  // are not sellers) is told plainly rather than crashing on a null
  // associateId three lines into acquireHold.
  const associate = await db.associate.findUnique({
    where: { userId: session.userId },
    select: { id: true },
  });
  if (associate === null) {
    return problemResponse({
      status: 403,
      type: "no-associate-profile",
      title: "Forbidden",
      detail: "This account has no associate profile; only associates can hold units.",
      instance: url.pathname,
    });
  }

  // Scoped by orgId AND projectId in one query, so a unitId from another
  // project or another tenant 404s rather than leaking which one it belongs
  // to -- unlike getUnitDeltas (packages/services/src/units.ts), which filters
  // on projectId alone; that gap is reported against that function, not
  // repeated here since this query already has orgId to hand.
  const unit = await db.unit.findUnique({
    where: { id: unitId, projectId, orgId: session.user.orgId },
    select: { id: true },
  });
  if (unit === null) {
    return problemResponse({
      status: 404,
      type: "unit-not-found",
      title: "Not Found",
      detail: "No such unit in this project.",
      instance: url.pathname,
    });
  }

  try {
    const acquired = await acquireHold(db, {
      orgId: session.user.orgId,
      unitId: unit.id,
      associateId: associate.id,
      // leadId omitted: no leads system exists yet (Phase 2).
      audit: {
        orgId: session.user.orgId,
        actorId: session.userId,
        actorLabel: session.user.name,
      },
    });

    const auditId = await findHoldAuditId(db, acquired.holdId);
    return Response.json(
      {
        holdId: acquired.holdId,
        unitId: acquired.unitId,
        expiresAt: acquired.expiresAt.toISOString(),
        auditId,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof UnitNotAvailableError) {
      // Idempotent retry: the "someone" holding it is the caller themselves.
      // Look up their own live hold on this unit and hand it back as success
      // rather than a 409 naming them as the winner they already are.
      if (error.heldBy?.associateId === associate.id) {
        const existing = await db.unitHold.findFirst({
          where: { unitId: unit.id, associateId: associate.id, releasedAt: null },
          select: { id: true, expiresAt: true },
        });
        if (existing !== null) {
          const auditId = await findHoldAuditId(db, existing.id);
          return Response.json(
            {
              holdId: existing.id,
              unitId: unit.id,
              expiresAt: existing.expiresAt.toISOString(),
              auditId,
            },
            { status: 200 },
          );
        }
        // Benign race: released between acquireHold's transaction and this
        // lookup (e.g. the sweep ran in between). Fall through to the normal
        // lost-race response below using the error acquireHold actually threw.
      }

      // The real lost race (docs/08-SCREENS.md: "Losing a hold race shows
      // 'Just taken by Ravi (A-0042)' -- never a generic error"). error.message
      // is already exactly that string, verbatim, from the existing, tested
      // UnitNotAvailableError -- not reformatted here.
      return problemResponse({
        status: 409,
        type: "unit-already-held",
        title: error.heldBy ? "Unit already held" : "Unit not available",
        detail: error.message,
        instance: url.pathname,
      });
    }
    if (error instanceof HoldQuotaExceededError) {
      return problemResponse({
        status: 422,
        type: "hold-quota-exceeded",
        title: "Hold quota exceeded",
        detail: error.message,
        instance: url.pathname,
      });
    }
    if (error instanceof HoldGuardError) {
      return problemResponse({
        status: 422,
        type: "hold-guard-failed",
        title: "Unit cannot be held",
        detail: error.message,
        instance: url.pathname,
      });
    }
    if (error instanceof UnitNotFoundError) {
      // Rare TOCTOU: the unit existed at the scoping check above and was
      // deleted before acquireHold's own lock. Same shape as the 404 above.
      return problemResponse({
        status: 404,
        type: "unit-not-found",
        title: "Not Found",
        detail: "No such unit in this project.",
        instance: url.pathname,
      });
    }
    throw error;
  }
}
