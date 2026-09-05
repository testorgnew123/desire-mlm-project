# 04 — Commission Engine Specification

> The most important document in this set. Everything here is implemented in
> `packages/commission`, which is a **pure function library with no database
> access**. That constraint is deliberate: it is what makes the engine testable
> with golden files and reproducible across years.

## 1. The model

Two independent layers.

**Self commission** — the seller's grade sets a rate, applied to the booking's
commissionable value.

**Level override** — each upline earns a fixed percentage **of the seller's
commission** (not of the sale value), by distance up the tree.

### Worked example

Commissionable value ₹1,00,00,000. Seller Ravi is a Manager at 1.5%.
Level rates: L1 10%, L2 5%, L3 2%. *(All PLACEHOLDER.)*

| Beneficiary | Role | Basis | Calculation | Amount |
|---|---|---|---|---|
| Ravi | SELF | 1.5% of base | 1,00,00,000 × 1.5% | **₹1,50,000** |
| Anil (L1) | OVERRIDE | 10% of Ravi's | 1,50,000 × 10% | **₹15,000** |
| Sunil (L2) | OVERRIDE | 5% of Ravi's | 1,50,000 × 5% | **₹7,500** |
| Meera (L3) | OVERRIDE | 2% of Ravi's | 1,50,000 × 2% | **₹3,000** |
| | | | **Total** | **₹1,75,500** = 1.755% of base |

### Why total payout is bounded

Total = `selfRate × (1 + Σ levelPcts)` = 1.5% × 1.18 = 1.77% ceiling.

This is structural — the overrides are a fraction of a fraction, so no tree
depth or shape can run away. The `maxTotalPct` assertion still exists because
the realistic risk is **a misconfigured scheme**, not the arithmetic.

## 2. Inputs, and where each is resolved

| Input | Resolved from | Pinned to |
|---|---|---|
| Commissionable value | `Booking.commissionableValue` | Frozen at booking confirmation |
| Scheme | `CommissionScheme` active for the project | `Booking.bookingDate` |
| Seller grade | `AssociateGrade` valid at the booking date | `bookingDate` |
| Grade rate | `SchemeGradeRate` | scheme version |
| Upline chain | `AssociateHierarchy` valid at the booking date | `bookingDate` |
| Level rates | `SchemeLevelRate` | scheme version |

**Everything pins to the booking date, not to now.** A promotion in June must not
change what a March sale pays.

### The snapshot, and why effective-dating alone is not enough

At accrual, the engine writes the fully resolved inputs onto each entry:

```jsonc
{
  "gradeCode": "G4", "gradeRank": 4,
  "rateType": "PCT_OF_BASE", "rateValue": "1.5000",
  "sellerCommission": "150000.00",
  "levelPct": "10.0000",
  "uplineChain": [
    { "level": 1, "associateId": "as_anil",  "code": "A-0042", "gradeCode": "G5" },
    { "level": 2, "associateId": "as_sunil", "code": "A-0011", "gradeCode": "G6" }
  ],
  "schemeVersion": 3,
  "compressionMode": "NONE",
  "computedAt": "2026-03-14T10:22:31Z"
}
```

Effective-dated tables let you *query* history. The snapshot means you don't have
to. If the tree is later restructured, if a `validTo` is set wrong, if someone
runs a bad migration — every historical payout is still explainable from its own
row. Time travel becomes a convenience rather than a dependency.

## 3. Accrual

Fires once, when a booking reaches `CONFIRMED`.

```
accrue(booking):
  scheme  = resolveScheme(booking.projectId, booking.bookingDate)   # version pinned
  base    = booking.commissionableValue                             # already frozen
  seller  = booking.sellingAssociate
  grade   = gradeAsOf(seller, booking.bookingDate)
  selfAmt = round2(applyRate(scheme.gradeRate(grade), base, booking.saleableAreaAtBooking))

  entries = [ Entry(seller, SELF, level = 0, selfAmt) ]
  uplineChain = uplineChainAsOf(seller, booking.bookingDate, scheme.maxLevel)

  for levelRate in scheme.levelRates:
      level, pct = levelRate.level, levelRate.pctOfSellerCommission
      if pct == 0: continue

      # No candidate exists at this level at all -- the chain simply doesn't
      # reach this far. Distinct from "a candidate exists but is ineligible":
      # skip entirely, no entry, NO BREAKAGE. A short chain must not
      # manufacture unclaimed money for a slot that was never occupied.
      if level > uplineChain.length: continue

      overrideAmt = round2(selfAmt * pct)
      placed = false
      candidateLevel = level

      while candidateLevel <= uplineChain.length:
          candidate = uplineChain[candidateLevel]

          if eligible(candidate, booking.bookingDate, scheme):
              # `level` here is the level this payout REPRESENTS, not
              # candidate's actual tree depth -- under ROLL_UP those can
              # differ. A beneficiary can end up with two entries for one
              # booking: their own level, and a rolled-up one.
              entries.push(Entry(candidate, OVERRIDE, level, overrideAmt))
              placed = true
              break

          if scheme.compressionMode == NONE:
              breakage += overrideAmt         # level consumed; company retains it
              placed = true
              break

          # ROLL_UP: NOT consumed. Offer the same percentage to the next
          # upline in the chain -- this is what "next upline takes it"
          # actually requires: walking the chain, not a bare `continue`.
          candidateLevel += 1

      if not placed:
          # ROLL_UP walked off the end of the chain with nobody eligible.
          # Nobody left to roll to -- it becomes breakage after all.
          breakage += overrideAmt

  assert sum(e.gross for e in entries) <= scheme.maxTotalPct * base
  persist(entries, status = ACCRUED, snapshot = resolvedInputs)
```

> **Revision note.** An earlier draft of this pseudocode had the `ROLL_UP`
> branch do a bare `continue` on an ineligible upline — which neither created
> an entry nor recorded breakage, so the money simply vanished, untracked.
> That contradicted the plain-English description directly below ("the next
> upline takes it") and was caught while implementing
> `packages/commission/src/accrue.ts`. The pseudocode above matches the actual,
> tested implementation; see the corrected walk-up logic there and in
> `packages/commission/test/accrue.test.ts` case 6 and the ROLL_UP extension
> cases.

### Rate types

| `rateType` | Formula |
|---|---|
| `PCT_OF_BASE` | `base × rateValue / 100` |
| `PER_SQFT` | `saleableAreaAtBooking × rateValue` |
| `FLAT` | `rateValue` |

### Eligibility

An upline earns their override only if, on the booking date, they are:

- `ACTIVE` (not `EXITED`, `SUSPENDED`, or in `NOTICE_PERIOD`)
- at or above `eligibilityRules.minGradeRank`, if set
- meeting `eligibilityRules.minPersonalBookingsInPeriod`, if set

### Compression — `NONE` is the default, deliberately

With an admin-assigned in-house org tree, a vacant or ineligible slot should not
silently promote someone else's earnings. If a team lead is suspended, their
manager should not quietly start earning the L1 rate — that is a payout nobody
can explain to the people involved.

`ROLL_UP` exists per scheme if the business wants classic MLM compression, but it
must be a decision, not a default.

Breakage under `NONE` is retained by the company and **reported, not discarded
silently** — finance needs to see it.

### Rounding

`ROUND_HALF_UP` to 2 decimal places, at each entry. The rounding residual is
absorbed by the company. **Never** push a rounding remainder onto an associate —
a ₹0.01 discrepancy in a statement costs more credibility than it saves in
reconciliation.

### Idempotency

`idempotencyKey = {bookingId}:{beneficiaryId}:{level}:{schemeId}`, uniquely
indexed. A retried job cannot double-accrue.

## 4. Release

Accrual answers *how much is owed*. Release answers *when it becomes payable*.
They are separate because the developer's cashflow and the associate's
entitlement are different questions.

Configured per project via `PayoutSchedule.mode`:

| Mode | Behaviour | Clawback exposure |
|---|---|---|
| `PRO_RATA_COLLECTION` | Payable tracks cleared collection. Buyer has paid 30% → 30% payable | Lowest |
| `MILESTONE` | Fixed slabs (e.g. 40% on booking-amount clearance, 40% on registration, 20% on possession) | Medium |
| `ON_BOOKING` | Fully payable at confirmation | Highest — the recovery flow must be solid |

```
onTriggerEvent(event):        # receipt cleared | milestone reached | booking confirmed
  pct = schedule.cumulativeReleasePct(booking, event)
  for entry in accruedEntries(booking):
      target = round2(entry.grossAmount * pct)
      delta  = target - alreadyReleased(entry)
      if delta > 0:
          createRelease(entry, event, delta)   # unique on (entry, triggerType, triggerRef)
```

**Release keys off `Receipt.clearedOn`, never `receivedOn`.** A cheque in hand is
not money in the bank, and a bounced cheque must never have released commission.

Entry lifecycle: `ACCRUED → PAYABLE → PAID`, with `ON_HOLD` for disputes and
`REVERSED` for contras.

## 5. Clawback

On cancellation, or on a bounced cheque that reverses a release:

```
onCancellation(booking, refundPct):
  for entry in entriesFor(booking):
      createContraEntry(entry, -entry.releasedTotal)   # never edit the original
      net against the beneficiary's pending PAYABLE first
      remainder -> Recovery(associate, amount, OUTSTANDING)
```

Outstanding recoveries auto-deduct from future payout batches, capped by
`PAYOUT_RECOVERY_MAX_DEDUCTION_PCT` (PLACEHOLDER 50%) so nobody's take-home drops
to zero without a conversation first.

## 6. Payout run

1. Finance opens a period. **Tree moves and grade changes freeze** for its window.
2. Collect `PAYABLE` entries in range.
3. Apply tax by `EngagementType` — see [11-COMPLIANCE-INDIA](11-COMPLIANCE-INDIA.md).
4. Apply recoveries and adjustments, respecting the deduction cap.
5. Generate `PayoutBatch`, a `PayoutLine` per associate, and `PayoutLineEntry` join rows.
6. **Maker-checker approval.** Preparer ≠ approver, enforced.
7. Export bank file (NEFT/RTGS), or hand off to payroll for `EMPLOYEE`.
8. Mark `PAID`, close the period.

The `PayoutLineEntry` join is what makes "which sales does this payment cover"
answerable. Without it, a statement is a number with no provenance.

## 7. Invariants

Asserted in tests, and re-checked nightly against production
([15-OPS-RUNBOOK](15-OPS-RUNBOOK.md)):

```
Σ(entries per booking).grossAmount  ≤  scheme.maxTotalPct × commissionableValue
Σ(releases per entry)               ≤  entry.grossAmount
Σ(PAID + PAYABLE + REVERSED)        reconciles to Σ(ACCRUED)
∀ entry:        snapshot is non-empty and contains schemeVersion
∀ contra entry: sourceEntryId is set and points to a real entry
∀ booking:      at most one SELF entry per scheme version
```

## 8. Test fixtures

Golden files under `packages/commission/__fixtures__/`. Each is
`{ scheme, tree, grades, booking } → expected entries`. Required cases:

| Case | Asserts |
|---|---|
| Seller with no upline | Only a SELF entry |
| Full 3-level chain | Four entries, correct amounts |
| Chain shorter than `maxLevel` | No phantom entries |
| Seller at top of tree | No overrides |
| Ineligible L1, `compression: NONE` | Level consumed, breakage recorded, L2 unaffected |
| Ineligible L1, `compression: ROLL_UP` | L2 receives the L1 percentage |
| Grade changed after booking | Booking-date grade used |
| Scheme versioned after booking | Booking-date version used |
| `PER_SQFT` and `FLAT` rate types | Correct formula |
| Zero and maximum discount | Base resolves correctly |
| Rounding at 2dp | Residual to company; entries sum correctly |
| Misconfigured scheme over `maxTotalPct` | Accrual **refuses**; nothing persisted |

### The test that matters most

**Reproducibility.** Accrue a booking. Then mutate the current tree and current
grades. Re-run the historical accrual. Output must be byte-identical.

If that test passes, the snapshot design works and March can always be
reproduced. If it ever fails, stop and fix it before shipping anything else.
