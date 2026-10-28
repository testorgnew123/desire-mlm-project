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

> An untested backup is not a backup. The quarterly drill fetches the latest
> `backups/{date}.json` blob and restores it into a scratch Postgres database
> (a free Neon branch, or local Docker Postgres) via
> `packages/db/scripts/restore-drill.ts`, then records the wall-clock time.
> That measured time is the real RTO — not the one in [12-NFR](12-NFR.md),
> which is an aspiration until a drill confirms it.
>
> **First real drill run: 2026-09-14.** Fetched the actual nightly backup
> blob from production (59 tables, taken 2026-09-13), restored all 38
> non-empty tables into a scratch local Postgres database via the script's
> dependency-order retry loop (no hardcoded table order — repeated passes
> until nothing more can progress). **Every row restored correctly, verified
> by row count per table plus a spot-check against known content** (unit
> count, organization name). Wall clock: **under 5 seconds** for the restore
> itself (schema migration apply is separate and takes a few seconds more).
> One real bug was found and fixed *during* the drill — exactly what a drill
> is for: a JSON-array-valued column (`PriceListItem.otherCharges`) was
> being bound as a native Postgres array instead of JSON text, which the
> real Postgres column rejected outright. Fixed by keeping an explicit
> allowlist of the schema's actual `String[]` columns and treating every
> other JS array as JSON. This RTO figure is against today's (dev/demo
> scale) dataset — re-run once real data volume exists, per
> [22-LOAD-TEST-RESULTS](22-LOAD-TEST-RESULTS.md)'s own caveat about
> today's numbers being a floor, not a ceiling.

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

Trunk-based. Merging to `main` deploys **production**: Netlify builds `main` and
publishes it once the build finishes. A pull request gets a deploy preview with its
own Neon branch (`neon-preview-branches.yml` creates and migrates it).

A production build applies pending Prisma migrations **before** it builds the app.
`netlify.toml` calls `packages/db/scripts/migrate-on-deploy.sh` between
`prisma generate` and the app build; it runs `prisma migrate deploy` through
**`DATABASE_URL_UNPOOLED`** (running migrations through the pooler is the classic
deploy-day failure). Netlify only publishes a build that finished, so the schema is
always in place before the code that reads it goes live. Previews are skipped, and
a production build with no `DATABASE_URL_UNPOOLED` (Builds scope) **fails** instead
of skipping, which leaves the previous deploy serving.

Until 2026-10-26 nothing in the repository did this for Netlify, although this
section said it did: PR 8 went live with code that reads `users.mustChangePassword`
before the hosted database had the column, and new sign-ins failed until the
migration was applied by hand.

Right after the migrations the same script runs the **role sync**
(`packages/db/src/sync-roles.ts`, `scripts/sync-roles.ts`): for every organisation it
adds the permissions, roles and role grants the permission matrix has and the database
lacks, through `DATABASE_URL_UNPOOLED`, retrying the first connect (a Neon database may
still be waking). Roles are rows that nothing else updates after the first seed, so a
role added in code (Admin, 2026-10-25) never existed in production: the Users screen
offered it and the save failed with *Role "ADMIN" is not configured for this
organisation*. The sync is **add-only** (it never removes a grant, a role or a user’s
role; grants a role holds beyond the matrix are only listed in the build log) and
idempotent, and a failure fails the build like a failed migration. A preview database
gets the same sync from `neon-preview-branches.yml`. To look without changing anything:
`pnpm db:sync-roles` is a dry run; `-- --apply` performs it. Moving people off the old
roles and removing grants is still `narrow-roles.ts`, by hand, with a go-ahead.

Last, the script gives every Admin and Super Admin who has no associate profile one
(`apps/web/scripts/ensure-admin-associates.ts`), because those roles can hold and book
plots too and a hold is recorded against an associate profile. Add-only and
idempotent, and **not** fatal: a failure (for example no grade exists yet) only means
an admin cannot hold until the next deploy, so it never withholds a build. A preview
branch gets the same step from the workflow. Dry run:
`pnpm --filter @desire/db exec tsx ../../apps/web/scripts/ensure-admin-associates.ts`.

Breaking schema changes use expand–contract: add column → backfill → switch reads
→ drop in a later release. Never a destructive migration in a single release. Because
migrations now run before the new code is published, the OLD code must keep working
against the NEW schema for the length of a build, which is what expand–contract gives.

### A migration failed on deploy

The build fails and the previous deploy keeps serving. Postgres runs a migration file
as one implicit transaction, so a failed migration normally leaves the schema as it
was, but Prisma records it as failed in `_prisma_migrations` and every later
`migrate deploy` refuses to run until that is resolved. Read the failed build log,
correct the migration file (it did not apply, so editing it is fine), then against the
unpooled hosted URL run
`prisma migrate resolve --rolled-back <migration_name>` and redeploy. If part of it
did apply (a non-transactional statement such as `CREATE INDEX CONCURRENTLY`),
correct the schema by hand and use `--applied` instead.

## Email

Everything the app mails goes through one SMTP account (`packages/services/src/email.ts`):

| Mail | When | Who gets it |
|---|---|---|
| Login ID and temporary password | An admin creates a user, or resets their password | The user |
| Password-reset link | "Forgot password" on the sign-in page | The user |
| Booking waiting | An associate (or admin) books a plot | Every active or invited user who can confirm bookings, except the person who booked |
| Booking confirmed | An admin confirms | The customer (if an email was entered) and the selling associate |
| Booking cancelled | An admin cancels | The selling associate |
| Scheduled reports | The saved-report job | The recipients on the saved view |

**Settings** (Netlify > Site configuration > Environment variables). Give them the **Functions** and **Runtime** scopes, not only *Builds*: the app reads them while serving requests, and a variable that exists only at build time looks set in the dashboard and is missing where mail is sent.

| Variable | Needed | What |
|---|---|---|
| `SMTP_HOST` | yes | The provider's SMTP server |
| `SMTP_PORT` | yes | `587` (STARTTLS) or `465` (SSL) |
| `SMTP_USER`, `SMTP_PASSWORD` | usually | The login (an app password or SMTP key, not a personal password) |
| `MAIL_FROM` | yes | The From address; the provider must allow sending as it (a verified sender or domain) |
| `APP_BASE_URL` | yes | The site's public address, no trailing slash: password-reset links and the "open it" link in mail are built from it |

A provider with a free tier, or the client's own mail hosting, is enough at this volume.

**Proving it works:** sign in as an Admin or Super Admin and open **Admin > Email**. It shows which settings are set (never their values) and sends one real test message, saying exactly why it failed if it does: a refused login, an unreachable server, a name that does not resolve, a sender the server will not accept. Do this after setting or changing any variable, and after each deploy that touches mail. Then create a throwaway user and press "Forgot password" on the sign-in page.

**Behaviour to know:**
- Mail never blocks the action. A booking is still made and confirmed, an account still created, if the mail server is down or slow; the person just does not get the email. Account mail shows the admin the temporary password once when it could not be sent. Booking mail waits at most 4 seconds in total.
- With no SMTP settings nothing is attempted and nothing is slowed.
- Without `APP_BASE_URL` the forgot-password link cannot be sent.
- The booking and account mails carry no document attachments and no KYC data.
- To try mail without a provider: `node apps/web/scripts/smtp-sink.mjs`, run the app with `SMTP_HOST=127.0.0.1 SMTP_PORT=2525 MAIL_FROM=noreply@desire.test APP_BASE_URL=http://localhost:3000`, and read what was sent at `http://127.0.0.1:2526/last?to=<address>`.

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
