// Hold expiry sweep trigger -- /jobs/holds/expire in docs/07-API.md, every
// 5 minutes from external cron (docs/21-TIER-LIMITS.md section 11). The caller
// is .github/workflows/scheduled-jobs.yml, which POSTs to
// `$BASE_URL/api/jobs/holds/expire` with an `x-job-secret` header.
//
// Lazy expiry (packages/services/src/holds.ts) means a delayed or duplicated
// run is safe: it never double-releases and never releases a hold that is
// still live. It does NOT mean a skipped run is harmless, which an earlier
// version of this comment claimed. The board's delta read is the exception:
// getUnitDeltas selects on Unit.updatedAt, and a hold expiring does not touch
// the unit row, so a unit whose hold expired between two polls is absent from
// the delta response and the board keeps showing it as HELD until this sweep
// finally writes that row. Between sweeps the board is stale; a skipped run
// keeps it stale. The fix belongs in getUnitDeltas
// (packages/services/src/units.ts), which needs to also select units whose
// current hold expired inside the polling window -- reported, not fixed here.
import { createHash, timingSafeEqual } from "node:crypto";
import { getPrismaClient } from "@desire/db";
import { expireStaleHolds } from "@desire/services/holds";

// This handler mutates and must run per request; never statically optimised.
export const dynamic = "force-dynamic";

/** RFC 7807 problem+json (docs/07-API.md, "Error shape"). Duplicated in
 *  apps/web/app/api/v1/projects/[projectId]/units/deltas/route.ts rather than
 *  shared: apps/web has no API helper module yet, and two call sites do not
 *  justify inventing one. */
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

/** Constant-time secret check. This path is reachable from the open internet,
 *  so `===` is not acceptable: it short-circuits on the first differing byte
 *  and leaks the secret a character at a time to anyone willing to time it.
 *
 *  Both sides are hashed before comparison so the buffers are always 32 bytes.
 *  timingSafeEqual THROWS on a length mismatch, and throwing-versus-returning
 *  is itself observable -- hashing removes length from the comparison entirely. */
function isAuthorizedJobRequest(provided: string | null): boolean {
  const expected = process.env.JOB_TRIGGER_SECRET;
  if (!expected) {
    // Fail closed. An unconfigured deploy must be unreachable, not open. The
    // resulting silence is what the dead-man's switch on /api/health is for
    // (docs/15-OPS-RUNBOOK.md), so leave a server-side breadcrumb here too.
    console.error("JOB_TRIGGER_SECRET is not set; job endpoints reject every request.");
    return false;
  }
  if (provided === null) return false;

  return timingSafeEqual(sha256(provided), sha256(expected));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const url = new URL(request.url);

  if (!isAuthorizedJobRequest(request.headers.get("x-job-secret"))) {
    return problemResponse({
      status: 401,
      type: "job-trigger-unauthorized",
      title: "Unauthorized",
      detail: "A valid x-job-secret header is required.",
      instance: url.pathname,
    });
  }

  // No state is kept here on purpose: expireStaleHolds is already idempotent
  // and takes the unit row lock per hold, so two overlapping runs -- a delayed
  // cron catching up, or a manual workflow_dispatch racing the schedule -- are
  // harmless. Any bookkeeping added at this layer would be the thing that
  // breaks that.
  const { released } = await expireStaleHolds(getPrismaClient());

  // expireStaleHolds returns the released holds so this endpoint can notify the
  // associates who lost them. There is no notification service yet, so the
  // response reports only the count, which is the {ok, processed, durationMs}
  // shape docs/07-API.md specifies for job endpoints. Fire the notifications
  // here when that service lands, and delete this paragraph.
  //
  // Nor is completion recorded for the /api/health dead-man's switch that
  // docs/07-API.md describes: the schema has no heartbeat table (checked
  // against packages/db/prisma/schema.prisma, which wins over the doc). Record
  // it here once one exists.
  return Response.json({
    ok: true,
    processed: released.length,
    durationMs: Date.now() - startedAt,
  });
}
