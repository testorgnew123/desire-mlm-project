import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { resolveTdsSection, resolveEffectiveTdsRate, computeTds } from "../src/tds";

const D = (v: string | number) => new Decimal(v);

describe("resolveTdsSection (PLACEHOLDER mapping, BLOCKED#11)", () => {
  it("maps each engagement type to its docs/11-COMPLIANCE-INDIA.md section", () => {
    expect(resolveTdsSection("EMPLOYEE")).toBe("SEC_192");
    expect(resolveTdsSection("CONSULTANT")).toBe("SEC_194J");
    expect(resolveTdsSection("CHANNEL_PARTNER")).toBe("SEC_194H");
  });
});

describe("resolveEffectiveTdsRate: Sec. 206AA no-PAN higher rate", () => {
  it("uses the no-PAN rate when the row configures one and the deductee has no PAN", () => {
    const rate = resolveEffectiveTdsRate({ ratePct: D("10.00"), noPanRatePct: D("20.00") }, false);
    expect(rate.toString()).toBe("20");
  });

  it("uses the base rate when the deductee HAS a PAN on file, even if a no-PAN rate is configured", () => {
    const rate = resolveEffectiveTdsRate({ ratePct: D("10.00"), noPanRatePct: D("20.00") }, true);
    expect(rate.toString()).toBe("10");
  });

  it("falls back to the base rate when the row configures no no-PAN rate at all, regardless of PAN status", () => {
    const withoutPan = resolveEffectiveTdsRate({ ratePct: D("10.00"), noPanRatePct: null }, false);
    const withPan = resolveEffectiveTdsRate({ ratePct: D("10.00") }, true);
    expect(withoutPan.toString()).toBe("10");
    expect(withPan.toString()).toBe("10");
  });
});

describe("computeTds", () => {
  it("computes rate% of gross, rounded to 2 decimal places", () => {
    expect(computeTds(D("70000"), D("10.00")).toString()).toBe("7000");
    expect(computeTds(D("100000"), D("2.00")).toString()).toBe("2000");
  });

  it("rounds half-up at the paise boundary", () => {
    // 100 * 12.345 / 100 = 12.345 -> half-up rounds to 12.35, not 12.34.
    expect(computeTds(D("100"), D("12.345")).toString()).toBe("12.35");
  });
});
