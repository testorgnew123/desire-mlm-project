/** Thrown when a scheme configuration would overpay -- e.g. the sum of self
 *  plus override commission exceeds maxTotalPct of the commissionable value.
 *  Accrual refuses to return entries when this fires; nothing is persisted.
 *  See docs/04-COMMISSION-SPEC.md section 7 and PROGRESS.md Phase 3 gates. */
export class CommissionSchemeMisconfiguredError extends Error {
  constructor(
    message: string,
    public readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CommissionSchemeMisconfiguredError";
  }
}
