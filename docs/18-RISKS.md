# 18 — Risk Register

Scored **before** mitigation. Review at every phase boundary.

| # | Risk | Impact | Likelihood | Mitigation | Owner |
|---|---|:-:|:-:|---|---|
| **R1** | Data residency requirement surfaces late, invalidating Neon | High | Med | **Decide before Phase 0.** [ADR-0001](adr/0001-nextjs-netlify-neon.md) lists the alternatives; nothing else in the design changes | Client + Tech lead |
| **R2** | Commission numbers disputed at go-live | High | **High** | Snapshots, explain drill-down shipped in pilot, 30-day parallel run to the rupee, golden-file tests | Tech lead |
| **R3** | Double-hold race in production | High | Low | Partial unique index **and** row lock; 50-way concurrency test against real Postgres | Tech lead |
| **R4** | Receipt fraud unlocking commission | High | Med | Separation of duties coded and tested; nightly invariant monitor | Tech lead |
| **R5** | Scheme misconfiguration overpays | High | Med | Simulator before publish, `maxTotalPct` hard assertion, maker-checker on publish | Tech lead |
| **R6** | Associates reject the system, revert to spreadsheets | High | Med | [17-ROLLOUT](17-ROLLOUT.md) in full — pilot, champions, parallel run, explain screen | Client + BA |
| **R7** | Legacy inventory does not reconcile | Med | **High** | [14-DATA-MIGRATION](14-DATA-MIGRATION.md) step 1. Budget two weeks, client-owned | Client finance |
| **R8** | Payout batch exceeds the 15-min ceiling | Med | Low | Chunked from the start; measured in Phase 4; worker fallback path kept viable | Tech lead |
| **R9** | Wrong tax treatment (Sec. 192 vs 194H) | High | Med | CA review of fixtures before Phase 4; `engagementType` drives it as data | Client CA |
| **R10** | WhatsApp template approval delays | Low | Med | Submit templates in Phase 2, not Phase 5 | DevOps |
| **R11** | Key-person dependency on the commission engine | Med | Med | Golden files **are** the spec; pair through Phase 3; engine is pure and small | Tech lead |
| **R12** | Scope creep from the sales floor | Med | **High** | Feature flags, Phase 5 backlog, written change control | Client + Tech lead |
| **R13** | Grade ladder and rates never confirmed | Med | Med | Blocks Phase 3. Escalate at Phase 2 boundary if still open | Client |
| **R14** | Neon cold start visible to associates on site | Low | Med | Disable autosuspend on the paid tier; measure in Phase 5 load test | DevOps |
| **R15** | Client finance unavailable for reconciliation | Med | Med | Named owner with decision authority agreed before Phase 0 | Client |
| **R16** | Netlify free invocation cap hit mid-month | High | Med | 60 s polling, pause-on-blur, 5-min sweeps; alert at 72%. **Hitting it stops the site** ([21-TIER-LIMITS](21-TIER-LIMITS.md)) | Tech lead |
| **R17** | Neon free 0.5 GB storage exhausted | High | **High** | Audit log alone is 1–2 GB/yr. Alert at 70%; **upgrade before real data lands** | Tech lead |
| **R18** | Data loss beyond the 6 h free-tier PITR window | High | Med | Nightly `pg_dump` to S3, 30-day retention; restore drills against the dump | DevOps |
| **R19** | Free-tier latency (Ohio) rejected by associates | Med | Med | Measure in the demo. ~₹3,500/mo upgrade moves functions and DB to Singapore | Tech lead |
| **R20** | Scheduled jobs stop firing silently | High | Med | Netlify Scheduled Functions are [reported to cease firing](https://answers.netlify.com/t/scheduled-functions-never-invoked-on-two-sites-schedules-registered-manual-triggers-work/164978) and to drift. Moved to external cron; **dead-man's switch is mandatory** ([21-TIER-LIMITS §11](21-TIER-LIMITS.md)) | Tech lead |
| **R21** | GitHub Actions scheduled workflows auto-disable after 60 days repo inactivity | Med | Med | Dead-man's switch catches it; quarterly ops check | DevOps |

## The three worth reading twice

### R2 — commission disputes at go-live

Rated high on both axes, and it is the one that kills the project rather than
delaying it. Associates comparing the new number against their own spreadsheet
is not a risk to be managed away — it is the expected behaviour, and the design
answer is to make every number auditable rather than to ask for trust.

Mitigation is not one control. It is four, stacked: snapshots so the number is
explainable, the drill-down so it is explainable *to the associate*, the parallel
run so they see agreement before they are asked to rely on it, and golden files
so the engine is right in the first place.

### R7 — legacy data

Highest likelihood on the register. Spreadsheets that have run a sales floor for
years always contain sold units never struck off, disputed credits, and areas
that do not match the RERA filing.

This is not an engineering risk — it is calendar time on the client's side, and
it needs a named person from their finance team with authority to rule on
disputed rows. If that person is not named before Phase 0, R7 and R15 compound.

### R12 — scope creep

High likelihood, and unusually so here because the users are commercially
motivated and vocal. Every associate will have a view on what the board should
show.

The defence is structural: feature flags so things can be dark-launched, a Phase
5 backlog that visibly exists so requests have somewhere to go, and written
change control so "can you just add" has a cost attached.

## Review cadence

At each phase boundary: re-score every risk, close what is closed, add what has
emerged. Any risk moving to High/High is escalated to the client immediately
rather than at the next review.
