import Decimal from "decimal.js";
import type { ClawbackInput, ClawbackResult } from "./types";

/**
 * Computes a cancellation's clawback against one commission entry, following
 * docs/04-COMMISSION-SPEC.md section 5: reverse the full released total,
 * netting first against the beneficiary's other pending PAYABLE entries,
 * with any remainder becoming a Recovery.
 *
 * The caller persists the actual contra CommissionEntry row (never edits the
 * original -- see ADR-0006) and applies PAYOUT_RECOVERY_MAX_DEDUCTION_PCT
 * when a Recovery is later netted against a future payout batch; that cap is
 * a payout-batch-time concern, not a clawback-time one, so it does not
 * appear here.
 */
export function computeClawback(input: ClawbackInput): ClawbackResult {
  const nettedAgainstPending = Decimal.min(
    input.beneficiaryPendingPayable,
    input.releasedTotal,
  );
  const recoveryAmount = input.releasedTotal.minus(nettedAgainstPending);

  return {
    contraAmount: input.releasedTotal.negated(),
    nettedAgainstPending,
    recoveryAmount,
  };
}
