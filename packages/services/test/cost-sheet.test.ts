// Cost sheet math. Every expected number below is computed BY HAND from the
// formula in docs/06-INVENTORY-SPEC.md section 5 -- not read off the
// implementation. If these disagree, one of the two is wrong and it needs
// deciding, which is the whole point.
//
// This is the highest silent-corruption risk in Phase 1: a wrong cost sheet
// produces a plausible number that flows into agreementValue and
// commissionableValue, and from there into what an associate is paid.
import { describe, expect, it } from "vitest";
import { Prisma } from "@desire/db";
import {
  ChargeHeadMisconfiguredError,
  ChargeHeadNotConfiguredError,
  CostSheetInputError,
  UnpricedPlcTagError,
  computeCostSheet,
  type ChargeHeadSpec,
  type CostSheetInput,
} from "../src/cost-sheet";

const D = (v: string | number) => new Prisma.Decimal(v);

const HEADS: ChargeHeadSpec[] = [
  { code: "BSP", name: "Basic Sale Price", category: "BASE_PRICE", isTaxable: true, gstRatePct: D(5), countsTowardCommission: true, displayOrder: 1 },
  { code: "PLC", name: "Preferential Location Charge", category: "PLC", isTaxable: true, gstRatePct: D(5), countsTowardCommission: true, displayOrder: 2 },
  { code: "PARKING", name: "Car Parking", category: "PARKING", isTaxable: true, gstRatePct: D(5), countsTowardCommission: false, displayOrder: 3 },
  { code: "CLUB", name: "Club Membership", category: "CLUB_MEMBERSHIP", isTaxable: true, gstRatePct: D(18), countsTowardCommission: false, displayOrder: 4 },
  { code: "IFMS", name: "Interest-Free Maintenance Security", category: "IFMS", isTaxable: false, gstRatePct: null, countsTowardCommission: false, displayOrder: 5 },
  { code: "STAMP", name: "Stamp Duty", category: "STAMP_DUTY", isTaxable: false, gstRatePct: null, countsTowardCommission: false, displayOrder: 6 },
  { code: "REG", name: "Registration", category: "REGISTRATION", isTaxable: false, gstRatePct: null, countsTowardCommission: false, displayOrder: 7 },
];

function baseInput(overrides: Partial<CostSheetInput> = {}): CostSheetInput {
  return {
    saleableArea: D(1000),
    carpetArea: D(650),
    baseRatePerSqft: D(5000),
    plcTags: ["CORNER", "PARK_FACING"],
    plcChargesByTag: { CORNER: D(150), PARK_FACING: D(200) },
    otherCharges: [
      { chargeHeadCode: "PARKING", amount: D(300_000) },
      { chargeHeadCode: "CLUB", amount: D(100_000) },
      { chargeHeadCode: "IFMS", amount: D(50_000) },
      { chargeHeadCode: "STAMP", amount: D(350_000) },
      { chargeHeadCode: "REG", amount: D(30_000) },
    ],
    discount: D(100_000),
    chargeHeads: HEADS,
    ...overrides,
  };
}

describe("computeCostSheet -- fully worked example, hand-computed from the spec", () => {
  const r = computeCostSheet(baseInput());

  // baseAmount = saleableArea x rate = 1000 x 5000
  it("base = saleable area x rate (NEVER carpet area)", () => {
    expect(r.baseAmount.toString()).toBe("5000000");
  });

  // CORNER 1000x150 = 150,000; PARK_FACING 1000x200 = 200,000
  it("PLC is one line per tag, summing to 350,000", () => {
    expect(r.plcAmount.toString()).toBe("350000");
    const plcLines = r.lines.filter((l) => l.chargeHeadCode === "PLC");
    expect(plcLines).toHaveLength(2);
    expect(plcLines.map((l) => l.amount.toString()).sort()).toEqual(["150000", "200000"]);
  });

  // PARKING 300k + CLUB 100k + IFMS 50k. Stamp duty and registration are
  // reported separately -- they sit OUTSIDE gross in the spec formula.
  it("otherCharges excludes stamp duty and registration", () => {
    expect(r.otherChargesAmount.toString()).toBe("450000");
    expect(r.stampDutyAmount.toString()).toBe("350000");
    expect(r.registrationAmount.toString()).toBe("30000");
  });

  // BSP 5,000,000 x 5%   = 250,000
  // PLC   150,000 x 5%   =   7,500
  // PLC   200,000 x 5%   =  10,000
  // PARK  300,000 x 5%   =  15,000
  // CLUB  100,000 x 18%  =  18,000
  // IFMS / STAMP / REG   =       0 (not taxable)
  //                        -------
  //                        300,500
  it("GST sums per taxable line at that line's own rate", () => {
    expect(r.gstAmount.toString()).toBe("300500");
  });

  // gross = 5,000,000 + 350,000 + 450,000 - 100,000 = 5,700,000
  // agreementValue = gross + gst + stamp + registration
  //                = 5,700,000 + 300,500 + 350,000 + 30,000 = 6,380,500
  it("agreementValue = gross + gst + stampDuty + registration", () => {
    expect(r.agreementValue.toString()).toBe("6380500");
  });

  // Only heads flagged countsTowardCommission: BSP + both PLC lines.
  // 5,000,000 + 150,000 + 200,000 = 5,350,000
  it("commissionableValue counts only flagged heads", () => {
    expect(r.commissionableValue.toString()).toBe("5350000");
  });

  it("commissionableValue EXCLUDES gst entirely", () => {
    // The whole GST take is 300,500. If any of it leaked into the
    // commissionable base, this equality would break.
    expect(r.commissionableValue.plus(r.gstAmount).toString()).toBe("5650500");
    expect(r.commissionableValue.lessThan(r.agreementValue)).toBe(true);
  });

  it("commissionableValue excludes refundable IFMS", () => {
    const ifmsLine = r.lines.find((l) => l.chargeHeadCode === "IFMS");
    expect(ifmsLine?.countsTowardCommission).toBe(false);
  });

  it("the discount appears as a negative line the customer can see", () => {
    const discountLine = r.lines.find((l) => l.chargeHeadCode === "DISCOUNT");
    expect(discountLine?.amount.toString()).toBe("-100000");
    expect(discountLine?.countsTowardCommission).toBe(false);
  });

  it("line amounts reconcile with the header totals", () => {
    // Every non-discount, non-stamp, non-registration line should sum to
    // base + plc + otherCharges. This is what the customer adds up by hand.
    const summed = r.lines
      .filter((l) => !["DISCOUNT", "STAMP", "REG"].includes(l.chargeHeadCode))
      .reduce((s, l) => s.plus(l.amount), D(0));
    expect(summed.toString()).toBe(
      r.baseAmount.plus(r.plcAmount).plus(r.otherChargesAmount).toString(),
    );
  });
});

describe("the mistakes that cost real money", () => {
  it("carpet area is never substituted for saleable area", () => {
    // If the implementation ever used carpetArea for the base, this would be
    // 650 x 5000 = 3,250,000 instead. That single confusion misprices a unit
    // by ~35% (docs/19-GLOSSARY.md).
    const r = computeCostSheet(baseInput({ carpetArea: D(650), saleableArea: D(1000) }));
    expect(r.baseAmount.toString()).toBe("5000000");
    expect(r.baseAmount.toString()).not.toBe("3250000");
  });

  it("refuses a fixed charge in a category the sheet computes itself", () => {
    // Passing BSP or PLC as a fixed charge would double-count it.
    expect(() =>
      computeCostSheet(
        baseInput({ otherCharges: [{ chargeHeadCode: "BSP", amount: D(1) }] }),
      ),
    ).toThrow(ChargeHeadMisconfiguredError);
  });

  it("refuses a charge head that is not in the catalogue", () => {
    expect(() =>
      computeCostSheet(
        baseInput({ otherCharges: [{ chargeHeadCode: "MYSTERY", amount: D(1) }] }),
      ),
    ).toThrow(ChargeHeadNotConfiguredError);
  });

  it("refuses a PLC tag with no configured rate rather than silently pricing it at zero", () => {
    expect(() =>
      computeCostSheet(baseInput({ plcTags: ["CORNER", "SEA_FACING"] })),
    ).toThrow(UnpricedPlcTagError);
  });

  it("refuses a negative discount (which would silently INCREASE the price)", () => {
    expect(() => computeCostSheet(baseInput({ discount: D(-50_000) }))).toThrow(
      CostSheetInputError,
    );
  });
});

describe("edge cases", () => {
  it("handles a unit with no PLC tags", () => {
    const r = computeCostSheet(baseInput({ plcTags: [], plcChargesByTag: {} }));
    expect(r.plcAmount.toString()).toBe("0");
    expect(r.lines.some((l) => l.chargeHeadCode === "PLC")).toBe(false);
  });

  it("handles a zero discount without emitting a discount line", () => {
    const r = computeCostSheet(baseInput({ discount: D(0) }));
    expect(r.discountAmount.toString()).toBe("0");
    expect(r.lines.some((l) => l.chargeHeadCode === "DISCOUNT")).toBe(false);
  });

  it("rounds half-up at 2dp, and the rounded lines still reconcile", () => {
    // 1000.005 x 3333.33 -> a third decimal that must round half-up.
    const r = computeCostSheet(
      baseInput({
        saleableArea: D("1000.005"),
        baseRatePerSqft: D("3333.33"),
        plcTags: [],
        plcChargesByTag: {},
        otherCharges: [],
        discount: D(0),
      }),
    );
    // 1000.005 x 3333.33 = 3333346.66665 -> 3333346.67
    expect(r.baseAmount.toString()).toBe("3333346.67");
    const baseLine = r.lines.find((l) => l.chargeHeadCode === "BSP");
    expect(baseLine?.amount.toString()).toBe(r.baseAmount.toString());
  });

  it("a sheet with only a base price still produces a coherent agreement value", () => {
    const r = computeCostSheet(
      baseInput({ plcTags: [], plcChargesByTag: {}, otherCharges: [], discount: D(0) }),
    );
    // 5,000,000 + 5% GST = 5,250,000
    expect(r.agreementValue.toString()).toBe("5250000");
    expect(r.commissionableValue.toString()).toBe("5000000");
  });
});
