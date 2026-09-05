# 21 — Free-Tier Constraints & Upgrade Triggers

The project runs on **Netlify Free** and **Neon Free**. That is workable, but it
is not the environment the rest of these docs were written against. This document
records what actually changes, why, and the exact point at which each limit
forces an upgrade.

Read alongside [ADR-0001](adr/0001-nextjs-netlify-neon.md).

## Verified limits

### Netlify Free

| Limit | Value | Consequence here |
|---|---|---|
| **Function invocations** | **125,000 / month** | The binding constraint. See §1 |
| Sync function timeout | **10 s** (Pro: 26 s) | Heavy queries and exports must be chunked |
| **Background Functions** | **Not available** (Pro only) | No 15-minute jobs. Payout batch and PDF generation must be redesigned |
| Scheduled Functions | Available, 30 s limit | Cadence gating by plan is **unconfirmed** — verify before relying on per-minute cron |
| **Function region** | **Locked to `cmh` (Ohio)** (Pro only) | Cannot use Singapore. Forces the DB to move — see §2 |
| Bandwidth | 100 GB / month | Not a concern at this scale |
| Build minutes | 300 / month | ~30–40 deploys. Tight with per-PR previews |
| Edge invocations | 1,000,000 / month | Middleware is fine |

### Neon Free

| Limit | Value | Consequence here |
|---|---|---|
| **Storage** | **0.5 GB per project** | See §3. The real ceiling on going live |
| Compute | 100 CU-hours / month (~400 h at 0.25 CU) | Tight once polling keeps the compute awake |
| Autoscaling | Up to 2 CU | Fine |
| **Scale-to-zero** | **Cannot be disabled.** Suspends after 5 min idle | Cold start on the first request after a quiet spell |
| **Point-in-time restore** | **6 hours / 1 GB history** | Effectively no disaster recovery — see §6 |
| Branches | 10 per project | Enough for a few concurrent PRs, not a large team |
| Egress | 5 GB / month | Fine |

## 1. The invocation budget — the binding constraint

Every SSR page load, server action, API call, poll and scheduled run is one
invocation against the same 125,000.

**The 10–15 s inventory poll in [ADR-0004](adr/0004-polling-not-sse.md) does not
fit.** The arithmetic:

```
invocations = associates × board_hours_per_day × (3600 / poll_seconds) × working_days
```

| Poll | Associates | Board hrs/day | Monthly | Verdict |
|---|---|---|---|---|
| 12 s | 200 | 8 | 124,800,000 | ~1000× over |
| 12 s | 10 | 1 | 78,000 | 62% of budget on polling alone |
| 30 s | 10 | 1 | 31,200 | Workable |
| **60 s** | **10** | **1** | **15,600** | **Target** |
| 60 s | 25 | 2 | 78,000 | Over, once app traffic is added |

And the hold-expiry sweep, specified at every minute:

```
every minute  = 43,200 / month   →  35% of the entire budget
every 5 min   =  8,640 / month
every 15 min  =  2,880 / month
```

### Free-tier budget

| Consumer | Allocation |
|---|---|
| Inventory delta poll, 60 s | ~16,000 |
| App traffic (SSR, actions, API) | ~40,000 |
| Hold expiry sweep, 5 min | ~8,600 |
| Daily sweeps (collections, grades, invariants) | ~100 |
| Payout run, chunked | ~2,000 |
| Headroom | ~58,000 |

**Envelope: roughly 10 concurrent associates.** Beyond that, upgrade.

### Required changes

- Poll interval **60 s**, not 10–15 s.
- **Pause on blur is mandatory**, not an optimisation. A background tab polling
  all day is now a budget item.
- Poll only while the inventory board is the visible route.
- Prominent **manual refresh** — an associate about to hold a unit taps it rather
  than waiting for the tick.
- Hold expiry sweep **every 5 minutes**. Lazy expiry on read already guarantees
  correctness ([06-INVENTORY-SPEC §3](06-INVENTORY-SPEC.md)); the sweep only
  materialises the audit row and the notification, so a slower cadence costs
  notification latency and nothing else.

## 2. Region — the database must move to Ohio

Functions are locked to `cmh` (Ohio) on Free. If Neon stays in Singapore every
query crosses the Pacific at ~200 ms, so a page issuing five queries spends a
full second on network alone.

**Move Neon to `aws-us-east-2` (Ohio).** Colocated, the function↔DB hop is ~1 ms
and the user pays the ~250 ms India→Ohio trip once per request rather than once
per query.

```
Free:  User (India) ──250ms──► Netlify cmh (Ohio)   ──1ms──► Neon us-east-2
Paid:  User (India) ──70ms───► Netlify sin (S'pore) ──1ms──► Neon ap-southeast-1
```

> **Compliance note.** This moves relational data from Singapore to the United
> States. Both are outside India and neither is currently restricted under DPDP,
> so the analysis in [11-COMPLIANCE-INDIA](11-COMPLIANCE-INDIA.md) is unchanged
> in kind — but the client should be told the data is US-hosted, not merely
> offshore. **Document storage has no India-region mitigation either**, since
> the project uses Netlify Blobs (no user-controlled region) rather than S3 —
> see [11-COMPLIANCE-INDIA](11-COMPLIANCE-INDIA.md) for the consequence.

## 3. Storage — 0.5 GB is the ceiling on going live

The append-only audit log is projected at ~5 M rows/year
([12-NFR](12-NFR.md)). At roughly 200–400 bytes per row with `before`/`after`
JSON, that is **1–2 GB/year from the audit log alone** — two to four times the
entire free allocation.

Auditing is a security control, not an optimisation. **Do not disable it to fit
the tier.**

Free-tier posture:

- Fine for development, seeded demo data, and a short pilot.
- **Storage is the trigger for going paid before real data lands.** Monitor from
  Phase 0; do not discover it during the migration weekend.
- Do not import legacy history ([14-DATA-MIGRATION](14-DATA-MIGRATION.md)) into a
  free-tier project.

## 4. No background functions

Background Functions are Pro-only, so the 15-minute ceiling assumed in
[ADR-0005](adr/0005-netlify-native-jobs-no-redis.md) is really **10 seconds**.

| Job | Paid design | Free-tier design |
|---|---|---|
| Payout batch | One background run, chunked | **Chained scheduled invocations.** Persist a cursor; each run does what fits in 10 s and enqueues the next |
| PDF generation | Background → Netlify Blobs | On demand within 10 s (`@react-pdf/renderer` handles a statement comfortably). Bulk generation chains |
| Report export | Async with download link | Cap synchronous exports; chain anything larger |

Chaining is more code than a background function, but it is genuinely more
robust: a chained job that dies resumes from its cursor, where a background
function that hits the ceiling loses the whole run. Build it this way and the
eventual upgrade becomes optional rather than forced.

## 5. Cold starts

Scale-to-zero cannot be disabled on Neon Free. After 5 minutes idle the first
query pays ~500 ms–2 s.

During business hours the 60 s poll keeps the compute awake — which is also why
compute-hours are tight. Outside business hours, the first associate each morning
absorbs it.

Acceptable for a pilot. **Not acceptable** for an associate standing in front of
a customer at scale, which is why disabling autosuspend is a paid-tier
requirement in [ADR-0001](adr/0001-nextjs-netlify-neon.md).

## 6. Disaster recovery is effectively absent

**6 hours of PITR, 1 GB of change history.** A problem noticed the next morning
is already past the window.

The RPO 1 h / RTO 4 h targets in [12-NFR](12-NFR.md) are **not met on the free
tier**, and no amount of engineering changes that.

Interim mitigation, mandatory once any real data exists:

- Nightly `pg_dump` to Netlify Blobs, retained 30 days. No India-region control (same gap as documents) and a 5 GB per-object ceiling worth watching as the database grows.
- The dump runs as a scheduled function — small, well within 30 s against a
  free-tier dataset.
- Restore drills run against the dump, not against PITR.

## 7. Revised targets while on free

Superseding [12-NFR](12-NFR.md) for as long as the free tier is in use:

| Metric | Paid target | Free-tier reality |
|---|---|---|
| Concurrent associates | 200 / 500 peak | **~10** |
| Inventory freshness | 10–15 s | **60 s** |
| Board first load p95 | < 1.5 s | < 3 s (Ohio round trip) |
| Delta poll p95 | < 200 ms | < 600 ms |
| Hold acquire p95 | < 500 ms | < 1.2 s |
| Cold start | None | 500 ms–2 s after idle |
| Payout batch | < 10 min | Chained; wall clock unbounded |
| RPO / RTO | 1 h / 4 h | **6 h / best-effort** |
| Storage | 200 GB/yr | **0.5 GB total** |

## 8. Upgrade triggers

Upgrade when **any one** of these is true. Do not wait for several.

| # | Trigger | Why it is the line |
|---|---|---|
| **T1** | Real customer or associate PII enters the database | 6-hour PITR is not an acceptable DR posture for KYC |
| **T2** | Storage passes **350 MB** (70%) | The ceiling is hard and there is no warning above it |
| **T3** | Invocations pass **90,000/month** (72%) | Hitting the cap stops the site, mid-month |
| **T4** | More than **10 concurrent associates** | Polling budget exhausted |
| **T5** | Legacy data import begins | Storage and DR, together |
| **T6** | First real payout batch | Chained runs against real money want the background-function guarantee |
| **T7** | Compute passes **80 CU-hours/month** | Compute exhaustion suspends the database |

Realistically **T1 and T5 arrive together**, at the start of the pilot. Plan for
the free tier to cover Phases 0–3 and the internal demo, and to upgrade before
Phase 4.

### Cost of upgrading

| | Monthly |
|---|---|
| Netlify Pro | ~$19 / member |
| Neon Launch | ~$19 |
| **Total** | **~$40 (₹3,500)** |

That unlocks region `sin`, background functions, a 26 s sync timeout, 10 GB
storage, 7-day PITR, and disabled autosuspend — every constraint in this
document.

> Against a project carrying 5 FTE for 20 weeks, ₹3,500/month is not a real
> saving. Free is a sensible choice **for the build**, and a poor one the day
> real money moves through the system.

## 9. Monitoring while on free

Add to [15-OPS-RUNBOOK](15-OPS-RUNBOOK.md), checked weekly:

| Metric | Alert at |
|---|---|
| Netlify function invocations, month to date | 72% (90,000) |
| Neon storage | 70% (350 MB) |
| Neon compute hours | 80% (80 CU-h) |
| Netlify build minutes | 80% (240) |

Hitting a Netlify hard limit stops the site. Exhausting Neon storage or compute
suspends the database. **Neither degrades gracefully** — these are alerts, not
dashboard tiles.

## 10. What does not change

Worth stating, because it is most of the system:

- The entire data model and `schema.prisma`
- The commission engine, its snapshots, and every golden-file test
- The partial unique indexes and the hold critical section — **correctness is
  unaffected by tier**
- Separation of duties and every security control
- Collections, the escalation ladder, and all business logic
- RBAC, audit logging, compliance handling

The free tier constrains **capacity and operational posture**, not correctness.
Nothing in this document is a reason to build the system differently — only to
run it smaller, and to know exactly when that stops being viable.

---

## 11. Job scheduling — do not depend on Netlify Scheduled Functions

Added after investigating whether sub-hourly cron is plan-gated.

### What the evidence actually shows

| Claim | Status |
|---|---|
| Scheduled functions require Pro | **Not confirmed.** Netlify docs state "available on all pricing plans" |
| Sub-hourly cadence is plan-gated | **Not confirmed.** Documented minimum interval is 10 s, no tier qualifier |
| Scheduled functions silently stop firing | **Reported.** [Thread 164978](https://answers.netlify.com/t/scheduled-functions-never-invoked-on-two-sites-schedules-registered-manual-triggers-work/164978) — two sites, schedules registered, manual triggers working, automatic invocation stopped |
| Cadence drifts off schedule | **Reported.** [Thread 114132](https://answers.netlify.com/t/netlify-scheduled-functions-cron-executing-at-31-29-31-29-intervals-instead-of-31-min-intervals/114132) — 31/29/31/29 min on a 31-minute schedule |

So the constraint is not a tier gate. It is **reliability, on every tier** — which
is a broader problem, because it also covers the daily collections sweep and the
nightly invariant monitor.

Two of these jobs must not quietly stop:

- **Collections escalation** — a ladder that stops firing means overdue payments
  go unchased, silently. Nobody notices until month-end.
- **Invariant monitor** — the control that exists precisely to catch silent
  failure. A silently-failing watchdog is worse than none, because it is trusted.

### Decision

**Job endpoints stay as plain HTTP handlers under `/api/jobs/*`, guarded by
`JOB_TRIGGER_SECRET`. The trigger moves off-platform.**

| Job | Cadence | Trigger |
|---|---|---|
| Hold expiry sweep | 5 min | GitHub Actions cron |
| Collections escalation | Daily 08:00 IST | GitHub Actions cron |
| Grade qualification | Daily 08:00 IST | GitHub Actions cron |
| Invariant monitor | Nightly 00:00 IST | GitHub Actions cron |
| `pg_dump` backup | Nightly 00:00 IST | GitHub Actions cron |
| Commission accrual / release | Event | In-request, after commit |
| Payout batch | On demand | Chained invocations, cursor-persisted (§4) |

Workflow: [`.github/workflows/scheduled-jobs.yml`](../.github/workflows/scheduled-jobs.yml).

**This is a better architecture regardless of tier.** The trigger becomes
pluggable — GitHub Actions today, cron-job.org or QStash if preferred, Netlify
Scheduled Functions if they become dependable — with no application change.
Coupling critical jobs to a platform feature was the mistake, not the choice of
which platform.

### Constraints of the replacement

- **GitHub Actions cron is best-effort** and can be delayed under load.
  Acceptable: every job is idempotent, and lazy expiry means the inventory board
  is never wrong between runs ([06-INVENTORY-SPEC §3](06-INVENTORY-SPEC.md)).
- **Scheduled workflows auto-disable after 60 days of repository inactivity.**
  Caught by the dead-man's switch below.
- **The invocation budget is unchanged.** An external trigger still consumes one
  Netlify invocation per call — §1's arithmetic stands.

### Dead-man's switch — mandatory

An external trigger fails differently from an in-platform one: it fails by
*absence*, which raises no error anywhere.

Every job records its last successful run. `/api/health` exposes those
timestamps, and the synthetic monitor treats a **stale timestamp as a failure**,
not just an HTTP 500.

| Job | Alert if no successful run within |
|---|---|
| Hold expiry sweep | 20 min |
| Collections escalation | 26 h |
| Grade qualification | 26 h |
| Invariant monitor | 26 h |
| Backup dump | 26 h |

Without this, the exact failure reported in thread 164978 — schedules registered,
nothing running — is invisible until someone asks why no alerts have gone out.

### Belt and braces

Correctness never depends on a job running:

- Hold expiry is **lazy on read**. The sweep only materialises the audit row and
  the notification.
- Accrual and release are **triggered in-request** after the booking or receipt
  commits, not by cron.
- Every job is **idempotent**, so a delayed or duplicated run is harmless.

The scheduler is a convenience layer over a system that is correct without it.
That was already the design; this change makes it load-bearing.
