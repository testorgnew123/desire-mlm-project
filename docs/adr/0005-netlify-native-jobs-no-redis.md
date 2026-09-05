# ADR-0005 — Netlify-native jobs, no Redis or BullMQ

**Status:** Accepted, **amended** — see "Amendment: the scheduler moves off-platform"
**Date:** 2026-09-05

## Context

The system needs background work: hold expiry, commission accrual and release,
the daily collections sweep, payout batches, PDF generation, notifications, and
a nightly invariant check.

The reflexive design is BullMQ on Redis with a long-running worker process.

## Decision

No Redis, no BullMQ, no worker process. Use Netlify's own primitives.

| Job | Mechanism | Cadence |
|---|---|---|
| Hold expiry sweep | Scheduled Function | Every minute |
| Collections alert sweep | Scheduled Function | Daily |
| Grade auto-qualification | Scheduled Function | Daily |
| Invariant monitor | Scheduled Function | Nightly |
| Commission accrual | Async Workload | On booking confirm |
| Commission release | Async Workload | On receipt clear |
| Payout batch | Background Function, **chunked** | On demand |
| PDF generation | Background Function → Netlify Blobs | Event |

## Why

**A serverless platform has no process to run a worker loop.** Hosting BullMQ
would mean a second deployment target — Render or Railway — with its own
pipeline, secrets, monitoring and on-call surface. That is real permanent
overhead for a five-person team.

**The limits fit — on Pro.** 30 s scheduled and 15 min background cover
everything here.

**On the free tier they do not.** Background Functions are Pro-only and the
synchronous ceiling is 10 s, so the payout batch and bulk PDF generation run as
**chained scheduled invocations with a persisted cursor** instead. See
[21-TIER-LIMITS §4](../21-TIER-LIMITS.md).

That is more code, but strictly more robust: a chained job that dies resumes from
its cursor, where a background function that hits the ceiling loses the run.
Build it chained and the upgrade becomes optional rather than forced.

**It removes a component.** Fewer moving parts is worth more than queue
sophistication on a system whose real risks are commission correctness and
adoption, not throughput.

## Consequences

**Payout batch must be chunked, not just "expected to fit".** Process N
associates per invocation and chain. Phase 4 measures the actual wall clock
against the 15-minute ceiling and tunes N from the measurement.

**No sophisticated retry or dead-letter semantics** out of the box. Compensated
by making every job **idempotent** — accrual is unique on
`{bookingId}:{beneficiaryId}:{level}:{schemeId}`, release is unique on
`(entry, triggerType, triggerRef)`, alerts are unique on `(demand, rung)`.
Idempotency is a stronger guarantee than retry semantics anyway.

**No queue dashboard.** Replaced by business alerts in
[15-OPS-RUNBOOK](../15-OPS-RUNBOOK.md): "any booking CONFIRMED for 15 minutes with
no commission entries" catches a failed accrual more directly than a queue depth
graph would.

**Job endpoints are HTTP**, so they need protecting. `JOB_TRIGGER_SECRET` is
mandatory on every one — otherwise anyone on the internet can trigger a payout
run.

**Scheduled functions can be missed.** Hence lazy expiry on holds: reads treat
`expiresAt < now()` as available regardless of whether the sweep ran. The sweep
materialises the audit trail and the notification; correctness does not depend
on it.

That property pays off on the free tier, where the sweep drops from every minute
to every 5 minutes to stay inside the invocation budget. Only notification
latency changes — the board is never wrong.

## The exit route, kept open deliberately

Job handlers stay thin — they call into `packages/services` and hold no logic of
their own.

If the payout batch ever outgrows 15 minutes, standing up a Render worker against
the same Neon database is a deploy change, not a rewrite. That property is worth
preserving even though we expect never to use it.


---

## Amendment — the scheduler moves off-platform

**Date:** 2026-09-05

### What changed

Investigating whether sub-hourly cron is plan-gated turned up something broader.
Netlify Scheduled Functions are **not** tier-gated — the docs say all plans, 10 s
minimum — but there are reports of them
[silently ceasing to fire](https://answers.netlify.com/t/scheduled-functions-never-invoked-on-two-sites-schedules-registered-manual-triggers-work/164978)
and [drifting off cadence](https://answers.netlify.com/t/netlify-scheduled-functions-cron-executing-at-31-29-31-29-intervals-instead-of-31-min-intervals/114132).

Combined with Background Functions being Pro-only, two of the three Netlify
primitives this ADR chose are unavailable or undependable.

### The decision that stands

**No Redis, no BullMQ, no worker process.** That reasoning is unaffected — it was
about not running a second deployment target, and it still holds.

### The decision that changes

Job endpoints remain plain HTTP handlers under `/api/jobs/*` guarded by
`JOB_TRIGGER_SECRET`. **The trigger moves to external cron** — GitHub Actions,
via [`.github/workflows/scheduled-jobs.yml`](../../.github/workflows/scheduled-jobs.yml).

Accrual and release move from Async Workloads to **in-request invocation after
commit**, so nothing that touches money waits on a scheduler at all.

Detail: [21-TIER-LIMITS §11](../21-TIER-LIMITS.md).

### Why this is better, not merely a workaround

The original design coupled critical jobs to a platform feature. The amended one
makes the trigger **pluggable**: GitHub Actions today, cron-job.org or QStash if
preferred, Netlify Scheduled Functions if they mature — with no application
change.

The mistake was the coupling, not the platform.

### New obligation

An external trigger fails by **absence**, which raises no error. A dead-man's
switch is therefore mandatory: every job records its last successful run,
`/api/health` exposes the timestamps, and a stale timestamp is treated as a
failure. Thresholds in [21-TIER-LIMITS §11](../21-TIER-LIMITS.md).

Without it, "schedules registered, nothing running" is invisible until someone
notices the alerts stopped.
