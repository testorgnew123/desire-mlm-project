// Plain literal types only -- no Prisma import (see ../.eslintrc.cjs). These
// mirror @desire/db's generated EngagementType/TdsSection enum VALUES
// exactly (packages/db/prisma/schema.prisma), so a caller in
// packages/services can pass its Prisma-typed values straight through
// without a translation table, but this package itself never depends on
// Prisma's generated client to know that. Money moves as decimal.js
// Decimal, the same bridge pattern packages/commission already uses --
// packages/services converts Prisma.Decimal -> decimal.js via .toString()
// at the call boundary and converts results back for persistence.
import type Decimal from "decimal.js";

/** Mirrors @desire/db's EngagementType enum. */
export type TaxEngagementType = "EMPLOYEE" | "CONSULTANT" | "CHANNEL_PARTNER";

/** Mirrors @desire/db's TdsSection enum (the subset this package resolves
 *  to -- the DB enum may carry more sections than engagement-type mapping
 *  ever produces, e.g. sections entered directly via TaxRate for other
 *  purposes). */
export type TaxSection = "SEC_192" | "SEC_194J" | "SEC_194H";

/** The two fields off a TaxRate row this package's math actually needs --
 *  callers pass a plain object, not a Prisma row, keeping this package
 *  DB-shape-agnostic. */
export interface TaxRateInput {
  ratePct: Decimal;
  /** Higher rate applied when PAN is not on file (Sec. 206AA). Optional --
   *  many effective-dated rows may never set this. */
  noPanRatePct?: Decimal | null;
}
