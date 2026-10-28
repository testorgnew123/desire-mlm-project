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
/** The original PLC shape: rupees per unit of area. */
const perArea = (v: string | number) => ({ basis: "PER_AREA" as const, value: D(v) });

const HEADS: ChargeHeadSpec[] = [
  { code: "BSP", name: "Basic Sale Price", category: "BASE_PRICE", countsTowardCommission: true, displayOrder: 1 },
  { code: "PLC", name: "Preferential Location Charge", category: "PLC", countsTowardCommission: true, displayOrder: 2 },
  { code: "PARKING", name: "Car Parking", category: "PARKING", countsTowardCommission: false, displayOrder: 3 },
  { code: "CLUB", name: "Club Membership", category: "CLUB_MEMBERSHIP", countsTowardCommission: false, displayOrder: 4 },
  { code: "IFMS", name: "Interest-Free Maintenance Security", category: "IFMS", countsTowardCommission: false, displayOrder: 5 },
  { code: "STAMP", name: "Stamp Duty", category: "STAMP_DUTY", countsTowardCommission: false, displayOrder: 6 },
  { code: "REG", name: "Registration", category: "REGISTRATION", countsTowardCommission: false, displayOrder: 7 },
];

function baseInput(overrides: Partial<CostSheetInput> = {}): CostSheetInput {
  return {
    saleableArea: D(1000),
    carpetArea: D(650),
    baseRate: D(5000),
    plcTags: ["CORNER", "PARK_FACING"],
    plcChargesByTag: { CORNER: perArea(150), PARK_FACING: perArea(200) },
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

  // gross = 5,000,000 + 350,000 + 450,000 - 100,000 = 5,700,000
  // agreementValue = gross + stamp + registration
  //                = 5,700,000 + 350,000 + 30,000 = 6,080,000
  it("agreementValue = gross + stampDuty + registration", () => {
    expect(r.agreementValue.toString()).toBe("6080000");
  });

  // Only heads flagged countsTowardCommission: BSP + both PLC lines.
  // 5,000,000 + 150,000 + 200,000 = 5,350,000
  it("commissionableValue counts only flagged heads", () => {
    expect(r.commissionableValue.toString()).toBe("5350000");
  });

  it("commissionableValue is less than the agreement value", () => {
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
        baseRate: D("3333.33"),
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
    // Nothing else on the sheet, so the agreement value is the base price.
    expect(r.agreementValue.toString()).toBe("5000000");
    expect(r.commissionableValue.toString()).toBe("5000000");
  });
});

// ── Plotted land ───────────────────────────────────────────────────────
//
// A plot has no carpet area and its corner premium is quoted as a PERCENTAGE
// of the land rate, not as rupees per square yard -- the DLC tables the rate
// comes from are themselves written that way (client, 2026-10-13). Every
// expected figure below is hand-computed, same rule as the block above.

/** The plotted-land shape: a percentage of the base price. */
const pctOfBase = (v: string | number) => ({ basis: "PCT_OF_BASE" as const, value: D(v) });

/** 200 sq yd at Rs 25,000/sq yd. No carpet, no built-up: it is land. */
function plotInput(overrides: Partial<CostSheetInput> = {}): CostSheetInput {
  return {
    saleableArea: D(200),
    carpetArea: null,
    baseRate: D(25_000),
    plcTags: ["CORNER"],
    plcChargesByTag: { CORNER: pctOfBase(10) },
    otherCharges: [],
    discount: D(0),
    chargeHeads: HEADS,
    ...overrides,
  };
}

describe("a corner plot priced as a percentage uplift", () => {
  const r = computeCostSheet(plotInput());

  // Before Stage 2 this threw: the engine required carpetArea > 0 and
  // rejected anything exceeding saleable. Land has no carpet at all, so a
  // plot could not be quoted by this system in any way.
  it("prices a unit with no carpet area at all", () => {
    expect(r.carpetArea).toBeNull();
    expect(r.baseAmount.toString()).toBe("5000000");
  });

  // 10% of 5,000,000
  it("the corner uplift is a percentage of the BASE, not of gross", () => {
    expect(r.plcAmount.toString()).toBe("500000");
  });

  // The whole point of "of base, not of gross": adding another charge must
  // not change what the corner premium costs. Gross would compound, and the
  // result would depend on the order the tags happened to be evaluated in.
  it("another charge does not change the corner uplift", () => {
    const withParking = computeCostSheet(
      plotInput({ otherCharges: [{ chargeHeadCode: "PARKING", amount: D(300_000) }] }),
    );
    expect(withParking.plcAmount.toString()).toBe("500000");
  });

  // gross = 5,000,000 + 500,000 = 5,500,000
  it("agreementValue = gross", () => {
    expect(r.agreementValue.toString()).toBe("5500000");
  });

  it("the uplift is commissionable, exactly as a per-area PLC line is", () => {
    expect(r.commissionableValue.toString()).toBe("5500000");
  });

  // A buyer reading the sheet sees WHY the number is what it is. A bare "10"
  // in the rate column beside an area quantity reads as Rs 10 per sq yd,
  // which is the misreading this avoids.
  it("the line says it is a percentage, and leaves quantity x rate empty", () => {
    const line = r.lines.find((l) => l.chargeHeadCode === "PLC");
    expect(line?.description).toBe("Preferential Location Charge - CORNER (10% of base)");
    expect(line?.quantity).toBeNull();
    expect(line?.rate).toBeNull();
  });

  it("header still reconciles to the printed lines", () => {
    const summed = r.lines
      .filter((l) => !["DISCOUNT", "STAMP", "REG"].includes(l.chargeHeadCode))
      .reduce((s, l) => s.plus(l.amount), D(0));
    expect(summed.toString()).toBe(r.baseAmount.plus(r.plcAmount).toString());
  });
});

describe("percentage and per-area charges on the same sheet", () => {
  // base          = 200 x 25,000      = 5,000,000
  // CORNER        = 10% of base       =   500,000
  // PARK_FACING   = 200 sq yd x Rs 50 =    10,000
  //                                     ---------
  // plcAmount                           =  510,000
  it("each tag is computed on its own basis", () => {
    const r = computeCostSheet(
      plotInput({
        plcTags: ["CORNER", "PARK_FACING"],
        plcChargesByTag: { CORNER: pctOfBase(10), PARK_FACING: perArea(50) },
      }),
    );
    expect(r.plcAmount.toString()).toBe("510000");
    const amounts = r.lines
      .filter((l) => l.chargeHeadCode === "PLC")
      .map((l) => l.amount.toString())
      .sort();
    expect(amounts).toEqual(["10000", "500000"]);
  });

  // 250 x 2000.30 = 500,075.00 base; 2.1% = 10,501.575, which must round HALF
  // UP to 10,501.58. Rounded down it is a paisa short and the header stops
  // reconciling with the printed line.
  it("rounds a fractional percentage half up, to the paisa", () => {
    const r = computeCostSheet(
      plotInput({
        saleableArea: D("250"),
        baseRate: D("2000.30"),
        plcChargesByTag: { CORNER: pctOfBase("2.1") },
      }),
    );
    expect(r.baseAmount.toString()).toBe("500075");
    expect(r.plcAmount.toString()).toBe("10501.58");
  });

  it("still refuses a tag with no charge configured, percentage or not", () => {
    expect(() =>
      computeCostSheet(plotInput({ plcTags: ["CORNER", "EAST_FACING"] })),
    ).toThrow(UnpricedPlcTagError);
  });
});

describe("an agreed price replaces the price list's", () => {
  it("is the base amount and the whole agreement value, with no corner premium on top", () => {
    const r = computeCostSheet(plotInput({ priceOverride: D("4800000") }));
    expect(r.baseAmount.toString()).toBe("4800000");
    expect(r.plcAmount.toString()).toBe("0");
    expect(r.otherChargesAmount.toString()).toBe("0");
    expect(r.agreementValue.toString()).toBe("4800000");
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ chargeHeadCode: "BSP", description: "Agreed price" });
    expect(r.lines[0]!.quantity).toBeNull();
  });

  it("drops the fixed charges and stamp duty the list would have added", () => {
    const r = computeCostSheet(
      plotInput({
        priceOverride: D("4800000"),
        otherCharges: [
          { chargeHeadCode: "PARKING", amount: D(300_000) },
          { chargeHeadCode: "STAMP", amount: D(350_000) },
        ],
      }),
    );
    expect(r.agreementValue.toString()).toBe("4800000");
    expect(r.stampDutyAmount.toString()).toBe("0");
  });

  it("stays commissionable as the BSP head says, and is rounded to the paisa", () => {
    const r = computeCostSheet(plotInput({ priceOverride: D("4800000.456") }));
    expect(r.agreementValue.toString()).toBe("4800000.46");
    expect(r.commissionableValue.toString()).toBe("4800000.46");
  });

  it("null or omitted prices from the list as before", () => {
    expect(computeCostSheet(plotInput({ priceOverride: null })).agreementValue.toString()).toBe("5500000");
    expect(computeCostSheet(plotInput()).agreementValue.toString()).toBe("5500000");
  });

  it.each(["0", "-5", "100000000001"])("refuses the price %s", (price) => {
    expect(() => computeCostSheet(plotInput({ priceOverride: D(price) }))).toThrow(CostSheetInputError);
  });

  it("refuses a discount on top of an agreed price", () => {
    expect(() => computeCostSheet(plotInput({ priceOverride: D("4800000"), discount: D(1000) }))).toThrow(
      /discount cannot be combined/,
    );
  });
});
