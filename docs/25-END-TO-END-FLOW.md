# 25 — End-to-end flow: enquiry to payout

The whole lifecycle in one read, **as actually implemented** — not as specified.
Every claim below was traced to code; where the code and the specs disagree,
this document follows the code and says so.

> ## Read this first
>
> **The chain cannot currently be completed end to end through the product.**
> Four links are missing — not bugs in logic, but actions with no screen and no
> API route. They are listed in [Where the chain breaks](#where-the-chain-breaks-today)
> and summarised here because nothing else in this document matters as much:
>
> 1. **A Customer cannot be created.** Nothing in the product creates one, so no
>    booking can be created at all.
> 2. **A PayoutSchedule cannot be created**, so no commission ever becomes
>    payable, so every payout batch is empty.
> 3. **Receipt allocation has no caller**, so collected money never reaches a
>    demand.
> 4. **Multi-milestone payment plans cannot be created** — the only UI path
>    hardcodes a single 100%-on-booking milestone.
>
> The engines behind all four are built and tested. What is missing is the way
> in. Everything up to a unit hold works today; everything after a booking is
> reachable only through tests.

---

## The intended path

```
Enquiry ──▶ Lead ──▶ Qualify / site visit ──▶ Hold a unit ──▶ Draft booking
                                                                    │
                                              discount request ─────┤
                                                                    ▼
                                                            CONFIRM BOOKING
                                                                    │
                        ┌───────────────────────────────────────────┤
                        ▼                                           ▼
              Demand schedule generated              Commission accrued
                        │                                           │
                        ▼                                           ▼
              Raise demand ──▶ Receipt ──▶ Verify ──▶ Clear ──▶ Release
                                                                    │
                                                                    ▼
                                                      Payout batch ──▶ Approve ──▶ Export
```

Confirming the booking is the hinge: it is the single action that freezes the
cost sheet, generates the demand schedule, accrues commission and converts the
hold — all in one transaction. If any part fails, the whole confirm rolls back.

---

## Stage 1 — Enquiry capture

**Entity:** `Lead`. **Stages:** `NEW → CONTACTED → QUALIFIED → SITE_VISIT_SCHEDULED
→ SITE_VISIT_DONE → NEGOTIATION → BOOKED`, plus `LOST` and `DORMANT`.

Two entry paths, and they behave differently.

**Manual** — `createLead`, permission `lead.write` (Super Admin, Sales Head,
Sales Admin, Team Lead, Associate). Deduplicates on a SHA-256 of the
E.164-normalised phone: if a live `LeadClaim` exists, it is rejected and the
error **names the associate holding it**. Creates the lead and its first claim
in one transaction. Claim window is **90 days** — a `PLACEHOLDER`.

**Portal webhook** — `POST /api/v1/webhooks/leads/[portal]` for 99acres,
MagicBricks and Housing. Authenticated by a shared secret, not a session, and
**fails closed if the secret is unset**. Idempotent on the external lead id.

> **The payload shape is a `PLACEHOLDER`** — no real portal API documentation
> was available when it was written. It will need revisiting against each
> portal's actual format.

> **Gap: a portal lead has no owner and no way to get one by self-service.** The
> webhook creates an unassigned lead with no claim, and an unassigned lead is
> **out of scope for every non-admin**. Only someone with `lead.reassign`
> (Super Admin, Sales Head, Sales Admin, Team Lead) can route it. There is no
> associate self-claim path, so portal leads sit invisible until an admin
> assigns them.

> **There is no lead-creation screen.** Both CRM lists are read-only. Manual
> capture is API-only today.

---

## Stage 2 — Qualification and site visits

| Action | Permission | Where |
|---|---|---|
| Log activity / change stage | `lead.activity` | PWA lead detail |
| Update lead | `lead.write` | API only |
| Schedule site visit | `sitevisit.create` | PWA lead detail |
| Complete site visit | `sitevisit.create` | **Built, but no screen and no route** |
| Reassign (reason mandatory) | `lead.reassign` | Back-office CRM detail |

Permission alone is not enough — `assertLeadInScope` checks the **specific**
lead: an Associate holding `lead.write` still cannot edit a colleague's lead,
and a Team Lead can act on their downline's but not a stranger's.

> **Every stage transition is manual.** Nothing auto-advances a lead.
> Scheduling a site visit does *not* set `SITE_VISIT_SCHEDULED`; completing one
> does *not* set `SITE_VISIT_DONE`; **confirming a booking does *not* set
> `BOOKED`**. The stage moves only when someone logs a `STAGE_CHANGE` activity
> by hand, which is why the source-ROI report carries a comment that stage data
> "can go stale".
>
> `LeadClaim.expiresAt` also has **no expiry sweep** — it is only evaluated
> lazily when a duplicate lead is attempted.

---

## Stage 3 — Hold a unit

**Statuses:** `AVAILABLE HELD BOOKED AGREEMENT_SIGNED REGISTERED POSSESSION BLOCKED`.

`acquireHold` takes a `SELECT … FOR UPDATE` on the unit, then checks in order:
lazily expires a stale hold inside the same lock → unit must be `AVAILABLE` (the
error **names the current holder**) → valid transition → **RERA must be present
and unexpired** → **an ACTIVE price list must exist** → quota.

- **TTL** comes from `project.holdTtlMinutes`, default **1440 minutes (24h)** —
  `PLACEHOLDER`, as are the extension window and max extensions.
- **Quota** comes from the associate's grade. **No grade assigned means a quota
  of zero** — a new associate cannot hold anything until graded.
- The acting associate is always the caller's own; it is never client-supplied.
- Double-booking is prevented structurally by a hand-written partial unique
  index, `one_active_hold_per_unit … WHERE releasedAt IS NULL`, which Prisma
  cannot express.

**Expiry has two mechanisms, deliberately.** Any read treats an expired hold as
gone (lazy), so correctness never depends on the cron. The 5-minute sweep only
materialises the release row and the notification.

> **Release and extend are unreachable.** `releaseHold` and `extendHold` are
> built and tested but have **no route and no screen**; `docs/07-API.md`
> specifies both. The `hold.force_release` permission exists in the matrix and
> is **never checked anywhere**. In practice a hold can only end by expiring or
> by converting to a booking.

---

## Stage 4 — Booking

**Statuses:** `DRAFT PENDING_APPROVAL CONFIRMED AGREEMENT_SIGNED REGISTERED
POSSESSION_GIVEN CANCELLED` — but **only `DRAFT`, `CONFIRMED` and `CANCELLED`
are ever written**. The other four are dead values.

**Draft** requires a **live hold held by the selling associate** and an ACTIVE
price list. Permission `booking.create`.

**Discount** is requested on a draft (`discount.request`) and decided by band —
≤1% Team Lead, ≤3% Sales Head, ≤5% Sales Head *or* Finance Admin, >5% Super
Admin. All `PLACEHOLDER`. Approval checks the permission, **then** band
membership, **then** blocks self-approval. Approval is the only thing that moves
`Booking.discountAmount`.

**Confirm** — `booking.confirm`, held only by **Super Admin, Sales Head and
Sales Admin**. One transaction, in order:

1. Re-computes the cost sheet and **freezes** base, agreement value and
   commissionable value
2. Generates the demand schedule
3. Accrues commission — *a misconfigured scheme rolls the whole confirm back*
4. Writes cost-sheet lines
5. Releases the hold as `CONVERTED_TO_BOOKING` (deliberately not via
   `releaseHold`, which would return the unit to `AVAILABLE`)
6. Moves the unit to `BOOKED` and writes both history tables

> **Hard break: `createDraftBooking` requires a `customerId`, and nothing in the
> product ever creates a `Customer`.** `customer.create` appears only in tests —
> no service, no route, no server action, not even the seed. `Customer` and
> `CoApplicant` are unreachable models, so **no booking can be created through
> the product at all.**

> There is also no booking-creation screen and no confirm screen; both are
> API-only.

---

## Stage 5 — Demands

**Statuses:** `SCHEDULED RAISED PARTIALLY_PAID PAID OVERDUE WAIVED`.

The schedule is generated **automatically inside `confirmBooking`**. Per
milestone: `amount = round2(agreementValue × pct / 100)`, with the **last
milestone absorbing the residual** so the schedule always sums exactly.

`raiseDemand` (`demand.raise` — Super Admin, Finance Admin, Sales Admin) moves
`SCHEDULED → RAISED` and immediately applies any booking credit balance.
`waiveDemand` (`demand.waive`) requires a reason and is terminal.

> **`OVERDUE` is never written.** The escalation sweep fires alert rungs but
> leaves the status at `RAISED`/`PARTIALLY_PAID`, though
> `docs/05-COLLECTIONS-SPEC.md` specifies `OVERDUE` as a state.
>
> **Raising is manual** — no cron raises a demand when its due date arrives. A
> `SCHEDULED` demand is invisible to the sweep, so a demand nobody raises by
> hand never alerts and never escalates.

> **Hard break: multi-milestone plans cannot be created.** The only UI path
> hardcodes a single `100% / day 0` milestone, and `addMilestone` has **zero
> callers**. Construction-linked plans — the normal case in Indian real estate —
> are not reachable.

---

## Stage 6 — Collections

**Receipt statuses:** `ENTERED VERIFIED CLEARED BOUNCED CANCELLED`.

| Step | Permission |
|---|---|
| Enter | `receipt.enter` — Super Admin, Finance Admin, Sales Admin |
| Verify | `receipt.verify` — **Super Admin, Finance Admin only** |
| Clear / Bounce | `receipt.verify` |
| Follow-up, promise-to-pay | `demand.follow_up` |

**Verification is the control point**, and it carries two exclusions:

1. The person who **entered** the receipt cannot verify it (maker-checker)
2. The **selling associate and their entire upline** cannot verify it

The second exists because commission releases on collection — without it, a
seller could unlock their own pay by marking money received. The nightly
invariant monitor re-checks both.

**Clearing triggers release.** `clearReceipt` computes
`cumulativeReleasePct = Σ(cleared allocations) / agreementValue × 100` and flips
entries `ACCRUED → PAYABLE`. It keys off `clearedOn`, never `receivedOn`.

**Bouncing reverses, never deletes** — allocations are marked `reversedAt`, the
affected demands re-synced, a `CHEQUE_BOUNCED` alert fired directly, credit
balance clawed back (clamped at zero), and every release triggered by that
receipt reversed.

**Escalation sweep** (daily, 08:00 IST) fires eight date-driven rungs from
`DUE_MINUS_7` through `OVERDUE_30`, plus `PROMISE_BREACHED`. **Every rung whose
threshold has passed fires**, so a missed day backfires everything owed.
Interest is recomputed in full each run, so repeated runs are idempotent — and
interest is never commissionable.

> **Hard break: `allocateReceipt` has no route, no server action and no screen.**
> It is referenced exactly once in the codebase — in a comment. Allocation is
> what moves money from a receipt onto a demand, so with no caller, **a cleared
> receipt's money never reaches a demand, demands never reach `PAID`, and the
> `MILESTONE` release trigger never fires.** `docs/05-COLLECTIONS-SPEC.md` makes
> allocation central to the design.

> `ReceiptStatus.CANCELLED` is never written, though the spec shows a cancel
> edge from both `ENTERED` and `VERIFIED`.

---

## Stage 7 — Commission

**Entry statuses:** `ACCRUED` (owed, not payable) → `PAYABLE` (released) →
`PAID`; plus `ON_HOLD` (disputed) and `REVERSED` (superseded by a contra entry).
The ledger is **append-only** — amounts are never edited.

Accrual fires **automatically inside `confirmBooking`**, never as a job. If no
ACTIVE scheme exists it accrues nothing and the booking still confirms.
Idempotency is structural: `{bookingId}:{beneficiaryId}:{level}:{schemeId}` is
unique.

The pure engine computes the seller's commission by grade rate, then each upline
level as a percentage **of the seller's commission** — not of the sale value. A
chain shorter than the configured depth produces **no entry and no breakage**: a
short tree must not manufacture unclaimed money. The `maxTotalPct` ceiling is
checked last and **throws**, so a scheme that would overpay rolls back the whole
confirm rather than persisting.

**Three release modes:**

| Mode | Fires when |
|---|---|
| `ON_BOOKING` | At confirm — entry created directly as `PAYABLE` with a 100% release |
| `PRO_RATA_COLLECTION` | On each receipt clearing, proportional to collection |
| `MILESTONE` | When a demand reaches `PAID` |

**Disputes** are implemented: anyone who can see an entry can dispute it, which
moves it to `ON_HOLD` and drops it out of payout batches. Only Super Admin and
Finance Admin can resolve. An amount change creates a **new `Adjustment` row**,
never an edit — this is the only place in the codebase that creates one.

> **Hard break: nothing ever creates a `PayoutSchedule`.** `createScheme` builds
> grade rates and level rates but **no schedule**, and
> `payoutSchedule.create` appears only in tests. Without one, all three release
> modes short-circuit: every entry stays `ACCRUED`, nothing becomes `PAYABLE`,
> and **every payout batch is empty**.

> Only 3 of the 6 release triggers are reachable. `AGREEMENT_SIGNED`,
> `REGISTRATION` and `POSSESSION` can never fire because nothing moves a booking
> past `CONFIRMED`.

---

## Stage 8 — Payouts

**Batch statuses:** `DRAFT PENDING_APPROVAL APPROVED EXPORTED PAID CANCELLED` —
only `DRAFT`, `APPROVED` and `EXPORTED` are ever written.

**Prepare** (`payout.prepare`) locks the organization row to serialise
check-then-insert, collects `PAYABLE` entries for the period, groups by
beneficiary, then computes tax and deductions:

- TDS section resolved from engagement type; **a missing tax rate throws**
  rather than guessing
- **Section 206AA higher no-PAN rate** applied where relevant
- GST only where the engagement type and registration call for it
- Outstanding recoveries deducted oldest-first, **capped at 50%** of that line's
  gross (`PLACEHOLDER`)
- `netPayable = gross + gst − tds − recoveryAdjustment`

**Approve** (`payout.approve`) blocks the preparer — maker-checker — and marks
every covered entry `PAID`.

**Export** splits by engagement type: employees go to a payroll handoff with
**no bank details**; consultants and channel partners to a bank file with a
decrypted account number, **each decryption writing its own `VIEW_SENSITIVE`
audit row, every time, including re-downloads**.

**The tree is frozen while a payout period is open** — associate moves and grade
changes are blocked, so a batch cannot compute against a shifting hierarchy.

> **Defect worth acting on: entries can become unpayable.** `prepareBatch`
> filters by **`accruedAt`**, because there is no `payableAt` column. Under
> `PRO_RATA_COLLECTION`, an entry accrued in January may only become `PAYABLE`
> in March. The January batch skipped it (still `ACCRUED`); the March batch
> filters on `accruedAt` and never sees it; and re-running January is blocked as
> a duplicate period. The entry is stranded unless someone picks non-identical
> period bounds.

> **`PAID` is never written** — "mark paid, close the period" is not
> implemented, and `PayoutBatch.paidAt` is never set. One report filters on
> `status: "PAID"` and is therefore permanently empty.

---

## Stage 9 — Cancellation and clawback

`cancelBooking` is the **narrowest mutation in the system** — `booking.cancel` is
held only by Super Admin and Sales Head. `CONFIRMED` bookings only, reason
mandatory.

For each commission entry on the booking:

1. The original entry is marked `REVERSED`; **money fields are never touched**
2. A **contra entry** is created with a negative gross, pointing at the original
3. Anything already released that cannot be netted against the beneficiary's
   other pending pay becomes a **`Recovery`** — later auto-deducted from a future
   payout, capped at 50%

`previewCancellation` shares the **exact same computation** as the commit, so the
preview shown before cancelling cannot drift from what actually happens.

> `Booking.refundPct` is never written — the spec has
> `onCancellation(booking, refundPct)`, but cancellation computes no customer
> refund. And `docs/07-API.md` says cancellation requires approval; the code has
> no approval step.

---

## Automatic vs manual

**Automatic, in the same transaction as the triggering action:** demand schedule
generation, commission accrual, `ON_BOOKING` release, cost-sheet freeze, hold
conversion, demand status sync, pro-rata and milestone releases, credit-balance
application, bounce reversal, clawback and recovery creation, recovery deduction,
and marking entries `PAID` at batch approval.

**Automatic by cron:**

| Schedule | Job | Role in the lifecycle |
|---|---|---|
| Every 5 min | Hold expiry sweep | Materialises releases; correctness does not depend on it |
| 08:00 IST | Collections escalation | **The only automatic participant in collections** |
| 08:00 IST | Grade qualification | Changes future accrual rates; blocked while a payout period is open |
| 00:00 IST | Invariant monitor | 20 read-only checks, including both separation-of-duty rules |
| 00:00 IST | Backup | The only DR mechanism |

All job routes use a constant-time secret compare and **fail closed** if the
secret is unset.

> See [21-TIER-LIMITS §1](21-TIER-LIMITS.md): the 5-minute cron measurably fires
> about **8 times in 24 hours, not 288**, so hold-expiry notifications lag by
> hours. Correctness is unaffected because expiry is lazy.

**Everything else is manual** — every lead action, hold, booking, discount,
demand, receipt, dispute and payout step.

---

## Where the chain breaks today

| # | Break | Consequence |
|---|---|---|
| 1 | **No way to create a `Customer`** | No booking can be created at all |
| 2 | **No way to create a `PayoutSchedule`** | Nothing becomes `PAYABLE`; every batch is empty |
| 3 | **`allocateReceipt` has no caller** | Collected money never reaches a demand |
| 4 | **Multi-milestone plans unreachable** | Only a single 100%-on-booking plan is possible |

All four are **missing entry points, not missing logic** — each underlying
service is built and tested. That is the cheap kind of gap, but it does mean the
product cannot presently take a sale from enquiry to payout.

### Other notable gaps

- **No lead-creation screen** — manual capture is API-only
- **No booking-creation or confirm screen** — API-only
- **No hold release/extend**, no unit-block screen; `unit.block` and
  `hold.force_release` are never checked
- **`Document` model entirely unused** — no KYC or agreement upload exists,
  though the PRD and screens doc both call for it
- **`ApprovalRequest` model entirely unused** — every approval is modelled ad hoc
- **Nothing moves a booking past `CONFIRMED`** — agreement, registration and
  possession are unreachable
- **API conventions in `docs/07-API.md` not implemented**: Zod validation at the
  boundary (zod is not even a dependency), mandatory `Idempotency-Key` on money
  mutations, cursor pagination, `requestId` in errors, and rate limiting

### Enum values no code ever writes

`DemandStatus.OVERDUE` · `ReceiptStatus.CANCELLED` · `PayoutBatchStatus.PAID`,
`.CANCELLED`, `.PENDING_APPROVAL` · `ApprovalStatus.WITHDRAWN` ·
`HoldReleaseReason.UNIT_BLOCKED`, `.RELEASED_BY_ASSOCIATE`, `.RELEASED_BY_ADMIN`
· `AdjustmentType.OPENING_BALANCE` · four of seven `BookingStatus` values.

---

## What this means for a pilot

The parts that **work end to end today**: lead capture (via API), qualification,
site visits, reassignment, the live inventory board, and unit holds with quota,
RERA and price-list gating.

The parts that **cannot be exercised**: everything from booking onward, because
of break #1.

Closing breaks #1–#4 is the shortest path to a demonstrable sale. Until then the
commission engine — which is the most thoroughly tested part of this codebase —
can only be exercised by its own test suite.
