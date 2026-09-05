# 14 — Data Migration & Cutover

The current source of truth is spreadsheets. This is a project phase with its own
risk profile, not a script somebody runs the night before launch.

Budget **two weeks**, not two days. Legacy inventory not reconciling is rated
high-likelihood in the [risk register](18-RISKS.md).

## Step 1 — Reconcile before you import

Export the current unit master and reconcile it against the RERA filing and the
sales register.

**They will disagree.** Typical findings: units sold but never struck off the
sheet, two associates credited with the same sale, carpet areas that don't match
the RERA filing, holds from eight months ago.

Resolve every disagreement **before** import. Importing contested data makes the
new system look wrong on day one, and the associates already looking for a reason
to distrust it will find one.

Produce a signed-off reconciliation: unit count, sold count, available count,
total collected. That document is the baseline everything else is checked against.

## Step 2 — Import order

Dependencies dictate the order. Each stage is validated before the next begins.

```
 1. Grades                     ← ladder must be confirmed first
 2. Users + Associates         ← KYC, engagement type, bank
 3. Associate hierarchy        ← cycle-checked on load
 4. Associate grades           ← effective-dated; historical grades matter
 5. Charge heads, tax rates
 6. Projects                   ← RERA numbers and validity
 7. Towers, unit types
 8. Units
 9. Price lists (historical versions, not just current)
10. Payment plans
11. Customers + co-applicants
12. Bookings                   ← pinned to the right price list version
13. Cost sheet lines
14. Demand schedules
15. Receipts + allocations     ← flagged MIGRATED, pre-verified
16. Commission opening balances ← see step 3
```

Historical price list versions matter: a 2024 booking pinned to today's price
list will render a cost sheet that never existed.

## Step 3 — Do not recompute historical commission

> Import historical commission as **opening balances**
> (`Adjustment` with `type = OPENING_BALANCE`). Never re-run old sales through
> the new engine.

Re-running produces different numbers than what was actually paid — different
rounding, different interpretation of the base, a grade recorded differently.
Those differences are not bugs; they are the new engine being more precise than
the spreadsheet was.

But an associate does not see "more precise". They see the system saying they
were underpaid in November. The project then starts with a payout dispute
instead of a launch.

Import the position. Compute forward only.

## Step 4 — Traceability

Every imported row carries `sourceRef` — the spreadsheet name and row number.

When somebody challenges a number in month two, "that came from Inventory
Master v14, row 812" ends the conversation. Without it, the argument is
unwinnable.

## Step 5 — Cutover

| When | What |
|---|---|
| Friday 18:00 | Spreadsheet frozen. Announced a week ahead |
| Saturday | Import, run every validation, reconcile against the step 1 baseline |
| Sunday | Client finance signs off on the reconciliation |
| Monday | Live for the pilot team |
| **Next 30 days** | **Parallel run** |

### Parallel run

Both systems live. Bookings entered in both. At month end, the payout computed by
each is compared **to the rupee**.

The spreadsheet is retired only after a month that matches exactly. Not "close
enough" — exactly. A mismatch is either a migration defect or an engine defect,
and both need finding before the spreadsheet goes away.

This is the single highest-value adoption mechanism in the project. Associates
watch the numbers agree before they are asked to trust them.

## Validation gates

Import stops if any of these fail:

```
unit count            = reconciliation baseline
sold unit count       = reconciliation baseline
Σ receipts imported   = total collected per the sales register
∀ associate:  exactly one live hierarchy row, no cycles
∀ associate:  exactly one grade row with validTo NULL
∀ booking:    unit exists, is not double-booked, price list version exists
∀ booking:    Σ demand amounts ≈ agreement value (within rounding tolerance)
∀ allocation: Σ per receipt ≤ receipt amount
∀ opening balance: total per associate = spreadsheet closing balance
```

## Rollback

If the import fails validation on Saturday, restore the pre-import Neon branch
and the spreadsheet stays authoritative. No partial state is left behind — the
import runs in a transaction per stage, and a failed stage rolls its stage back.

The cutover window is a full weekend precisely so this is an option rather than a
crisis.

## Ownership

The client owns reconciliation. The build team owns the import mechanics. That
split has to be explicit and agreed before Phase 0, because reconciliation is
where the calendar time goes and it needs someone from the client's finance team
with the authority to make calls about disputed rows.
