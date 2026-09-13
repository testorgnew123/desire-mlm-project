// GST on brokerage -- Phase 4. Extracted from packages/services/src/
// payouts.ts's inline PLACEHOLDER constant. docs/11-COMPLIANCE-INDIA.md's
// own mapping: EMPLOYEE never attracts GST (payroll, not a vendor invoice);
// CONSULTANT/CHANNEL_PARTNER attract it only if GST-registered.
import Decimal from "decimal.js";
import type { TaxEngagementType } from "./types";

// PLACEHOLDER pending CA confirmation (BLOCKED#11), per
// docs/11-COMPLIANCE-INDIA.md's stated "18% if registered".
const GST_RATE_PCT_IF_REGISTERED = new Decimal("18.00");

export function gstApplies(engagementType: TaxEngagementType, isGstRegistered: boolean): boolean {
  return engagementType !== "EMPLOYEE" && isGstRegistered;
}

export function computeGst(grossAmount: Decimal, ratePct: Decimal = GST_RATE_PCT_IF_REGISTERED): Decimal {
  return grossAmount.mul(ratePct).div(100).toDecimalPlaces(2);
}

export { GST_RATE_PCT_IF_REGISTERED };
