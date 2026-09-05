# ADR-0006 — Append-only financial ledger

**Status:** Accepted
**Date:** 2026-09-05

## Context

Commission entries, releases, allocations and payout lines record what people
were paid. Corrections are inevitable: a cancellation, a bounced cheque, a
scheme misconfiguration found after accrual, a dispute resolved in the
associate's favour.

The convenient implementation is to update the row.

## Decision

**Financial rows are never updated and never deleted.** Corrections are contra
entries.

Applies to: `CommissionEntry`, `CommissionRelease`, `ReceiptAllocation`,
`PayoutLine`, `PayoutLineEntry`, `Recovery`, `Adjustment`, `AuditLog`.

- A reversal is a **new row** with `sourceEntryId` pointing at what it reverses.
- A cancelled allocation sets `reversedAt` — the row stays.
- `CommissionEntry.status` moves through its lifecycle, but `grossAmount` and
  `snapshot` are immutable once written.

## Why

**Someone will ask what happened.** An associate disputing a payout does not
want the current number — they want to know why it changed and when. An UPDATE
destroys exactly that.

**Reproducibility depends on it.** Combined with
[ADR-0003](0003-snapshot-inputs-on-accrual.md), append-only means any historical
state can be reconstructed by replaying rows up to a date. With mutation, the
past is whatever the last write left behind.

**Auditors expect it.** This is how financial systems work, and there is no
benefit in being unconventional here.

**It makes bugs visible instead of silent.** A defect that writes a wrong contra
entry leaves evidence. A defect that overwrites a value leaves nothing.

## Consequences

**Reads need care.** "Current commission for this booking" is a sum over entries
net of reversals, not a column. Encapsulated in `packages/services` so no caller
hand-rolls it — this is the main place the decision costs anything.

**Row growth.** ~24,000 entries a year plus reversals. Trivial at this scale.

**Status is the one mutable field.** `ACCRUED → PAYABLE → PAID` is a lifecycle,
not a value change, and every transition writes an audit row. Amounts never move.

**Discipline must be enforced, not assumed.** The invariant monitor asserts
`∀ contra entry: sourceEntryId set and resolvable`, and code review treats any
`prisma.commissionEntry.update()` touching an amount as a defect.

Consider a database trigger rejecting amount updates outright once the schema
settles — the guarantee is worth more than the flexibility.

## Consequence worth stating plainly

Fixing a mistake is more work than making one. Correcting a wrongly accrued
entry means reversing it and re-accruing, not editing a number.

That friction is the point. It means every correction is deliberate, attributed,
and visible to the person whose money it was.
