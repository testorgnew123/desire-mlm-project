# 13 — Test Strategy

Testing effort is deliberately unevenly distributed. The commission engine and
the hold critical section get disproportionate attention because those are the
two places where a bug is silent, expensive and discovered late.

## Pyramid

| Layer | Tool | Scope |
|---|---|---|
| Unit (pure) | Vitest | `packages/commission`, `packages/tax` — golden files |
| Integration | Vitest + real Postgres | `packages/services` — transactions, authorization, audit |
| Concurrency | Vitest + real Postgres | Hold races, allocation races |
| Contract | Zod schemas | API request/response shapes |
| E2E | Playwright | Full journeys against a deploy preview |
| Invariant | SQL assertions | Run in CI **and** nightly against production |

**Never mock Postgres.** Row locks, partial unique indexes and transaction
isolation are the things being tested. A mock cannot reproduce any of them.

## Commission engine — golden files

`packages/commission` is pure, so this is cheap and must be exhaustive.

Each fixture is `{ scheme, tree, grades, booking } → expected entries`, stored as
JSON under `__fixtures__/`. Required cases are enumerated in
[04-COMMISSION-SPEC §8](04-COMMISSION-SPEC.md).

### The test that matters most

```
1. Accrue a booking dated 2026-03-14.
2. Mutate the current tree — move the seller under a different manager.
3. Mutate current grades — promote the seller two grades.
4. Re-run the historical accrual.
5. Assert byte-identical output.
```

If this passes, the snapshot design works and any historical payout can be
reproduced. If it ever fails, stop everything else and fix it.

**Coverage target: 100% branch.** Every uncovered branch in this package is a
payout nobody has verified.

## Invariants

Asserted in integration tests and re-checked nightly in production
([15-OPS-RUNBOOK](15-OPS-RUNBOOK.md)).

### Commission
```
Σ(entries per booking).grossAmount  ≤  scheme.maxTotalPct × commissionableValue
Σ(releases per entry)               ≤  entry.grossAmount
Σ(PAID + PAYABLE + REVERSED)        reconciles to Σ(ACCRUED)
∀ entry:        snapshot non-empty, contains schemeVersion
∀ contra entry: sourceEntryId set and resolvable
∀ booking:      at most one SELF entry per scheme version
```

### Inventory
```
∀ unit:  at most one unit_hold with released_at IS NULL
∀ unit in BOOKED:  exactly one booking CONFIRMED or beyond
∀ associate:       live holds ≤ their grade's holdQuota
```

### Collections
```
Σ(allocations per receipt)  ≤  receipt.amount
Σ(allocations per demand)   ≤  demand.amount + demand.gstAmount
Σ(cleared receipts)         =  Σ(active allocations) + booking.creditBalance
∀ demand, rung:  at most one CollectionAlert
```

### Network & duties
```
∀ associate:  not their own ancestor; exactly one hierarchy row with validTo NULL
∀ receipt:    enteredById ≠ verifiedById, and neither is the selling
              associate nor in their upline
∀ payoutBatch: preparedById ≠ approvedById
```

## Concurrency tests

| Test | Assertion |
|---|---|
| 50 parallel holds on one unit | Exactly 1 success, 49 clean `409`s |
| Parallel hold + admin block | Consistent final state, no orphan hold |
| Parallel receipt allocations against one demand | Never over-allocated |
| Parallel payout batch creation for one period | Second is rejected |
| Hold expiry sweep racing a conversion | Booking wins; no double release |

Run against real Postgres, in CI, on every PR touching those paths.

## State machine tests

Table-driven over every (state, transition) pair for `Unit` and `Booking`. Legal
transitions succeed and write history; illegal ones throw and write nothing.

## Tax tests

Fixture-driven per `engagementType` × TDS section × GST registration status,
including a rate change that falls **inside** a payout period.

**These fixtures must be reviewed by the client's CA.** Correctness here is a
domain question, not an engineering one — a passing test against a wrong fixture
is worse than no test.

## End-to-end (Playwright)

### Happy path
Seed 100 units → associate holds a unit → converts to booking → demand schedule
generates → admin enters receipt → finance verifies and clears → commission
accrues for seller + 3 uplines → releases pro-rata → payout batch runs →
statement PDF matches the ledger → cancel booking → clawback appears as a
recovery on the next batch.

### Collections path
Advance the clock past a due date → assert each escalation rung fires exactly
once, to the right recipients, in order → log a promise-to-pay → breach it →
assert the breach alert → bounce the cheque → assert the pro-rata release
reverses.

### Authorization path
For each role, attempt every forbidden action from the
[RBAC matrix](09-RBAC-MATRIX.md) and assert a clean denial. Specifically: the
selling associate's upline cannot verify a receipt on that booking.

## Performance tests

Before Phase 5 sign-off, against production-scale seed data:

- Inventory board at 500 concurrent pollers — confirm Neon's pooler holds and no
  function approaches the 60 s cap
- **Payout batch wall-clock against the 15-minute background ceiling** — tune
  chunk size from the measured number, not a guess
- Neon cold start with autosuspend on and off — confirm the configured setting

## CI gates

A PR cannot merge unless: typecheck passes · lint passes · unit tests pass ·
`packages/commission` at 100% branch · integration tests pass against ephemeral
Postgres · invariant assertions pass · E2E passes on the deploy preview ·
no high-severity `npm audit` finding.
