import Decimal from "decimal.js";
import { round2 } from "./round";
import type { ReleaseComputationInput, ReleaseScheduleSlab } from "./types";

/**
 * Resolves the cumulative release percentage for MILESTONE schedules: the
 * highest releasePct among slabs whose trigger has already fired. Pure --
 * "has this trigger fired" is a plain set membership check the caller
 * resolves (it may need DB data to know that); this function only does the
 * arithmetic once that's known.
 *
 * For PRO_RATA_COLLECTION and ON_BOOKING, the caller resolves
 * cumulativeReleasePct directly (from live collection data, or 100 on
 * booking) and calls computeRelease below without going through this.
 */
export function resolveMilestoneCumulativePct(
  slabs: readonly ReleaseScheduleSlab[],
  firedTriggerRefs: ReadonlySet<string>,
): Decimal {
  let cumulative = new Decimal(0);
  for (const slab of slabs) {
    const key = slab.triggerRef ?? slab.triggerType;
    if (firedTriggerRefs.has(key) && slab.releasePct.greaterThan(cumulative)) {
      cumulative = slab.releasePct;
    }
  }
  return cumulative;
}

/**
 * How much of one commission entry should release now, given the cumulative
 * percentage unlocked and what has already been released against it.
 * Idempotent by construction: calling this again with the same cumulative
 * percentage returns zero, since target - alreadyReleased is then zero.
 *
 * Release always keys off cleared collection, never off money merely
 * received -- see docs/05-COLLECTIONS-SPEC.md. That distinction is made by
 * the caller when it resolves cumulativeReleasePct; this function only
 * turns a percentage into a rupee delta.
 */
export function computeRelease(input: ReleaseComputationInput): Decimal {
  const target = round2(
    input.entryGrossAmount.mul(input.cumulativeReleasePct).div(100),
  );
  const delta = target.minus(input.entryAlreadyReleased);
  return delta.greaterThan(0) ? delta : new Decimal(0);
}
