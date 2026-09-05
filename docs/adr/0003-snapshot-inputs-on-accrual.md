# ADR-0003 — Snapshot resolved inputs onto every commission entry

**Status:** Accepted
**Date:** 2026-09-05

## Context

A commission entry is computed from inputs that change over time: the seller's
grade, the upline chain, the scheme's rates. A payout run for a March sale must
produce March's numbers, forever — including when it is re-run in 2029 to settle
a dispute or satisfy an audit.

Effective dating (`validFrom` / `validTo`) is the standard answer. It is not
sufficient on its own.

## Decision

Effective-date the assignment tables **and** write the fully resolved inputs into
`CommissionEntry.snapshot` (JSON) at accrual time.

```jsonc
{
  "gradeCode": "G4", "gradeRank": 4,
  "rateType": "PCT_OF_BASE", "rateValue": "1.5000",
  "sellerCommission": "150000.00",
  "levelPct": "10.0000",
  "uplineChain": [ { "level": 1, "associateId": "...", "code": "A-0042", "gradeCode": "G5" } ],
  "schemeVersion": 3,
  "compressionMode": "NONE",
  "computedAt": "2026-03-14T10:22:31Z"
}
```

## Why not effective dating alone

Effective dating lets you *query* history. It assumes the historical rows are
still there and still correct. That assumption fails in ordinary ways:

- A tree restructure sets `validTo` on the wrong row.
- A bulk grade correction overwrites rather than closes-and-inserts.
- A migration rewrites hierarchy paths.
- An associate is hard-deleted despite the policy against it.

Each of those is a data-quality bug. With effective dating alone, each also
**silently changes what a three-year-old payout appears to have been**. The
number in someone's bank account and the number the system now reports diverge,
and there is no way to tell which was right.

The snapshot makes historical entries **self-contained**. Time travel becomes a
convenience rather than a dependency.

## Consequences

**The reproducibility test becomes possible.** Accrue a booking, then mutate the
current tree and grades, then re-run the historical accrual and assert
byte-identical output. That test is the strongest correctness guarantee in the
system and it only works because of this decision.

**The explain drill-down becomes trivial.** `GET /commission/entries/:id/explain`
reads one column. No joins across effective-dated tables, no risk of the
explanation disagreeing with the payment.

**Storage cost.** Roughly 1–2 KB per entry, ~24,000 entries a year. Around 50 MB
a year. Irrelevant.

**Duplication.** The same grade appears in `AssociateGrade` and in every snapshot
referencing it. Accepted deliberately: this is an audit record, not normalised
state, and audit records are supposed to be redundant.

**Discipline required.** The snapshot must be written at accrual and never
mutated afterwards. Enforced by the append-only rule
([ADR-0006](0006-append-only-financial-ledger.md)) and asserted by the invariant
`∀ entry: snapshot non-empty and contains schemeVersion`.

## Related

Same reasoning applies to `Booking.commissionableValue` (frozen at confirmation),
`CostSheetLine` (snapshot of what the customer signed), and `PayoutLine`
banking details (snapshot so a reissued statement matches the original payment).

The pattern throughout: **anything a person was paid on gets frozen at the moment
of the decision.**
