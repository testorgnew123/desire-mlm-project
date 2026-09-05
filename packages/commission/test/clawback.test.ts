import { describe, expect, it } from "vitest";
import { computeClawback } from "../src/clawback";
import { D } from "./helpers";

describe("computeClawback", () => {
  it("fully nets against pending payable when it covers the released total", () => {
    const result = computeClawback({
      releasedTotal: D("15000"),
      beneficiaryPendingPayable: D("50000"),
    });

    expect(result.contraAmount.toString()).toBe("-15000");
    expect(result.nettedAgainstPending.toString()).toBe("15000");
    expect(result.recoveryAmount.toString()).toBe("0");
  });

  it("nets what it can and turns the remainder into a recovery", () => {
    const result = computeClawback({
      releasedTotal: D("15000"),
      beneficiaryPendingPayable: D("4000"),
    });

    expect(result.contraAmount.toString()).toBe("-15000");
    expect(result.nettedAgainstPending.toString()).toBe("4000");
    expect(result.recoveryAmount.toString()).toBe("11000");
  });

  it("becomes a full recovery when there is no pending payable to net against", () => {
    const result = computeClawback({
      releasedTotal: D("15000"),
      beneficiaryPendingPayable: D("0"),
    });

    expect(result.nettedAgainstPending.toString()).toBe("0");
    expect(result.recoveryAmount.toString()).toBe("15000");
  });
});
