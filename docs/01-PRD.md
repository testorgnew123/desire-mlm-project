# 01 — Product Requirements

## The problem

A residential real estate developer runs its sales floor on spreadsheets and
WhatsApp. Two failures follow from that, and everything in this product exists
to fix one of them.

**Inventory is not knowable in real time.** An associate standing with a customer
cannot say with confidence whether a unit is free, held by a colleague, or sold.
The consequences are double-selling, quoting from a stale price list, and units
sitting "held" indefinitely because nothing releases them.

**Commission is not reproducible.** Associates are paid on a grade ladder with
multi-level overrides on their downline. It is computed by hand each month. It
is slow, it is disputed, and nobody can reconstruct last quarter's numbers.
Associates do not trust it, so they keep private spreadsheets — which means the
company argues about arithmetic instead of selling.

## What success looks like

| | Today | After |
|---|---|---|
| Knowing if a unit is free | Phone a colleague | On screen, ≤15s stale, exclusivity enforced by the database |
| Double-booked units | Happens | Structurally impossible |
| Producing monthly commission | Days of manual work | A batch run, reconciled to the rupee |
| "Why is my commission this number?" | An argument | A drill-down: base → grade → rate → level → release rule |
| Collections follow-up | Remembered, or not | Scheduled, escalated, logged |
| Reproducing a past payout | Not possible | Byte-identical, from snapshots |

## Users

| User | What they need most |
|---|---|
| **Associate** (frontline) | Check availability and hold a unit from a phone, on site. See their own earnings and what is blocking them |
| **Team Lead / Manager** | Their team's pipeline and performance; their override earnings |
| **Sales Head** | Cross-project inventory and funnel; discount and tree-move approvals |
| **Sales Admin** | Booking paperwork, receipt entry, hold administration |
| **Finance Admin** | Receipt verification, payout batches, tax, liability provisioning |
| **Project Manager** | Unit master, price lists, blocking |
| **Super Admin** | Roles, schemes, configuration |
| **Auditor** | Read everything, change nothing |

## Jobs to be done

1. *"I'm with a customer at the site — is C-1204 still available, and can I hold it for them right now?"*
2. *"Which 3BHKs under ₹1.2cr are free in Tower B?"*
3. *"How much have I earned this month, how much is payable, and what's stuck?"*
4. *"Which of my buyers owe money this week, and who do I call?"*
5. *"Show me why Ravi was paid ₹15,000 on the Sharma booking."*
6. *"What is our total commission liability against confirmed bookings?"*
7. *"Reproduce the March payout exactly as it was run."*

## Scope

### In scope

- Project, tower, unit and versioned price-list masters
- Live inventory board with timed, quota-limited holds
- Lead capture, dedup, claim windows, activity logging, site visits
- Booking workflow with discount approval, documents, cancellation
- Payment plans, demand schedules, receipt entry with maker-checker, allocation
- Automated collections escalation ladder
- Associate hierarchy (admin-assigned), effective-dated grades, auto-qualification
- Commission engine: accrual, configurable release, clawback, recovery, simulator
- Payout batches with TDS/GST, statements, bank export
- Role-scoped dashboards, reporting, notifications
- Associate PWA
- Audit log and separation-of-duties controls

### Explicitly out of scope

| Not building | Why |
|---|---|
| **Resale / secondary market** | Primary sales only — developer's own inventory. No third-party owner entity. Confirmed with client |
| **Rentals / leasing** | Same |
| **Self-recruited downline** | Tree is admin-assigned. No referral signup, no genealogy placement rules |
| **Construction / project management** | Different product |
| **Full accounting or ERP** | Export to Tally instead |
| **Payroll** | Employee commission exports to the existing payroll system |
| **Customer-facing sales website** | This is internal |
| **Customer portal** | Phase 5, flagged, not in the committed scope |

## Product principles

**1. Every rupee must be explainable.** An associate who cannot audit their own
payout will not trust the system, and will keep their spreadsheet. Explainability
is a core feature, not a reporting nicety.

**2. Financial history is immutable.** No edits to a commission entry, ever.
Corrections are contra entries. This is what makes reproducing March possible.

**3. Correctness lives in the database, not the UI.** Exclusive holds are a
partial unique index and a row lock. A fresh screen is a convenience; the
constraint is the guarantee.

**4. Separation of duties is code.** Commission releases on collection, so
whoever marks money as received can unlock their own pay. That is a coded
assertion with a test, not a line in a policy document.

**5. Configuration over deployment.** Rates, ladders, hold durations, escalation
offsets and notification rules are rows. Every developer runs a different policy
and none of them should need a release.

## Constraints

- **India / RERA.** Carpet area disclosure, project registration, GST, TDS by engagement type, DPDP for KYC data.
- **Mobile-first for associates.** They work standing up, on 4G, on cheap Android phones. They will never open the desktop app.
- **No India region on Neon** — see [ADR-0001](adr/0001-nextjs-netlify-neon.md) and [11-COMPLIANCE-INDIA](11-COMPLIANCE-INDIA.md).
- **Rates unconfirmed.** Grade ladder, commission rates, level percentages and hold durations are all `PLACEHOLDER`.

## Non-goals for v1

Multi-tenancy (schema is ready, product is not) · offline write support · regional
language UI · AI lead scoring · automated site-visit routing.
