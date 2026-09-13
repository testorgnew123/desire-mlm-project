// TDS (Tax Deducted at Source) resolution -- Phase 4. Extracted from
// packages/services/src/payouts.ts, where these lived as inline PLACEHOLDER
// constants (BLOCKED#11, docs/11-COMPLIANCE-INDIA.md's open item: "Confirm
// the actual engagement basis with the client's CA before Phase 4"). The
// mechanism here is real; the section MAPPING is the part still awaiting
// CA confirmation -- see docs/11-COMPLIANCE-INDIA.md lines 22-40.
import type Decimal from "decimal.js";
import type { TaxEngagementType, TaxRateInput, TaxSection } from "./types";

// docs/11-COMPLIANCE-INDIA.md's own mapping table. PLACEHOLDER pending CA
// confirmation of the actual engagement basis (BLOCKED#11) -- EMPLOYEE is
// the doc's own stated "expected default" for an in-house network.
const TDS_SECTION_BY_ENGAGEMENT: Record<TaxEngagementType, TaxSection> = {
  EMPLOYEE: "SEC_192",
  CONSULTANT: "SEC_194J",
  CHANNEL_PARTNER: "SEC_194H",
};

export function resolveTdsSection(engagementType: TaxEngagementType): TaxSection {
  return TDS_SECTION_BY_ENGAGEMENT[engagementType];
}

/** Sec. 206AA: a higher TDS rate applies when the deductee has no PAN on
 *  file. Previously read from the schema (`TaxRate.noPanRatePct`) but never
 *  actually applied anywhere -- this is that fix. Falls back to the base
 *  rate whenever the row doesn't configure a no-PAN rate at all, or when
 *  the beneficiary does have a PAN on file. */
export function resolveEffectiveTdsRate(taxRate: TaxRateInput, hasPan: boolean): Decimal {
  if (!hasPan && taxRate.noPanRatePct != null) {
    return taxRate.noPanRatePct;
  }
  return taxRate.ratePct;
}

export function computeTds(grossAmount: Decimal, effectiveRatePct: Decimal): Decimal {
  return grossAmount.mul(effectiveRatePct).div(100).toDecimalPlaces(2);
}
