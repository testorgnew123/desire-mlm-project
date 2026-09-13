// Nightly backup trigger -- /jobs/backup/dump in docs/07-API.md, nightly
// 00:00 IST from external cron (docs/21-TIER-LIMITS.md section 11). The
// caller is .github/workflows/scheduled-jobs.yml, which POSTs to
// `$BASE_URL/api/jobs/backup/dump` with an `x-job-secret` header.
//
// This exists because the free tier this project must stay on permanently
// (PROGRESS.md decision log, 2026-09-13: no paid service is affordable, ever)
// gives Neon only 6 hours of point-in-time restore -- not a real DR posture
// once actual data exists. runNightlyBackup (packages/services/src/backup.ts)
// is idempotent per calendar day (same date key overwrites, not appends), so
// a delayed or duplicated run is harmless, same as every other job here.
import { createHash, timingSafeEqual } from "node:crypto";
import { getPrismaClient } from "@desire/db";
import { runNightlyBackup } from "@desire/services/backup";

// This handler performs real I/O (a full logical dump) and must run per
// request; never statically optimised.
export const dynamic = "force-dynamic";

/** RFC 7807 problem+json (docs/07-API.md, "Error shape"). Duplicated per job
 *  route rather than shared -- see holds/expire/route.ts for why. */
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

/** Constant-time secret check -- see holds/expire/route.ts for the full
 *  reasoning (hashed before comparison so timingSafeEqual never sees a
 *  length mismatch, which is itself observable). */
function isAuthorizedJobRequest(provided: string | null): boolean {
  const expected = process.env.JOB_TRIGGER_SECRET;
  if (!expected) {
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

  const result = await runNightlyBackup(getPrismaClient());

  // No heartbeat table exists yet for the /api/health dead-man's switch
  // docs/07-API.md describes -- same gap noted in every other job route.
  // Record completion here once one exists; this job is exactly the one
  // that must not fail silently.
  return Response.json({
    ok: true,
    processed: result.totalRows,
    durationMs: Date.now() - startedAt,
  });
}
