# 22 — Load Test Results

Phase 5. Run with `apps/web/scripts/load-test.mjs` (autocannon — pure npm,
no system binary to install, same free/open-source bar as k6). **Always run
against a local server + local Docker Postgres, never hosted Neon** — the
free tier's own invocation/compute ceilings
([21-TIER-LIMITS](21-TIER-LIMITS.md) §1: ~90,000 invocations/month, 80 CU-h
compute) make a real load test against it a self-inflicted outage, not a
measurement.

## How this was run

- `next build && next start` (production build, not `next dev`) on
  `localhost:3011`.
- `DATABASE_URL` pointed at local Docker Postgres (`desire-postgres`
  container), seeded via `packages/db/prisma/seed.ts`.
- 10 connections, 15 seconds per scenario — 10 concurrent associates is the
  actual concurrency ceiling [21-TIER-LIMITS §7](21-TIER-LIMITS.md) sizes
  the free tier for, not an arbitrary load-test number.
- Session cookie for a seeded demo user (`super_admin@demo.test`), issued
  the same way this project's other live-verification steps already do
  (`createSession` directly, not the login flow).

## Results (2026-09-14, local machine, no network hop)

| Scenario | p50 | p97.5 | p99 | Req/sec (avg) |
|---|---|---|---|---|
| Board delta poll (`GET /api/v1/projects/:id/units/deltas`) | 72 ms | 143 ms | 166 ms | 128 |
| Stock statement report export (`GET /api/v1/reports/stock-statement`) | 107 ms | 198 ms | 224 ms | 87 |
| Dashboard page (SSR, heaviest tile set — 5+ parallel aggregate queries) | 305 ms | 479 ms | 495 ms | 31 |

All requests returned `200` — no errors, no timeouts, at this concurrency
against the current (dev/demo scale) dataset.

## Compared against the free-tier targets

[21-TIER-LIMITS §7](21-TIER-LIMITS.md)'s revised targets, restated:

| Metric | Free-tier target | Measured (local, no network hop) |
|---|---|---|
| Delta poll p95 | < 600 ms | **166 ms (p99)** — comfortably inside, before the ~250 ms India→Ohio round trip the real deployment adds on top |
| Board first load p95 | < 3 s | **495 ms (p99)** for the dashboard, the heaviest SSR page measured — before the network hop |

**Caveat, stated plainly:** this measures application + database latency
only. It does not include the real India→Ohio network round trip
([21-TIER-LIMITS §2](21-TIER-LIMITS.md)) or a genuine serverless cold start
— neither is reproducible from a local `next start` process. Add roughly
250 ms to every number above for a real user's experience, and expect the
first request after 5+ minutes idle to add another 500 ms–2 s (Neon
scale-to-zero). Real-world figures at the deployed Netlify+Neon free tier
have not been measured this pass — only the part that's actually
controllable from this environment.

## What this does and doesn't prove

- **Proves:** the query/rendering logic itself is fast at the free tier's
  own stated concurrency ceiling (10 associates) against a dataset at
  today's (dev/demo) scale. No N+1 query blew up, no lock contention
  surfaced.
- **Does not prove:** behavior at real production data volume (the audit
  log alone is projected at 1-2 GB/year — [21-TIER-LIMITS §3](21-TIER-LIMITS.md)),
  or anything about the real network/cold-start numbers above.
- **Re-run before the pilot**, once there's a realistic amount of seed data
  (hundreds of units, thousands of leads/bookings) rather than the current
  handful of demo rows — today's numbers are a floor, not a ceiling.
