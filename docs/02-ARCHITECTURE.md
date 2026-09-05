# 02 — Architecture

## Stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 15, App Router, TypeScript strict | One repo, server actions for mutations, RSC for heavy inventory grids |
| Hosting | Netlify, Next.js Runtime v5 | See [ADR-0001](adr/0001-nextjs-netlify-neon.md) |
| DB | Neon Postgres. **`aws-us-east-2` on the free tier** (colocated with functions in Ohio); `ap-southeast-1` once on Pro | Serverless pooling, DB branch per PR. **No India region** — see [11-COMPLIANCE-INDIA](11-COMPLIANCE-INDIA.md) and [21-TIER-LIMITS](21-TIER-LIMITS.md) |
| ORM | Prisma | Typed schema; migration history doubles as a change record |
| Jobs | **External cron (GitHub Actions) → guarded HTTP endpoints.** No Redis, no worker process | Netlify Scheduled Functions are not dependable — [ADR-0005 amendment](adr/0005-netlify-native-jobs-no-redis.md), [21-TIER-LIMITS §11](21-TIER-LIMITS.md) |
| Auth | Auth.js self-hosted + TOTP | Own the session store; no third-party PII processor |
| Files | S3 `ap-south-1` (Mumbai) | KYC and agreements stay India-resident |
| PDF | `@react-pdf/renderer` | Pure JS; Chromium will not fit a function bundle |
| RBAC | Permission matrix table + CASL | Sales orgs restructure constantly |
| Realtime | Delta polling, **60 s on the free tier** | See [ADR-0004](adr/0004-polling-not-sse.md) and [21-TIER-LIMITS §1](21-TIER-LIMITS.md) |
| Errors | Sentry + structured JSON logs | |

## Repo shape

```
.github/workflows/        external cron triggers for scheduled jobs
apps/web
  app/                    routes (RSC + server actions)
  app/api/jobs/           job handlers, secret-guarded, idempotent
packages/db               Prisma schema, migrations, seed
packages/commission       PURE. No I/O. The engine.
packages/tax              India tax rules: GST, TDS 192/194H/194J
packages/services         business logic; the only layer that touches the DB
packages/ui               shared components
```

Single deployable. No separate worker process.

### The layering rule

```
route handler / server action   →  packages/services  →  packages/db
                                          ↓
                                   packages/commission (pure)
                                   packages/tax        (pure)
```

- **Route handlers and server actions contain no business logic.** They validate
  input, resolve the actor, call a service, shape a response.
- **Services own transactions, authorization and audit.** Every service method
  takes an actor and asserts permission. Nothing bypasses this layer.
- **`packages/commission` never imports Prisma.** It takes a resolved input
  object and returns entries. This is not stylistic — it is what allows golden-file
  testing and byte-identical reproduction of historical runs.

## Non-negotiable cross-cutting rules

**Money is `Decimal(18,2)`.** Never `Float`, never `Number`. Prisma `Decimal` in
app code, `NUMERIC(18,2)` in Postgres. `ROUND_HALF_UP` at 2dp. Rounding residual
belongs to the company.

**Every table carries `orgId`.** Single-tenant today. This makes Postgres RLS a
configuration change later rather than a migration.

**Financial rows are append-only.** No `UPDATE` on a commission entry, a receipt
allocation, or a payout line. Corrections are contra rows.

**Every mutation writes an `AuditLog`** with actor, entity, before/after JSON, and
a request id.

**Effective-dated assignments are never overwritten.** Close the current row
(`validTo`), insert a new one.

## Constraints Prisma cannot express

Two partial unique indexes must be added by hand in Phase 0. Both are correctness
guarantees, not optimisations.

```sql
-- One live hold per unit. Without this, two associates tapping Hold in the
-- same second both succeed.
CREATE UNIQUE INDEX one_active_hold_per_unit
  ON unit_holds (unit_id) WHERE released_at IS NULL;

-- Postgres treats NULLs as distinct, so a plain unique constraint would let the
-- same org-wide role be granted to a user twice.
CREATE UNIQUE INDEX user_role_org_wide
  ON user_roles (user_id, role_id) WHERE project_id IS NULL;
CREATE UNIQUE INDEX user_role_scoped
  ON user_roles (user_id, role_id, project_id) WHERE project_id IS NOT NULL;
```

## Jobs

Every job is a plain HTTP handler under `/api/jobs/*`, guarded by
`JOB_TRIGGER_SECRET`. The trigger is deliberately external and pluggable.

| Job | Trigger | Cadence |
|---|---|---|
| Hold expiry sweep | GitHub Actions cron | Every 5 min |
| Collections escalation | GitHub Actions cron | Daily 08:00 IST |
| Grade auto-qualification | GitHub Actions cron | Daily 08:00 IST |
| Invariant monitor | GitHub Actions cron | Nightly |
| `pg_dump` backup | GitHub Actions cron | Nightly |
| Commission accrual | **In-request, after booking commit** | Event |
| Commission release | **In-request, after receipt clears** | Event |
| Payout batch | Chained invocations, cursor-persisted | On demand |
| PDF generation | On demand within the sync timeout | Event |

Nothing that touches money waits on a scheduler. Accrual and release fire
in-request after the transaction commits.

Netlify limits by plan: **10 s** synchronous on Free (26 s on Pro), **30 s**
scheduled, and **15 min** background — but **Background Functions are Pro-only**.
On the free tier the payout batch runs as chained scheduled invocations with a
persisted cursor. See [21-TIER-LIMITS §4](21-TIER-LIMITS.md).

Job handlers stay thin — they call services. Because the trigger is external
HTTP, swapping GitHub Actions for cron-job.org, QStash, or a Render worker is a
configuration change, not a rewrite.

**An external trigger fails by absence.** Every job records its last successful
run; `/api/health` exposes the timestamps and a stale one is an alert. See
[15-OPS-RUNBOOK](15-OPS-RUNBOOK.md).

## Deployment topology

```
Browser / PWA
      ↓ HTTPS
Netlify Edge Function (middleware)          ← Deno, at the edge
      ↓
Netlify Function, region sin (Singapore)    ← Next.js SSR / actions / API
      ↓                        ↓
Neon Postgres                  S3 ap-south-1 (Mumbai)
aws-ap-southeast-1 (pooled)    documents, KYC — India-resident
```

Function region and DB region are deliberately the same, so the function↔DB round
trip stays in single-digit milliseconds. Only the user↔edge hop crosses water
(~60–80 ms Mumbai→Singapore).

**Region selection is a Pro feature.** On the free tier functions are locked to
`cmh` (Ohio), so Neon must be colocated in `aws-us-east-2` rather than Singapore —
otherwise every query crosses the Pacific. See
[21-TIER-LIMITS §2](21-TIER-LIMITS.md).

Neon autosuspend **cannot be disabled on the free tier** (5 min scale-to-zero),
so cold starts are a fact of life until the upgrade. On Pro, disable it — a cold
start while an associate stands in front of a customer is not acceptable.
