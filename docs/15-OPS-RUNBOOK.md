# 15 — Operations Runbook

## Monitoring

| Layer | Tool |
|---|---|
| Errors | Sentry, with KYC-touching routes scrubbed |
| Function logs | Netlify → searchable log store |
| Uptime | External synthetic check against `/api/health`, every minute |
| Database | Neon metrics: connections, compute time, storage |

## Business alerts — not just infrastructure

Infrastructure alerts tell you the app is up. These tell you it is *correct*.
Both page.

| Alert | Condition | Severity |
|---|---|---|
| Accrual job failed | Any booking `CONFIRMED` > 15 min with no commission entries | **Page** |
| Payout batch stuck | Batch in `DRAFT` > 2 h during a run | **Page** |
| Invariant violated | Any nightly assertion fails | **Page** |
| **Job did not run** | Any job's last-success timestamp stale — see the dead-man's switch below | **Page** |
| Collections sweep missed | No `CollectionAlert` rows in 26 h | High |
| Holds not expiring | Any hold past `expiresAt` + 20 min still live | High |
| Verification queue backed up | > 20 receipts in `ENTERED` for > 24 h | Medium |
| Delta poll latency | p95 > 500 ms for 10 min | Medium |
| Neon connections | > 80% of pool | Medium |
| Failed logins | > 50 in 5 min | Security |
| Bulk export | > 5,000 rows exported by one user in an hour | Security |

## Free-tier quota alerts

The project runs on Netlify Free and Neon Free. Hitting a Netlify hard limit
**stops the site**; exhausting Neon storage or compute **suspends the database**.
Neither degrades gracefully, so these are alerts, not dashboard tiles. Check
weekly.

| Metric | Alert at | Ceiling |
|---|---|---|
| Netlify function invocations, month to date | 72% | 125,000 |
| Neon storage | 70% | 0.5 GB |
| Neon compute hours | 80% | 100 CU-h |
| Netlify build minutes | 80% | 300 |

These feed the upgrade triggers in [21-TIER-LIMITS §8](21-TIER-LIMITS.md).

## The nightly invariant monitor

A nightly job — external cron, see [21-TIER-LIMITS §11](21-TIER-LIMITS.md) —
runs every invariant from
[13-TEST-STRATEGY](13-TEST-STRATEGY.md) against production and pages on any
breach.

This is how a commission bug is found in week one instead of at month-end in
front of 200 associates. It is the single highest-value operational control in
the system — build it in Phase 3, not "later".

Output goes to a dashboard with history, so a slow drift is visible before it
becomes a breach.

## Backups

| Aspect | Setting |
|---|---|
| Mechanism | Neon point-in-time recovery |
| Retention | **6 hours on the free tier** (7 days on Pro) |
| Free-tier supplement | **Nightly `pg_dump` to Netlify Blobs, retained 30 days — mandatory once any real data exists.** No India-region control (same gap as documents, [11-COMPLIANCE-INDIA](11-COMPLIANCE-INDIA.md)); watch the 5 GB per-object limit as the database grows |
| Documents | Netlify Blobs. No built-in versioning or cross-region replication -- if either turns out to matter, that is a reason to reconsider the storage provider, not to build them by hand |
| **Restore drill** | **Quarterly** |

> An untested backup is not a backup. The quarterly drill restores to a scratch
> Neon branch, runs the invariant suite against it, and records the wall-clock
> time. That measured time is the real RTO — not the one in
> [12-NFR](12-NFR.md), which is an aspiration until a drill confirms it.

## Disaster recovery

Targets: **RPO 1 hour, RTO 4 hours.**

> **Not met on the free tier.** Neon Free provides 6 hours of PITR and 1 GB of
> change history — a problem noticed the next morning is already past the window.
> Until the upgrade, the nightly `pg_dump` above is the actual recovery
> mechanism, and restore drills run against it rather than against PITR.
> See [21-TIER-LIMITS §6](21-TIER-LIMITS.md).

| Scenario | Response |
|---|---|
| Bad deploy | Netlify instant rollback. App only — the database rolls forward, never back |
| Bad migration | Forward-fix migration. **Never `migrate reset` in production** |
| Data corruption | Restore to a Neon branch at a point in time, validate, cut over |
| Neon region outage | Restore into another region from PITR; update `DATABASE_URL`; expect degraded latency |
| Storage outage | Documents unavailable, app degraded but functional; bookings can continue |
| Total loss | Full runbook rehearsed in the quarterly drill |

## Routine operations

### Daily
Check overnight job results · check the invariant dashboard · check the receipt
verification queue depth.

### Monthly — payout run
1. Announce the freeze window to sales.
2. Open the period (tree and grade changes freeze automatically).
3. Run the batch. **Watch the wall clock against the 15-minute ceiling.**
4. Reconcile: total accrued, released, payable, recovered.
5. Preparer hands to approver. **Different person — the system enforces it.**
6. Export bank file / hand off to payroll.
7. Publish statements.
8. Close the period; the freeze lifts.

### Quarterly
Backup restore drill · access review (who holds privileged roles, and should
they) · secret rotation · dependency audit · TDS rate check against the current
Finance Act.

## Common incidents

| Symptom | First checks |
|---|---|
| "Unit shows available but won't hold" | Expired-hold sweep failing? Stale `currentHoldId`? Quota exhausted? |
| "My commission is missing" | Booking `CONFIRMED`? Accrual job ran? Release trigger fired? Receipt actually `clearedOn`? |
| "Two people hold the same unit" | **Check the partial unique index exists.** This is the failure mode if a migration dropped it |
| "Payout batch won't approve" | Approver is the preparer. Working as designed |
| "Board is stale" | Delta poll failing? Check `units.updated_at` index and function latency |
| "No alerts went out yesterday" | **Check the dead-man's switch first.** Then GitHub Actions run history — scheduled workflows auto-disable after 60 days of repo inactivity |
| "Holds aren't expiring" | Lazy expiry means the board is still correct. The sweep is what stopped — check the external cron, not the app |
| Commission looks wrong | Read `CommissionEntry.snapshot` first — it says exactly what was used |

## On-call

Business hours during Phases 4–5, then per the agreed support SLA.

Escalation: on-call engineer → tech lead → client's IT contact.

Anything touching money — payout, receipt, commission — escalates immediately
rather than waiting for a second occurrence.

## Deployment

Trunk-based. `main` auto-deploys to staging; production on tag.

Pre-deploy runs `prisma migrate deploy` against **`DATABASE_URL_UNPOOLED`**.
Running migrations through the pooler is the classic deploy-day failure.

Breaking schema changes use expand–contract: add column → backfill → switch reads
→ drop in a later release. Never a destructive migration in a single release.

## Health check

`GET /api/health` returns database connectivity, the last successful run of each
job, and pending queue depth.

### Dead-man's switch — mandatory

Jobs are triggered by **external cron** (GitHub Actions), because Netlify
Scheduled Functions have been reported to stop firing silently
([21-TIER-LIMITS §11](21-TIER-LIMITS.md)).

An external trigger fails by **absence**, which raises no error anywhere. So the
synthetic monitor treats a **stale timestamp as a failure**, not just an HTTP 500:

| Job | Page if no successful run within |
|---|---|
| Hold expiry sweep | 20 min |
| Collections escalation | 26 h |
| Grade qualification | 26 h |
| Invariant monitor | 26 h |
| Backup dump | 26 h |

Without this, "schedules registered, nothing running" is invisible until someone
notices the alerts stopped going out.

Also watch for GitHub Actions **auto-disabling scheduled workflows after 60 days
of repository inactivity** — a quiet period on a stable system is exactly when
this bites.
