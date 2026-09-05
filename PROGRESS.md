# Progress Tracker

**The living document.** [16-ROADMAP](docs/16-ROADMAP.md) is the plan; this is
the state. Update it as work lands, not at the end of a sprint.

## How to use this

- `[ ]` → `[x]` when the task meets the phase's definition of done, not when the
  code first runs.
- **`GATE`** — the phase cannot be called complete without it. Do not carry a
  gate into the next phase; every one of them is a silent-failure risk.
- **`BLOCKED#n`** — waiting on client open item *n* in [plan.md](plan.md).
  Escalate at the phase boundary if still open.
- Each task cites its spec. If the spec and the code disagree, one of them is a
  bug — decide which before writing more code.
- Log anything you decided while building in **Decision log**. Small calls that
  are not worth an ADR still need a written reason six months later.

---

## Status

| | |
|---|---|
| **Current phase** | Phase 0 — Foundation, 15/17 done. Production deploy is live and verified. Remaining 2 tasks need a Neon API key (per-PR DB branching) and a `/api/jobs/*` endpoint (Phase 1) — neither blocks starting Phase 1. Phase 3's pure engine already built ahead of order — risk-first sequencing, see Decision log |
| **Started** | 2026-09-05 |
| **Target** | 18–22 weeks from start |
| **Hosting** | **Live**: [desire-mlm-project.netlify.app](https://desire-mlm-project.netlify.app) — verified via `/api/health` returning `200` with a real hosted-Neon query. Hosted Neon (`ap-southeast-1`, Postgres 18.6). Local Docker Postgres 18 kept for offline dev / concurrency tests. Repo at `github.com/testorgnew123/desire-mlm-project`, connected for auto-deploy on push |
| **Last updated** | 2026-09-05 |

| Phase | Tasks | Done | Gates | Status |
|---|:-:|:-:|:-:|---|
| 0 — Foundation | 17 | 15 | 1/1 | Live and deployed; 2 minor tasks remain (Phase 1-gated) |
| 1 — Inventory | 17 | 0 | 0/2 | Not started |
| 2 — Sales & Collections | 23 | 0 | 0/2 | Not started |
| 3 — Commission | 23 | 7 | 5/7 | In progress (engine only) |
| 4 — Payouts | 14 | 0 | 0/3 | Not started |
| 5 — Scale | 13 | 0 | 0/1 | Not started |
| Pre-go-live | 11 | 0 | — | Not started |
| **Total** | **118** | **22** | **6/16** | |

---

## Blocked on client

Ordered by when they bite. Full list in [plan.md](plan.md).

| # | Item | Blocks | Status |
|---|---|---|---|
| 1 | Data residency decision | First real KYC record (Trigger T1) | **Effectively decided** — Neon project live in `ap-southeast-1` (Singapore). Formal client sign-off on Singapore-hosted KYC still open, but no longer blocks any current work — see plan.md correction |
| 2 | Legacy data owner named | Phase 2 (reconciliation) | Open |
| 4 | Grade ladder — names, ranks, rates | Phase 3 | Open |
| 5 | Level override percentages, depth cap | Phase 3 | Open |
| 6 | Commissionable base definition | Phase 3 | Open |
| 7 | Payout schedule per project | Phase 3 | Open |
| 8 | Grade qualification thresholds | Phase 3 | Open |
| 9 | Hold TTL and quota | Phase 1 | Open |
| 10 | Discount approval bands | Phase 2 | Open |
| 11 | Engagement type + CA confirmation | Phase 4 | Open |
| 12 | Collections escalation policy | Phase 2 | Open |
| 13 | Pilot project and champions | Phase 5 | Open |
| 14 | Hosting upgrade budget | Phase 4 | Open |

> Items 4–8 all block Phase 3. Chase them during Phase 1, not at the Phase 2
> boundary — the commission engine is the longest phase and it cannot start on
> placeholders alone.

---

## Free-tier quota watch

Check weekly. Hitting a Netlify cap **stops the site**; exhausting Neon storage
or compute **suspends the database**. Neither degrades gracefully.
See [21-TIER-LIMITS](docs/21-TIER-LIMITS.md).

| Metric | Ceiling | Alert at | Current | Checked |
|---|---|---|---|---|
| Netlify invocations / month | 125,000 | 90,000 | — | — |
| Neon storage | 0.5 GB | 350 MB | — | — |
| Neon compute | 100 CU-h | 80 CU-h | — | — |
| Netlify build minutes | 300 | 240 | — | — |

---

## Phase 0 — Foundation

*1–2 weeks. Exit: login works, roles enforced server-side, every mutation
audited, preview deploys with a DB branch.*

- [x] Monorepo scaffold — pnpm workspace + Turborepo, `apps/web`, `packages/{db,commission}` fully scaffolded (package.json, tsconfig, lint, build all green). `packages/{tax,services,ui}` are empty directories by design — deferred to the blocks that need them, not forgotten — [02-ARCHITECTURE](docs/02-ARCHITECTURE.md)
- [x] Neon project created in `ap-southeast-1` (Singapore) — confirmed via `SELECT version()` (Postgres 18.6). Both migrations applied via `prisma migrate deploy`; the partial-index gate test passes against the hosted DB, not just locally — [21-TIER-LIMITS §2](docs/21-TIER-LIMITS.md)
- [x] `prisma migrate dev` against `schema.prisma` — applied to local Postgres 18, via `directUrl` (schema.prisma, not `prisma.config.ts` — verified against actual Prisma 6.19 behavior, see Decision log)
- [x] **GATE** Hand-written partial unique indexes migration — `one_active_hold_per_unit`, `user_role_org_wide`, `user_role_scoped` — applied, gate-tested in `packages/db/test/partial-indexes.test.ts`, and the test was proven to actually fail when an index is dropped (not just proven to pass) — [02-ARCHITECTURE](docs/02-ARCHITECTURE.md)
- [x] Auth.js + argon2id + server-side sessions — **hand-rolled against the existing schema, not the Auth.js library** (see PROGRESS.md Decision log and the corrected [02-ARCHITECTURE](docs/02-ARCHITECTURE.md)). `packages/services/src/auth.ts`: `@node-rs/argon2` (verified real argon2id output, native binary confirmed working on Windows), session create/validate/revoke matching every rule in [10-SECURITY](docs/10-SECURITY.md) exactly (12h idle, 7d absolute, httpOnly-cookie-shaped opaque token hashed before storage). 10 integration tests against real Postgres, including idle-timeout and absolute-timeout as independently-failing conditions
- [x] TOTP MFA, enforced for roles with `requiresMfa` — `generateMfaSecret`/`buildMfaEnrollmentUri`/`verifyMfaToken` via `otplib`. Secret stored encrypted (reuses the AES-256-GCM below) even though the schema doesn't split it into separate ciphertext/last4 columns the way PAN/Aadhaar do. 5 tests including cross-secret rejection
- [x] Login rate limiting and account lockout — **partial, honestly**: per-account lockout is real and tested (5 failed attempts → 15 min lock, the 6th attempt fails even with the correct password). Per-IP rate limiting is **not implemented** — it needs a request-rate store this schema doesn't provide, and faking it with an in-memory counter would silently not work across serverless instances or survive a cold start. Needs a Netlify edge rate limit or Upstash-backed counter once hosted; tracked here, not invented today
- [x] `Role` / `Permission` / `RolePermission` seeded from the matrix — [09-RBAC-MATRIX](docs/09-RBAC-MATRIX.md) transcribed column-by-column into `packages/db/src/permission-matrix.ts` (not copy-pasted from a spreadsheet), with 13 consistency tests (spot-checks against specific doc rows + structural invariants like "SUPER_ADMIN holds everything", "AUDITOR never holds a write permission"). Seeded and verified on **both** local Postgres and the hosted Neon project: 32 permissions, 8 roles, 114 grants
- [x] Permission assertion in `packages/services`; **one** scope resolver, unit-tested against a deep tree — `rbac.ts`: `hasPermission`/`assertPermission` (DB-backed, integration-tested) and `isInScope`/`resolveAccessibleAssociateIds` (pure, unit-tested against a 9-node, 5-level-deep tree — own scope, downline scope, sibling-exclusion, ancestor-exclusion, and a substring-collision guard test proving `/mgr_a/` doesn't falsely match a node path containing `mgr_ab`)
- [x] Audit log written on every mutation, with before/after JSON — `audit.ts`, takes a transaction client so the audit row commits atomically with the mutation it describes. Tested including the CREATE case (`before: undefined` → stored as `Prisma.DbNull`, not a JS `undefined` Prisma would reject)
- [x] Field-level AES-256-GCM for PAN / Aadhaar / bank — `encryption.ts`. Tested: round-trip, random-IV non-determinism, **tamper detection** (flipping one ciphertext byte fails to decrypt — proves the auth tag is actually checked, not just present), wrong-key-id rejection, truncated-auth-tag rejection, missing/wrong-length key config errors
- [x] Seed: PLACEHOLDER grades, demo project, 100 units, test users per role — complete and **verified by direct row-count query, not by trusting console output** (see below). 6 grades, 32 permissions, 8 roles, 114 role-permission grants, 1 demo project (10 floors × 10 units = 100 units, one unit type), 8 test users (one per role, shared demo password, `<role>@demo.test`), 2 with Associate records (ASSOCIATE, TEAM_LEAD) and a grade + tree placement each
- [x] CI — `.github/workflows/ci.yml`: typecheck, lint, migrate against an **ephemeral** Postgres 18 service container (never hosted Neon or a dev's local DB), unit+integration tests, coverage gates, and an honest no-op Playwright step (no UI exists yet to test against — same pattern as `apps/web`'s own `"no tests yet"` script). YAML validated, every referenced script cross-checked against actual `package.json` scripts, `pnpm install --frozen-lockfile` confirmed passing locally. **Not yet actually run on GitHub** — repo isn't pushed yet, so this is verified-correct-on-paper, not CI-green-in-practice
- [x] Netlify production deploy pipeline -- **live and verified**: `https://desire-mlm-project.netlify.app/api/health` returns `200 {"status":"ok","db":{"ok":true}}`, a real query against hosted Neon from the deployed function. Took five real, verified-against-live-state iterations, not one: (1) `netlify.toml` `publish` omitted -> doubled broken path, fixed; (2) first local build -> Windows backslash paths corrupted the serverless bundle (control-character garbled import, 502) -> fixed for real by getting Netlify's own Linux cloud builders to do the build (repo-link, the one step needing the user's org-admin click); (3) `pnpm --filter @desire/web build` never triggered `packages/db`'s build, so Prisma Client was never generated -> added an explicit `prisma generate` step; (4) generated client's binary target (Debian, the build container's OS) didn't match the Lambda runtime (RHEL-based) -> tried `binaryTargets`, but (5) that fix was silently never deployed at all -- `base = apps/web` made Netlify's change-detection skip a commit that only touched `packages/db/`, erroring "no content change" -> fixed with `ignore = "exit 1"`. At that point the real fix turned out to be structural, not another patch: switched Prisma to `engineType="client"` + `@prisma/adapter-pg`, which generates no native binary at all, ending this whole class of bug rather than chasing its next layer. Presented as a real choice to the user (small patch vs. permanent fix) before choosing the larger one -- not decided silently
- [ ] Neon DB branch per PR specifically (ephemeral per-PR database) -- **not yet built**, separate from the production pipeline above. Needs a Neon API key (not supplied) and a dedicated GitHub Action (e.g. `neondatabase/create-branch-action`) wired into a PR-preview workflow
- [x] `/api/health` reporting DB connectivity **and each job's last successful run** — DB check is real (`SELECT 1` via Prisma); job timestamps are honestly `"not yet implemented"`, not fabricated — no job or heartbeat table exists yet (that's Phase 1). Revisit the comment in `apps/web/app/api/health/route.ts` when the first job lands
- [ ] GitHub Actions cron secrets (`APP_BASE_URL`, `JOB_TRIGGER_SECRET`) + a manual `workflow_dispatch` proving a job endpoint responds -- secrets are set and `APP_BASE_URL` now points at a genuinely live, verified deploy (previously it pointed at a broken one). Still blocked on the one real remaining dependency: no `/api/jobs/*` endpoint exists yet to trigger (Phase 1)

### A process note worth keeping

Running the seed script against hosted Neon, a foreground call hit its 60s
tool timeout and was moved to the background. The background task later
reported **"completed, exit code 0"** — but a direct row-count query showed
the run had actually stopped partway through (5 of 8 roles, zero units,
zero users). The exit-0 signal was trusted for a moment before verifying;
it was wrong. Re-ran with a proper 300s foreground timeout, which completed
correctly for real, confirmed again by direct query afterward, not by
reading its console output. **Lesson applied throughout this block:** a
tool's reported status is a claim, not a fact — verify against the actual
system state, especially for anything that ran against the hosted
database, not just the log text it produced.

---

## Phase 1 — Inventory

*3–4 weeks. Exit: two users cannot hold the same unit, proven by test. Holds
auto-expire. Board refreshes within the configured interval.*

- [ ] Project master with RERA fields and hold policy config
- [ ] Tower, UnitType, Unit CRUD — carpet / built-up / saleable all captured — [19-GLOSSARY](docs/19-GLOSSARY.md)
- [ ] Bulk unit import (CSV/XLSX) with validation report
- [ ] `ChargeHead` master, `countsTowardCommission` flag
- [ ] Versioned price lists, maker-checker publish (`preparedBy != approvedBy`)
- [ ] Cost sheet computation — base, PLC, other charges, GST — [06-INVENTORY-SPEC §5](docs/06-INVENTORY-SPEC.md)
- [ ] Unit state machine with guards; every transition writes `UnitStatusHistory`
- [ ] Table-driven test over every (state, transition) pair
- [ ] **GATE** Hold acquire inside `SELECT … FOR UPDATE` — [06-INVENTORY-SPEC §2](docs/06-INVENTORY-SPEC.md)
- [ ] **GATE** 50-way concurrency test against real Postgres — exactly 1 success, 49 clean 409s
- [ ] Lazy expiry on read (`expiresAt < now()` reads as available)
- [ ] Hold expiry sweep job, 5-min external cron — [21-TIER-LIMITS §11](docs/21-TIER-LIMITS.md)
- [ ] Hold quota per grade, counted across projects · **BLOCKED#9**
- [ ] Hold extension, capped by `maxHoldExtensions`
- [ ] Delta endpoint + `@@index([orgId, updatedAt])`
- [ ] Live inventory board — countdown on held tiles, filters, unit drawer, **manual refresh**, pause-on-blur at 60 s — [08-SCREENS](docs/08-SCREENS.md)
- [ ] Lost-race UI names the winner ("Just taken by Ravi (A-0042)"), never a generic error

---

## Phase 2 — Sales & Collections

*4–5 weeks. Exit: a lead reaches a confirmed booking with a verified cleared
receipt; an overdue demand escalates through every rung to the right people.*

### CRM
- [ ] Lead capture, `phoneHash` / `emailHash` dedup at entry
- [ ] Claim window with expiry; walk-in matching a live claim surfaces the conflict **before** booking
- [ ] Assignment, manager reassignment with reason
- [ ] Activities, site visits, task reminders

### Booking
- [ ] Draft booking from a held unit; pins `priceListId`
- [ ] Discount request routed by the approval matrix · **BLOCKED#10**
- [ ] Document checklist, upload, verification
- [ ] **GATE** On confirm: freeze `agreementValue` **and** `commissionableValue`, snapshot `CostSheetLine` — [06-INVENTORY-SPEC §5](docs/06-INVENTORY-SPEC.md)
- [ ] Allotment letter PDF
- [ ] Cancellation with a **clawback preview shown before confirming**

### Collections
- [ ] Payment plan templates; demand schedule generated at confirmation
- [ ] Demand raising, statuses, waiver with approval
- [ ] Receipt entry — mode, instrument, bank, `receivedOn`
- [ ] **GATE** Verification rejects when actor entered it, **or** is the selling associate or in their upline — [10-SECURITY](docs/10-SECURITY.md)
- [ ] `clearedOn` set only on verification; allocation to demands
- [ ] Partial payments, multi-demand allocation, `creditBalance` for overpayment
- [ ] Bounce reverses allocations **and** any commission released against them
- [ ] Escalation ladder, `@@unique([demandId, rung])` enforced · **BLOCKED#12**
- [ ] Follow-up tasks mandatory from `OVERDUE_1`; promise-to-pay tracking
- [ ] Collections console — overdue buckets, sorted by amount within worst bucket
- [ ] Delay interest accrual (optional per project)

### Notifications
- [ ] `NotificationRule` config, in-app + email channels
- [ ] WhatsApp templates **submitted for approval** — do not defer to Phase 5 (R10)

---

## Phase 3 — Commission

*4–5 weeks. The riskiest phase. Exit: golden files pass, the reproducibility
test passes, a full sale produces correct entries for seller + 3 uplines.*

> Blocked items 4–8 must be closed before this phase starts. Building the engine
> on placeholders means rebuilding the fixtures when the real rates arrive.

### Network
- [ ] Grade master with qualification thresholds · **BLOCKED#4, #8**
- [ ] Effective-dated `AssociateGrade` — close-and-insert, never update
- [ ] Hierarchy with materialised `path`; subtree recompute on move
- [ ] **GATE** Cycle detection and self-referral block on every move
- [ ] Tree move rejected while a payout period is open
- [ ] Grade auto-qualification job (daily, external cron)
- [ ] Visual org tree

### Engine — built ahead of order this block (risk-first, see Decision log)

> Everything checked below is pure logic, golden-file tested, at 100% branch
> coverage. Nothing here is wired to a real database yet — that's `packages/services`,
> which does not exist. Persisting entries, resolving a booking's scheme
> version from the DB, and computing live collection percentages are all
> still open, listed where they belong below.

- [x] `packages/commission` — **pure, zero Prisma imports** — enforced by a package-level ESLint rule, proven to actually fail on a violation (not just proven to pass) — [04-COMMISSION-SPEC](docs/04-COMMISSION-SPEC.md)
- [ ] Scheme builder, versioned, maker-checker publish · **BLOCKED#5, #6**
- [ ] `baseDefinition` resolver → commissionable value — lives in the booking-confirmation flow ([06-INVENTORY-SPEC §5](docs/06-INVENTORY-SPEC.md)), not in `packages/commission` — `accrue()` takes `commissionableValue` as an already-frozen input, by design
- [x] **GATE** Accrual: self + level overrides, `ROUND_HALF_UP`, residual to company — `src/accrue.ts`, `src/round.ts`
- [x] **GATE** `maxTotalPct` assertion refuses to persist a breach — throws `CommissionSchemeMisconfiguredError`, tested
- [x] **GATE** `snapshot` written with grade, rates, upline chain, scheme version — `src/types.ts` `CommissionEntrySnapshot`
- [x] Compression modes `NONE` (breakage to company, reported) and `ROLL_UP` — **the spec's own pseudocode for ROLL_UP was under-specified** (a bare `continue` that discarded money without even recording it as breakage); implemented as "walk up the chain until someone eligible is found, or it becomes breakage after all" and `docs/04-COMMISSION-SPEC.md` has been corrected to match, with a revision note explaining why
- [ ] Release engine — all three modes, keyed off `clearedOn` · **BLOCKED#7** — pure computation (`computeRelease`, `resolveMilestoneCumulativePct`) is done and tested; wiring to real receipts/collections is `packages/services` work
- [ ] Clawback → contra entries → `Recovery`, with per-cycle deduction cap — pure computation (`computeClawback`) is done and tested; persisting the contra entry and applying the deduction cap at payout-batch time is `packages/services` work
- [x] **GATE** Golden-file fixtures, all cases in [§8](docs/04-COMMISSION-SPEC.md), **100% branch coverage** — 15 cases (12 from the spec + 3 extensions the implementation surfaced), `vitest run --coverage` exits 0 against a 100% threshold on every metric
- [x] **GATE** Reproducibility test — mutate tree and grades, re-run, byte-identical — passing, plus a negative-control test proving the mutation would have mattered on a different booking date (so the main test isn't accidentally vacuous)
- [ ] Scheme simulator (no writes)
- [ ] Explain drill-down — [08-SCREENS §2](docs/08-SCREENS.md)
- [ ] Earnings screen with **"₹X blocked by ₹Y in pending collections"**
- [ ] Dispute workflow
- [ ] **GATE** Invariant monitor live and paging — ships with the engine, not after

---

## Phase 4 — Payouts

*2–3 weeks. Exit: one clean month-end run reconciled to the rupee, CA sign-off
on tax fixtures.*

- [ ] **GATE** Upgrade off the free tier — background functions, 10 GB, 7-day PITR, region `sin` · **BLOCKED#14**
- [ ] Move Neon to `ap-southeast-1` and Netlify functions to `sin` after upgrade
- [ ] `packages/tax` — pure, fixture-driven
- [ ] Effective-dated `TaxRate` seeded with confirmed values · **BLOCKED#11**
- [ ] **BLOCKED#11** CA review of tax fixtures — engagement type, TDS section, GST
- [ ] Payout period open/close; freezes tree and grade changes
- [ ] Batch preparation, chunked with a persisted cursor
- [ ] Recovery netting with per-cycle deduction cap
- [ ] **GATE** Approval rejects when approver is the preparer
- [ ] `PayoutLineEntry` join — every payment traceable to its sales
- [ ] Commission statement PDF matching the ledger exactly
- [ ] Bank file export (NEFT/RTGS); payroll handoff for `EMPLOYEE`
- [ ] Form 16A, TDS challan export, GST reconciliation
- [ ] **GATE** One full month-end run reconciled to the rupee

---

## Phase 5 — Scale

*3–4 weeks. Exit: load-tested at target concurrency, associates using it on site.*

- [ ] Report catalogue — [20-REPORTS](docs/20-REPORTS.md)
- [ ] Role dashboards
- [ ] PWA install, offline reads (**no offline writes**)
- [ ] WhatsApp live; SMS via DLT-registered templates
- [ ] Tally / ERP export
- [ ] e-sign integration
- [ ] Portal lead ingestion (99acres, MagicBricks, Housing)
- [ ] Report builder with saved views and scheduled email
- [ ] Load test — board at target concurrency, payout wall clock, cold start measured
- [ ] **GATE** External penetration test — [10-SECURITY](docs/10-SECURITY.md)
- [ ] Accessibility audit, WCAG 2.1 AA on back-office
- [ ] Quarterly backup restore drill performed once, timed
- [ ] Customer portal *(flagged, out of committed scope)*

---

## Pre-go-live

Not a phase — a gate. Nothing ships to real associates until every box is ticked.

- [ ] **No `PLACEHOLDER` values remain in production config** — 35 exist today
- [ ] All 14 client open items closed
- [ ] Penetration test passed, findings remediated
- [ ] `AUTH_SECRET` and `PII_ENCRYPTION_KEY` generated fresh for production
- [ ] MFA enrolled and verified for every privileged user
- [ ] Every separation-of-duties assertion covered by a passing test
- [ ] Invariant monitor running and paging; dead-man's switch verified by killing a job
- [ ] Backup restore drill completed and timed — that time is the real RTO
- [ ] Legacy reconciliation signed off by client finance — [14-DATA-MIGRATION](docs/14-DATA-MIGRATION.md)
- [ ] Parallel run matched to the rupee for one full month
- [ ] Champions trained; associate laminated cards printed — [17-ROLLOUT](docs/17-ROLLOUT.md)

---

## Decision log

Small decisions made during the build. Anything structural gets an
[ADR](docs/adr/) instead.

| Date | Decision | Why | Who |
|---|---|---|---|
| 2026-09-05 | Jobs moved to external cron | Netlify Scheduled Functions reported to stop firing silently | Tech lead |
| 2026-09-05 | ~~Neon in `us-east-2`, not Singapore~~ **SUPERSEDED — see next row** | Free tier locks functions to Ohio; avoids a Pacific hop per query | Tech lead |
| 2026-09-05 | Neon in `ap-southeast-1` (Singapore), permanently — overrides the row above | A Neon project's region is **fixed at creation**; moving later means a new project plus a manual dump/restore. That immutability outweighs the Ohio-latency argument. Accepted consequence: a free-tier deploy (functions locked to `cmh`) pays a Pacific round trip per query until upgrading to Pro (`sin`) — see `docs/21-TIER-LIMITS.md` §2 | User + Tech lead |
| 2026-09-05 | Postgres 18 everywhere (Neon supports 18.2; local Docker matches) | Dev/prod parity | User |
| 2026-09-05 | Confirmed: no real KYC data stored yet — current seed data (grades, demo org) is synthetic | Means the DPDP/residency clock hasn't started; residency only needs deciding before Trigger T1 (first real KYC record), not before Phase 0 as the earlier plan.md draft overstated. Corrected `plan.md` Open Items #1 and #2 (legacy-data timing had the same "before Phase 0" error) | User |
| 2026-09-05 | Hosted Neon project (`ap-southeast-1`, Postgres 18.6) wired and migrated | User had already created it; supplied the pooled connection string. Direct/unpooled string was **derived** (stripped `-pooler` from the hostname — Neon's documented, consistent convention) rather than requested a third time, then verified by actually connecting (`prisma db pull` correctly reported "database was empty") before running real migrations against it. Both migrations applied via `migrate deploy`; partial-index gate test passes against the hosted DB itself, not just locally | User + Tech lead |
| 2026-09-05 | Deleted root `.env`, kept only `packages/db/.env` and `apps/web/.env.local` | Root `.env` was never read by either Prisma (reads `packages/db/.env`) or Next.js (reads `apps/web/.env.local` — app-scoped, not repo-root-scoped). It had accumulated a mismatched pooled/unpooled pair after a manual edit; two files claiming to configure the same thing, one of them inert, was a live footgun | Tech lead |
| 2026-09-05 | Auth hand-rolled directly against the schema; no Auth.js/next-auth dependency | Confirmed with user before building. The schema's `User`/`Session` (tokenHash, mfaSecret, custom revocation fields) don't match Auth.js's Prisma adapter conventions — using the real library meant either reshaping the schema or writing a custom adapter that duplicates the same logic anyway. `docs/02-ARCHITECTURE.md` corrected to match | User + Tech lead |
| 2026-09-05 | `permission-matrix.ts` moved from `packages/services` to `packages/db` | It's pure data with zero DB dependency, but `packages/db/prisma/seed.ts` needs it and `db` cannot depend on `services` (services already depends on db — would create a cycle). Since services already depends on db, importing the matrix from there costs nothing | Tech lead |
| 2026-09-05 | `@node-rs/argon2` added directly to `packages/db` (in addition to `packages/services`) | The seed script needs to hash a real demo password; `db` can't depend on `services` for the same cycle reason above. It's a generic crypto library, not domain logic, so duplicating the dependency (not the logic) across two packages is the correct fix, not a layering violation | Tech lead |
| 2026-09-05 | Two test-hygiene bugs found and fixed via direct row-count verification, not by trusting "tests passed" | (1) `auth.test.ts` had per-describe cleanup; the "sessions" describe re-created the shared test org via `makeTestUser()` but never deleted it, because an *earlier* describe's `afterAll` had already deleted it once and this one's didn't repeat that step — consolidated into one file-level `afterAll`. (2) `rbac-permission.test.ts` created a **global** `Permission` row (`test.action` — Permission has no `orgId`) and only ever cleaned up org-scoped rows, leaking it across every run. Caught by literally counting rows after a seed run and getting 33 permissions instead of 32, not by the test suite reporting green (it did) | Tech lead |
| 2026-09-05 | A background task's "completed, exit code 0" was verified against real hosted-DB state, found to be false, and re-run in the foreground | The seed run against hosted Neon hit a 60s tool timeout mid-run and was moved to the background; the eventual "completed" signal did not match reality — a direct query showed it had stopped after 5 of 8 roles, with zero units/users. Re-ran with a 300s foreground timeout, which completed correctly, confirmed again by direct query rather than by its own console output. Applies generally: verify tool-reported success against actual system state for anything that touched the hosted database, especially after a timeout/background transition | Tech lead |
| 2026-09-05 | GitHub repo pushed (`github.com/testorgnew123/desire-mlm-project`); a stray compiled `seed.js`/`seed.d.ts` (leftover from before the tsconfig rootDir fix, containing outdated seed logic) was caught in `git add -A` and removed before commit, with a `.gitignore` guard added | These predated the fix to `packages/db/tsconfig.json`'s include list and would have committed dead, misleading code into `prisma/`, which should only ever hold `schema.prisma`, `migrations/`, and `seed.ts` | Tech lead |
| 2026-09-05 | Netlify site created and wired (production env vars, GitHub Actions secrets), but the first real deploy verification found it genuinely broken | Netlify CLI's own account (`kyleinnovates@gmail.com`) didn't match the user's GitHub identity — confirmed with the user before proceeding rather than assumed. `netlify sites:create --account-slug kyle` 404'd; the real slug (`kyleinnovates`) differs from the display name (`kyle`) — found via `netlify api listAccountsForUser`, not guessed. First deploy attempt failed outright on a `netlify.toml` bug: omitting `publish` (per Netlify's own general guidance) let their default-guessing concatenate `base` onto itself, producing a broken doubled path (`apps/web/apps/web/.next`) — fixed by setting `publish` explicitly. Second attempt reported "Deploy is live!" in its own logs, but curling the live URL directly returned `502` on every route, with a control-character-corrupted import path -- the known failure mode of building an OpenNext/Netlify serverless bundle on Windows (backslash separators) for a Linux Lambda runtime. Every step here was checked against real state (account slug via API, deploy success via curl) rather than trusting a tool's own success message, consistent with the seed-run lesson above | Tech lead |
| 2026-09-05 | GitHub repo linked to the Netlify site (user's action); homepage confirmed fixed (`200`) by the resulting cloud (Linux) build, confirming the Windows-build diagnosis above. `/api/health` then surfaced a second, genuine bug: `"@prisma/client did not initialize yet"` | `pnpm --filter @desire/web build` does not trigger `packages/db`'s own build step first -- that dependency-graph behavior is Turbo's `dependsOn: ["^build"]`, not something plain `pnpm --filter` does. Fixed by adding an explicit `pnpm --filter @desire/db exec prisma generate` step to `netlify.toml`'s build command, before the web build | Tech lead |
| 2026-09-05 | Netlify deploy fixed for real: five iterations, each verified against the live URL rather than trusted from a log message | Chain of root causes, each real: (1) omitted `publish` -> Netlify's own default-guessing doubled the path; (2) building on this Windows machine baked corrupted backslash paths into the serverless bundle (control-character garbled import, 502) -- fixed by getting the GitHub-connected repo to build on Netlify's Linux cloud infrastructure instead, not by patching the local build; (3) `pnpm --filter @desire/web build` doesn't trigger `packages/db`'s own build step (that's Turbo's `dependsOn`, not plain `pnpm --filter`) -- Prisma Client was never generated; (4) the generated client's binary target (Debian, the build container) didn't match the Lambda runtime (RHEL-based) -- config error message named the exact fix; (5) that fix was never actually deployed -- `base = apps/web` made Netlify's change-detection skip a commit that only touched `packages/db/`, silently "no content change". At that point, presented the user a real choice rather than patching a sixth time: a small `outputFileTracingIncludes` workaround, or Prisma's newer `engineType="client"` (no native binary at all, GA since 6.16) with a driver adapter. **User chose the permanent fix.** Substituted `@prisma/adapter-pg` for the `@prisma/adapter-neon` shown in the option preview -- the Neon-specific adapter's HTTP/WebSocket transport only works against Neon itself and would have broken every local Docker Postgres and CI test in this project; `adapter-pg` speaks plain Postgres wire protocol, identical code path everywhere. Verified with a live query against hosted Neon through the new adapter (not just a connection check) before declaring it fixed, and again after the real deploy: `/api/health` returns `200 {"status":"ok","db":{"ok":true}}` | Tech lead |
| 2026-09-05 | Storage decision: **no S3.** Netlify Blobs instead | User's call, confirmed explicitly rather than assumed. Verified Netlify Blobs' actual behavior before writing anything: no user-controlled region for the durable `getStore()` (only the deploy-scoped `getDeployStore()` supports a `region` option, which doesn't fit persistent document storage), no presigned-URL mechanism, 5 GB per-object limit. Consequence: **the "S3 in Mumbai keeps documents India-resident" mitigation in `docs/11-COMPLIANCE-INDIA.md` and `ADR-0001` no longer holds** -- flagged explicitly in both rather than quietly dropped, since it's a real regression on the compliance story, not a neutral swap. Renamed `Document.s3Key` → `storageKey`, `PayoutBatch.bankFileS3Key` → `bankFileStorageKey`, `PayoutLine.statementS3Key` → `statementStorageKey` via a hand-written `RENAME COLUMN` migration (Prisma's own non-interactive diff generates a data-losing drop+add for renames; rewrote it before applying, same discipline as the partial-unique-index migration). Applied to local Postgres and hosted Neon, verified by querying `information_schema.columns` directly. Full sweep of `S3`/`s3Key` across 9 docs, 2 ADRs, `.env.example`, and the schema | Tech lead |
| 2026-09-05 | Local Docker Postgres for development, not hosted Neon free tier | Real Postgres for concurrency tests, no free-tier quota burn during dev, no dependency on a hosted project's uptime while building | Tech lead |
| 2026-09-05 | Sequencing: `packages/commission` built before Phase 0/1/2 finish (risk-first, not roadmap order) | It carries 7 of 16 gates and the register's only high/high risk (R2); it has zero dependencies (no DB, no auth, no deploy, no unanswered client questions), so it can be fully retired as a risk in week ~3 instead of week ~13. Accepted cost: nothing demoable until ~week 5 | User + Tech lead |
| 2026-09-05 | `directUrl` in `schema.prisma`'s datasource block, not `prisma.config.ts`, for the pooled/unpooled connection split | Verified against actual Prisma 6.19 behavior (the Neon+Prisma guide's `prisma.config.ts` pattern is v7-only) before shipping an unverified config — see `.env.example` and `docs/02-ARCHITECTURE.md` | Tech lead |
| 2026-09-05 | `docker-compose.yml` volume mounts at `/var/lib/postgresql`, not `/var/lib/postgresql/data` | `postgres:18` images changed their on-disk layout to a `pg_ctlcluster`-style structure; the old mount point crash-loops the container on first start. Found by actually starting the container, not assumed | Tech lead |
| | | | |

---

## Changelog

| Date | Change |
|---|---|
| 2026-09-05 | Design set complete — 21 docs, 6 ADRs, `schema.prisma` (58 models, validated) |
| 2026-09-05 | Free-tier constraints documented; jobs moved to external cron |
| 2026-09-05 | Implementation started (Work Block 1, risk-first). Monorepo scaffolded (pnpm + Turborepo); schema applied to local Postgres 18; all 3 hand-written partial unique indexes applied and gate-tested (including a proven negative case); `packages/commission` built complete — pure, lint-enforced boundary (proven to fail on violation), 38 tests, 100% branch/statement/function/line coverage, reproducibility test passing. 3 real bugs found and fixed during testing: (1) `accrue.ts` manufactured breakage for tree levels with no upline at all, not just ineligible ones; (2) the spec's own `ROLL_UP` pseudocode silently discarded money without recording it as breakage — `docs/04-COMMISSION-SPEC.md` corrected to match the real, tested behavior; (3) a test helper (`cloneOrg`) shallow-cloned array containers but not the record objects inside, so a "cloned" org's mutations leaked back into the original. `docs/16-ROADMAP.md`'s "data residency must be decided before Phase 0" was also corrected — residency gates the first *hosted deploy*, not development; schema/auth/RBAC/the whole engine build and test against local Postgres. `apps/web` shell with `/api/health` (real DB check, honest "not yet implemented" for job timestamps — no heartbeat table exists yet). Full workspace build/typecheck/lint green. |
| 2026-09-05 | Confirmed no real KYC data stored yet (synthetic seed only); corrected two more "before Phase 0" overstatements in `plan.md` (residency now tied to Trigger T1; legacy-data reconciliation timing to Phase 2, matching the roadmap). |
| 2026-09-05 | Hosted Neon project (`ap-southeast-1`, Postgres 18.6) wired: pooled string supplied by user, direct/unpooled string derived (Neon's documented `-pooler` convention) and verified by connecting before running real migrations. Both migrations applied and gate-tested against the live hosted DB. Root `.env` (never actually read by any tool) deleted; correct app-scoped env files created instead. |
| 2026-09-05 | Phase 0 completed to 14/16 (only external-account-blocked tasks remain). Added `packages/services`: hand-rolled session auth (argon2id, 12h/7d timeouts, per-account lockout — IP rate limiting explicitly deferred, documented why), TOTP MFA, AES-256-GCM field encryption (with a real tamper-detection test), append-only audit logging, and the RBAC permission + scope-resolver layer (unit-tested against a 9-node deep tree). Transcribed the full `docs/09-RBAC-MATRIX.md` permission grid into seed data (32 permissions × 8 roles, 114 grants) with 13 consistency tests. Completed the seed script (demo project, 100 units, 8 test users) and verified it — twice — directly against row counts rather than console output, because the first hosted run's reported "success" turned out to be false (see Decision log). Found and fixed two test-hygiene bugs (a cleanup-ordering gap that leaked a test org, a global `Permission` row never cleaned up) the same way: by counting rows, not by trusting green tests. Wrote and validated `ci.yml` (ephemeral Postgres, full pipeline, honest no-op e2e step) — correct on paper, not yet run for real pending the GitHub push. 99 tests total across the workspace, all passing; `packages/services` at 100% statements/functions/lines, 97%+ branches. |
| 2026-09-05 | Repo pushed to GitHub, Netlify site created and deployed for real -- verified live at [desire-mlm-project.netlify.app](https://desire-mlm-project.netlify.app), `/api/health` returning `200` against hosted Neon. Storage decision changed from S3 to Netlify Blobs (user's call): renamed three schema fields off the S3-specific name, swept the compliance implication across 9 docs and 2 ADRs rather than dropping it quietly (no artifact in this system is now guaranteed India-resident). The deploy itself took five real, individually-verified fixes before it worked, ending with a genuine architecture change (Prisma's engineType="client" + a driver adapter, eliminating the native-binary bundling problem for good) chosen deliberately over a smaller patch -- full account in the Decision log. |
| | |
