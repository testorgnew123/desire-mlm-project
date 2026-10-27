// The words an associate reads when a hold or release is refused.
import { describe, expect, it } from "vitest";
import { HoldGuardError, HoldQuotaExceededError, UnitNotAvailableError, UnitNotFoundError } from "@desire/services/holds";
import {
  HoldHasDraftError,
  NoActivePriceListError,
  PlotNotHeldError,
  PlotNotPricedError,
  PlotTagNotPricedError,
} from "@desire/services/plot-booking";
import { ForbiddenError } from "@desire/services/rbac";
import { describeHoldFailure } from "../lib/hold-messages";

describe("describeHoldFailure", () => {
  it("names the associate who just took the plot", () => {
    const error = new UnitNotAvailableError("u1", "HELD", { associateId: "a1", code: "A-0042", name: "Ravi" });
    expect(describeHoldFailure(error)).toBe("Just taken by Ravi (A-0042).");
  });

  it("says a blocked plot is blocked, and anything else that it is gone", () => {
    expect(describeHoldFailure(new UnitNotAvailableError("u1", "BLOCKED"))).toMatch(/blocked/);
    expect(describeHoldFailure(new UnitNotAvailableError("u1", "BOOKED"))).toBe("This plot is no longer available.");
  });

  it("explains the allowance in plain numbers, and a missing allowance as a grade problem", () => {
    expect(describeHoldFailure(new HoldQuotaExceededError("a1", 3, 3))).toBe(
      "You already hold 3 of 3 plots. Release one, or book it, to hold another.",
    );
    expect(describeHoldFailure(new HoldQuotaExceededError("a1", 0, 0))).toMatch(/no hold allowance.*grade/);
  });

  it("passes through the messages that are already written for people", () => {
    for (const error of [
      new NoActivePriceListError("p1"),
      new PlotNotPricedError("u1"),
      new PlotTagNotPricedError("u1", ["CORNER"]),
      new HoldGuardError("Project cannot be held."),
      new ForbiddenError("This account has no associate profile; only associates can hold a plot."),
      new PlotNotHeldError("u1"),
      new HoldHasDraftError("u1", "PLT-0001"),
    ]) {
      expect(describeHoldFailure(error)).toBe(error.message);
    }
    expect(describeHoldFailure(new HoldHasDraftError("u1", "PLT-0001"))).toMatch(/PLT-0001/);
  });

  it("says a missing plot is missing, and shows nothing technical for anything unexpected", () => {
    expect(describeHoldFailure(new UnitNotFoundError("u1"))).toBe("This plot was not found.");
    expect(describeHoldFailure(new Error("connect ECONNREFUSED 10.0.0.1:5432"))).toBe(
      "Something went wrong. Try again in a moment.",
    );
    expect(describeHoldFailure("boom")).toBe("Something went wrong. Try again in a moment.");
  });
});
