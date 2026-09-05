// Golden-file cases from docs/04-COMMISSION-SPEC.md section 8, plus two cases
// (marked EXTENSION) covering the roll-up walk-up behaviour clarified during
// implementation -- see the comment block atop src/accrue.ts. If this file
// and the spec ever disagree, one of them is a bug: fix the doc or fix the
// code, don't leave them silently apart.
import { describe, expect, it } from "vitest";
import { accrue } from "../src/accrue";
import { CommissionSchemeMisconfiguredError } from "../src/errors";
import type { AccrualInput } from "../src/types";
import { D, makeOrg, makeScheme } from "./helpers";

const BOOKING_DATE = "2026-03-14";
const COMPUTED_AT = "2026-03-14T10:22:31.000Z";

function baseInput(overrides: Partial<AccrualInput> = {}): AccrualInput {
  return {
    bookingId: "booking_1",
    bookingDate: BOOKING_DATE,
    commissionableValue: D("10000000"),
    saleableAreaAtBooking: D("1200"),
    scheme: makeScheme(),
    seller: { associateId: "seller" },
    computedAt: COMPUTED_AT,
    ...overrides,
  };
}

describe("accrue -- self commission", () => {
  it("case 1: seller with no upline produces only a SELF entry", () => {
    const org = makeOrg([
      { associateId: "seller", code: "A-0001", gradeCode: "G4", gradeRank: 4, parentAssociateId: null },
    ]);

    const result = accrue(baseInput(), org);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.role).toBe("SELF");
    expect(result.entries[0]?.level).toBe(0);
    expect(result.entries[0]?.grossAmount.toString()).toBe("150000");
    expect(result.breakage.toString()).toBe("0");
  });

  it("case 4: seller at top of tree produces no overrides", () => {
    const org = makeOrg([
      { associateId: "seller", code: "A-0001", gradeCode: "G6", gradeRank: 6, parentAssociateId: null },
    ]);

    const result = accrue(baseInput({ scheme: makeScheme() }), org);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.role).toBe("SELF");
  });
});

describe("accrue -- level overrides", () => {
  const fullChainOrg = makeOrg([
    { associateId: "seller", code: "A-0001", gradeCode: "G4", gradeRank: 4, parentAssociateId: "l1" },
    { associateId: "l1", code: "A-0002", gradeCode: "G5", gradeRank: 5, parentAssociateId: "l2" },
    { associateId: "l2", code: "A-0003", gradeCode: "G5", gradeRank: 5, parentAssociateId: "l3" },
    { associateId: "l3", code: "A-0004", gradeCode: "G6", gradeRank: 6, parentAssociateId: null },
  ]);

  it("case 2: full 3-level chain produces four entries with the spec's worked amounts", () => {
    const result = accrue(baseInput(), fullChainOrg);

    expect(result.entries).toHaveLength(4);

    const [self, l1, l2, l3] = result.entries;
    expect(self?.role).toBe("SELF");
    expect(self?.grossAmount.toString()).toBe("150000");

    expect(l1?.beneficiaryAssociateId).toBe("l1");
    expect(l1?.level).toBe(1);
    expect(l1?.grossAmount.toString()).toBe("15000");

    expect(l2?.beneficiaryAssociateId).toBe("l2");
    expect(l2?.level).toBe(2);
    expect(l2?.grossAmount.toString()).toBe("7500");

    expect(l3?.beneficiaryAssociateId).toBe("l3");
    expect(l3?.level).toBe(3);
    expect(l3?.grossAmount.toString()).toBe("3000");

    const total = result.entries.reduce((s, e) => s.plus(e.grossAmount), D(0));
    expect(total.toString()).toBe("175500");
  });

  it("case 3: chain shorter than maxLevel produces no phantom entries", () => {
    const shortOrg = makeOrg([
      { associateId: "seller", code: "A-0001", gradeCode: "G4", gradeRank: 4, parentAssociateId: "l1" },
      { associateId: "l1", code: "A-0002", gradeCode: "G5", gradeRank: 5, parentAssociateId: null },
    ]);

    const result = accrue(baseInput(), shortOrg);

    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.level)).toEqual([0, 1]);
    expect(result.breakage.toString()).toBe("0");
  });

  it("case 9: PER_SQFT and FLAT self-rate types compute correctly", () => {
    const org = makeOrg([
      { associateId: "seller", code: "A-0001", gradeCode: "G4", gradeRank: 4, parentAssociateId: null },
    ]);

    const perSqft = accrue(
      baseInput({
        scheme: makeScheme({
          gradeRates: [{ gradeCode: "G4", rateType: "PER_SQFT", rateValue: D(50) }],
        }),
      }),
      org,
    );
    expect(perSqft.entries[0]?.grossAmount.toString()).toBe("60000");

    const flat = accrue(
      baseInput({
        scheme: makeScheme({
          gradeRates: [{ gradeCode: "G4", rateType: "FLAT", rateValue: D(75000) }],
        }),
      }),
      org,
    );
    expect(flat.entries[0]?.grossAmount.toString()).toBe("75000");
  });

  it("case 10: extreme commissionable values still resolve correctly", () => {
    const org = makeOrg([
      { associateId: "seller", code: "A-0001", gradeCode: "G4", gradeRank: 4, parentAssociateId: null },
    ]);

    const tiny = accrue(baseInput({ commissionableValue: D("1") }), org);
    expect(tiny.entries[0]?.grossAmount.toString()).toBe("0.02");

    const huge = accrue(baseInput({ commissionableValue: D("500000000") }), org);
    expect(huge.entries[0]?.grossAmount.toString()).toBe("7500000");
  });

  it("case 11: rounding is half-up at 2dp and entries still sum correctly", () => {
    const org = makeOrg([
      { associateId: "seller", code: "A-0001", gradeCode: "G4", gradeRank: 4, parentAssociateId: null },
    ]);

    const result = accrue(baseInput({ commissionableValue: D("333.35") }), org);

    expect(result.entries[0]?.grossAmount.toString()).toBe("5");
  });
});

describe("accrue -- compression", () => {
  const threeLevelOrg = (l1Status: string) =>
    makeOrg([
      { associateId: "seller", code: "A-0001", gradeCode: "G4", gradeRank: 4, parentAssociateId: "l1" },
      { associateId: "l1", code: "A-0002", gradeCode: "G5", gradeRank: 5, status: l1Status, parentAssociateId: "l2" },
      { associateId: "l2", code: "A-0003", gradeCode: "G6", gradeRank: 6, parentAssociateId: null },
    ]);

  it("case 5: ineligible L1 under NONE consumes the level as breakage; L2 unaffected", () => {
    const result = accrue(baseInput(), threeLevelOrg("SUSPENDED"));

    const beneficiaries = result.entries.map((e) => e.beneficiaryAssociateId);
    expect(beneficiaries).not.toContain("l1");
    expect(beneficiaries).toContain("l2");

    const l2Entry = result.entries.find((e) => e.beneficiaryAssociateId === "l2");
    expect(l2Entry?.level).toBe(2);
    expect(l2Entry?.grossAmount.toString()).toBe("7500");

    expect(result.breakage.toString()).toBe("15000");
  });

  it("case 6: ineligible L1 under ROLL_UP passes the level-1 percentage to L2", () => {
    const result = accrue(
      baseInput({ scheme: makeScheme({ compressionMode: "ROLL_UP" }) }),
      threeLevelOrg("SUSPENDED"),
    );

    expect(result.breakage.toString()).toBe("0");

    const l2Entries = result.entries.filter((e) => e.beneficiaryAssociateId === "l2");
    expect(l2Entries).toHaveLength(2);

    const rolledUp = l2Entries.find((e) => e.level === 1);
    expect(rolledUp?.grossAmount.toString()).toBe("15000");

    const own = l2Entries.find((e) => e.level === 2);
    expect(own?.grossAmount.toString()).toBe("7500");
  });

  it("EXTENSION: ROLL_UP with every upline ineligible becomes breakage after all", () => {
    const org = makeOrg([
      { associateId: "seller", code: "A-0001", gradeCode: "G4", gradeRank: 4, parentAssociateId: "l1" },
      { associateId: "l1", code: "A-0002", gradeCode: "G5", gradeRank: 5, status: "SUSPENDED", parentAssociateId: null },
    ]);

    const result = accrue(
      baseInput({ scheme: makeScheme({ compressionMode: "ROLL_UP", maxLevel: 1 }) }),
      org,
    );

    expect(result.entries).toHaveLength(1);
    expect(result.breakage.toString()).toBe("15000");
  });

  it("EXTENSION: a level rate of exactly zero is skipped without creating an entry", () => {
    const org = makeOrg([
      { associateId: "seller", code: "A-0001", gradeCode: "G4", gradeRank: 4, parentAssociateId: "l1" },
      { associateId: "l1", code: "A-0002", gradeCode: "G5", gradeRank: 5, parentAssociateId: null },
    ]);

    const result = accrue(
      baseInput({
        scheme: makeScheme({ levelRates: [{ level: 1, pctOfSellerCommission: D(0) }] }),
      }),
      org,
    );

    expect(result.entries).toHaveLength(1);
    expect(result.breakage.toString()).toBe("0");
  });

  it("EXTENSION: minGradeRank eligibility rule excludes an under-ranked upline", () => {
    const org = makeOrg([
      { associateId: "seller", code: "A-0001", gradeCode: "G4", gradeRank: 4, parentAssociateId: "l1" },
      { associateId: "l1", code: "A-0002", gradeCode: "G2", gradeRank: 2, parentAssociateId: null },
    ]);

    const result = accrue(
      baseInput({ scheme: makeScheme({ eligibilityRules: { minGradeRank: 3 } }) }),
      org,
    );

    expect(result.entries).toHaveLength(1);
    expect(result.breakage.toString()).toBe("15000");
  });
});

describe("accrue -- effective dating", () => {
  it("case 7: a grade change after the booking date does not affect this booking", () => {
    const org = makeOrg([
      {
        associateId: "seller",
        code: "A-0001",
        gradeCode: "G4",
        gradeRank: 4,
        gradeValidFrom: "2020-01-01",
        gradeValidTo: "2026-06-01",
        parentAssociateId: null,
      },
    ]);
    org.gradeHistory.get("seller")!.push({
      gradeCode: "G6",
      gradeRank: 6,
      validFrom: "2026-06-01",
      validTo: null,
    });

    const result = accrue(baseInput(), org);

    expect(result.entries[0]?.snapshot.gradeCode).toBe("G4");
    expect(result.entries[0]?.grossAmount.toString()).toBe("150000");
  });

  it("case 8: the scheme version passed in is the one reflected in the output", () => {
    const org = makeOrg([
      { associateId: "seller", code: "A-0001", gradeCode: "G4", gradeRank: 4, parentAssociateId: null },
    ]);

    const v1Result = accrue(baseInput({ scheme: makeScheme({ schemeVersion: 1 }) }), org);
    const v2Result = accrue(
      baseInput({
        scheme: makeScheme({
          schemeVersion: 2,
          gradeRates: [{ gradeCode: "G4", rateType: "PCT_OF_BASE", rateValue: D(2.0) }],
        }),
      }),
      org,
    );

    expect(v1Result.entries[0]?.snapshot.schemeVersion).toBe(1);
    expect(v1Result.entries[0]?.grossAmount.toString()).toBe("150000");
    expect(v2Result.entries[0]?.snapshot.schemeVersion).toBe(2);
    expect(v2Result.entries[0]?.grossAmount.toString()).toBe("200000");
  });
});

describe("accrue -- guardrails", () => {
  it("case 12: a scheme exceeding maxTotalPct refuses to accrue -- nothing is returned", () => {
    const org = makeOrg([
      { associateId: "seller", code: "A-0001", gradeCode: "G4", gradeRank: 4, parentAssociateId: "l1" },
      { associateId: "l1", code: "A-0002", gradeCode: "G5", gradeRank: 5, parentAssociateId: null },
    ]);

    const misconfigured = makeScheme({ maxTotalPct: D(1.0) });

    expect(() => accrue(baseInput({ scheme: misconfigured }), org)).toThrow(
      CommissionSchemeMisconfiguredError,
    );
  });

  it("throws when the seller has no grade assignment in force on the booking date", () => {
    const org = makeOrg([]);

    expect(() => accrue(baseInput(), org)).toThrow(CommissionSchemeMisconfiguredError);
  });

  it("throws when the scheme has no rate configured for the seller's grade", () => {
    const org = makeOrg([
      { associateId: "seller", code: "A-0001", gradeCode: "G1", gradeRank: 1, parentAssociateId: null },
    ]);

    expect(() => accrue(baseInput({ scheme: makeScheme() }), org)).toThrow(
      CommissionSchemeMisconfiguredError,
    );
  });
});
