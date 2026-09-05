// Public API of the commission engine. Everything exported here is pure --
// no I/O, no @prisma/client import (see ../.eslintrc.cjs), no Date.now().
// See docs/04-COMMISSION-SPEC.md.

export { accrue } from "./accrue";
export { gradeAsOf, uplineChainAsOf } from "./resolve";
export { computeRelease, resolveMilestoneCumulativePct } from "./release";
export { computeClawback } from "./clawback";
export { round2 } from "./round";
export { CommissionSchemeMisconfiguredError } from "./errors";

export type {
  AccrualInput,
  AccrualResult,
  AssociateSnapshot,
  ClawbackInput,
  ClawbackResult,
  CommissionEntryResult,
  CommissionEntrySnapshot,
  CommissionRole,
  CompressionMode,
  EligibilityRules,
  GradeAssignmentRecord,
  GradeRate,
  HierarchyAssignmentRecord,
  LevelRate,
  OrgSnapshot,
  RateType,
  ReleaseComputationInput,
  ReleaseScheduleSlab,
  ResolvedUplineNode,
  SchemeConfig,
  SellerInfo,
} from "./types";
