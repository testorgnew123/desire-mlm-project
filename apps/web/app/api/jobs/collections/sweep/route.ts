// Collections escalation sweep trigger -- /jobs/collections/sweep,
// daily 08:00 IST from external cron (docs/21-TIER-LIMITS.md section 11).
// The caller is .github/workflows/scheduled-jobs.yml, which POSTs to
// `$BASE_URL/api/jobs/collections/sweep` with an `x-job-secret` header --
// copying apps/web/app/api/jobs/holds/expire/route.ts's shape exactly.
//
// runCollectionsSweep (packages/services/src/collections-sweep.ts) is
// idempotent by construction: alerts are guarded by
// @@unique([demandId, rung]), and interest is recomputed in full each run
// rather than incremented -- so a delayed or duplicated run is safe.
import { createHash, timingSafeEqual } from "node:crypto";
import { getPrismaClient } from "@desire/db";
import { runCollectionsSweep } from "@desire/services/collections-sweep";

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

  const result = await runCollectionsSweep(getPrismaClient());

  return Response.json({
    ok: true,
    processed: result.alertsFired,
    durationMs: Date.now() - startedAt,
  });
}
