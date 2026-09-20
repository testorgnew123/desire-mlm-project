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
| **Current phase** | **Phase 2 — Sales & Collections, 19/23 done** (Booking Core, discount routing, cancellation + clawback preview, CRM, payment plans + demand generation, receipts + the maker-checker verify GATE, escalation ladder + collections console + interest, notifications). Phase 2 is scoped as a sequence of slices, not one pass — all 7 planned slices have now landed. The one remaining item, WhatsApp template approval, cannot be code-completed by design (a live Meta Business Account + human review, stated up front, not discovered as an excuse afterward). Phases 0 and 1 are both **complete** (17/17 each). **CI is green.** Phase 3's pure engine built ahead of order — risk-first sequencing, see Decision log |
| **Started** | 2026-09-05 |
| **Target** | 18–22 weeks from start |
| **Hosting** | **Live**: [desire-mlm-project.netlify.app](https://desire-mlm-project.netlify.app) — verified via `/api/health` returning `200` with a real hosted-Neon query. Hosted Neon (`ap-southeast-1`, Postgres 18.6). Local Docker Postgres 18 kept for offline dev / concurrency tests. Repo at `github.com/testorgnew123/desire-mlm-project`, connected for auto-deploy on push |
| **Last updated** | 2026-09-12 |

| Phase | Tasks | Done | Gates | Status |
|---|:-:|:-:|:-:|---|
| 0 — Foundation | 17 | **17** | 1/1 | Complete. Per-PR Neon branches proven end-to-end on PR #1 |
| 1 — Inventory | 17 | **17** | **2/2** | Complete. Both gates passed |
| 2 — Sales & Collections | 23 | 19 | **1/2** | In progress — all 7 slices landed; only WhatsApp approval (external, not code) remains |
| 3 — Commission | 23 | 7 | 5/7 | In progress (engine only) |
| 4 — Payouts | 14 | 0 | 0/3 | Not started |
| 5 — Scale | 13 | 0 | 0/1 | Not started |
| Pre-go-live | 11 | 0 | — | Not started |
| **Total** | **118** | **60** | **9/16** | |

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
- [x] Neon DB branch per PR (ephemeral per-PR database) -- **working, proven end-to-end on PR #1**. `.github/workflows/neon-preview-branches.yml` creates a Neon branch per PR, applies migrations to it, points that PR's Netlify preview at it via a branch-scoped override, rebuilds the preview, comments on the PR, and deletes both on close. It had never once succeeded, and could not have: `role:` is not an input of `create-branch-action@v5` (the required one is `username`); the pooled output is `db_url_with_pooler`, not `db_url_pooled`, so both references resolved to an empty string; `cache: pnpm` ran before `corepack enable`; there was no `permissions:` block against a read-only default token; and every `netlify env:*` call needed `--filter @desire/web` in a four-package workspace. **Two behaviours were settled by experiment, not argument.** `branch:<name>` *does* apply to deploy previews -- but Netlify starts building the moment the PR is pushed, so the first build of every PR captured the environment before the override existed and talked to the **production database**. Proven with a session row created only in the preview branch: first build 404, after a rebuild 200, production 404 both times. Fixed with a build hook (`NETLIFY_BUILD_HOOK_URL`) fired once the override is in place. And `cancel-in-progress: true` ate the cleanup run outright -- closing the PR produced *no* run, stranding the branch and both overrides, with `closed` never firing again. Now false for `closed` only. `NEON_PROJECT_ID` is confirmed correct: the preview branch came up with this project's 100 units and 3 applied migrations. Cleanup verified: override removed, production `DATABASE_URL` intact across all four contexts, `/api/health` 200, preview endpoint unreachable
- [x] `/api/health` reporting DB connectivity **and each job's last successful run** — DB check is real (`SELECT 1` via Prisma); job timestamps are honestly `"not yet implemented"`, not fabricated — no job or heartbeat table exists yet (that's Phase 1). Revisit the comment in `apps/web/app/api/health/route.ts` when the first job lands
- [x] GitHub Actions cron secrets (`APP_BASE_URL`, `JOB_TRIGGER_SECRET`) + a manual `workflow_dispatch` proving a job endpoint responds -- `workflow_dispatch` run returned `{"ok":true,"processed":1}` against the live deploy, and the sweep's effect was confirmed in hosted Neon rather than inferred from the 200. The two daily schedules were removed until their routes exist; see the decision log

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

- [x] Project master with RERA fields and hold policy config -- `packages/services/src/projects.ts`. RERA validity and hold policy are *validated*, not just stored: `ProjectReraInvalidError` and `InvalidHoldPolicyError` refuse incoherent config at the boundary, and `holds.ts` reads the same policy rather than a second copy
- [x] Tower, UnitType, Unit CRUD — carpet / built-up / saleable all captured — [19-GLOSSARY](docs/19-GLOSSARY.md) -- `createTower`/`createUnitType`/`createUnit`/`updateUnit`. `resolveUnitAreas` applies per-unit overrides over the unit type's defaults, and `InvalidUnitAreasError` rejects carpet ≥ saleable — the confusion that misprices a unit by ~35%. `CrossProjectReferenceError` stops a unit pointing at another project's tower
- [x] Bulk unit import (CSV/XLSX) with validation report -- `unit-import.ts`. Reports **every** problem in one pass with 1-based row numbers matching the user's spreadsheet, so a file is fixed once instead of yielding a new error per re-upload. 21 tests
- [x] `ChargeHead` master, `countsTowardCommission` flag -- `charge-heads.ts`. `setCommissionableFlag` is separated from general update and requires a reason: flipping that flag silently re-bases everyone's commission
- [x] Versioned price lists, maker-checker publish (`preparedBy != approvedBy`) -- `price-lists.ts`. Both identities come from the audit context, never a parameter — a caller-supplied approver id would let the preparer name a colleague and assert an approval that never happened. Proven: a user holding **both** permissions still cannot publish their own list. Publish archives the incumbent in the same transaction, so no reader can observe two ACTIVE lists; 10 concurrent drafts get 10 distinct versions. 8 tests
- [x] Cost sheet computation — base, PLC, other charges, GST — [06-INVENTORY-SPEC §5](docs/06-INVENTORY-SPEC.md) -- `cost-sheet.ts`, pure. **Every expected number in its 19 tests is hand-computed from the spec, not read off the implementation**, because a wrong cost sheet produces a *plausible* number that flows into `agreementValue` → `commissionableValue` → what an associate is paid. GST is summed per line at that line's own rate; refundable IFMS and the whole GST take are excluded from the commissionable base
- [x] Unit state machine with guards; every transition writes `UnitStatusHistory` -- `packages/services/src/unit-transitions.ts` (pure, no Prisma import) + `units.ts` (DB-backed `transitionUnitStatus`/`blockUnit`/`unblockUnit`, each writing history + audit inside the same transaction as the change). Unblock restores the unit to whatever status it held before blocking, read from `UnitStatusHistory` rather than passed in -- so an admin can't accidentally unblock a sold unit back to AVAILABLE
- [x] Table-driven test over every (state, transition) pair -- all 7x7 = 49 combinations asserted explicitly, plus 5 named rule tests. The expected-legal set is transcribed independently from the doc, **not** imported from the implementation, so a bug in the table can't define its own correctness. 54 tests
- [x] **GATE** Hold acquire inside `SELECT … FOR UPDATE` -- `packages/services/src/holds.ts`. Row lock serialises check-then-act; the partial unique index is the backstop, and a P2002 from it is converted to the same clean named rejection rather than a 500 — [06-INVENTORY-SPEC §2](docs/06-INVENTORY-SPEC.md)
- [x] **GATE** 50-way concurrency test against real Postgres -- exactly 1 success, 49 clean `UnitNotAvailableError`s each naming the winning associate, plus an independent DB-level assertion that only one live hold row exists. **Proven non-vacuous**: with both defences removed (row lock bypassed AND index dropped) the test genuinely fails with raw transaction-layer errors, then passes again once restored. A second test holds 50 *different* units concurrently and expects all 50 to succeed -- catching the naive implementation that would pass the first test by serialising everything globally
- [x] Lazy expiry on read -- `isHoldLive`/`effectiveUnitStatus` (pure) plus materialisation inside `acquireHold`'s lock, so a hold that expired but hasn't been swept is immediately re-holdable and the sweep can't disagree with a concurrent acquirer. Tested including the exact between-expiry-and-sweep state
- [x] Hold expiry sweep job, 5-min external cron — [21-TIER-LIMITS §11](docs/21-TIER-LIMITS.md) -- `POST /api/jobs/holds/expire`, triggered by `.github/workflows/scheduled-jobs.yml` (`*/5 * * * *`), not a Netlify Scheduled Function. Auth is a timing-safe compare of `x-job-secret` that **fails closed when the env var is unset** — an unconfigured deploy rejects everything rather than exposing an open endpoint. Verified: `401` with no secret, `401` with a wrong secret, `200` with the right one. Then verified **non-vacuously** — an expired hold was planted and the real GitHub Actions run returned `{"ok":true,"processed":1}`, with the unit confirmed back to `AVAILABLE` in hosted Neon afterwards. Two things this caught that a green local check had not: the scheduled runs were 404ing because the route existed only on disk and had never been committed, and `processed:0` on an empty sweep proves nothing — planting a row is what turned the check into evidence. It also surfaced a real correctness bug, below
- [x] Hold quota per grade, counted across projects -- reads `Grade.holdQuota` (currently a PLACEHOLDER default of 3; the *mechanism* doesn't need the real number, only the value does, so this is no longer blocked). An associate with no grade assignment gets a quota of 0, not an unlimited default · **BLOCKED#9** applies only to the confirmed value
- [x] Hold extension, capped by `maxHoldExtensions` -- tested to succeed once then refuse
- [x] Delta endpoint + `@@index([orgId, updatedAt])` -- `GET /api/v1/projects/[projectId]/units/deltas`, index present at `schema.prisma:891`. Auth is checked *before* validation, so a bad `?since` can't be used to probe which projects exist. Errors are RFC 7807 problem+json. Verified live: `401` unauthenticated, `200` with all 100 seeded units, `?since=<serverTime>` → 0 changed (the polling contract), `400` problem+json on a malformed `since`
- [x] Live inventory board — countdown on held tiles, filters, unit drawer, **manual refresh**, pause-on-blur at 60 s — [08-SCREENS](docs/08-SCREENS.md) -- `apps/web/app/board/[projectId]/`. Polling stops when the tab is hidden *and* when no hold is live, so an idle board costs nothing against the free tier's invocation budget. Status is conveyed as a **text label**, not colour alone. Verified against the running app rather than trusting that it compiles: real seeded unit numbers render, and the tile mix reflects genuine DB state
- [x] Lost-race UI names the winner ("Just taken by Ravi (A-0042)"), never a generic error -- `POST /api/v1/projects/[projectId]/units/[unitId]/holds` calls straight into `acquireHold` (`packages/services/src/holds.ts`, untouched -- GATE-tested, not re-verified here) with no client guess in between. Idempotent per docs/07-API.md: a caller retrying against a unit they already hold gets `200` with the existing hold back, not a `409` naming themselves -- proven at the DB level (two POSTs from the same associate, one hold row). A genuine concurrent race (two associates, `Promise.allSettled` over real HTTP, winner determined by Postgres afterward rather than assumed) confirms the loser's response names the actual winner. The drawer's new "Hold this unit" button surfaces that `409`'s `detail` verbatim: confirmed live in the browser (not just curl) -- `role="alert"` text reading exactly **"Unit is held by Demo Team Lead (A-DEMO-TEAM_LEAD)."** after a real background take-over. Success needs no new drawer state: `refreshNow()` re-polls and the existing HELD countdown block takes over on its own. Permission `hold.create`; the acting associate is always the caller's own record (no "hold on behalf of" -- unspecified anywhere, out of scope); a caller with `hold.create` but no Associate row (SUPER_ADMIN/SALES_HEAD/SALES_ADMIN) gets a clear `403`, not a crash

---

## Phase 2 — Sales & Collections

*4–5 weeks. Exit: a lead reaches a confirmed booking with a verified cleared
receipt; an overdue demand escalates through every rung to the right people.*

### CRM
- [x] Lead capture, `phoneHash` / `emailHash` dedup at entry -- `packages/services/src/leads.ts` `createLead`. `hashForDedup` is SHA-256, matching the schema's own comment exactly; phone normalisation is a stated PLACEHOLDER (India-only E.164, `+91`) since every phone example anywhere in this codebase is a bare 10-digit Indian mobile with no country code. Verified live: `"98765 43210"` and `"+91-9876543210"` hash identically and correctly conflict
- [x] Claim window with expiry; walk-in matching a live claim surfaces the conflict **before** booking -- claiming is not a separate action: `createLead` both creates the `Lead` and its first `LeadClaim` in one transaction (docs/07-API.md: create itself "returns a conflict if a live claim exists"), naming the claiming associate rather than silently merging. Window is 90 days, PLACEHOLDER per the schema's own comment. A claim past `expiresAt` returns the lead to the pool lazily (no sweep), mirrored from `isHoldLive`/`effectiveUnitStatus`'s exact shape -- tested directly (backdating `expiresAt` lets a second associate claim fresh)
- [x] Assignment, manager reassignment with reason -- `reassignLead`: releases the current live claim, creates a new one for the target, moves `assignedAssociateId`, reason mandatory. A gap found while wiring `resolveAssigneeId` (who may be named as assignee/reassignment target): bookings.ts's equivalent `resolveSellingAssociateId` requires the CALLER to already have an Associate profile before it even checks admin-ness, which would make a pure manager account (no Associate row) unable to assign a lead to anyone else. Fixed in this new file by checking the admin/downline bypass first -- not backported to bookings.ts, which is unrelated to this slice
- [x] Activities, site visits (**task reminders not built** -- that needs Slice 7's notification queue, not this slice) -- `logActivity` (STAGE_CHANGE also moves `Lead.stage`, stamping `fromStage`/`toStage` -- the activity log **is** the stage history) and `scheduleSiteVisit`/`completeSiteVisit`. All four write actions (`lead.write`, `lead.activity`, `lead.reassign`, `sitevisit.create`) enforce the same `O`/`T` scope split `lead.read` documents (docs/09-RBAC-MATRIX.md) against the SPECIFIC lead being touched, not just permission possession -- an `ASSOCIATE` holding `lead.write` cannot edit a colleague's lead; a `TEAM_LEAD` can act on their downline's but not a stranger's. `lead.write`, `lead.activity` and `sitevisit.create` are new permission codes (no write permission existed for leads at all); `completeSiteVisit` has no route yet (docs/07-API.md names only the schedule endpoint) but is built and tested since otherwise `completedAt`/`feedback`/`interestLevel` would be permanently unreachable columns. 34 tests against real Postgres, organized by invariant (dedup, assignee resolution, update, activity/stage-change, reassign, site visits, scoped listing, tenancy). Verified live: create → dedup conflict (`409`, names the claimant) → update (`200`) → `STAGE_CHANGE` activity (`201`, `NEW`→`QUALIFIED`) → missing `toStage` (`422`) → reassign without permission (`403`) → reassign with reason (`200`) → empty reason (`422`) → scoped `GET /leads` (associate sees own, admin sees the whole org)

### Booking
- [x] Draft booking from a held unit; pins `priceListId` -- `packages/services/src/bookings.ts` `createDraftBooking`. Verifies the unit is HELD **by the drafting associate specifically** (not just HELD by anyone) via the existing `effectiveUnitStatus`/`isHoldLive` predicates -- a real gap this closes: without it, associate A could draft against a unit associate B legitimately holds. `bookingNumber` is a new placeholder format (`{project.code}-{4-digit sequence}`, e.g. `SKYLINE-0001`) with a real correctness backstop (`@@unique([orgId, bookingNumber])` + retry-on-P2002), same placeholder-vs-structure status as the grade ladder. Discount fixed at 0 this slice (bands are `BLOCKED#10`, see below)
- [x] Discount request routed by the approval matrix · **BLOCKED#10** (bands stay PLACEHOLDER; the mechanism is real) -- `packages/services/src/discounts.ts`. Maker-checker modeled directly on `publishPriceList`'s pattern (plain columns + an inline assertion), not the unused generic `ApprovalRequest` model. `resolveApproverRoles` is a pure band lookup; `decideDiscount` checks the decider holds `discount.approve` **and** their role is in the resolved band's set, **and** they aren't the requester -- three distinct rejections, each tested. Found and fixed a real gap while wiring this: `FINANCE_ADMIN` is named in the 3-5% band but the permission matrix never granted them `discount.approve` at all -- that band was unreachable by the role the doc itself names; fixed in `permission-matrix.ts` and `docs/09-RBAC-MATRIX.md`. Approval writes `discountAmount` onto the booking; `confirmBooking` already re-reads that column fresh at confirm time, so no change was needed there. Verified live: request 4% → team_lead (wrong band) `403` naming the required roles → finance_admin (correct band) `200` → confirm reflects it exactly (`agreementValue` 5,981,750 → 5,781,750, minus the 200,000 discount)
- [ ] Document checklist, upload, verification
- [x] **GATE** On confirm: freeze `agreementValue` **and** `commissionableValue`, snapshot `CostSheetLine` — [06-INVENTORY-SPEC §5](docs/06-INVENTORY-SPEC.md) -- `confirmBooking`. Re-verifies HELD-by-the-same-associate under a fresh lock rather than trusting the draft's premise (the hold can expire in the gap -- tested explicitly, including the case where a *different* associate now holds it). Re-runs `computeCostSheet` against the pinned price list rather than trusting the draft's cached preview, matching the spec's own "never recompute it later" -- true from the confirm instant, not before it. Releases the hold via `HoldReleaseReason.CONVERTED_TO_BOOKING` (existed in the schema, unused until now -- `releaseHold` in `holds.ts` was the wrong function to call here, since it unconditionally sends the unit back to `AVAILABLE` rather than `BOOKED`) and transitions the unit `HELD → BOOKED` in the same transaction. Verified against real Postgres (20 tests: hold-ownership at both draft and confirm time, tenancy, RBAC-before-any-lock, a genuine concurrency race between two associates, audit rows) and end-to-end against a live dev server + real Postgres: draft → confirm → re-confirm (`409`) → confirm without permission (`403`) → draft against a unit held by someone else (`409`) → read-scoped `GET` (own booking `200`, no permission `403`, outside scope `404` not `403`, so a scoped reader can't detect a booking id exists outside their scope)
- [ ] Allotment letter PDF
- [x] Cancellation with a **clawback preview shown before confirming** -- `packages/services/src/bookings.ts` `previewCancellation`/`cancelBooking`. Only legal from `CONFIRMED` -- the unit state machine (`unit-transitions.ts`) has no path back to `AVAILABLE` from `AGREEMENT_SIGNED`/`REGISTERED`/`POSSESSION` (and nothing in this codebase yet moves a booking that far anyway), so `CONFIRMED` is the one reachable state, not an arbitrary choice. "Approval required" ([06-INVENTORY-SPEC](docs/06-INVENTORY-SPEC.md)) is `booking.cancel`'s already-narrow SUPER_ADMIN/SALES_HEAD grant plus a mandatory reason, not a second workflow. `previewCancellation` and `cancelBooking` share one `computeClawbackLines` helper (real Prisma reads, feeding `packages/commission`'s pure `computeClawback`) so preview can never drift from what cancelling actually does. Per `CommissionEntry`: the original is marked `REVERSED` (its own schema comment -- "superseded by a contra entry"); a contra row is persisted (`sourceEntryId`, `grossAmount` = the negative `contraAmount`, original's amount untouched per ADR-0006) and marked `REVERSED` too, since its whole effect is already disposed of right here (netted against the beneficiary's other pending entries, or turned into a `Recovery` row) rather than something a future payout batch should re-discover -- a genuine interpretation call, noted in code, since no payout-batch logic exists yet to check it against. No commission-accrual service exists anywhere in this codebase yet (`accrue()` in `packages/commission` is pure and unwired into any booking flow -- Phase 3, not this slice), so 15 tests seed `CommissionEntry`/`CommissionRelease` rows directly to exercise the real caller: zero entries, fully released with/without other pending payable to net against, partial release, a reversed release correctly excluded, multiple entries (SELF + OVERRIDE) independently, plus the CONFIRMED-only gate, permission, reason-required, cross-org, and one audit-row check. Verified live against a real dev server + local Postgres: hold → draft → confirm → preview (`200`, empty clawback -- no entries exist) → cancel without permission (`403`) → cancel with empty reason (`422`) → cancel (`200`, unit `BOOKED → AVAILABLE`, status history `DRAFT → CONFIRMED → CANCELLED`) → re-cancel (`409`)

### Collections
- [x] Payment plan templates; demand schedule generated at confirmation -- `packages/services/src/payment-plans.ts`. `createPaymentPlan`/`addMilestone` require milestones to sum to **exactly** 100% (a real guard, not asked for by the plan text but the same class of risk `CommissionScheme.maxTotalPct` already guards against -- a plan that doesn't sum to 100% would silently mis-schedule every booking against it). `generateDemandSchedule` is called from `confirmBooking` **in the same transaction**, right after the freeze -- a confirmed booking with a payment plan but no demand schedule is an inconsistent state prevented atomically, not patched after the fact. Residual-on-last-milestone rounding (same discipline as the commission engine and the cost sheet) so the sum of generated demands matches `agreementValue` exactly. A booking with no `paymentPlanId` gets no schedule -- not an error. Verified live: 20/30/50 plan against a 5,981,750 agreement value generated demands of exactly 1,196,350 / 1,794,525 / 2,990,875 (summing back to the cent)
- [x] Demand raising, statuses (**waiver with approval** is `demand.waive`'s already-narrow SUPER_ADMIN/FINANCE_ADMIN/SALES_HEAD grant, same "the permission gate itself is the approval" reasoning as booking cancellation, not a separate workflow) -- `raiseDemand`/`waiveDemand`. No permission gated raising a demand at all before this (only waiving); added `demand.raise` mirroring `receipt.enter`'s exact role set. 21 tests against real Postgres: the 100%-sum invariant (create and incremental add), demand generation (residual, no-plan case, milestoneRef lineage), raise (SCHEDULED-only), waive (reason mandatory), tenancy, audit. Verified live: raise (`200`) → re-raise (`409`, already RAISED) → raise without permission (`403`)
- [x] Receipt entry — mode, instrument, bank, `receivedOn` -- `packages/services/src/receipts.ts` `enterReceipt`. Same generated-with-retry-on-P2002 `receiptNumber` pattern as `bookingNumber`
- [x] **GATE** Verification rejects when actor entered it, **or** is the selling associate or in their upline — [10-SECURITY](docs/10-SECURITY.md) -- `verifyReceipt`. All three assertions exactly as the doc states them: `enteredById !== actorId`; then, ONLY if the actor has an Associate profile at all (most `FINANCE_ADMIN`s won't -- they're back-office, not sales), `isInScope(actorAssociateId, sellerHierarchyRow)` answers "is the actor the seller or an ancestor (upline) of them" in one call, reusing the SAME resolver as every other scope check in this codebase rather than a bespoke upline-chain walk. A downline of the seller is explicitly **not** excluded -- only ancestors are (tested directly, since it is the one case easy to get backwards)
- [x] `clearedOn` set only on verification; allocation to demands -- `clearReceipt` (only legal from `VERIFIED`) computes `cumulativeReleasePct` ONCE per booking (Σ cleared, non-reversed allocations / `agreementValue`) and applies it to every `PRO_RATA_COLLECTION` `CommissionEntry` via `packages/commission`'s pure `computeRelease`; entries under `MILESTONE`/`ON_BOOKING` schemes are skipped, not half-computed (no payout-schedule-resolution code exists anywhere yet for those modes). `allocateReceipt` (`VERIFIED` or `CLEARED`) enforces both invariants literally: Σ(allocations per receipt) ≤ `receipt.amount`, Σ(allocations per demand) ≤ `demand.amount + demand.gstAmount`. Oldest-unpaid-first by `dueDate` unless the caller passes explicit allocations. Demand status (`RAISED`/`PARTIALLY_PAID`/`PAID`) is derived from allocations on every change, never set directly, and never touches a `WAIVED` demand. No route exists for `allocateReceipt` -- docs/07-API.md's own Collections table never lists one either (only entry/verify/clear/bounce), so it is built and tested as a service only, same honest-gap pattern as Slice 3/4's unrouted functions
- [x] Partial payments, multi-demand allocation, `creditBalance` for overpayment -- overflow beyond every outstanding demand becomes `Booking.creditBalance`; **auto-applied to the next demand raised** (docs/05-COLLECTIONS-SPEC.md rule 3), wired into `raiseDemand` (`payment-plans.ts`) via `applyCreditBalanceToNewDemand`: pulls room from the booking's own `CLEARED` receipts, oldest-cleared-first, creating a real `ReceiptAllocation` against one of them rather than a receipt-less allocation -- credit is unspent room on an actual receipt, not a floating number, so `Σ(allocations per receipt) ≤ receipt.amount` still holds per receipt
- [x] Bounce reverses allocations **and** any commission released against them -- `bounceReceipt` (`VERIFIED` or `CLEARED` only, reason mandatory): reverses every non-reversed `ReceiptAllocation` (`reversedAt`, never deleted), re-derives each affected demand's status, claws back whatever portion of `creditBalance` came from this receipt's own unallocated overflow (clamped at zero), and reverses every `CommissionRelease` this receipt triggered (matched by `triggerRef = receiptId`) -- the spec's own invariant verbatim. Deliberately does **not** cascade-recompute releases on OTHER, later receipts; the doc's own invariant only requires reversing what THIS receipt triggered. 29 tests against real Postgres covering the GATE (all three assertions, plus the downline exception), the release math (single and second-incremental clear), every allocation invariant and error, the credit-balance round trip, and the full bounce reversal cascade. Verified live: enter → verify by the same enterer or by the seller (`403`, permission-gated) → verify legitimately (`200`) → clear (`200`) → re-clear (`409`) → bounce with no reason (`422`) → bounce (`200`)
- [x] Escalation ladder, `@@unique([demandId, rung])` enforced · **BLOCKED#12** -- `packages/services/src/collections-sweep.ts` `runCollectionsSweep`, copying `expireStaleHolds`'s exact shape: one transaction per demand, guarded, only records what actually fired. Offsets/audiences are PLACEHOLDER per BLOCKED#12; the mechanism is real. A run that missed several days **backfills every rung it owes**, not just the current one -- tested directly (a demand 10 days overdue with no prior sweep fires all six rungs from `DUE_MINUS_7` through `OVERDUE_7` in one pass, correctly stopping short of `OVERDUE_15`). `CHEQUE_BOUNCED` fires from `bounceReceipt` directly, not the sweep, exactly as the doc's own ladder table says. **A real bug found while wiring this**: firing a rung by INSERT-and-catch-P2002 works on SQLite/MySQL but not Postgres -- a caught constraint violation leaves the whole transaction *aborted* for every statement after it, silently breaking every later rung check, the interest update, and the promise check inside that same per-demand transaction. Fixed by checking `@@unique([demandId, rung])` first (`findUnique`) and only inserting when absent, never relying on catching the violation. A second real bug, found the same pass: the console's `where` clause built three independent `{ booking: {...} }` filter objects (project, scope, explicit associate) and spread them into one object -- the last one silently clobbered the earlier ones instead of merging, which would have let an explicit `associateId` query parameter bypass a non-admin caller's own scope entirely. Fixed by building one merged `booking` filter and validating an explicit `associateId` is inside the caller's own accessible set first
- [x] Follow-up tasks mandatory from `OVERDUE_1` (UI-surfaced, not DB-enforced -- nothing in the schema blocks other actions on an un-followed-up demand, same honesty as this tracker used for the hold-quota placeholder); promise-to-pay tracking -- `promiseToPay` creates a `PaymentFollowUp`; a promise date that passes unpaid fires `PROMISE_BREACHED` from the same sweep (checked every run, not a separate job), correctly skipped once the demand is fully paid. New permission `demand.follow_up` -- an associate-level action, mirroring `discount.request`'s role set, not `demand.raise`/`waive`'s finance-shaped one
- [x] Collections console — overdue buckets, sorted by amount within worst bucket -- `getCollectionsConsole`, gated by the existing `report.read` permission (already `O` for `ASSOCIATE` / `T` for `TEAM_LEAD` in docs/09-RBAC-MATRIX.md -- exactly this console's own scoping need, no new permission)
- [x] Delay interest accrual (optional per project) -- recomputed in **full** from the current outstanding principal and days overdue on every sweep run, not incremented, so a repeated or delayed run is idempotent without a separate "last accrued" field. Never touches `commissionableValue`/`CommissionEntry` (docs/05-COLLECTIONS-SPEC.md section 7: "never commissionable"). 17 tests against real Postgres: the ladder's fire-once and catch-up-backfill behavior, idempotent interest, `PROMISE_BREACHED` (including the fully-paid exception), `CHEQUE_BOUNCED` wiring, and the console's O/T/admin scoping. New cron: `.github/workflows/scheduled-jobs.yml`'s `'30 2 * * *'` (08:00 IST) schedule un-commented in the same commit as its route, per the workflow's own instruction. Verified live: hold → draft → confirm → raise → back-date `dueDate` 3 days overdue → trigger `/api/jobs/collections/sweep` without a secret (`401`) → with the secret (`200`, `processed: 15`) → exactly `DUE_MINUS_7`/`DUE_MINUS_3`/`DUE_MINUS_1`/`DUE_TODAY`/`OVERDUE_1` fired for that demand → an immediate re-run (`processed: 0`, confirming idempotency) → the demand appears correctly on `GET /collections/console` → a follow-up logs successfully

### Notifications
- [x] `NotificationRule` config, in-app + email channels -- `packages/services/src/notifications.ts`. `createNotificationRule` is config, gated the same way RBAC config itself is (`rbac.manage`, `SUPER_ADMIN` only -- deciding who gets notified about what is a policy decision, and `NotificationRule` has no `projectId` to scope it any narrower); no route exists for it yet (this slice's own scope is evaluation + the read endpoint), built and tested as a service only so `evaluateNotificationRules` has something real to evaluate against. `evaluateNotificationRules` resolves an enabled rule's `audience` -- role codes, `"ASSOCIATE"` (the event's own associate), `"UPLINE_L1"` (their immediate parent, the same lookup `collections-sweep.ts`'s alert recipients already do) -- into real `userId`s and creates one `Notification` row per `(user, channel)`, `status: QUEUED`. Wired into the escalation ladder and `CHEQUE_BOUNCED`: every rung fired by `runCollectionsSweep`/`bounceReceipt` now also evaluates a `DEMAND_{rung}`-coded rule, a real no-op until one is actually configured. **In-app is genuinely real and useful** -- `GET /api/v1/notifications` (own, `userId`-scoped, no permission check needed since a notification already targets exactly one user) lets a user see their queue right now. **Stated plainly, not hidden**: nothing sends an `EMAIL`/`WHATSAPP`/`SMS`-channel `Notification` anywhere -- a rule naming those channels queues real rows (the data model and audience resolution are identical regardless of channel) that sit `QUEUED` forever until a real provider is chosen and wired, matching `/api/health`'s own honest `"not yet implemented"`. 13 tests against real Postgres: rule CRUD, all three audience-resolution shapes (role code, `ASSOCIATE`, `UPLINE_L1`, including the no-parent case), multi-channel fan-out, dedup across overlapping audience entries, own-only listing, and the end-to-end wiring through a real collections sweep. Verified live: a `DEMAND_OVERDUE_1` rule configured for `org_demo` → a fresh demand raised and back-dated 1 day overdue → the sweep fires → a real `IN_APP` notification appears on `GET /api/v1/notifications` for the correct seller, `status: QUEUED`, with the right `actionUrl`/`entity`/`entityId`
- [ ] WhatsApp templates **submitted for approval** — do not defer to Phase 5 (R10). **Cannot be code-completed in this session, stated in the plan before this slice was reached, not discovered as an excuse afterward**: this needs a live WhatsApp Business Account and a real provider (`gupshup`/`interakt`/`meta_cloud` are named as *examples* in `.env.example`, none chosen), submitted to Meta for human review over days. `evaluateNotificationRules` above already builds the entire mechanism a WhatsApp channel would ride on (rule config, audience resolution, per-channel row creation) -- the day a provider is chosen, wiring actual delivery is a worker that reads `QUEUED` rows for `channel: WHATSAPP` and calls that provider's API, not a redesign

---

## Phase 3 — Commission

*4–5 weeks. The riskiest phase. Exit: golden files pass, the reproducibility
test passes, a full sale produces correct entries for seller + 3 uplines.*

**Status: 22/23 done.** All exit criteria met -- golden files pass at 100%
branch coverage, the reproducibility test passes, and a real `confirmBooking`
call produces the exact worked entries for seller + 3 uplines from docs/
04-COMMISSION-SPEC.md's own example. The one remaining item, "Visual org
tree," is a frontend screen -- out of scope, matching this project's own
backend-only pattern so far (Phases 0–2 built no frontend screen either).
BLOCKED#4–#8 stay open in the table below: every mechanism they gate is
built and tested for real, against the PLACEHOLDER values the docs and ADRs
already name explicitly, same precedent as Phase 2's discount bands and
hold TTL.

> Blocked items 4–8 must be closed before this phase starts. Building the engine
> on placeholders means rebuilding the fixtures when the real rates arrive.

### Network
- [x] Grade master with qualification thresholds · **BLOCKED#4, #8** still open — mechanism real, PLACEHOLDER values only — `packages/services/src/grades.ts`'s `createGrade`/`updateGrade`
- [x] Effective-dated `AssociateGrade` — close-and-insert, never update — `assignGrade`
- [x] Hierarchy with materialised `path`; subtree recompute on move — `packages/services/src/associates.ts`'s `moveAssociate`
- [x] **GATE** Cycle detection and self-referral block on every move — tested against a multi-level fixture, proven live over HTTP
- [x] Tree move rejected while a payout period is open — `PayoutPeriodOpenError`, tested
- [x] Grade auto-qualification job (daily, external cron) — `packages/services/src/grades.ts`'s `runGradeQualificationSweep`, copies `expireStaleHolds`/`runCollectionsSweep`'s exact one-transaction-per-associate shape; a grade with every threshold null is vacuously never auto-qualified into (tested); `/api/jobs/grades/qualify`, registered in `.github/workflows/scheduled-jobs.yml` at the same 08:00 IST slot as the collections sweep, verified live (both the authorized 200 and the unauthorized 401 path) against a running dev server
- [ ] Visual org tree — UI screen, out of scope: nothing in this project has a frontend yet

### Engine — built ahead of order this block (risk-first, see Decision log)

> Everything checked below is pure logic, golden-file tested, at 100% branch
> coverage. Nothing here is wired to a real database yet — that's `packages/services`,
> which does not exist. Persisting entries, resolving a booking's scheme
> version from the DB, and computing live collection percentages are all
> still open, listed where they belong below.

- [x] `packages/commission` — **pure, zero Prisma imports** — enforced by a package-level ESLint rule, proven to actually fail on a violation (not just proven to pass) — [04-COMMISSION-SPEC](docs/04-COMMISSION-SPEC.md)
- [x] Scheme builder, versioned, maker-checker publish · **BLOCKED#5, #6** still open (grade ladder/level-rate percentages are PLACEHOLDER; the mechanism is real) — `packages/services/src/schemes.ts`'s `createScheme`/`publishScheme`, `publishPriceList`'s pattern exactly, incumbent-archiving tested
- [x] `baseDefinition` resolver → commissionable value — lives in the booking-confirmation flow ([06-INVENTORY-SPEC §5](docs/06-INVENTORY-SPEC.md)), not in `packages/commission` — `accrue()` takes `commissionableValue` as an already-frozen input, by design; `baseDefinition` documents the rule, `Booking.commissionableValue` already enforces it, no new logic needed
- [x] **GATE** Accrual: self + level overrides, `ROUND_HALF_UP`, residual to company — `src/accrue.ts`, `src/round.ts` — **now WIRED**, not just pure: `packages/services/src/commission.ts`'s `accrueCommission`, called from `bookings.ts`'s `confirmBooking` in the same transaction, proven against `confirmBooking` end-to-end with the exact worked numbers from docs/04-COMMISSION-SPEC.md's own example (seller + 3 uplines)
- [x] **GATE** `maxTotalPct` assertion refuses to persist a breach — throws `CommissionSchemeMisconfiguredError`, tested — **now WIRED**: a breach rolls back the whole `confirmBooking` transaction, tested against real Postgres (zero `CommissionEntry` rows, booking stays `DRAFT`)
- [x] **GATE** `snapshot` written with grade, rates, upline chain, scheme version — `src/types.ts` `CommissionEntrySnapshot` — **now WIRED**: persisted onto each real `CommissionEntry` row
- [x] Compression modes `NONE` (breakage to company, reported) and `ROLL_UP` — **the spec's own pseudocode for ROLL_UP was under-specified** (a bare `continue` that discarded money without even recording it as breakage); implemented as "walk up the chain until someone eligible is found, or it becomes breakage after all" and `docs/04-COMMISSION-SPEC.md` has been corrected to match, with a revision note explaining why — **now WIRED**: breakage recorded on a `CommissionAccrual` audit row (no dedicated ledger table exists), never silently dropped
- [x] Release engine — all three modes, keyed off `clearedOn` · **BLOCKED#7** applies only to the confirmed payout-schedule number, not the mechanism — `PRO_RATA_COLLECTION` wired in Phase 2 Slice 5 (`receipts.ts`'s `releaseCommissionForBooking`); `ON_BOOKING` releases 100% in the same transaction as accrual (`commission.ts`'s `accrueCommission`); `MILESTONE` wired into `receipts.ts`'s `syncDemandStatus`, firing on `ReleaseTriggerType.DEMAND_PAID` (the one trigger genuinely fireable today — no code moves `Booking.status` past `CONFIRMED`, so `AGREEMENT_SIGNED`/`REGISTRATION`/`POSSESSION` slabs stay unfireable, a future phase's booking-lifecycle work), tested releasing incrementally as slabs fire one at a time and skipping (not half-computing) a scheme with no matching slabs
- [x] Clawback → contra entries → `Recovery`, with per-cycle deduction cap — pure computation (`computeClawback`) done and tested; contra entry + `Recovery` persistence shipped in Phase 2 Slice 2 (`bookings.ts`'s `cancelBooking`); the deduction cap (`PAYOUT_RECOVERY_MAX_DEDUCTION_PCT`, PLACEHOLDER 50%) now closed at payout-batch time — `packages/services/src/payouts.ts`'s `prepareBatch`, deducting oldest-outstanding-`Recovery`-first, capped at 50% of each line's gross, tested against a recovery larger than the cap and one fully satisfied under it
- [x] **GATE** Golden-file fixtures, all cases in [§8](docs/04-COMMISSION-SPEC.md), **100% branch coverage** — 15 cases (12 from the spec + 3 extensions the implementation surfaced), `vitest run --coverage` exits 0 against a 100% threshold on every metric
- [x] **GATE** Reproducibility test — mutate tree and grades, re-run, byte-identical — passing, plus a negative-control test proving the mutation would have mattered on a different booking date (so the main test isn't accidentally vacuous)
- [x] Scheme simulator (no writes) — `packages/services/src/commission.ts`'s `simulateScheme`, calls `accrue()` directly against a caller-supplied hypothetical, works against a DRAFT scheme too, tested to write zero rows
- [x] Explain drill-down — [08-SCREENS §2](docs/08-SCREENS.md) — `explainEntry`, `GET /commission/entries/:id/explain`, verified live over HTTP
- [x] Earnings screen with **"₹X blocked by ₹Y in pending collections"** — `getEarnings`, `GET /associates/:id/earnings`, both numbers computed from real `CommissionRelease`/`Demand`/`ReceiptAllocation` rows (the exact canonical outstanding-balance query `receipts.ts`'s `allocatedTotalForDemand` already established), verified live over HTTP
- [x] Dispute workflow — `packages/services/src/commission.ts`'s `raiseDispute` (gated by `commission.read`, same O/T/admin scope as `explainEntry`, sets the entry `ON_HOLD`) and `resolveDispute` (new `commission.dispute_resolve` permission, mirroring `payout.approve`'s exact role set; restores the entry to its prior status either way, recomputed from whether it has a non-reversed `CommissionRelease` rather than stored; an `Adjustment` row created only when the resolution names a signed amount)
- [x] **GATE** Invariant monitor live and paging — ships with the engine, not after — `packages/services/src/invariant-monitor.ts`'s `runInvariantChecks` asserts the FULL list in docs/13-TEST-STRATEGY.md across all four domains (6 commission, 3 inventory, 4 collections, 3 network-and-duties), never throws, always reports; `/api/jobs/monitor/invariants`, nightly 00:00 IST, registered in `.github/workflows/scheduled-jobs.yml`. Honest "paging" note: no real paging provider exists anywhere in this project's dependencies — the route returns non-200 on any violation, turning the nightly GitHub Actions run red, this project's actual working alert channel today (same posture as `holds/expire`'s own route). Verified live against a running dev server: a clean pass (200), a genuine injected violation (500, correctly identified and named), and the unauthorized path (401). Building this surfaced one real gap it fixed in passing: `bookings.ts`'s `cancelBooking` created contra `CommissionEntry` rows with no audit trail at all -- now audited the same way `accrueCommission` audits every entry it creates

---

## Phase 3.5 — Frontend

*New phase, not a renumbering — Phase 4/5 below keep their names, numbers,
and scope as-is. Sequenced per the approved plan
(`i-am-working-on-functional-fountain.md`): Associate PWA first, then
back-office by docs/08-SCREENS.md's own section order. Never ship a screen
against a backend gap — fold missing backend into the same slice.*

### Slice 1 — Foundation (stack, session, formatters, login + MFA)

- [x] Tailwind v4 + shadcn/ui (`base-nova` style, `@base-ui/react` primitives —
  the current `npx shadcn@latest init` default, not classic Radix) —
  `apps/web/postcss.config.mjs`, `apps/web/app/globals.css` (design tokens:
  slate neutrals, `--primary` blue-600 `#2563eb`, `--success`/`--warning`/
  `--danger`), `apps/web/components.json`
- [x] `apps/web/lib/session.ts` (`getSession`/`requireSession`) and
  `apps/web/lib/api-session.ts` (`readSessionToken`, `SESSION_COOKIE_NAME`) —
  `board/[projectId]/page.tsx` migrated off its inline cookie-read
- [x] `apps/web/lib/format.ts` (`formatDate`, `formatDateTime`,
  `formatCountdown`, `groupIndian`) + `apps/web/lib/money.ts`
  (`formatMoney`, `formatMoneyCompact`, `formatArea`) — **split into two
  files, not the one the plan named**: `lib/format.ts`'s money/area helpers
  need `Prisma.Decimal` from `@desire/db`, and board's `InventoryBoard.tsx`
  (a client component) re-exports board's own formatters through the same
  module — one file would have dragged `pg`/`net`/`tls` into the browser
  bundle. Board's `format.ts` now just re-exports the shared pieces it used
  to duplicate.
- [x] `packages/services/src/rbac.ts`: `getSessionPermissions`
- [x] Login + MFA (first ever in this repo) — `apps/web/app/login/{page,actions}.tsx`,
  `login/mfa/`, `login/mfa-enroll/`, `login/pending.ts`, `login/session.ts`.
  MFA requirement is checked via **`Role.requiresMfa` from the DB**
  (`packages/services/src/auth.ts`'s new `userRequiresMfa`), not a
  role-code string match against `MFA_REQUIRED_ROLE_CODES` — that constant
  is test/seed-assertion only, per its own comment. QR rendered server-side
  (`qrcode` package, SVG) from `buildMfaEnrollmentUri`; the pending
  password-verified-but-not-yet-MFA-verified state travels in a short-lived
  (5 min) cookie encrypted with the existing `encryptField`/`PII_ENCRYPTION_KEY`
  primitive rather than a new signing scheme.
- [x] `apps/web/app/page.tsx` redirects: unauthenticated → `/login`,
  ASSOCIATE/TEAM_LEAD → `/home`, everyone else → `/dashboard`. Both targets
  are minimal real placeholder pages (Slice 2 fleshes them out) rather than
  routes that don't exist yet.
- [x] Verified live end-to-end against a running dev server + seeded Neon
  data (`pnpm db:seed`, 8 demo users): plain login (PROJECT_MANAGER, no
  MFA) → `/dashboard`; invalid-credentials error shown inline; MFA
  enrollment (SALES_HEAD, real QR scanned via a script computing the TOTP
  from the displayed secret) → session created; MFA challenge on a second
  login (same user, now `mfaEnabled`) → verified against the persisted
  encrypted secret; the live inventory board re-tested after the
  session/format refactor (unchanged rendering, area labels correct).

### Slice 2 -- Role-aware shell + dashboards

- [x] `apps/web/lib/nav.ts` -- static nav-tree data (section -> gating
  permission code(s) -> route) for both shells, filtered by a permission
  SET (`filterNav`), not a role-name string check. Collections needs a
  union of several role-specific grants (no single permission covers it);
  every other section uses one representative code.
- [x] Back-office shell -- `apps/web/app/(back-office)/layout.tsx`, shadcn's
  `Sidebar` (base-nova/`@base-ui` uses a `render` prop, not classic Radix
  `asChild`, on `SidebarMenuButton`)
- [x] PWA shell -- `apps/web/app/(pwa)/layout.tsx`, a plain fixed bottom tab
  bar (not the desktop `Sidebar`) filtered the same way -- Team correctly
  hidden for a plain ASSOCIATE and shown for TEAM_LEAD, verified live
- [x] Real dashboards (no lorem ipsum): `(pwa)/home/page.tsx` (ASSOCIATE/
  TEAM_LEAD landing -- `getEarnings` + today's scheduled `SiteVisit` rows as
  "today's follow-ups"); `(back-office)/dashboard/page.tsx` role-branched --
  SUPER_ADMIN/SALES_HEAD/PROJECT_MANAGER see project/unit/booking counts,
  FINANCE_ADMIN sees a real collections-aging bucket summary (built on
  `getCollectionsConsole`, no new aggregation function needed), everyone
  else (SALES_ADMIN, AUDITOR) gets a real minimal "your open items" tile
  (project/unit/open-lead counts) rather than a placeholder
- [x] Verified live against a running dev server across every role in the
  seed (SALES_HEAD, AUDITOR, ASSOCIATE, TEAM_LEAD): sidebar/tab filtering
  matches `packages/db/src/permission-matrix.ts` exactly per role
  (Payouts/Admin hidden from SALES_HEAD, Admin shown to AUDITOR via
  `audit.read`, Collections hidden from AUDITOR, Team hidden from
  ASSOCIATE / shown for TEAM_LEAD); keyboard-focus spot check on the
  back-office sidebar shows a visible focus ring

### Slice 3 -- PWA: Home tab polish + Inventory tab

- [x] Home tab deepened: today's task count + unread-alert count stat
  tiles, plus a real Alerts card (`listNotifications`, unread bolded)
- [x] Inventory tab -- `apps/web/app/(pwa)/inventory/page.tsx` (project
  picker) + `[projectId]/page.tsx` + `InventoryList.tsx`. Reuses, does not
  duplicate: board's `useUnitDeltas` hook completely unmodified (it turned
  out to already be presentation-agnostic -- only `InventoryBoard.tsx`'s
  tower/floor grid layout is desktop-specific, not the hook itself),
  `STATUS_PRESENTATION` data, and the existing hold route
  (`POST .../units/:id/holds`) via a client-side `fetch` -- the one place
  that's justified over a Server Action, matching the board's own pattern
- [x] **Real bug caught during live testing, fixed before commit**: the
  delta poll carries no holder identity (docs/06-INVENTORY-SPEC.md section
  6), and a first draft kept showing the PAGE-LOAD snapshot's `isMine`/
  `heldByName` even after a live delta changed a unit's status --
  mislabelling a hold as "Held by Another associate" when it could easily
  have been the viewer's own hold, or vice versa. Board already solved
  this exact problem (`InventoryBoard.tsx`'s `holderIsFromSnapshot`); the
  PWA list now mirrors it exactly -- a unit whose status came from `live`
  strips `isMine`/`heldByName` and shows "Taken since this list loaded --
  Refresh to see who" instead of guessing
- [x] Verified live: held/available/blocked units render with the correct
  colour + glyph + label (no colour-only status), tapping a unit opens a
  real detail sheet with real area figures, holding an available unit
  succeeds (201, confirmed via network log), the list picks it up on the
  next poll, and a full reload correctly resolves "Your hold expires" for
  the viewer's own hold

### Slice 4 -- PWA: Leads tab

- [x] `apps/web/app/(pwa)/leads/page.tsx` (list, stage-filter chips via
  `?stage=`) and `[leadId]/page.tsx` (detail + activity timeline + "log
  activity" + "schedule site visit" forms as Server Actions). Wires
  entirely to the existing `leads.ts` -- no backend gap. The single-lead
  read reuses `listLeads` (already correctly scoped: ASSOCIATE own,
  TEAM_LEAD own + downline) and finds the one row, rather than an unscoped
  direct lookup -- no scoped single-lead getter exists yet, and this reuse
  is honestly correct at demo scale even though it is not the most
  efficient shape
- [x] **Real bug caught during live testing, fixed before commit**: the
  "log activity" form let a caller pick a target stage regardless of
  activity type, but `logActivity` only ever applies `toStage` when
  `type === "STAGE_CHANGE"` (by design -- a stage move is its own event,
  not an attribute on a call or note). The form silently accepted a stage
  pick on a "Call" entry and dropped it, which reads as a bug to whoever
  is filling it in. Fixed with a clarifying label rather than hidden
  client-side show/hide logic, keeping the form plain RSC + Server Action
- [x] Verified live end-to-end against a running dev server (with one lead
  seeded via `createLead` for this check): logging a "Call" with a note,
  then a "Stage change" (confirmed `Lead.stage` actually moved New ->
  Contacted and the timeline recorded "Stage: New -> Contacted"), and
  scheduling a site visit (confirmed it appears in the Site visits list)

### Slice 5 -- PWA: Earnings tab + Team tab (closes out the PWA)

- [x] Earnings tab -- `apps/web/app/(pwa)/earnings/page.tsx`:
  accrued/payable/paid + blocked-by-collections (reuses `getEarnings`),
  a real grade ladder (all org grades, current rung highlighted -- NOT a
  fabricated progress percentage: every seeded grade's auto-qualification
  thresholds are still PLACEHOLDER `null`, so a numeric progress bar would
  be dishonest; ladder position is the real thing available today), and
  Statements -- the associate's own `CommissionEntry` rows (no
  `PayoutBatch`/PDF exists yet, that is Phase 4 -- entries themselves are
  the honest real "statement" for now), each linking to explain
- [x] **"Explain this number"** (one of 08-SCREENS.md's three screens that
  carry the product) -- `apps/web/app/(pwa)/earnings/[entryId]/explain/page.tsx`,
  the full derivation tree rendered straight from `CommissionEntry.snapshot`
  via `explainEntry`, called directly RSC-side. First UI for this endpoint
  (previously API-only since Phase 3); reused again as-is in Slice 13's
  back-office Commission Ledger rather than rebuilt
- [x] Team tab (managers only) -- `apps/web/app/(pwa)/team/page.tsx`,
  downline roster via `getAssociateTree` plus a small real aggregation
  (total non-reversed commission per downline associate, `groupBy` --
  no dedicated performance function exists yet, and this is a plain read)
- [x] Verified live end-to-end: seeded a real confirmed booking +
  `CommissionEntry` + `CommissionRelease` (going through the actual
  `createDraftBooking`/`confirmBooking` transactional flow kept timing out
  against this dev environment's Neon connection -- environment latency,
  not a product bug -- so the row was inserted directly for this one
  verification pass) and confirmed: the Earnings summary matches
  (₹97,500 payable, ₹58,500 blocked = 97,500 − 39,000 released), the
  Statements entry links through, the explain page's derivation matches
  the snapshot exactly (seller rate, grade, scheme version, release
  status), and the Team tab shows the downline associate with the correct
  aggregated total
- [x] This closes the PWA -- all 5 tabs (Home, Inventory, Leads, Earnings,
  Team) are real

### Slice 6 -- Back-office: Dashboard section (deepen)

- [x] `apps/web/app/(back-office)/dashboard/page.tsx` deepened from
  Slice 2's single either/or view into composed, role-specific widget sets
  -- no backend gaps, every widget reads an existing table or the existing
  `getCollectionsConsole`:
  - SUPER_ADMIN: everything (stock/booking, collections aging, commission
    overview, pending price lists, pending discount approvals)
  - FINANCE_ADMIN: collections aging (existing) + a new commission
    overview (org-wide accrued/payable/paid via `groupBy`)
  - PROJECT_MANAGER: stock/booking (existing) + new pending-price-lists
    queue (`PriceList` where `status: PENDING_APPROVAL`)
  - SALES_HEAD: stock/booking (existing) + new pending-discount-approvals
    queue, correctly filtered to `approverRoleCode: "SALES_HEAD"` -- not
    every pending request, only the ones actually routed to this role
  - SALES_ADMIN: unchanged minimal "your open items" -- no permission in
    the matrix maps to a distinguishing widget for this role yet
  - AUDITOR: new real "recent activity" feed off the existing `AuditLog`
    table (last 10 org-wide entries) + the open-items tile -- an honest
    preview, not the full filterable browser Slice 15 builds
- [x] Verified live across four roles against a running dev server:
  SALES_HEAD (stock/booking + empty discount-approval queue),
  PROJECT_MANAGER (stock/booking + empty price-list queue), AUDITOR (real
  audit-log entries spanning every earlier slice's own testing, plus open
  items) -- each showing exactly its own role's widget set, nothing more

### Slice 7 -- Back-office: Projects section

- [x] **Backend gap closed**: `schemes.ts`'s `createScheme`/`publishScheme`
  had zero HTTP routes since Phase 3 -- added
  `apps/web/app/api/v1/schemes/route.ts` (POST create) and
  `.../[schemeId]/publish/route.ts` (POST publish), both using
  `readSessionToken` from `lib/api-session.ts`, request bodies narrowed by
  hand-written parsers (no `any`) rather than trusting the shape.
  **Naming correction caught by the dev server itself**: the publish
  route's dynamic segment had to be named `[schemeId]`, matching its
  sibling `simulate` route, not `[id]` as first written -- Next.js refuses
  to boot when siblings at the same path depth disagree on a slug name,
  and the dev server crash on start made this impossible to miss
- [x] Detail page (`apps/web/app/(back-office)/projects/[projectId]/page.tsx`)
  covers List/Detail/Towers/Units/Price lists/Payment plans/Commission
  scheme on one page rather than six routes -- 08-SCREENS.md lists them as
  one "Projects" section. "Units" here is the unit-TYPE catalogue a price
  list prices against (a project-configuration concern), not live
  inventory monitoring -- that stays on the board, linked in from Slice 8.
  Real create actions for towers, unit types, draft price lists (+
  publish), payment plans (single 100%-on-booking milestone -- full
  milestone editing explicitly deferred), and commission schemes (+
  publish) -- all calling the existing service functions directly via
  Server Actions, per the back-office data pattern, not through the new
  HTTP routes
- [x] **Real bug caught during live testing, fixed before commit**: every
  mutation above can genuinely fail on an expected business rule (wrong
  role, maker-checker, a duplicate code) -- a first pass let these throw
  uncaught, crashing to Next's generic "Application error" page instead of
  a message. Fixed with a shared `runAction` wrapper that catches and
  redirects with the real error text as a query param -- these are
  internal back-office actors, so the actual service error message is
  safe and useful to show verbatim, same discipline as the login flow
- [x] Verified live end-to-end against a running dev server across three
  roles: PROJECT_MANAGER created a tower and a unit type; SALES_HEAD hit
  the friendly `pricelist.approve`/`project.write` permission errors
  correctly (confirming the fix) then successfully published a draft
  price list (confirmed the outgoing version auto-archived); SUPER_ADMIN
  created a payment plan and a draft commission scheme, hit the
  maker-checker violation publishing their own scheme, and SALES_HEAD then
  published it successfully as the second approver (confirmed ACTIVE +
  the prior version ARCHIVED)

### Slice 8 -- Back-office: Inventory section

- [x] **Backend gap closed**: no existing function answered "list all
  current holds" or "list blocked units" (`getUnitDeltas` is delta-since
  only) or "units grouped by tower/type/status" -- added `listActiveHolds`,
  `listBlockedUnits`, `getStockStatement` to `packages/services/src/units.ts`,
  with real Postgres tests in `test/units.test.ts` (27 tests total, package
  coverage 87%+ on this file, well above the repo's 80% gate)
- [x] Live board -- kept at its existing path
  (`apps/web/app/board/[projectId]`), not moved. **Route naming fix**: the
  hub and its three sub-screens were first built at `/inventory`, which
  collides with the PWA's own `/inventory` route (route groups don't
  affect the URL) -- Next.js refused to build ("You cannot have two
  parallel pages that resolve to the same path"). Renamed to `/stock`
  (`/stock`, `/stock/holds`, `/stock/blocked`, `/stock/statement`) and
  updated `lib/nav.ts`'s Inventory entry to match
- [x] **Real bug caught during live testing, fixed before commit**:
  `getStockStatement` first grouped by the unit's raw `status` column, but
  every other inventory screen in this codebase (board, the deltas
  endpoint, the new Active holds screen) treats a hold past its
  `expiresAt` as AVAILABLE even before the nightly sweep runs
  (`effectiveUnitStatus`) -- the statement would have disagreed with the
  board for as long as an expired hold sat unswept. Fixed to fetch-then-
  reduce with the same effective-status computation, with a test asserting
  the exact scenario
- [x] Verified live against a running dev server: Active holds listed 5
  real holds (unit, project, holder name+code, expiry) accumulated from
  earlier slices' own testing; Blocked units showed the correct honest
  empty state; Stock statement's project picker and grouped table both
  rendered correctly, matching the board's own live counts

### Slice 9 -- Back-office: CRM section

- [x] Leads list (`/crm`) and detail (`/crm/[leadId]`) -- desktop re-skin
  of the PWA Leads screens' data via the existing `listLeads`, with fuller
  columns (source, assigned associate) and a stage-filter chip row. Backend
  ready, no gap.
- [x] **Scope reduction, stated explicitly**: 08-SCREENS.md's "bulk actions
  (reassign)" was built as a single-lead reassign action on the detail page
  (`reassignLeadAction` -> `reassignLead`), not a multi-select bulk-reassign
  UI -- that's a real, separable enhancement, not required for a working
  reassign flow, and out of scope for this slice's time/context budget.
- [x] **Backend gap closed**: no aggregation existed for source ROI. Added
  `getSourceRoi(db, { orgId, actorId, from?, to? })` to
  `packages/services/src/leads.ts` -- leads-per-source vs. bookings-per-
  source (a "booked" lead has >=1 non-cancelled `Booking` via the existing
  `Lead.bookings` relation, not the same as `stage === "BOOKED"`, which can
  go stale). Org-wide by design (a leadership view, not scoped to
  own/downline like `listLeads`). Real Postgres tests added to
  `test/leads.test.ts` (converted vs. unbooked leads, cancelled bookings
  excluded, permission refusal) -- 37 tests total in the file, all passing.
  Rendered at `/crm/source-roi`.
- [x] Reused the `runAction` try/catch-and-redirect-with-message pattern
  from Slice 7 for `reassignLeadAction`.
- [x] Verified live against a running dev server: `/crm` listed the real
  "Test Buyer" lead (WALK_IN, Contacted, assigned to Demo Associate) from
  earlier slices' seeded/tested data; the detail page rendered the same
  activity timeline and site visit the PWA Leads screen shows; submitted
  the Reassign form live (Test Buyer -> Demo Team Lead) and confirmed the
  "Currently:" line updated after the round trip; `/crm/source-roi` showed
  the correct live row (WALK_IN: 1 lead, 0 booked, 0%) matching the
  Test Buyer lead having no booking yet.

### Slice 10 -- Back-office: Bookings section

- [x] **Backend gap closed**: bookings.ts had only a single-row `getBooking`
  (org-scoped only, no row-level scope), no list existed at all. Added
  `listBookings` (List screen) and `getBookingForActor` (Detail screen),
  scoped exactly as the existing `GET /bookings/:id` route already
  hand-rolled this check inline (`booking.read`: ASSOCIATE sees own,
  TEAM_LEAD sees own + downline, everyone else with the permission sees the
  whole org) -- same split as `leads.ts`'s `listLeads`, resolved through the
  one scope resolver (`getAccessibleAssociateIds`), never a second hand-
  rolled copy in the UI layer. `getBookingForActor` returns `null` (not a
  thrown error) both for a missing booking and one outside scope, matching
  the existing route's "don't reveal existence" reasoning.
- [x] **Backend gap closed**: `discounts.ts`'s `decideDiscount` could only
  act on a request id you already had -- no queue view existed. Added
  `listPendingDiscountRequests`, filtered to exactly what this actor could
  act on (PENDING, not their own request, within `resolveApproverRoles`'
  band for their role) -- the same three checks `decideDiscount` itself
  enforces, applied here as a filter instead of a thrown error.
- [x] Real Postgres tests added: 6 for `listBookings`/`getBookingForActor`
  scope (`bookings.test.ts`, 26 tests total in the file), 4 for
  `listPendingDiscountRequests` (`discounts.test.ts`, 18 tests total) --
  all passing.
- [x] Screens: `/bookings` (list, status filter chips, link to Discount
  approvals gated on `discount.approve`), `/bookings/[bookingId]` (cost
  sheet, discount requests + a request form when DRAFT, a cancellation
  panel with a live clawback preview + cancel form when CONFIRMED),
  `/bookings/discount-approvals` (the approval queue, approve/reject forms).
  Reused the `runAction` try/catch-and-redirect-with-message pattern from
  Slices 7/9 for all three mutations (request discount, cancel booking,
  decide discount).
- [x] Verified live against a running dev server: `/bookings` listed the
  real seeded `TEST-SEED-0001` booking (project, unit, customer, status,
  agreement value, date) with the Discount approvals link visible for
  SUPER_ADMIN; the detail page rendered its cost sheet, empty discount-
  requests state, and a real clawback preview line (₹39,000 recovery) for
  its CONFIRMED status; `/bookings/discount-approvals` showed the correct
  honest empty state. No console errors from the running server.
- [x] **Known environment limitation, not exercised live**: `requestDiscount`,
  `decideDiscount` and `cancelBooking` each wrap their write in
  `db.$transaction`, and this dev shell's `DATABASE_URL` points at hosted
  Neon -- the same Neon round-trip latency already documented in Slice 5
  reliably exceeds Prisma's 5s interactive-transaction timeout from this
  environment for `createDraftBooking`/`confirmBooking`. Not attempted live
  for the same reason it wasn't there: an infra limitation of this dev
  shell, not a product bug. Coverage for the actual mutation logic is the
  real-Postgres test suite (above), and the UI wiring is the same
  `runAction`-plus-Server-Action pattern already proven live in Slice 9's
  Reassign flow.

### Slice 11 -- Back-office: Collections section

- [x] Console + Aging: `/collections` uses the existing `getCollectionsConsole`
  (one row per open demand, already carrying `daysOverdue`). The separately-
  named "Aging report" screen is the same rows regrouped into buckets
  (Current/1-30/31-60/61-90/90+) computed on the page rather than a second
  aggregation query added to `collections-sweep.ts` -- it is the same data
  at a different grouping, not a second read.
- [x] Demands: folded into the Booking detail page (Slice 10) as a "Payment
  schedule" card using the existing `getDemandsForBooking` (gated by
  `booking.read`, not a separate permission -- "a demand schedule is a view
  of its booking's payment plan, not an independent resource" per its own
  doc comment) plus Raise/Waive actions -- a demand is inherently booking-
  scoped, so this is the real screen for it, not a workaround for a missing
  org-wide list.
- [x] **Backend gap closed**: `receipts.ts` had no way to list receipts at
  all (every function acts on a `receiptId` you already have). Added
  `listReceipts` (org-wide, optional status filter), gated by the same
  `report.read` permission `getCollectionsConsole` already uses for viewing
  collections data. `/collections/receipts` (all receipts + enter-receipt
  form + inline verify/clear/bounce actions) and
  `/collections/verification-queue` (the same list, `status: "ENTERED"`)
  are two views of this one function, not two reads.
- [x] **Explicit scope reduction**: `allocateReceipt` (splitting a receipt's
  amount across specific demand lines) is not exposed as its own UI this
  slice -- a real, separate many-to-many allocation screen, not required
  for the enter/verify/clear/bounce maker-checker lifecycle (the "highest-
  value control in the system" per receipts.ts's own header comment) to
  work correctly end-to-end. Tracked here as a follow-up, not silently
  dropped.
- [x] Real Postgres tests added: 4 for `listReceipts` (`receipts.test.ts`,
  33 tests total in the file) -- all passing.
- [x] Verified live against a running dev server: `/collections`,
  `/collections/receipts`, and `/collections/verification-queue` all
  rendered correctly with honest empty states (this org's seeded demo data
  has no raised demands or receipts yet); the Booking detail page's new
  Payment schedule card rendered its honest "no payment plan attached"
  state for the seeded `TEST-SEED-0001` booking. No errors from the running
  server (confirmed via server logs, not just the browser console, which
  still carried stale entries from earlier in this long testing session).
- [x] **Known environment limitation, not exercised live**: same as Slice
  10 -- `enterReceipt`/`verifyReceipt`/`clearReceipt`/`bounceReceipt`/
  `promiseToPay`/`raiseDemand`/`waiveDemand` all wrap their write in
  `db.$transaction` against this dev shell's hosted-Neon `DATABASE_URL`,
  the same round-trip latency already documented for `createDraftBooking`/
  `confirmBooking`. Coverage is the real-Postgres test suite; the UI wiring
  reuses the already-proven `runAction` pattern.

### Slice 12 -- Back-office: Network section

- [x] Org tree, Associates list, Associate detail (move + assign grade +
  earnings): backend ready, no gap -- `listAssociates`/`getAssociateTree`
  already carry `depth`/`parentId`, so the tree screen (`/network`) and the
  flat list (`/network/associates`) render the exact same read two ways
  rather than duplicating it. The detail page reuses `getEarnings` (already
  proven live in the PWA Earnings tab, Slice 5) and folds the Move/Assign-
  grade forms onto the same page, the "detail page owns its own actions"
  pattern from CRM (Slice 9) and Bookings (Slice 10).
- [x] **Backend gap closed**: `grades.ts`'s `createGrade`/`updateGrade` had
  zero HTTP routes. Added `POST /api/v1/grades` and
  `PATCH /api/v1/grades/[gradeId]` (thin handlers, same error-mapping style
  as Slice 7's scheme routes), plus the `/network/grades` CRUD screen
  (create + activate/deactivate) calling the service functions directly per
  this phase's own back-office data pattern.
- [x] **Plan correction, verified against the actual code before building**:
  the plan's own first guess for "Promotions" was `HierarchyChangeLog` --
  checked `moveAssociate` directly and confirmed that table records ORG-
  TREE moves (who reports to whom), a different concept from a grade
  change. `runGradeQualificationSweep` and `assignGrade` both close-and-
  insert `AssociateGrade` rows instead, which is the actual promotion
  history (a `null` `approvedById` distinguishes an auto-qualification from
  a human decision) -- added `listGradeHistory` to `grades.ts` against that
  table instead, scoped identically to `listAssociates` (O/T/admin split),
  and built `/network/promotions` as a read-only table against it.
- [x] Real Postgres tests added: 4 for `listGradeHistory`
  (`grades.test.ts`, 16 tests total in the file) -- all passing.
- [x] Verified live against a running dev server: `/network` rendered the
  real two-level seeded tree (Demo Team Lead > Demo Associate) with correct
  indentation; the associate detail page showed real earnings figures
  (₹97,500 payable, ₹58,500 blocked) and populated Move/Assign-grade
  dropdowns; `/network/grades` listed all 6 seeded grades with real hold
  quotas; `/network/promotions` showed both associates' real auto-qualified
  initial grade assignments. No server errors.
- [x] **Known environment limitation, not exercised live**: same as Slices
  10-11 -- `moveAssociate`, `assignGrade`, `createGrade` and `updateGrade`
  all wrap their write in `db.$transaction` against this dev shell's
  hosted-Neon `DATABASE_URL`. Coverage is the real-Postgres test suite
  (existing tests plus this slice's additions); the UI wiring reuses the
  already-proven `runAction` pattern.

### Slice 13 -- Back-office: Commission section

- [x] **Backend gap closed**: `commission.ts` had no ledger read at all
  (`explainEntry`/`getEarnings` each resolve one entry or one associate's
  aggregate). Added `listCommissionEntries`, scoped identically to
  `explainEntry`/`getEarnings`'s own `assertAssociateInScope` (own /
  own+downline / org-wide), as a set filter rather than a per-row
  assertion since a ledger returns many associates' rows at once. Powers
  `/commission`, with an inline "Explain" link into the Slice 5 PWA page
  (`/earnings/:id/explain`) reused directly, and an inline "Dispute" form
  since `raiseDispute` needs nothing the row doesn't already have.
- [x] **Backend gap closed**: `schemes.ts` had no cross-project browse
  (`getSchemeById`/`getActiveScheme` each resolve exactly one). Added
  `listSchemes`, gated by `commission.read` (the same permission the
  ledger it produces is gated by). Powers `/commission/schemes`; creating/
  publishing a scheme stays on the Projects detail page (Slice 7) since
  that is where a scheme belongs to one project's configuration.
- [x] Scheme simulator: `/commission/schemes/[schemeId]/simulate` calls the
  already-routed `simulateScheme` directly. Built as a native GET form
  into the page's own `searchParams` rather than a Server Action, since
  the endpoint's own contract is "no writes" (docs/07-API.md) -- there is
  nothing to mutate or redirect away from. Verified live: a hypothetical
  ₹50,00,000 booking against the real "Skyline Phase 3" v2 scheme (1.5%
  grade rate) correctly returned ₹75,000 with zero breakage, with zero
  rows written to `commission_entries`.
- [x] **Backend gap closed**: `raiseDispute`/`resolveDispute` had zero HTTP
  routes. Added `POST /api/v1/commission/entries/[entryId]/dispute`
  (matching docs/07-API.md's already-documented path exactly, rather than
  the plan's own guessed `/commission/disputes` path for raising) and
  `POST /api/v1/commission/disputes/[disputeId]/resolve` (undocumented,
  following the plan since no existing path names it). Built
  `/commission/disputes` as a read-only PENDING queue queried directly
  (same precedent as the Projects detail page's own direct queries, Slice
  7) rather than a new list service function -- an org-wide queue has no
  O/T/admin scope to resolve, unlike the ledger. Resolve actions render
  only for a `commission.dispute_resolve` holder; `resolveDispute` itself
  re-checks regardless.
- [x] Real Postgres tests added: 5 for `listCommissionEntries`
  (`commission-reads.test.ts`, 13 tests total in the file), 4 for
  `listSchemes` (`schemes.test.ts`, 12 tests total) -- all passing.
- [x] Verified live against a running dev server: `/commission` listed the
  real seeded PAYABLE entry (₹97,500, Demo Associate) with working status
  filter chips; "Explain" correctly opened the existing PWA drill-down
  page showing the real derivation (1.5% of ₹65,00,000 commissionable
  value); `/commission/schemes` listed both the ACTIVE v2 and ARCHIVED v1
  Skyline schemes with real grade rates; the simulator produced a correct
  live result (see above); `/commission/disputes` showed the correct
  honest empty state. No server errors.
- [x] **Known environment limitation, not exercised live**: `raiseDispute`
  and `resolveDispute` both wrap their write in `db.$transaction` against
  this dev shell's hosted-Neon `DATABASE_URL`, same as every other
  mutation this phase has hit the limitation on. Coverage is the real-
  Postgres test suite (Phase 3's own existing dispute tests); the UI
  wiring reuses the already-proven `runAction` pattern.

### Slice 14 -- Back-office: Payouts section (backend-first slice)

- [x] **Backend gap closed, as the plan itself flagged**: this whole section
  had no HTTP surface at all -- `prepareBatch`/`approveBatch`/`exportBatch`
  existed since Phase 3 with zero routes, and no read (list or detail) ever
  existed. Added `listPayoutBatches`, `getPayoutBatch`, `listRecoveries`,
  `listAdjustments` to `payouts.ts`, all gated by `payout.prepare` (the
  same permission `prepareBatch` itself requires -- `payout.prepare` and
  `payout.approve` are always granted together per `permission-matrix.ts`,
  so one code covers both preparer and approver views).
- [x] Routes added: `GET`/`POST /api/v1/payouts/batches` (list / prepare),
  `GET /api/v1/payouts/batches/[batchId]` (detail -- documented in
  docs/07-API.md but missing from the plan's own route list, added to
  match the documented surface), `POST .../approve`,
  `POST .../export`. **Deliberate deviation from docs/07-API.md**: its
  table lists export as `GET`, but `exportBatch` mutates the row (status
  -> EXPORTED, sets `exportedAt` and the stub `bankFileStorageKey`) -- a
  real state transition, not a safe/idempotent fetch, so `POST` is used
  instead, consistent with every other state-transitioning route in this
  codebase (scheme/price-list publish, booking confirm/cancel).
- [x] Screens: `/payouts` (list + prepare form), `/payouts/batches/[id]`
  (totals, approve/export actions folded onto the detail page per this
  phase's own established pattern, line-by-line breakdown),
  `/payouts/recoveries` and `/payouts/adjustments` (read-only -- this
  slice's route list creates no Adjustment-authoring endpoint; the only
  place one is created today is `commission.ts`'s `resolveDispute`, so
  Adjustments is an audit-style view, the same scope Slice 12's Promotions
  screen used for the same reason).
- [x] **Statements (PDF) explicitly descoped**, exactly as the plan
  directed: no PDF library exists anywhere in this repo (the Allotment-
  letter PDF from Phase 2 is still unchecked), and adding one is the kind
  of new-dependency decision this project has always paused on rather than
  pulling in silently as a side effect of a UI slice. The batch detail
  page states this plainly once a batch is EXPORTED, and it is tracked
  here rather than silently dropped.
- [x] Real Postgres tests added: 8 for the four new reads (`payouts.test.ts`,
  20 tests total in the file) -- all passing.
- [x] **Live verification limited to the permission boundary, honestly
  noted**: the dev-server browser session authenticated earlier in this
  phase's testing lacks `payout.prepare` (confirmed by nav correctly
  hiding the Payouts link, matching every other role-gated section this
  phase has built), so `/payouts` correctly threw a `ForbiddenError` end-
  to-end through the real page -> service -> rbac stack against real
  Neon data -- a genuine, valid verification of the security-critical
  path, just not of the data-rendering path. Switching to a super-admin
  session was not possible without either writing directly to the hosted
  Neon database outside the app (attempted, correctly refused by the
  session's own auto-mode permission classifier as an inappropriate
  direct-DB action) or adding a logout feature out of this slice's scope.
  Data-rendering correctness for these same read/list/detail/table
  patterns has already been proven live four times this phase (Bookings,
  Collections, Network, Commission), and every new function here is
  covered by the real-Postgres test suite above.
- [x] **Known environment limitation, not exercised live**: `prepareBatch`,
  `approveBatch` and `exportBatch` all wrap their write in
  `db.$transaction` against this dev shell's hosted-Neon `DATABASE_URL`,
  same as every other mutation this phase has hit the limitation on.

### Slice 15 -- Back-office: Reports and Admin sections (scoped honestly)

- [x] **Reports: deferred, exactly as the plan directed.** Read
  `docs/20-REPORTS.md` as the first step, as instructed -- it names roughly
  20 distinct reports (Inventory/Sales & CRM/Collections/Network/
  Commission categories) with a shared CSV/XLSX export mechanism, async
  processing over 5,000 rows, and its own `AuditAction.EXPORT` convention.
  This is a real, separate slice's worth of work, not a gap to fold in
  here. Nothing built against it. `/reports` continues to 404 via nav's
  own documented "not yet built" convention (nav.ts's header comment) --
  not a fabricated screen.
- [x] **Backend gap closed**: no service ever exposed User/Role management
  (seeded and read since Phase 0, never written to). Added
  `packages/services/src/admin.ts` -- `listUsers`, `createUser` (assigns
  one EXISTING role, generates a real random temporary password via
  `hashPassword`; this codebase has no invite-email flow, so the plaintext
  is returned once, shown once in the UI via a query param, never logged
  or persisted beyond its argon2id hash), `updateUserRoles` (close-and-
  replace, matching every seeded user's real one-role-each shape rather
  than building a multi-role UI nothing else assumes). All three gated by
  `rbac.manage`. Screen: `/admin/users`.
- [x] **Backend gap closed**: `writeAuditLog` has been used everywhere
  since Phase 0, but nothing ever read the log back. Added `listAuditLog`
  to `audit.ts` (org-wide, `entity`/`action` filters, capped at 500 rows --
  a browsing screen, not the bulk CSV/XLSX export docs/20-REPORTS.md
  describes and this phase defers), gated by `audit.read`. Screen:
  `/admin/audit-log`.
- [x] **Verified against the actual code before building, per this plan's
  own instruction**: `createNotificationRule` already existed (Phase 2,
  built as a service only -- its own doc comment says exactly this: "No
  route exists for this yet"). Added `listNotificationRules` and
  `updateNotificationRule` (enable/disable, gated by the same `rbac.manage`
  `createNotificationRule` already uses) rather than a second CRUD
  mechanism. Screen: `/admin/notification-rules` (list + enable/disable +
  a create form -- channels/audience stay free-text, matching how
  `evaluateNotificationRules` already treats them as data, not a fixed
  enum-driven builder).
- [x] **Admin > Config: explicitly descoped**, exactly as the plan
  directed -- no org-config data model exists; the Admin landing page
  states this plainly rather than silently omitting the section.
- [x] Real Postgres tests added: `admin.test.ts` (new, 11 tests),
  4 for `listAuditLog` (`audit.test.ts`, 6 tests total in the file),
  3 for `listNotificationRules`/`updateNotificationRule`
  (`notifications.test.ts`, 19 tests total) -- all passing. **Real bug
  caught and fixed during this work**: `audit.test.ts`'s original
  `afterAll` (which deletes the test org and disconnects the client) was
  scoped *inside* the file's one `describe` block -- harmless while that
  was the only block, but it fired prematurely between describe blocks
  the moment a second, sibling `describe` was added, deleting the org and
  disconnecting before the new tests ran. Fixed by hoisting `beforeAll`/
  `afterAll` to the file's top level, the pattern every other test file in
  this codebase already uses.
- [x] **Live verification limited to the permission boundary, honestly
  noted, same situation as Slice 14**: the dev-server session authenticated
  earlier in this phase's testing holds none of `rbac.manage`, `audit.read`,
  or `payout.prepare` (confirmed by nav correctly hiding both Admin and
  Payouts). All three new Admin screens correctly threw their respective
  `ForbiddenError` end-to-end through the real page -> service -> rbac
  stack against real Neon data when accessed directly -- the same valid
  security-boundary verification as Slice 14, not a full data-rendering
  check. Data-rendering correctness for these same patterns is covered by
  the real-Postgres test suite above and has been proven live five times
  this phase already (Bookings, Collections, Network, Commission, and the
  Admin landing page itself, which has no permission gate of its own and
  rendered correctly with real links).
- [x] **Known environment limitation, not exercised live**: `createUser`,
  `updateUserRoles`, and `updateNotificationRule` all wrap their write in
  `db.$transaction` against this dev shell's hosted-Neon `DATABASE_URL`,
  same as every other mutation this phase has hit the limitation on.

### Slice 16 -- Accessibility pass (cross-cutting, final)

- [x] **Color contrast**: computed contrast ratios by hand for every text/
  background and interactive-state token pair in `apps/web/app/globals.css`
  actually used across this phase's screens -- `--foreground` on
  `--background` (~16:1), `--muted-foreground` on `--background` (~4.76:1),
  `--primary-foreground` on `--primary` (~5.17:1), `--danger`/
  `--destructive` text on `--background` (~4.83:1), the focus `--ring`
  against `--background` (~5.17:1). **All pass WCAG AA's 4.5:1 (normal
  text) / 3:1 (UI/focus) thresholds** -- no token needed adjusting.
  `--border`/`--input` (~1.2:1 against white) do not reach the stricter
  3:1 non-text-contrast threshold (1.4.11), but every input/button in this
  phase carries a visible label and a high-contrast focus ring as the real
  interactive-state indicator, not the hairline border alone -- left
  as-is rather than darkening every card/table divider in the app on a
  borderline, debatable reading of a criterion aimed at boundary-as-sole-
  affordance cases, which none of these are.
- [x] **Keyboard navigation audit, one real bug found and fixed**: the
  live board's unit detail drawer (`board/[projectId]/UnitDrawer.tsx`,
  pre-existing since Phase 0, explicitly named in the plan) moved focus in
  on open, returned it to the trigger tile on close, and closed on
  Escape -- but had **no focus trap**: Tab/Shift+Tab could walk straight
  past the dialog into the unit grid behind it, since nothing marked that
  grid inert while the drawer was open. Fixed with a standard Tab-cycle
  trap scoped to the panel's own focusable elements. Verified live: opened
  a HELD unit's drawer, confirmed Tab moved through to the Close button
  and then correctly wrapped back to it (not into a board tile) on the
  next Tab, Escape still closed it, and focus returned to the triggering
  tile -- all with zero server errors. Every other back-office screen
  built this phase uses only plain native `<form>`/`<input>`/`<select>`/
  `<button>` elements with no custom `tabIndex` or keydown interception
  (confirmed by grep across the whole `(back-office)` tree) -- no other
  traps found. The Collections console never grew bulk-select checkboxes
  (each row ended up as its own inline form instead, Slice 11's own
  scope note) -- the plan's specific worry about unlabelled checkboxes
  there doesn't apply; there are none.
- [x] **No colour-only status**: the board's own `status.ts` already
  pairs every status color with a glyph and text (`short`/`long`) and
  builds each unit tile's `aria-label` from the text form -- confirmed by
  reading it directly, not just skimming. Every back-office screen built
  in Slices 6-15 renders status as plain text (`{booking.status}`,
  `{demand.status}`, `{dispute.status}`, ...) with no colored badge/dot
  component anywhere in that tree (confirmed by grep) -- there was never
  a color-only exception to find.
- [x] **Screen-reader labelling on icon-only controls**: `sidebar.tsx`'s
  `SidebarTrigger` and `sheet.tsx`'s close button both already carry an
  `sr-only` label; the board's own drawer close button carries
  `aria-label="Close unit details"`. Confirmed there are **no icon-only
  buttons anywhere in the back-office screens built this phase** -- every
  action button in every slice has a visible text label, so there was
  nothing new to label.
- [x] **PII masking spot-check, correctly moot**: `encryption.ts`'s
  `last4` masking helper exists (from Phase 2) and `panLast4`/
  `aadhaarLast4` schema fields exist, but **no screen built in this
  entire phase displays a KYC/PAN/Aadhaar field at all** -- the Associate
  detail page (Slice 12) shows name/code/grade/status/earnings/downline
  only. Confirmed by grep (zero references to `panLast4`/`aadhaarLast4`
  anywhere under `apps/web`). Nothing to fix; also confirmed no
  `VIEW_SENSITIVE` audit action is emitted anywhere yet, consistent with
  no reveal action existing -- both are real, tracked gaps for whichever
  future slice actually builds a KYC-displaying screen, not silently
  glossed over here.
- [x] Delegated the investigation phase to a research agent (four-part
  brief: keyboard/focus, color-only status, icon-button labelling, PII
  masking) to keep this pass's own context small, then personally verified
  its one actionable finding (the drawer focus trap) by reading the file,
  fixing it, and re-testing live in the browser rather than trusting the
  report at face value.
- [x] **Phase 3.5 -- Frontend is now complete.** All 16 slices shipped,
  committed, CI-green, and confirmed against prod health after each one.

**Decision log:**
- `attemptLogin` lives in `@desire/services/password`, takes `orgId` —
  resolved via `db.organization.findFirst()` since the system is genuinely
  single-tenant today (one seeded `Organization` row). A second real org
  needs this revisited.
- **Build fix, not a workaround**: `serverExternalPackages` alone does not
  stop webpack from opening `@node-rs/argon2` and its platform-specific
  sibling package, even though `packages/db`'s Prisma/`pg` externals use
  the same mechanism successfully — confirmed by testing both a Server
  Action and a plain Route Handler that import
  `packages/services/src/password.ts`. Fixed with a webpack-level function
  external in `apps/web/next.config.ts`, matched on the `@node-rs/argon2`
  request prefix. This is the first request-path code in the repo to
  import `password.ts`, so the gap was real, not previously exercised.
- `PII_ENCRYPTION_KEY`/`PII_ENCRYPTION_KEY_ID` added to
  `apps/web/.env.local` (local-only value, generated for this dev machine)
  — required by `encryptField`, previously only exercised by CI's own
  secret; local dev had never hit this path before the login flow.

---

## Phase 4 — Payouts

*2–3 weeks. Exit: one clean month-end run reconciled to the rupee, CA sign-off
on tax fixtures.*

- [x] ~~**GATE** Upgrade off the free tier~~ **CLOSED, will not happen** — client cannot fund any paid service, ever (2026-09-13). Free tier is the permanent operating envelope; see `docs/21-TIER-LIMITS.md` §8
- [x] ~~Move Neon to `ap-southeast-1` and Netlify functions to `sin`~~ **CLOSED, moot** — no upgrade means no Pro-tier region selection; Neon stays `ap-southeast-1`, Netlify functions stay locked to `cmh` (Ohio) permanently, per `docs/21-TIER-LIMITS.md` §2
- [x] `packages/tax` — pure, fixture-driven (also fixed a real bug in the move: Sec 206AA's no-PAN higher TDS rate was read from `TaxRate.noPanRatePct` but never applied — `resolveEffectiveTdsRate` applies it now)
- [x] ~~Effective-dated `TaxRate` seeded with confirmed values~~ **CLOSED, stays PLACEHOLDER indefinitely** — client will not engage a CA (2026-09-13). SEC_192/194J/194H rates remain unconfirmed; a real payout run against them carries a real, accepted compliance risk, not a resolved one — see `plan.md` open item 11
- [x] ~~**BLOCKED#11** CA review of tax fixtures~~ **CLOSED, no CA will be engaged** — client decision 2026-09-13
- [x] Payout period open/close; freezes tree and grade changes (`assertPayoutPeriodNotOpen`, shared by `moveAssociate`, `assignGrade`, and `runGradeQualificationSweep`)
- [ ] Batch preparation, chunked with a persisted cursor — deliberately deferred; single-pass is fine at current volume, chunk size wants tuning from real measurement first (see comment above `prepareBatch` and `docs/adr/0005-netlify-native-jobs-no-redis.md`)
- [x] Recovery netting with per-cycle deduction cap
- [x] **GATE** Approval rejects when approver is the preparer
- [x] `PayoutLineEntry` join — every payment traceable to its sales
- [x] Commission statement PDF matching the ledger exactly (`@react-pdf/renderer`, `GET /api/v1/payouts/lines/:id/statement`)
- [x] Bank file export (NEFT/RTGS); payroll handoff for `EMPLOYEE` — real CSVs correctly split by destination and served directly (not blob storage); not tied to any one bank's proprietary NEFT/RTGS layout, since none is documented anywhere in `docs/`
- [ ] Form 16A, TDS challan export, GST reconciliation — no format spec exists anywhere in `docs/`; fabricating one would be a compliance risk, not a placeholder
- [ ] **GATE** One full month-end run reconciled to the rupee — needs real production data and CA-confirmed rates

---

## Phase 5 — Scale

*3–4 weeks. Exit: load-tested at target concurrency, associates using it on site.*

Planned against the 2026-09-13 permanent constraints (no CA, no paid service
ever): several of this checklist's items structurally need a paid third
party (WhatsApp Business API, DLT SMS, e-sign vendors, a professional
pen-test firm) and cannot be closed by engineering. Each is resolved below
as either built-for-real, a free substitute, or a new tracked blocker — not
silently skipped.

- [x] Report catalogue — [20-REPORTS](docs/20-REPORTS.md). Shared row-scoped CSV/XLSX export engine (`packages/services/src/export.ts`) + **6 of 30 reports** built as real, tested exemplars (one per category: stock statement, sales funnel, outstanding aging, commission liability, audit trail, a Tally-adjacent transaction export). Remaining ~24 follow the identical `{asOf, columns, rows}` pattern, not built this pass — real scope call, not an oversight
- [x] Role dashboards — extended the existing role-branched `/dashboard` and `/home` pages with the tiles `docs/20-REPORTS.md`'s dashboard table named as missing (Executive: absorption, commission cost %; Project: active holds; Finance: verification queue, batch status; Team: downline bookings/pipeline/overdue collections/team earnings on `/home`, previously TEAM_LEAD saw only their own data; Associate: this month's bookings, grade progress). Not a rewrite
- [x] PWA install, offline reads (**no offline writes**) — real manifest + service worker, network-first with cache fallback (never cache-first, so a live session is never served stale). Service worker only ever intercepts `GET`; every mutation, including Server Actions, is untouched
- [ ] WhatsApp live; SMS via DLT-registered templates · **stays queued-forever, permanently** — structurally paid at any volume, no free path exists, per the 2026-09-13 decision. `packages/services/src/notifications.ts`'s existing mechanism (rules, audience resolution, queuing) is unchanged; in-app notifications remain the real channel
- [x] Tally / ERP export — generic CSV stopgap (bookings + receipts + payouts), not native Tally XML: no ledger-mapping spec exists anywhere, same reasoning that declined a fabricated Form 16A format in Phase 4. Labelled honestly in the UI as a generic export
- [ ] e-sign integration · **new blocked item** — no spec anywhere in `docs/`, and every real vendor (Aadhaar eSign ASPs, DocuSign, Leegality) is paid. See `plan.md` open items
- [x] Portal lead ingestion (99acres, MagicBricks, Housing) — real webhook (`POST /api/v1/webhooks/leads/:portal`), real dedup/`LeadSource` mapping, real audit trail with a system (null) actor. **Payload shape is explicitly PLACEHOLDER** — no real portal API doc exists; the mechanism is real, field names may need adjusting once an actual portal account exists
- [x] Report builder with saved views and scheduled email — `SavedReportView` model + CRUD + `runScheduledReportEmails`, wired into the existing job-cron pattern. **Real SMTP sending** (`packages/services/src/email.ts`, nodemailer) — unlike WhatsApp/SMS, plain SMTP has real free options at this scale, so this is built for real with placeholder/unset credentials, same pattern as `TaxRate`
- [x] Load test — board at target concurrency, payout wall clock, cold start measured. Run with `autocannon` (pure npm, no system binary) against **local Docker Postgres only, never hosted Neon** (the free tier's own invocation/compute ceilings make a real load test against it a self-inflicted outage). Results in [22-LOAD-TEST-RESULTS](docs/22-LOAD-TEST-RESULTS.md); cold start and the real India→Ohio network hop are explicitly not measurable from a local run
- [ ] **GATE** External penetration test — [10-SECURITY](docs/10-SECURITY.md) · **blocked on budget**, same status as BLOCKED#14. Free substitute performed instead: `pnpm audit` + a manual OWASP Top 10 pass, see [23-SECURITY-SELF-SCAN](docs/23-SECURITY-SELF-SCAN.md) — explicitly not equivalent, does not close this GATE
- [x] Accessibility audit, WCAG 2.1 AA on back-office — automated pass (axe-core) + manual check. Found and fixed a real, systemic duplicate-`<main>`-landmark bug across all 34 back-office pages plus the PWA home page; one remaining finding (the shell header's banner landmark) documented as a real, deliberately-deferred structural fix in [12-NFR](docs/12-NFR.md) rather than a rushed layout change
- [x] Quarterly backup restore drill performed once, timed — real drill against the actual Phase 4 production backup blob (59 tables), restored via the new `packages/db/scripts/restore-drill.ts` into a scratch Postgres database. All 38 non-empty tables restored correctly, verified by row count and content spot-check, under 5 seconds. Found and fixed a real bug in the restore mechanism during the drill itself (a JSON-array column bound as a native Postgres array). See [15-OPS-RUNBOOK](docs/15-OPS-RUNBOOK.md)
- [ ] Customer portal *(flagged, out of committed scope)* — no action; already correctly deferred

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
| 2026-09-06 | Demo seed now creates charge heads and an ACTIVE price list | The Phase 0 seed predates price lists, and `holds.ts` refuses to hold a unit when a project has no active list — so all 100 demo units were unholdable and the board's primary action was dead while the board itself rendered perfectly. Found by attempting a real hold, not by reading the board. Written with plain Prisma rather than through `packages/services` (that package depends on `@desire/db`, so importing it into the seed would be a cycle Turbo rejects); the two invariants the service guards — one ACTIVE list, preparer != approver — are upheld by hand and the publish is idempotent across re-runs | Tech lead |
| 2026-09-06 | Tests are now typechecked (`tsconfig.typecheck.json` per package) | Every package used `include: ["src"]`, so `pnpm typecheck` never looked at `test/`. Splitting argon2 out of `auth.ts` moved four exports and broke nine tests while typecheck stayed green — the suite was the only thing that noticed, and only at runtime. The new config covers `src` + `test` (+ `prisma` for db, since `seed.ts` is real code). Build still uses the original config so `rootDir`/emit are unchanged. Negative-controlled: reintroducing the exact break now fails with "has no exported member 'hashPassword'" | Tech lead |
| 2026-09-06 | Hold sweep: the unit-update count is now the authority for the history write and the reported release | `expireStaleHolds` guarded the unit update on `currentHoldId` but wrote `UnitStatusHistory` and counted the release unconditionally. When the guard missed, the hold was released, the unit stayed `HELD` forever (no later sweep would reconsider it — its hold was gone), and the append-only history asserted a `HELD -> AVAILABLE` that never happened. The false history row is the worse half: it is the record used to reconstruct what the inventory did. The sweep now recovers a still-`HELD` unit and refuses to touch `BOOKED`/`SOLD`/`BLOCKED`, where forcing `AVAILABLE` would destroy a sale. **Found by planting an expired hold and reading the database after the real cron ran** — the endpoint's `200 {"processed":0}` had looked like proof and was not | Tech lead |
| 2026-09-06 | CI had never passed once, on any commit | `cache: pnpm` ran before `corepack enable`; ubuntu-latest ships npm and yarn but not pnpm, so every run died at setup-node with "Unable to locate executable file: pnpm" before a single test executed. I had been verifying deploys and never looked at CI. Fixed by enabling corepack first. Same bug was in neon-preview-branches.yml | Tech lead |
| 2026-09-06 | Task env declared in `turbo.json` | With the pnpm bug fixed, CI reached the tests and failed on "DATABASE_URL is not set" despite ci.yml setting it at job level. Turborepo 2.x runs tasks in **strict env mode by default** — a task sees only what `turbo.json` declares, and it declared nothing. It passed locally only because `packages/*/.env` exists on disk and the tests call `dotenv/config`, so local and CI were never running the same way. Verified by reproducing CI's exact condition: both `.env` files moved aside, variables exported in the shell, 19 test files pass | Tech lead |
| 2026-09-06 | Preview deploys get a build hook rather than trusting env-var ordering | Netlify begins building a PR's preview the moment the PR is pushed, while the workflow is still creating the Neon branch — so the first build of every PR read the **production** database, non-deterministically. Settled by experiment rather than reading docs: a session row created only in the preview branch was rejected by the first build (404) and accepted after a rebuild (200), with production rejecting it both times. That also refuted the competing theory — `branch:<name>` *does* reach deploy previews; only the ordering was wrong | Tech lead |
| 2026-09-06 | `cancel-in-progress` disabled for the `closed` event | Closing PR #1 produced **no cleanup run at all**, stranding the Neon branch and both Netlify overrides — and `closed` never fires twice, so nothing would have collected them. Superseding a create/update run saves build minutes; superseding the one run that deletes resources leaks them. The bare `\|\| true` on `env:unset` was hiding the same class of failure and now warns instead | Tech lead |
| 2026-09-06 | Daily job crons removed until their routes exist | `/api/jobs/holds/expire` is the only job route; the four endpoints the 08:00 and 00:00 IST schedules targeted would 404, retry three times and exit 1 — two guaranteed-red runs a day. With no heartbeat table yet, the Actions run status is the only signal the 5-minute sweep is alive, and poisoning it with known-bogus failures trains everyone to ignore the channel a real failure arrives on | Tech lead |
| 2026-09-12 | Hold-taking endpoint: acting associate is always the caller's own record, no request body accepted | `POST .../units/:id/holds` resolves `associateId` strictly from `Associate.userId = session.userId`, never a client-supplied value. docs/08-SCREENS.md ("Hold button shows the associate's remaining quota") describes a self-action; a "hold on behalf of another associate" flow is unspecified anywhere and deliberately not built. A caller with `hold.create` but no Associate row (SUPER_ADMIN/SALES_HEAD/SALES_ADMIN, per seed.ts) gets a clear 403 rather than a crash on a null associateId | Tech lead |
| 2026-09-12 | Hold idempotency and `auditId` handled in the route, not in `holds.ts` | `acquireHold` is GATE-tested (50-way concurrency proof); re-verifying that after an edit was judged disproportionate to this task. "Idempotent" (docs/07-API.md) — a caller retrying against a unit they already hold gets `200` with the existing hold, not a `409` naming themselves — is implemented as a read-only lookup in the route after `acquireHold` throws `UnitNotAvailableError` with `heldBy.associateId` equal to the caller's own. `auditId` (docs/07-API.md: "every mutation response includes auditId") is likewise a read-only lookup by `(entity, entityId, action)` after a successful acquire, since `writeAuditLog` returns void and can't hand one back directly. Both proven against real Postgres: two POSTs from the same associate produce exactly one hold row; a genuine concurrent race between two associates (`Promise.allSettled` over real HTTP) has its winner confirmed independently in Postgres, matching the loser's `409` response exactly | Tech lead |
| 2026-09-12 | Phase 2 scoped as a sequence of slices, Booking Core (Draft → Confirm) built first | Risk-first, same reasoning as Phase 3's engine-ahead-of-order: the confirm GATE is the doc's own named pivot ("never recompute agreementValue/commissionableValue later"), reuses code already built and tested in Phase 1 (`computeCostSheet`, the unit state machine, hold lazy-expiry), and every later Collections task (demands, receipts) needs a real `Booking` row to hang off. Discount routing, cancellation/clawback, and CRM (Lead is nullable on Booking) explicitly deferred — not silently dropped, each has a stated reason in `bookings.ts`'s header. Roadmap for the slices after this one: (1) discount request + PLACEHOLDER approval-matrix routing, (2) cancellation + clawback preview, (3) payment plans + demand generation, (4) receipts + the maker-checker verify GATE, (5) bounce reversal + escalation ladder + collections console + notifications, (6) CRM — independent of 1–5, can run in parallel | Tech lead |
| 2026-09-12 | `releaseHold` (holds.ts) could not be reused inside `confirmBooking`; the release+transition is inlined instead | Found by reading the function body, not assumed: `releaseHold` unconditionally sets `Unit.status` back to `AVAILABLE` and opens its own `db.$transaction` — correct for a manual release, wrong for a confirm (the unit must go to `BOOKED`, and a second separate transaction would reopen the exact race window this codebase's row-locking discipline exists to close). `HoldReleaseReason.CONVERTED_TO_BOOKING` already existed in the schema for exactly this path and was unused until now. Also established as this codebase's first precedent for locking two entities in one transaction: `Booking` then `Unit`, documented in `bookings.ts` for future cross-entity locks to follow | Tech lead |
| 2026-09-12 | `booking.read` added as a new permission code | Checked directly: `permission-matrix.ts` defined `booking.create`/`confirm`/`cancel` but no read permission existed for bookings at all. Added mirroring `lead.read`'s exact role set and scope split (`SUPER_ADMIN, SALES_HEAD, SALES_ADMIN, TEAM_LEAD, ASSOCIATE, AUDITOR`; `TEAM_LEAD` = own + downline via the existing `getAccessibleAssociateIds`, `ASSOCIATE` = own only) rather than left ungated. `docs/09-RBAC-MATRIX.md` and `permission-matrix.test.ts` both updated; the 13 structural-invariant tests still pass unchanged | Tech lead |
| 2026-09-12 | `sellingAssociateId` scope and `bookingNumber` format resolved as stated assumptions, not left open | The RBAC matrix shows `booking.create` as a flat grant with no (O)/(T) annotation, unlike `lead.read` — taken literally, any associate could book under any other associate's name. Resolved conservatively: defaults to the caller's own Associate row; only `SUPER_ADMIN`/`SALES_HEAD`/`SALES_ADMIN` may name someone else, `TEAM_LEAD` only a downline associate. `bookingNumber` has no prior convention anywhere in the schema or docs — `{project.code}-{4-digit sequence scoped to the project}` (e.g. `SKYLINE-0001`) is a placeholder format, same status as the grade ladder's placeholder rates; the structure (`@@unique([orgId, bookingNumber])` + retry-on-P2002) is real and race-safe regardless of what the client eventually wants the format to look like | Tech lead |
| 2026-09-13 | Tax math extracted to a new `packages/tax` (mirrors `packages/commission`), fixing a real Sec 206AA bug in the move | `TaxRate.noPanRatePct` existed in the schema and was read by `prepareBatch`, but nothing ever applied it — every payout used the base `ratePct` regardless of whether the beneficiary had a PAN on file. Found while extracting the tax math into its own pure package (same "no `@prisma/client`/`@desire/db` import" pattern as `commission`); `resolveEffectiveTdsRate(taxRate, hasPan)` now applies the higher no-PAN rate for real. `prepareBatch` only checks PAN *presence* (`panEncrypted !== null`), never decrypts it | Tech lead |
| 2026-09-13 | `assertPayoutPeriodNotOpen` moved from `associates.ts` (private, `moveAssociate`-only) to `payouts.ts` and exported | Grade changes needed the same open-batch freeze tree moves already had (`grades.ts`'s `assignGrade` and `runGradeQualificationSweep`) — a second real caller, not a trivial constant, so it moved to the one place both can import from rather than being re-duplicated. `associates.ts` keeps only an internal import, no re-export, since re-exporting the same symbol from two barrel-merged modules (`export * from "./associates"` and `"./payouts"`) is a genuine ambiguity, not just redundant | Tech lead |
| 2026-09-13 | `exportBatch` reworked to a real bank-transfer CSV + payroll-handoff CSV, replacing the old fake stub key | Nothing previously distinguished an `EMPLOYEE` beneficiary (routes through payroll) from `CONSULTANT`/`CHANNEL_PARTNER` (real bank transfer) — every `PayoutLine` got the same fake `stub/payout-batches/{id}.bank-file` key. Partitioned by `engagementType`; non-`EMPLOYEE` lines decrypt `bankAccountEncrypted` and write a `VIEW_SENSITIVE` audit row per reveal (`docs/10-SECURITY.md`'s "reveal actions audited" rule — the first real call site of that pattern). CSVs are served directly in the HTTP response, not written to blob storage, since nothing today reads them back from a stored key — a new `getBatchExportCsvs` read function (same underlying `buildExportCsvs` helper) lets an already-`EXPORTED` batch's CSVs be re-fetched without re-running the one-time state transition | Tech lead |
| 2026-09-13 | Commission statement is a real PDF (`@react-pdf/renderer`), not deferred again | Phase 3.5 Slice 14 explicitly deferred this; user chose to close it for real this round rather than defer twice. `getPayoutLineStatement` scopes like `commission.ts`'s existing associate-scope check (own line, or admin-shaped/downline). The route file needed `.tsx` (not `.ts`) since `renderToBuffer` takes JSX directly | Tech lead |
| 2026-09-13 | Prod 502 on every route (including `/api/health`) after the Phase 4 deploy, fixed with `outputFileTracingIncludes` | `pdfkit` (pulled in by `@react-pdf/renderer`) resolves its built-in fonts via a dynamic `require()` keyed by font name (`js/standard-fonts/Helvetica.cjs` etc.) — Next's output file tracing only follows static imports, so those font files were missing from the deployed Netlify function; confirmed via `netlify logs --source functions`: `Cannot find module '.../pdfkit/js/standard-fonts/Helvetica.cjs'`. Crashed every route, not just the statement one, because Netlify bundles the whole app into one function ("1 function deployed"). First attempt at the include-path glob resolved relative to `apps/web` and matched nothing (pdfkit only exists in the monorepo root's pnpm store, not hoisted into `apps/web/node_modules`); fixed by pointing the glob two directories up. Verified two ways before declaring it fixed: the route's `.nft.json` trace manifest listed all 30 font files including `Helvetica.cjs`, and `/api/health` returned live `200` after the redeploy | Tech lead |
| 2026-09-13 | Two Phase 4 blockers closed by client decision, not resolved by further work: no CA will ever be engaged (BLOCKED#11), and no paid service of any kind is affordable, ever (BLOCKED#14) | Recorded verbatim from the client. **Tax**: `TaxRate` (SEC_192/194J/194H) stays on its current PLACEHOLDER rates indefinitely — there is no professionally-confirmed value coming. This is a standing, accepted compliance risk on any real payout run, not a resolved item; flagged in `plan.md` open item 11 and `docs/11-COMPLIANCE-INDIA.md` so it can't be mistaken for confirmed later. **Hosting**: free tier (Netlify Free + Neon Free) is now the *permanent* operating envelope, not an interim one pending Phase 4 — every constraint in `docs/21-TIER-LIMITS.md` (§1 invocation budget, §2 Ohio-region lock, §3 0.5 GB storage ceiling, §6 no real DR) stands indefinitely, and its upgrade-trigger table (§8) is kept only as a record of what won't be acted on. This reopens one concrete gap: the nightly `pg_dump`-to-Blobs backup was deferred in `.github/workflows/scheduled-jobs.yml` on the assumption the paid tier (and its background-function guarantee) would arrive before real data did — it never will, so that backup job is now a real piece of unbuilt, load-bearing work, not a someday item. Any future task that appears to need a paid service is a stop-and-ask, not a default | User |
| 2026-09-13 | Nightly backup job (`POST /api/jobs/backup/dump`) built same day, closing the gap the row above just reopened | Not a real `pg_dump` (no such binary in a Netlify Function) — a logical dump instead, tables discovered via `information_schema.tables` rather than a hardcoded list, written to Netlify Blobs. Found a real bug while writing the real-Postgres test for the DB-reading half: `information_schema.tables.table_name` is Postgres's internal `name` type, which Prisma's raw-query deserializer rejects outright ("Failed to deserialize column of type 'name'") without an explicit `::text` cast — every call failed until that was added. The Blobs write+prune half has no local test coverage (no local emulation for Blobs the way there's a real Docker Postgres for everything else here); verified live instead by manually triggering the deployed job (`gh workflow run scheduled-jobs.yml -f job=backup/dump`) and confirming both the `{"ok":true,"processed":420,...}` response and, separately, that `netlify blobs:list backups` actually shows the written `2026-09-13.json` object — not just trusting the HTTP response | Tech lead |
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
| 2026-09-14 | Phase 5 scoped against the 2026-09-13 permanent constraints before any code: two research passes plus four `AskUserQuestion` rounds resolved every checklist item that could conflict with "no CA, no paid service ever" *before* writing anything | WhatsApp/SMS have no free path at any volume (stays queued-forever, permanent); e-sign has no spec and no free vendor (new blocked item #15); the external pen-test stays blocked on budget (free `pnpm audit` + manual OWASP pass substituted, explicitly not equivalent); Tally export becomes a generic CSV stopgap (no ledger-mapping spec, same reasoning that declined Form 16A in Phase 4); the 30-report catalogue is scoped to 6 real exemplars + a shared engine, not 30 shallow builds. Scheduled email is the one exception treated as buildable-for-real rather than blocked: plain SMTP has real free options at this volume, unlike WhatsApp Business API/DLT SMS | User + Tech lead |
| 2026-09-14 | Portal lead webhook ships with an explicitly PLACEHOLDER payload shape | No real 99acres/MagicBricks/Housing API document exists to build against -- same status as `bookingNumber`'s format. Built anyway (client's own choice, "build it now regardless") since the mechanism (shared-secret auth, per-portal `LeadSource` mapping, idempotent dedup on `sourceDetail`) is real and portal-independent; only the exact field names will need adjusting once a real portal account exists. Deliberately does not reuse `leads.ts`'s `createLead` (requires a real session actor, auto-assigns to the caller) -- a new `ingestPortalLead` creates an unassigned lead instead, claimed later through the existing claim flow | Tech lead |
| 2026-09-14 | Load test run with `autocannon` (pure npm) instead of k6, against local Docker Postgres only | k6 needs a system binary install; autocannon is a devDependency, same free/open-source bar, zero machine setup. Never run against hosted Neon -- the free tier's own invocation/compute ceilings ([21-TIER-LIMITS §1](docs/21-TIER-LIMITS.md)) make a real load test against it a self-inflicted outage, not a measurement. A real bug in the test script itself was found and fixed before trusting any number: passing `url` + a separate `path` option to this autocannon version silently produced a bogus 307 on every request instead of the real 200 -- caught by cross-checking one request against `curl` rather than trusting the tool's own summary. Results in [22-LOAD-TEST-RESULTS](docs/22-LOAD-TEST-RESULTS.md) | Tech lead |
| 2026-09-14 | First real quarterly backup restore drill performed -- fetched the actual production backup blob (Phase 4's job, 59 tables) and restored it into a scratch Postgres database via a new `packages/db/scripts/restore-drill.ts`, not a hand-wave | All 38 non-empty tables restored correctly (row-count + content spot-check), under 5 seconds. A real bug was found and fixed *during* the drill, which is exactly what a drill is for: a JSON-array-valued jsonb column (`PriceListItem.otherCharges`) was being bound as a native Postgres array instead of JSON text, and the real database rejected it outright -- traced by comparing which specific row failed against a manual `psql` insert, not by guessing. Fixed with an explicit allowlist of the schema's actual few `String[]` columns, treating every other JS array as JSON. Full account in [15-OPS-RUNBOOK](docs/15-OPS-RUNBOOK.md) | Tech lead |
| 2026-09-14 | Automated accessibility pass (axe-core) found a systemic bug across all 34 back-office pages, not just new Phase 5 screens | Every back-office page rendered its own `<main>` nested inside the sidebar shell's own `<main>` (`SidebarInset`) -- two same-role landmarks per page, present since the shell was first built, unnoticed until this pass actually ran a tool against it. Fixed mechanically across all 34 files (`<main>` &rarr; `<div>`; the shell's `SidebarInset` is the one real landmark) plus the PWA `/home` page, verified zero landmark violations after. One remaining finding (the shell header's banner landmark, present on every back-office page) deliberately left open rather than rushed -- fixing it means moving the header outside `SidebarInset` in the DOM, which risks breaking `SidebarProvider`'s expected layout and deserves its own verified pass. Documented in [12-NFR](docs/12-NFR.md) | Tech lead |
| 2026-09-14 | **Closed the prod `/login` 500 (task_2737dcf5)** -- took three deploys to find the real root cause, not one | First attempt (`c72817d`) assumed the same class of bug as the earlier pdfkit fix (a dynamic platform-keyed require the file tracer can't follow) and added an `outputFileTracingIncludes` glob for `@node-rs/argon2-linux-x64-gnu` -- deployed, still 500'd, `netlify logs` showed the *base* package missing, not just its platform sibling, disproving that theory. Second attempt (`ad45369`) added `@node-rs/argon2` to `serverExternalPackages` -- also deployed, also still 500'd, same error. Only inspecting the actual `.next/server/app/login/page.js.nft.json` trace locally revealed the real cause: `apps/web` itself never had `@node-rs/argon2` in its own `package.json` -- it only reached `apps/web` transitively through `packages/services`/`packages/db`, and under pnpm's strict linking that gives it no resolvable path from the compiled output at all, regardless of tracing config. Fixed (`61e65c5`) by adding the dependency directly to `apps/web/package.json`, matching the same "each package that needs it declares it" pattern already used for `packages/db`. Verified for real: local `.nft.json` now traces all 6 expected files unprompted; live-tested against prod with `super_admin@demo.test` -- password verified, correctly proceeded to the MFA screen (proof `attemptLogin`'s argon2 check ran, not just that a page rendered); `netlify logs` clean of `MODULE_NOT_FOUND` after. The now-unneeded `outputFileTracingIncludes` entry from the first attempt was removed rather than left as dead config | Tech lead |
| 2026-09-14 | MFA deferred for all roles by client decision -- "remove for now, I will enroll later" | `MFA_REQUIRED_ROLES`/`MFA_REQUIRED_ROLE_CODES` (`packages/db/src/permission-matrix.ts`, `packages/services/src/auth.ts`) both emptied -- the consistency test between them stays green on `[] === []`. Capability itself untouched: `verifyMfaToken`/enrollment routes still work for any user who already opted in. Production data required a real fix, not just a code change: the 3 roles' `Role.requiresMfa` rows in hosted Neon were already seeded `true` from Phase 0, so a disposable script (inline creds, deleted after) ran `UPDATE roles SET "requiresMfa" = false` directly against prod, verified before/after via a real query, not assumed from the code change alone. `docs/09-RBAC-MATRIX.md` reworded to record this as deferred, not silently dropped. **Caught during live verification, not before**: role-level `requiresMfa=false` alone wasn't enough -- `super_admin@demo.test` and `sales_head@demo.test` still hit the MFA challenge on real login, because `User.mfaEnabled` (a genuine prior enrollment, independent of the role force) was already `true` on both from earlier in this project's history. "Remove for now" was read as covering that too, so a second disposable script cleared `mfaEnabled`/`mfaSecret` for both, re-verified live end-to-end (real login, real password, straight to `/dashboard`, no MFA screen) | User |
| 2026-09-14 | Fixed 4 real, verified performance issues rather than guessing at "slow" | An Explore agent traced concrete bottlenecks first: (1) every back-office/PWA page validated the session TWICE per request (once in its layout, once in the page) -- `apps/web/lib/session.ts`'s `getSession` wrapped in React's `cache()`, deduping automatically across all 84 existing call sites with zero call-site changes; verified for real, not assumed -- `pg_stat_user_tables.n_tup_upd` on the `sessions` table measured exactly +1 per `/dashboard` hit post-fix (was +2 before, confirmed by the same counter). (2) Same duplication for `getSessionPermissions` (4 call sites) -- added a `getCachedSessionPermissions` next to it. (3) `board/[projectId]/page.tsx`'s two independent queries (`project.findUnique`, `unit.findMany`) parallelized via `Promise.all`. (4) Added `@@index([projectId, updatedAt])` to `Unit` -- the exact shape `getUnitDeltas` (the board's 60s poll, the hottest query in the app) filters and sorts by, which neither existing index covered; migrated and applied to both local Postgres and hosted Neon. Explicitly did NOT attempt a broader ISR/`unstable_cache` pass over near-static reads (grade ladder, permission matrix) -- real staleness judgment calls per read, deferred rather than rushed. A wall-clock autocannon re-run on this same machine came back noisier/slower than Phase 5's baseline, but that run coincided with 4 parallel background agents plus builds/typechecks competing for the same CPU -- reported honestly as inconclusive rather than claimed as a win; the `pg_stat_user_tables` count is the number actually trusted here, because it measures real DB work done, immune to machine load noise | Tech lead |
| 2026-09-14 | Foundational UI/UX pass across all pages + a real dark-mode toggle, scope chosen by the client via `AskUserQuestion` over a lighter or narrower option | Audited actual current state first (a second Explore agent) rather than guessing: `globals.css` already had a real custom palette and semantic success/warning/danger tokens, entirely unused in markup; no dark-mode toggle despite complete `.dark` CSS; 10 of ~17 typical back-office primitives missing. Scaffolded `badge`/`table`/`dropdown-menu`/`avatar`/`dialog`/`select`/`tabs`/`sonner` via the project's own `shadcn` CLI (already configured) rather than hand-rolling; added `next-themes` for the toggle. Built `StatusBadge`+`lib/status-tone.ts` (per-enum tone mapping, verified against each field's real Prisma type, not guessed) and `EmptyState`, proved the pattern on `dashboard/page.tsx` first, then swept the remaining ~40 back-office/PWA files via 4 parallel agents each running its own `typecheck` before reporting back. Also built a real sign-out (`lib/sign-out-action.ts` -- there was NONE anywhere in the app before this) via `UserMenu`'s avatar+dropdown, and a `HeaderTitle` breadcrumb. One real bug found and fixed during this pass, not before shipping: passing the nav tree (now carrying `icon` component references) as a prop from a Server Component into the `HeaderTitle` Client Component crashed every back-office/PWA page in production mode ("Functions cannot be passed directly to Client Components") -- fixed by having the client component import the nav data itself instead of receiving it as a prop. A second bug (`DropdownMenuLabel` needs a `<Menu.Group>` wrapper in this Base UI version) was caught live via the browser console before being called done. Deliberately left `board/[projectId]`'s `UnitTile`/`board.module.css` untouched -- already a bespoke, accessible, color+glyph+label status system, not bare-bones, and replacing it with generic badges would have been a regression | User + Tech lead |
| 2026-09-20 | **Moved the production database from Singapore to Ohio** — the app "feeling slow" turned out to be geography, not code | Measured production before theorising (10 samples/route, median TTFB): `/login`, which runs **zero** queries, was as slow as `/api/health`, which runs one — so the app code was not the problem. `netlify api getSite` showed `functions_region: us-east-2` (Ohio) while Neon sat in `ap-southeast-1` (Singapore): every request ran India → Ohio → Singapore → Ohio → India. Measured RTT from the client machine: **~270 ms to Ohio, ~60 ms to Singapore**, and the Ohio↔Singapore leg cost **~193 ms on every single query** (the dashboard needs 7 sequential round trips minimum, 21 queries total — ~1.5 s of pure network). [21-TIER-LIMITS §2](docs/21-TIER-LIMITS.md) had **predicted this exact problem and prescribed this exact fix** back in the design phase; the original Neon project was created in Singapore anyway on 2026-09-05, so the app shipped with the penalty until the client noticed it. Fixed by creating a new free Neon project in `aws-us-east-2` and migrating into it with this repo's own tooling rather than anything new — `buildDatabaseDump`'s logic to dump, `packages/db/scripts/restore-drill.ts` (the Phase 5 drill script) to restore. 59 tables / 436 rows, verified **row-for-row per table** as a hard gate before cutover; `_prisma_migrations` deliberately excluded from the restore since `migrate deploy` owns it and copying it would have duplicated every migration record. Result, same code, same measurement: the per-query penalty collapsed from **~193 ms to ~6 ms** — `/api/health` now costs what a route doing no database work costs. Netlify function region selection is **Pro-only**, so the remaining ~440 ms India→Ohio floor is a permanent free-tier ceiling, recorded as such rather than absorbed silently. Client approved the residency change (US rather than Singapore) knowing no real KYC data exists yet; `plan.md` open item #1, [11-COMPLIANCE-INDIA](docs/11-COMPLIANCE-INDIA.md) and [ADR-0001](docs/adr/0001-nextjs-netlify-neon.md) all updated to say US, not "offshore" | User + Tech lead |
| 2026-09-20 | Made pages stream instead of blocking, and stopped writing to the database on every authenticated request | Two findings independent of geography. (1) The app had **zero** `loading.tsx`, **zero** `Suspense` boundaries and zero uses of its own `components/ui/skeleton.tsx`, so every page held the entire response until its slowest query finished — the user watched a blank screen for the whole 1–3 s. Added a `loading.tsx` per route group (back-office, PWA) and gave each dashboard tile its own Suspense boundary, with the page itself made non-async so the heading flushes before any query runs. Verified by actually watching the chunks arrive, not by reasoning about it: first byte **98 ms** carrying the skeleton, real tile data **196 ms**, in one streamed response. (2) `validateSession` wrote `lastActiveAt` unconditionally on every authenticated request — a second serial round trip, and a write, on the hot path — to feed an idle window that is **12 hours** long. Now written only when it is more than 5 minutes stale, which moves the effective deadline by under 1%; two new tests cover both branches (the pre-existing test was named "touches lastActiveAt" but asserted nothing about it). Also set explicit `pg` pool options, having first tried `idleTimeoutMillis: 0` and **backed it out** when it destabilised the 38-file test suite — with the database now colocated a handshake is single-digit ms, so "never reap sockets" bought nothing and risked holding handles open forever | Tech lead |
| 2026-09-20 | **Cold start 4.2 s → 1.7 s**: Prisma's 2.5 MB WASM query compiler was being inlined into the bundle TWICE, plus two libraries loading for routes that never use them | Client asked for every remaining way to speed the app up, so three audits ran (cold-start weight, caching/navigation, index coverage) against the real build and real production. Warm requests were already near the ~440 ms India→Ohio floor, so the prize was the cold start — the worst experience anyone gets on a tier with no provisioned concurrency. Root cause, measured not guessed: the identical 2,539 KB base64 blob was emitted as **two** chunks (one traced by 97 of 98 routes, a second by 34 more — the back-office pages, which reach it through a second webpack layer via their server actions); `/dashboard` traced both, 5.08 MB of its 7.62 MB, decoded and compiled on every cold start. `serverExternalPackages` never prevented it because `transpilePackages` includes `@desire/db`, whose `main` is TypeScript source, so the generated client entered webpack's graph. Externalising it (as `import`, not `commonjs` — these are ESM files loaded by dynamic import) immediately broke the build, which turned out to be **the same bug as the `/login` argon2 incident five days earlier**: `apps/web` had never declared `@prisma/client`, reaching it only transitively through `packages/db`, and pnpm's strict linking gives a bare specifier emitted into `apps/web`'s own output no path to resolve. Same fix, direct dependency. Separately, `exceljs` (~810 KB) was in 26 of 98 route traces — including the PWA home screen and every `network/*` page — because CSV and XLSX shared `export.ts`, so `payouts.ts` (and through it `grades.ts`/`associates.ts`) dragged a spreadsheet engine along for `toCsv`; `toXlsx` has exactly one caller, so it moved to its own module, deliberately NOT re-exported from the barrel. And `otplib` sat in `auth.ts` next to `validateSession`, so 100% of authenticated requests paid for a library used on two screens — moved to `mfa.ts`, the same split `password.ts`/argon2 already set the precedent for. Result: no chunk over 1 MB remains, `/dashboard`'s trace 7.62 → 4.91 MB, cold start 4.2 s → 1.73 s, warm ~0.83 s. Shipped as separate commits, riskiest last, each verified against the live function before the next | User + Tech lead |
| 2026-09-20 | Found an index that **could never have worked**, and cached client-side navigation | `AssociateHierarchy.path` carried a plain btree, and every "all my downline" read queries it with `startsWith`. On this database a plain btree **cannot** serve `LIKE 'prefix%'`, because the collation is `en_US.utf8` rather than `C` — proven with `EXPLAIN … enable_seqscan = off`, where the planner chose a different index for the `validTo` predicate and applied `path` as a *Filter*, reading every row. So the index existed, looked right, and did nothing; the team dashboards have been scanning the table. Replaced with a hand-written `text_pattern_ops` index (Prisma cannot express an operator class) following the `20260905092850` precedent, now confirmed as an *Index Cond* in production as well as locally. The guard test asserts both the operator class **and** that the planner actually picks it — existence alone would not catch someone "tidying" it back into `@@index([path])`, which keeps working and only gets quietly slower. Also indexed `Booking.unitId`/`leadId`, the only two relations on that model with no index. **Deferred the other seven** the audit proposed: 440 rows in production means they buy nothing measurable while costing storage against a 0.5 GB cap. On caching: `staleTimes.dynamic` was 0, so every back/forward refetched the whole RSC payload (378–518 ms); set to 15 s, which also cuts invocations, the binding free-tier constraint. That change quietly invalidated an assumption the board depends on — `useUnitDeltas` deliberately skips its mount fetch, commented "the server snapshot this page rendered with is already current", true only while every open was a fresh server render — so the board now re-polls when its snapshot is older than 5 s: conditional, so a fresh open still spends no extra invocation, and below the 15 s window so a cache replay always trips it. **Rejected with the arithmetic**: a keep-warm pinger would kill cold starts entirely, but Neon Free allows 100 CU-hours/month and a 0.25 CU compute alive 24/7 costs 182 CU-h — it would suspend the database mid-month. Server-side `unstable_cache` was rejected too: ~2–6 ms of query time against a ~440 ms floor is not worth invalidation risk on data that must not go stale | User + Tech lead |
