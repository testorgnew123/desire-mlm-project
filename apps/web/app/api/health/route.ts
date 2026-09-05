// Health check. See docs/15-OPS-RUNBOOK.md and docs/21-TIER-LIMITS.md section
// 11 -- the intended shape reports DB connectivity plus every job's last
// successful run, since an externally-triggered job (GitHub Actions cron)
// fails by ABSENCE, which raises no error anywhere else.
//
// `jobs` is honestly "not yet implemented" rather than fabricated: no job
// exists yet in this phase (Phase 0 is schema + commission engine only, see
// PROGRESS.md), and no heartbeat table exists in the schema to back it. Wire
// this up for real when the first scheduled job lands (Phase 1, hold expiry
// sweep) -- do not let this comment go stale once that happens.
import { getPrismaClient } from "@desire/db";

export async function GET() {
  const startedAt = Date.now();
  let dbOk = false;
  let dbError: string | undefined;

  try {
    await getPrismaClient().$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  const body = {
    status: dbOk ? "ok" : "degraded",
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    db: dbOk ? { ok: true } : { ok: false, error: dbError },
    jobs: "not yet implemented -- see docs/21-TIER-LIMITS.md section 11",
  } as const;

  return Response.json(body, { status: dbOk ? 200 : 503 });
}
