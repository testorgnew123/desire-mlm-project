# Build Plan — Real Estate Sales & Commission Platform

Index to the design set. Depth lives in [`docs/`](docs/); the schema lives in
[`prisma/schema.prisma`](prisma/schema.prisma).

## Context

A residential real estate developer runs its sales floor on spreadsheets and
WhatsApp. Two failures follow, and everything here exists to fix one of them.

**Inventory is not knowable in real time.** An associate with a customer cannot
say whether a unit is free, held by a colleague, or sold. Result: double-selling,
stale price lists, units held indefinitely because nothing releases them.

**Commission is not reproducible.** Associates are paid on a grade ladder with
multi-level overrides, computed by hand each month. Slow, disputed, and nobody
can reconstruct last quarter. So associates keep private spreadsheets, and the
company argues about arithmetic instead of selling.

**Target outcome:** one source of truth for units and bookings, and a commission
engine whose output is reproducible, explainable and reversible — an associate
opens a statement and sees which sale, which grade, which rate and which release
rule produced every rupee.

## Locked decisions

| Decision | Choice |
|---|---|
| Commission model | Grade slab on own sale + **fixed level %** override on downline commission (PLACEHOLDER L1 10%, L2 5%, L3 2%) |
| Release trigger | **Configurable per project** — pro-rata on collection / milestone slabs / on booking |
| Network | **In-house sales staff, admin-assigned tree.** No self-signup, no self-recruited downline |
| Hold policy | **Timed auto-expiring hold** with per-grade quota |
| Sales type | **Primary only.** Developer's own inventory; "owner" in payment alerts means the **buyer** |
| Market | **India** — RERA, GST, TDS |
| Stack | **Next.js + Prisma + Postgres**, on Netlify + Neon |
| Hosting tier | **Netlify Free + Neon Free.** Covers Phases 0–3 and the demo; upgrade before Phase 4 ([21-TIER-LIMITS](docs/21-TIER-LIMITS.md)) |
| Grades & rates | **Not supplied.** All `PLACEHOLDER` |

## Current status

Design complete. **No application code written.** Phase 0 starts by running the
schema — see [16-ROADMAP](docs/16-ROADMAP.md) for the plan and
**[PROGRESS.md](PROGRESS.md)** for live state.

| Artifact | State |
|---|---|
| `docs/21-TIER-LIMITS.md` | Free-tier constraints, revised targets, upgrade triggers, job scheduling |
| `.github/workflows/scheduled-jobs.yml` | External cron triggers — Netlify Scheduled Functions are not dependable |
| `PROGRESS.md` | Living tracker — 117 tasks, 16 gates, blockers, decision log |
| `prisma/schema.prisma` | 58 models, 33 enums. Validated and formatted |
| `docs/` | 21 documents |
| `docs/adr/` | 6 decision records |
| `.env.example` | Complete, documented |

## Documentation map

**Start here:** [01-PRD](docs/01-PRD.md) for scope, then
**[19-GLOSSARY](docs/19-GLOSSARY.md) before writing any code** — the domain terms
are not intuitive and getting one wrong pays the wrong amount.

| Build | Get right | Ship & run |
|---|---|---|
| [02-ARCHITECTURE](docs/02-ARCHITECTURE.md) | [09-RBAC-MATRIX](docs/09-RBAC-MATRIX.md) | [14-DATA-MIGRATION](docs/14-DATA-MIGRATION.md) |
| [03-DATA-MODEL](docs/03-DATA-MODEL.md) | [10-SECURITY](docs/10-SECURITY.md) | [15-OPS-RUNBOOK](docs/15-OPS-RUNBOOK.md) |
| [04-COMMISSION-SPEC](docs/04-COMMISSION-SPEC.md) | [11-COMPLIANCE-INDIA](docs/11-COMPLIANCE-INDIA.md) | [16-ROADMAP](docs/16-ROADMAP.md) |
| [05-COLLECTIONS-SPEC](docs/05-COLLECTIONS-SPEC.md) | [12-NFR](docs/12-NFR.md) | [17-ROLLOUT](docs/17-ROLLOUT.md) |
| [06-INVENTORY-SPEC](docs/06-INVENTORY-SPEC.md) | [13-TEST-STRATEGY](docs/13-TEST-STRATEGY.md) | [18-RISKS](docs/18-RISKS.md) |
| [07-API](docs/07-API.md) · [08-SCREENS](docs/08-SCREENS.md) · [20-REPORTS](docs/20-REPORTS.md) | [21-TIER-LIMITS](docs/21-TIER-LIMITS.md) | |

Decision records: [ADR index](docs/adr/) — hosting, commission model, snapshots,
polling, jobs, append-only ledger.

## Roadmap at a glance

| Phase | Weeks | Scope |
|---|---|---|
| 0 — Foundation | 1–2 | Schema, auth, RBAC, audit, CI/CD |
| 1 — Inventory | 3–4 | Units, price lists, state machine, holds, live board |
| 2 — Sales & Collections | 4–5 | CRM, bookings, demands, receipts, escalation |
| 3 — Commission | 4–5 | Tree, grades, schemes, accrual, release, clawback |
| 4 — Payouts | 2–3 | Batches, tax, statements, invariant monitor |
| 5 — Scale | 3–4 | Analytics, PWA, integrations |

**18–22 weeks, 5.25 FTE.** Detail in [16-ROADMAP](docs/16-ROADMAP.md).

## The four things most likely to go wrong

1. **Commission disputed at go-live** (R2 — high/high). Mitigated by snapshots,
   the explain drill-down shipped in the pilot, and a 30-day parallel run to the rupee.
2. **Legacy data doesn't reconcile** (R7 — high likelihood). Budget two weeks,
   client-owned, before any import.
3. **Data residency invalidates Neon** (R1). Neon has no India region.
   **Decide before the first real KYC record is stored** — not before Phase 0.
   Confirmed harmless right now: no KYC data is stored yet (Phase 0/1 seed data
   is synthetic — grades, demo units, no real customers or associates). The
   clock starts at Trigger T1 in [21-TIER-LIMITS §8](docs/21-TIER-LIMITS.md),
   not before.
4. **Associates reject the system** (R6). They have a working spreadsheet. See
   [17-ROLLOUT](docs/17-ROLLOUT.md).
5. **Free-tier ceilings** (R16–R19). Neon Free is 0.5 GB — the audit log alone is
   1–2 GB/year — and Netlify Free caps at 125k invocations/month. Neither
   degrades gracefully. [21-TIER-LIMITS](docs/21-TIER-LIMITS.md).
6. **Scheduled jobs stopping silently** (R20–R21). Netlify Scheduled Functions
   are reported to cease firing without error, so jobs run on external cron with
   a mandatory dead-man's switch. A collections ladder or invariant monitor that
   quietly stops is worse than one that never existed.

Full register: [18-RISKS](docs/18-RISKS.md).

## Open items — client input needed

Blocking, in rough order of when they bite:

1. **Data residency** — is Singapore-hosted KYC acceptable, or is India residency contractually required? Not urgent today: **no KYC data is stored yet** — current seed/dev data is synthetic. *Before the first real KYC record is stored (Trigger T1, [21-TIER-LIMITS §8](docs/21-TIER-LIMITS.md)) — practically, before Phase 2's real customer/associate onboarding, and definitely before Phase 4.* ([ADR-0001](docs/adr/0001-nextjs-netlify-neon.md))
2. **Legacy data** — what exists (spreadsheets, Tally, an existing CRM?), and **who from client finance owns reconciling it**. *Before Phase 2* (reconciliation runs in parallel from Phase 2 per [16-ROADMAP](docs/16-ROADMAP.md)), not Phase 0.
3. **Team and budget** — confirm the [16-ROADMAP](docs/16-ROADMAP.md) placeholders before dates are committed.
4. **Grade ladder** — names, ranks, rate per grade. *Before Phase 3.*
5. **Level overrides** — percentages and depth cap. *Before Phase 3.*
6. **Commissionable base** — BSP only, or BSP + PLC, or something else. *Before Phase 3.*
7. **Payout schedule per project** — pro-rata, milestones, or on booking.
8. **Grade qualification** — auto-thresholds, or manual promotion only.
9. **Hold policy** — TTL and per-grade quota.
10. **Discount approval matrix** — amount bands to approver roles.
11. ~~**Engagement type** — needs the client's CA.~~ **RESOLVED 2026-09-13: no CA will be engaged.** The client has decided not to involve a CA for engagement type / TDS section / GST treatment. `TaxRate` (SEC_192/194J/194H) stays on the current PLACEHOLDER rates indefinitely — there is no professionally-confirmed value to move to. **This is a real, accepted compliance risk, not a resolved one**: an actual payout run against these rates could misapply TDS or GST. Flagged plainly here and in [11-COMPLIANCE-INDIA](docs/11-COMPLIANCE-INDIA.md) so it is never mistaken for a confirmed figure later. If a real payout must run before this changes, that risk needs a conscious client sign-off at that moment, not silence.
12. **Collections policy** — escalation offsets, audiences, delay-interest rate.
13. **Pilot project and team**, plus which senior associates act as champions.
14. ~~**Hosting upgrade budget**~~ **RESOLVED 2026-09-13: staying on free tier permanently — no billed software of any kind.** The client cannot fund the ~₹3,500/month upgrade (or any paid service), now or later. This is a standing constraint on every future decision in this project, not a one-time answer: default to free-tier and free/open-source options; if a task ever seems to need a paid service, that is a stop-and-ask moment, not a default. Every consequence in [21-TIER-LIMITS](docs/21-TIER-LIMITS.md) (§7's revised targets, ~10 concurrent associates, 0.5 GB storage ceiling, cold starts, 6-hour PITR) is now the permanent operating envelope, not an interim one — see its Decision-log entry for the one real gap this reopens (the nightly backup job was deferred pending this exact upgrade, and never built). Since built for real, see [21-TIER-LIMITS §6](docs/21-TIER-LIMITS.md) and the 2026-09-14 restore-drill decision-log entry.
15. **e-sign integration** — no spec exists anywhere in `docs/` beyond the Phase 5 roadmap line naming it, and no vendor has been chosen. Every real option (Aadhaar eSign ASPs, DocuSign, Leegality) is a paid service, in direct conflict with open item #14 above — this cannot be resolved by engineering alone. Needs both: (a) a real specification of what needs to be e-signed and by whom, and (b) a client decision on whether a paid vendor is ever acceptable for this one capability specifically, as an exception to #14. *Named in Phase 5.*

Every `PLACEHOLDER` in the docs and schema traces back to one of these. **Do not
ship a PLACEHOLDER** — they exist so the system can be built and demonstrated,
not so it can go live unconfirmed.
