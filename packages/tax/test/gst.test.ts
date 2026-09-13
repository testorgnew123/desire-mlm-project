import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { gstApplies, computeGst, GST_RATE_PCT_IF_REGISTERED } from "../src/gst";

const D = (v: string | number) => new Decimal(v);

describe("gstApplies", () => {
  it("never applies to an EMPLOYEE, registered or not", () => {
    expect(gstApplies("EMPLOYEE", true)).toBe(false);
    expect(gstApplies("EMPLOYEE", false)).toBe(false);
  });

  it("applies to a CONSULTANT or CHANNEL_PARTNER only when GST-registered", () => {
    expect(gstApplies("CONSULTANT", true)).toBe(true);
    expect(gstApplies("CONSULTANT", false)).toBe(false);
    expect(gstApplies("CHANNEL_PARTNER", true)).toBe(true);
    expect(gstApplies("CHANNEL_PARTNER", false)).toBe(false);
  });
});

describe("computeGst (PLACEHOLDER rate, BLOCKED#11)", () => {
  it("defaults to the 18% PLACEHOLDER rate", () => {
    expect(GST_RATE_PCT_IF_REGISTERED.toString()).toBe("18");
    expect(computeGst(D("100000")).toString()).toBe("18000");
  });

  it("accepts an explicit rate override", () => {
    expect(computeGst(D("100000"), D("12.00")).toString()).toBe("12000");
  });
});
