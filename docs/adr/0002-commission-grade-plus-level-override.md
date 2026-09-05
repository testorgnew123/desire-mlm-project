# ADR-0002 — Grade slab plus fixed-percentage level overrides

**Status:** Accepted
**Date:** 2026-09-05

## Context

Associates are paid on a grade ladder with multi-level participation in their
downline's sales. "Grade-based MLM" describes at least three different payout
mathematics, and they behave very differently under stress.

## Decision

**Self commission:** the seller's grade sets a rate on the commissionable value.

**Override:** each upline earns a fixed percentage **of the seller's commission**
(not of the sale value), by tree level. PLACEHOLDER: L1 10%, L2 5%, L3 2%, depth
cap 3.

## Alternatives considered

**Grade slab only, no overrides.** Simplest — no tree needed at all. Rejected:
the client's existing model pays managers on their team's production, and
removing that changes their compensation structure, which is not ours to change.

**Differential override.** The upline earns the difference between their grade
rate and the downline's. Self-balancing and popular in real estate. Rejected: it
makes a promotion silently reduce the upline's earnings on that person's sales,
which is hard to explain and generates disputes. It also couples every payout to
the exact grade of everyone above, so one wrong grade cascades.

**Fixed percentage of sale value per level.** Rejected: unbounded. Total payout
grows with tree depth, and a deep tree can exceed the margin on the unit.

## Why this one

**Total payout is structurally bounded** at `selfRate × (1 + Σ levelPcts)`.
With the placeholder rates that is 1.18×. No tree shape or depth can run away,
because overrides are a fraction of a fraction.

**It is explainable in one sentence.** "You earn 10% of what your direct report
earns." An associate can verify it with a calculator, which matters more than
elegance — see [17-ROLLOUT](../17-ROLLOUT.md).

**Grade and level are decoupled.** A promotion changes what you earn on your own
sales without silently changing what your manager earns on them.

## Consequences

- Requires a genealogy tree with reliable level resolution. Handled by the
  materialised `path` on `AssociateHierarchy`.
- Requires a `compressionMode` decision for ineligible uplines —
  see [ADR-0003](0003-snapshot-inputs-on-accrual.md) context and
  [04-COMMISSION-SPEC §3](../04-COMMISSION-SPEC.md).
- `maxTotalPct` is still asserted at accrual. The bound is mathematical, but a
  misconfigured scheme is the realistic risk, not the arithmetic.
- Deeper trees need more level rates configured; the depth cap prevents an
  unbounded configuration surface.

## Revisit if

The client restructures compensation, or the tree grows deeper than ~6 levels, at
which point the fixed percentages will need re-tuning to stay meaningful at the
bottom.
