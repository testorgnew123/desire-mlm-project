// Scheduled report email trigger -- /jobs/reports/send-scheduled, nightly
// from external cron (docs/21-TIER-LIMITS.md section 11). Same
// x-job-secret pattern as every other job (see holds/expire/route.ts).
//
// Sends nothing until MAIL_FROM/SMTP_* are configured (email.ts) -- every
// due view fails with EmailConfigError, counted and logged, never thrown,
// so this job reports {ok:true, processed:0} rather than 500ing forever
// until the client points SMTP at a real free account.
import { createHash, timingSafeEqual } from "node:crypto";
import { getPrismaClient } from "@desire/db";
import { runScheduledReportEmails } from "@desire/services/report-schedules";

export const dynamic = "force-dynamic";

function problemResponse(params: { status: number; type: string; title: string; detail: string; instance: string }): Response {
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
      status: 401, type: "job-trigger-unauthorized", title: "Unauthorized",
      detail: "A valid x-job-secret header is required.", instance: url.pathname,
    });
  }

  const result = await runScheduledReportEmails(getPrismaClient());

  return Response.json({
    ok: true,
    processed: result.sent,
    failed: result.failed,
    durationMs: Date.now() - startedAt,
  });
}
