// Public API of the tax engine. Everything exported here is pure -- no I/O,
// no @prisma/client import (see ../.eslintrc.cjs). See
// docs/11-COMPLIANCE-INDIA.md.

export { resolveTdsSection, resolveEffectiveTdsRate, computeTds } from "./tds";
export { gstApplies, computeGst, GST_RATE_PCT_IF_REGISTERED } from "./gst";

export type { TaxEngagementType, TaxSection, TaxRateInput } from "./types";
