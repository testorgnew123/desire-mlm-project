import Decimal from "decimal.js";

/** The single rounding rule for the whole commission engine: round half up to
 *  2 decimal places. Nothing else in this package rounds independently --
 *  see docs/04-COMMISSION-SPEC.md section 3. The residual belongs to the
 *  company; it is never distributed to an associate. */
export function round2(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}
