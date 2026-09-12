// Grade auto-qualification sweep trigger -- /jobs/grades/qualify in
// docs/07-API.md, daily 08:00 IST from external cron (docs/21-TIER-LIMITS.md
// section 11). The caller is .github/workflows/scheduled-jobs.yml, which
// POSTs to `$BASE_URL/api/jobs/grades/qualify` with an `x-job-secret` header
// -- same shape as holds/expire and collections/sweep's own routes.
import { createHash, timingSafeEqual } from "node:crypto";
import { getPrismaClient } from "@desire/db";
import { runGradeQualificationSweep } from "@desire/services/grades";

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

/** Constant-time secret check -- see holds/expire's own route for the full
 *  reasoning (this path is reachable from the open internet). */
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

  // No state kept here: runGradeQualificationSweep only ever promotes
  // (never demotes) and re-evaluates from scratch each run, so a delayed or
  // duplicated run is harmless -- re-promoting someone already at or above
  // the target grade is a no-op (higherGrades excludes their current rank).
  const result = await runGradeQualificationSweep(getPrismaClient());

  return Response.json({
    ok: true,
    processed: result.evaluated,
    promoted: result.promoted,
    durationMs: Date.now() - startedAt,
  });
}
