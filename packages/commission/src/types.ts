// Plain data only -- no ORM types, no Prisma.Decimal. This package never
// imports @prisma/client (enforced by ../.eslintrc.cjs), so every type here is
// a hand-written mirror of the relevant slice of prisma/schema.prisma. See
// docs/04-COMMISSION-SPEC.md for the spec these types implement.
import type Decimal from "decimal.js";

export type RateType = "PCT_OF_BASE" | "PER_SQFT" | "FLAT";
export type CompressionMode = "NONE" | "ROLL_UP";
export type CommissionRole = "SELF" | "OVERRIDE";

// ── Scheme configuration ────────────────────────────────────────────────────

export interface GradeRate {
  gradeCode: string;
  rateType: RateType;
  /** PCT_OF_BASE: percent, e.g. 1.5 means 1.5%.
   *  PER_SQFT: rupees per saleable square foot.
   *  FLAT: rupees per booking. */
  rateValue: Decimal;
}

export interface LevelRate {
  /** 1 = immediate upline. */
  level: number;
  /** Percent OF THE SELLER'S COMMISSION, not of the sale value. e.g. 10 means
   *  10% of what the seller earned. */
  pctOfSellerCommission: Decimal;
}

export interface EligibilityRules {
  minGradeRank?: number;
  minPersonalBookingsInPeriod?: number;
}

export interface SchemeConfig {
  schemeId: string;
  schemeVersion: number;
  maxLevel: number;
  compressionMode: CompressionMode;
  /** Hard ceiling as a percentage of commissionable value. Accrual asserts
   *  against this and refuses to return on breach -- see accrue.ts. */
  maxTotalPct: Decimal;
  gradeRates: GradeRate[];
  levelRates: LevelRate[];
  eligibilityRules?: EligibilityRules;
}

// ── Effective-dated history, as fetched by the caller ───────────────────────
//
// This package resolves "as of a date" purely from these in-memory records --
// it never queries a database. Effective-dated rows are never overwritten
// (see docs/02-ARCHITECTURE.md), only closed (validTo set) and superseded by a
// new row, which is what makes the reproducibility test possible: mutating
// the CURRENT assignment only appends to these arrays, it never removes or
// edits the historical record a past booking date resolves to.

export interface GradeAssignmentRecord {
  gradeCode: string;
  gradeRank: number;
  validFrom: string; // ISO 8601
  validTo: string | null; // null = currently in force
}

export interface HierarchyAssignmentRecord {
  parentAssociateId: string | null; // null = top of tree
  validFrom: string;
  validTo: string | null;
}

/** Associate.status has no effective-dating in the schema (only grade and
 *  hierarchy assignments are historised) -- so eligibility can only ever be
 *  evaluated against the CURRENT status, not a historical one. This is a
 *  known, deliberate limitation carried from the schema as built, not
 *  something this package can paper over. See resolve.ts. */
export interface AssociateSnapshot {
  associateId: string;
  code: string;
  status: string;
}

export interface OrgSnapshot {
  hierarchyHistory: ReadonlyMap<string, readonly HierarchyAssignmentRecord[]>;
  gradeHistory: ReadonlyMap<string, readonly GradeAssignmentRecord[]>;
  associates: ReadonlyMap<string, AssociateSnapshot>;
}

export interface ResolvedUplineNode {
  level: number;
  associateId: string;
  code: string;
  gradeCode: string;
  gradeRank: number;
  status: string;
}

// ── Accrual ──────────────────────────────────────────────────────────────

export interface SellerInfo {
  associateId: string;
}

export interface AccrualInput {
  bookingId: string;
  /** ISO 8601 date. Every effective-dated lookup resolves against this, not
   *  against "now" -- a promotion in June must not change what a March sale
   *  paid. */
  bookingDate: string;
  /** Already frozen on the booking at confirmation time -- this package never
   *  derives it from cost-sheet lines. See docs/06-INVENTORY-SPEC.md. */
  commissionableValue: Decimal;
  saleableAreaAtBooking: Decimal;
  scheme: SchemeConfig;
  seller: SellerInfo;
  /** Caller-supplied, not Date.now() -- keeps accrue() a pure function of its
   *  arguments. The reproducibility test passes the same value on both runs
   *  so the ONLY things that can differ are the numbers actually being
   *  tested. */
  computedAt: string;
}

export interface CommissionEntrySnapshot {
  gradeCode: string;
  gradeRank: number;
  rateType: RateType;
  rateValue: string;
  sellerCommission: string;
  levelPct?: string;
  uplineChain: Array<{ level: number; associateId: string; code: string; gradeCode: string }>;
  schemeVersion: number;
  compressionMode: CompressionMode;
  computedAt: string;
}

export interface CommissionEntryResult {
  bookingId: string;
  schemeId: string;
  beneficiaryAssociateId: string;
  role: CommissionRole;
  /** 0 for SELF. For OVERRIDE, the level this payout REPRESENTS -- under
   *  ROLL_UP that may not equal the beneficiary's actual tree depth, since
   *  the money rolled up to them from a more junior, ineligible slot. */
  level: number;
  baseAmount: Decimal;
  grossAmount: Decimal;
  snapshot: CommissionEntrySnapshot;
  idempotencyKey: string;
}

export interface AccrualResult {
  entries: CommissionEntryResult[];
  /** Override money nobody qualified for, retained by the company. Must be
   *  reported, never silently dropped -- see docs/04-COMMISSION-SPEC.md. */
  breakage: Decimal;
}

// ── Release ──────────────────────────────────────────────────────────────

export interface ReleaseScheduleSlab {
  sequence: number;
  triggerType: string;
  triggerRef: string | null;
  /** Cumulative percentage unlocked once this slab's trigger has fired. */
  releasePct: Decimal;
}

export interface ReleaseComputationInput {
  entryGrossAmount: Decimal;
  entryAlreadyReleased: Decimal;
  /** 0-100. For PRO_RATA_COLLECTION and ON_BOOKING this is resolved by the
   *  caller (it needs live receipt/collection data this package cannot see).
   *  For MILESTONE, resolve it first with resolveMilestoneCumulativePct. */
  cumulativeReleasePct: Decimal;
}

// ── Clawback ─────────────────────────────────────────────────────────────

export interface ClawbackInput {
  releasedTotal: Decimal;
  /** Sum of the beneficiary's other PAYABLE entries, supplied by the caller. */
  beneficiaryPendingPayable: Decimal;
}

export interface ClawbackResult {
  /** Negative -- the magnitude of the reversal to record as a contra entry. */
  contraAmount: Decimal;
  nettedAgainstPending: Decimal;
  /** Remainder after netting, becomes a Recovery. Not yet capped by
   *  PAYOUT_RECOVERY_MAX_DEDUCTION_PCT -- that cap applies at payout-batch
   *  time, not at clawback time. */
  recoveryAmount: Decimal;
}
