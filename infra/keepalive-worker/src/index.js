/**
 * Keep-warm pinger for the Desire production app.
 *
 * Problem it solves: Neon Free scales the compute to zero after 5 minutes
 * idle and that cannot be disabled, and Netlify Free has no provisioned
 * concurrency. Measured on production: the first request of the day took
 * 9.09 s, against 0.4-0.6 s warm. See docs/21-TIER-LIMITS.md section 12.
 *
 * Why a Cloudflare Worker and not the alternatives:
 *   - GitHub Actions cron: measured delivering 8 runs in 24 h against 288
 *     scheduled (docs/21-TIER-LIMITS.md section 1). A keep-warm that fires
 *     every few hours keeps nothing warm.
 *   - cron-job.org: works, but is another third-party account to own. This
 *     project already has Cloudflare in front of the domain.
 *
 * Cost: free. Workers Free allows 100,000 requests/day; this is ~150/day.
 * The 10 ms CPU cap is not a constraint -- waiting on a fetch does not count
 * toward CPU time.
 */

/** Which cold start, if any, a ping paid for. The thresholds are rough, from what
 *  production showed: a database wake took 4.5-4.9 s inside /api/health, a cold
 *  function about 2 s, and a warm ping a few hundred ms. Written into the log line
 *  so Workers Logs can be searched for `"state":"neon-asleep"` -- a ping that still
 *  woke the database means the schedule is not keeping it warm. */
function classify({ ok, elapsedMs, dbDurationMs }) {
  if (!ok) return "error";
  if (dbDurationMs !== null && dbDurationMs > 1000) return "neon-asleep";
  if (elapsedMs > 1500) return "function-cold";
  return "warm";
}

export default {
  async scheduled(event, env, ctx) {
    const url = env.HEALTH_URL;
    if (!url) {
      // Fail loudly in the Worker log rather than silently pinging nothing.
      console.error("HEALTH_URL is not configured; nothing to warm.");
      return;
    }

    // waitUntil so the scheduled invocation is not torn down before the
    // request completes -- a cold origin is the whole point, and a cold
    // origin is slow by definition.
    ctx.waitUntil(
      (async () => {
        const startedAt = Date.now();
        try {
          const response = await fetch(url, {
            // A cold Neon compute plus a cold function can take several
            // seconds. Do not give up before the thing being warmed responds.
            signal: AbortSignal.timeout(25_000),
            headers: { "user-agent": "desire-keepalive-worker" },
            // Never serve this from Cloudflare's cache: a cached 200 would
            // warm nothing and the Worker would report success forever.
            cache: "no-store",
          });

          const elapsedMs = Date.now() - startedAt;
          // /api/health reports its own DB timing, which distinguishes "the
          // function was cold" from "Neon was asleep".
          let durationMs = null;
          try {
            durationMs = (await response.json())?.durationMs ?? null;
          } catch {
            // Non-JSON means something is wrong upstream, but the ping still
            // did its job. Not worth failing over.
          }

          const line = {
            ok: response.ok,
            status: response.status,
            elapsedMs,
            dbDurationMs: durationMs,
          };
          line.state = classify(line);
          // An error response goes to the error level so it can be filtered on.
          (response.ok ? console.log : console.error)(JSON.stringify(line));
        } catch (error) {
          // A failed ping is not an outage -- the next one is 4 minutes away.
          // Logged so a persistent failure is visible in the Worker log.
          console.error(
            JSON.stringify({
              ok: false,
              state: "error",
              elapsedMs: Date.now() - startedAt,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      })(),
    );
  },
};
