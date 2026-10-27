// What an associate is told when holding or releasing a plot is refused. The
// services throw errors written for logs; this says what happened in terms of what
// the person did ("Just taken by Ravi (A-0042)", never a generic failure,
// docs/08-SCREENS.md). A pure function so every message can be tested.
import { HoldGuardError, HoldQuotaExceededError, UnitNotAvailableError, UnitNotFoundError } from "@desire/services/holds";
import {
  HoldHasDraftError,
  NoActivePriceListError,
  PlotNotHeldError,
  PlotNotPricedError,
  PlotTagNotPricedError,
} from "@desire/services/plot-booking";
import { ForbiddenError } from "@desire/services/rbac";

export function describeHoldFailure(error: unknown): string {
  if (error instanceof HoldQuotaExceededError) {
    return error.quota === 0
      ? "You can't hold plots yet: your account has no hold allowance. Ask an admin to check your grade."
      : `You already hold ${error.liveHolds} of ${error.quota} plots. Release one, or book it, to hold another.`;
  }
  if (error instanceof UnitNotAvailableError) {
    if (error.heldBy) return `Just taken by ${error.heldBy.name} (${error.heldBy.code}).`;
    if (error.status === "BLOCKED") return "This plot is blocked and can't be held or booked.";
    return "This plot is no longer available.";
  }
  if (error instanceof UnitNotFoundError) return "This plot was not found.";
  if (
    error instanceof NoActivePriceListError ||
    error instanceof PlotNotPricedError ||
    error instanceof PlotTagNotPricedError ||
    error instanceof HoldGuardError ||
    error instanceof ForbiddenError ||
    error instanceof PlotNotHeldError ||
    error instanceof HoldHasDraftError
  ) {
    return error.message;
  }
  return "Something went wrong. Try again in a moment.";
}
