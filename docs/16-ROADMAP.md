# 16 — Roadmap, Team & Effort

> This is the **plan**. For live state — what is done, what is blocked, what to
> pick up next — see **[PROGRESS.md](../PROGRESS.md)**, which breaks these phases
> into 117 tracked tasks and 16 gates.

## Phases

| Phase | Duration | Scope | Exit criteria |
|---|---|---|---|
| **0 — Foundation** | 1–2 wk | Repo, Prisma schema + the two hand-written partial indexes, auth, RBAC, audit log, seed data, CI/CD, Neon branching, **free-tier quota monitoring** | Login works · roles enforced server-side · every mutation audited · preview deploys with a DB branch |
| **1 — Inventory** | 3–4 wk | Projects, towers, units, versioned price lists, state machine, timed holds, live board | **Two users cannot hold the same unit — proven by the 50-way concurrency test.** Holds auto-expire. Board refreshes within the configured interval (60 s on free) |
| **2 — Sales & Collections** | 4–5 wk | CRM, leads, bookings, discount approval, documents, payment plans, demands, receipt entry + verification, allocation, escalation ladder | A lead reaches a confirmed booking with a verified cleared receipt · an overdue demand escalates through every rung to the right people |
| **3 — Commission** | 4–5 wk | Network tree, grades, scheme builder, simulator, accrual, release, clawback, recovery, explain drill-down | Golden-file tests pass · **the reproducibility test passes** · a full sale cycle produces correct entries for seller + 3 uplines |
| **4 — Payouts** | 2–3 wk | Batches, TDS/GST, recoveries, maker-checker, statements, bank export, invariant monitor | One clean month-end run, reconciled to the rupee · CA has signed off the tax fixtures |
| **5 — Scale** | 3–4 wk | Analytics, reports, PWA polish, WhatsApp, integrations, customer portal (flagged) | Load-tested at target concurrency · associates using it on site |

**Total: 18–22 weeks.**

## Where the risk actually is

**Phase 1** — concurrency bugs corrupt inventory silently. Nobody notices until
two customers have paid for the same flat.

**Phase 3** — commission bugs corrupt trust permanently. Once associates stop
believing the numbers they go back to spreadsheets, and the platform is dead
regardless of how good the rest of it is.

Everything else is ordinary CRUD work. Staff and schedule accordingly: these two
phases get the tech lead's full attention and the longest buffers.

## Sequencing constraints

- **Data residency gates the first hosted deploy, not development.** Corrected
  from an earlier overstatement in this doc — schema, auth, RBAC, and the
  entire commission engine build and test fully against local Postgres with
  no hosted database at all. What residency actually decides is which Neon
  region to create the project in, and a Neon project's region is **fixed at
  creation** (moving later means a new project plus a manual dump/restore) —
  so decide before the first `neon projects create`, not before Phase 0 as a
  whole. See [ADR-0001](adr/0001-nextjs-netlify-neon.md). This block decided
  `ap-southeast-1` (Singapore) for when that hosted project is created — no
  hosted Neon project exists yet, development so far is entirely local
  Postgres. See PROGRESS.md decision log.
- The grade ladder and rates must be confirmed **before Phase 3**, not during.
- CA review of tax fixtures must land **before Phase 4**.
- WhatsApp templates need approval — submit in **Phase 2**, not Phase 5 (risk R10).
- Legacy reconciliation ([14-DATA-MIGRATION](14-DATA-MIGRATION.md)) runs in
  parallel from Phase 2, owned by the client.
- The invariant monitor ships in **Phase 3**, with the engine — not after.
- **Upgrade off the free tier before Phase 4.** Real payouts and real KYC need
  background functions and a DR window longer than 6 hours
  ([21-TIER-LIMITS](21-TIER-LIMITS.md)).

## Team

| Role | Count | Phases |
|---|---|---|
| Tech lead / full-stack | 1 | All |
| Full-stack engineer | 2 | All |
| Frontend engineer | 1 | 1, 2, 5 |
| QA | 1 | From Phase 1 |
| BA — real estate + accounts domain | 0.5 | All |
| Designer | 0.5 | 0–2 |
| DevOps | 0.25 | 0, 4 |

**5.25 FTE**, ~18–22 weeks calendar.

The BA is not optional. The domain has terms that look interchangeable and are
not ([19-GLOSSARY](19-GLOSSARY.md)), and a wrong assumption ships as working code
that pays the wrong amount.

Phase 3 needs the tech lead undivided. The commission engine cannot be handed to
a junior and reviewed casually — the failure mode is silent and the blast radius
is every associate's pay.

## Cost

Recurring infrastructure, order of magnitude:

**Currently on Netlify Free and Neon Free — ₹0 for hosting and database.** That
covers Phases 0–3 and the internal demo. Upgrade is triggered before Phase 4;
see [21-TIER-LIMITS §8](21-TIER-LIMITS.md).

Post-upgrade:

| Item | Monthly (₹) |
|---|---|
| Netlify Pro | 2,000–4,000 |
| Neon paid | 2,000–5,000 |
| S3 + transfer | 1,000–3,000 |
| WhatsApp BSP | 10,000–25,000 |
| SMS (DLT) | 2,000–5,000 |
| Sentry | 1,500 |
| **Total** | **~₹25,000–45,000** |

Dominated by WhatsApp per-message pricing, which scales with collections volume
and alert cadence — tuning the escalation ladder is a cost lever as well as a
UX one.

> **These are planning placeholders.** Confirm team composition and budget before
> committing to the dates above.

## Definition of done, per phase

Applied per task in [PROGRESS.md](../PROGRESS.md). Not "the code works":

- [ ] Tests pass, including the invariants for that phase
- [ ] Documented in the relevant `docs/` file (the doc is updated, not "to be updated")
- [ ] Audit logging covers every new mutation
- [ ] RBAC covers every new action, with a denial test
- [ ] Reviewed against [10-SECURITY](10-SECURITY.md) if it touches money or PII
- [ ] No new `PLACEHOLDER` values without a corresponding open item
- [ ] Demoed to the client, feedback logged
