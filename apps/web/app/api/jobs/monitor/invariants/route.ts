// The Invariant Monitor GATE trigger -- /jobs/monitor/invariants in
// docs/07-API.md, nightly from external cron (docs/21-TIER-LIMITS.md
// section 11). Same shape as holds/expire and grades/qualify's own routes.
//
// Honest "paging" note: no real paging provider (PagerDuty/Opsgenie/etc.)
// exists anywhere in this project's dependencies or .env.example. This
// route returns non-200 on ANY violation, which is exactly the mechanism
// this project already relies on -- "the GitHub Actions run status is
// currently the ONLY signal" (verbatim from holds/expire's own comment). A
// violation turns the nightly Action red, this project's actual, working
// alerting channel today. A real pager integration is future work, not
// invented here.
import { createHash, timingSafeEqual } from "node:crypto";
import { getPrismaClient } from "@desire/db";
import { runInvariantChecks } from "@desire/services/invariant-monitor";

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

  const result = await runInvariantChecks(getPrismaClient());

  if (!result.ok) {
    // Logged server-side (Netlify function logs) in addition to the
    // response body, so the violation survives even if the caller only
    // checks the HTTP status.
    console.error("Invariant monitor found violations:", JSON.stringify(result.violations));
    return Response.json(
      {
        ok: false,
        violationCount: result.violations.length,
        violations: result.violations,
        durationMs: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }

  return Response.json({
    ok: true,
    violationCount: 0,
    durationMs: Date.now() - startedAt,
  });
}
