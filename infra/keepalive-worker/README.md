# Keep-warm Worker

A Cloudflare Worker that pings `/api/health` every 4 minutes during Indian
working hours, so the first real user of the day does not pay a cold start.

Free. Deploying it is a Cloudflare action, but the source lives here so the
schedule and the target are reviewable and version-controlled rather than
being a setting somebody changed in a dashboard once.

## Why this exists

Measured on production (see [21-TIER-LIMITS §12](../../docs/21-TIER-LIMITS.md)):

| | |
|---|---|
| First request of the day | **9.09 s** |
| Warm | 0.4–0.6 s |

Two causes, neither fixable on the free tier: Neon scales its compute to zero
after 5 minutes idle and that cannot be disabled, and Netlify Free has no
provisioned concurrency. A request every 4 minutes keeps both awake.

## Why not the alternatives

**GitHub Actions cron** — already in this repo for the scheduled jobs, and
measured delivering **8 runs in 24 hours against 288 scheduled**
([§1](../../docs/21-TIER-LIMITS.md)). A pinger that fires every few hours
warms nothing. This is the whole reason the keep-warm plan originally said
"external pinger, not GitHub Actions".

**cron-job.org** — works and is free, but is another third-party account to
create, own and remember. Cloudflare is already in front of this domain.

## Deploy

```bash
npm install --global wrangler   # once
cd infra/keepalive-worker
wrangler login
wrangler deploy
```

Or paste `src/index.js` into **Workers & Pages → Create → Worker** in the
dashboard and add the cron trigger (`*/4 4-13 * * mon-fri`) and the `HEALTH_URL`
variable (`https://crm.desirerealty.in/api/health`) by hand, and switch on
Workers Logs in the Worker's settings.

**One account step first.** Cloudflare will not store a cron schedule on an
account that has no `workers.dev` subdomain, even for a Worker with no public URL:
`wrangler deploy` uploads the script and then stops with error 10063 (this
happened on the first deploy, 2026-11-15). Open **Workers & Pages** in the
dashboard (it creates one the first time) or register a name there, then run
`wrangler triggers deploy`, which re-saves just the schedule. The Worker has
`workers_dev = false`, so no URL is published either way.

`wrangler login --scopes account:read user:read workers_scripts:write` is enough
for this Worker, and gives the login far less than the default.

Cron changes can take up to 15 minutes to propagate.

## Verify

```bash
wrangler tail                   # watch invocations live
```

Runs are also kept: **Workers & Pages → desire-keepalive → Logs** shows each one
for a few days (`[observability]` in `wrangler.toml` turns it on at deploy).

Each run logs one JSON line:

```json
{"ok":true,"status":200,"elapsedMs":180,"dbDurationMs":3,"state":"warm"}
```

`dbDurationMs` comes from `/api/health` itself and separates the two failure
modes: a high `elapsedMs` with a low `dbDurationMs` means the **function** was
cold (`"state":"function-cold"`); a high `dbDurationMs` means **Neon** was asleep
(`"neon-asleep"`). Either one, once the Worker has been running a while, means the
schedule is not keeping things warm: search the Logs for it. (The thresholds, 1 s
and 1.5 s, are rough.)

**Check the days it runs.** The first lines of a week should appear on Monday at
04:00 UTC (09:30 IST) and the last on Friday at 13:56 UTC (19:26 IST); nothing on
Saturday or Sunday. Cloudflare numbers weekdays 1 = Sunday to 7 = Saturday, which
is why the schedule uses `mon-fri` and not `1-5` (see below).

The real test is the next weekday morning — the 09:30 IST request should look
like a warm one, not like 9 seconds. From any machine, after the Worker has been
off for 6+ minutes (before 09:30 IST, say), the first request shows the cold hit;
one 5-15 minutes into the window should not:

```bash
curl -s -w "\n ttfb=%{time_starttransfer}s\n" https://crm.desirerealty.in/api/health
```

## Budget

| | |
|---|---|
| Worker invocations | ~150/day against **100,000/day** free |
| Cron triggers used | 1 of **5** free per account |
| CPU per invocation | ~0 ms against **10 ms** — waiting on a fetch does not count |
| Netlify invocations | ~2,600/month against **125,000** |
| **Neon compute** | **~55 of 100 CU-hours/month** ← the binding one |

Neon compute is the constraint that decides the schedule. 24/7 would be
182 CU-h and would suspend the database mid-month; 12 h × 7 days is ~90 and
leaves no headroom. Weekday working hours is what fits.

**Check Neon usage a few days after deploying, and abort if it trends past
~70 CU-h before month end.**

## Changing the schedule

`crons` in `wrangler.toml`. **Cloudflare cron is UTC** and has no timezone
setting — the current `*/4 4-13 * * mon-fri` is 09:30–19:29 IST, and the comment
there explains the half-hour offset. **Write weekdays as names.** Cloudflare
numbers them 1 = Sunday to 7 = Saturday (unlike most cron systems), so a numeric
`1-5` is Sunday–Thursday; that was this file's schedule until 2026-11-15.
`apps/web/test/keepalive-worker.test.ts` reads the line and fails if the window
moves. Any widening costs Neon CU-hours linearly, so re-do the arithmetic above
before changing it: one more day of 10 hours is about 11 CU-h a month (Saturday
too: ~66 of 100; Sunday as well: ~77, past the 70 where this README says to stop).
