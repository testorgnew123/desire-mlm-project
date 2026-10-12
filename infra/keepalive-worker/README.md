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
dashboard and add the cron trigger and the `HEALTH_URL` variable by hand.

Cron changes can take up to 15 minutes to propagate.

## Verify

```bash
wrangler tail                   # watch invocations live
```

Each run logs one JSON line:

```json
{"ok":true,"status":200,"elapsedMs":180,"dbDurationMs":3}
```

`dbDurationMs` comes from `/api/health` itself and separates the two failure
modes: a high `elapsedMs` with a low `dbDurationMs` means the **function** was
cold; both high means **Neon** was asleep.

The real test is the next weekday morning — the 09:30 IST request should look
like a warm one, not like 9 seconds.

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
setting — the current `*/4 4-13 * * 1-5` is 09:30–19:29 IST, and the comment
there explains the half-hour offset. Any widening costs Neon CU-hours
linearly, so re-do the arithmetic above before changing it.
