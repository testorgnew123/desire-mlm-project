// THE test that matters most (docs/04-COMMISSION-SPEC.md section 8, ADR-0003).
// If this ever fails, stop everything else and fix it before touching
// anything downstream of the commission engine.
//
// Accrue a historical booking, then mutate the CURRENT tree and CURRENT
// grades, then re-run the SAME historical accrual. The output must be
// byte-identical, because a promotion or a tree move today must never change
// what a March sale paid.
import { describe, expect, it } from "vitest";
import { accrue } from "../src/accrue";
import { D, cloneOrg, makeOrg, makeScheme } from "./helpers";
import type { AccrualInput } from "../src/types";

const BOOKING_DATE = "2026-03-14";
const COMPUTED_AT = "2026-03-14T10:22:31.000Z"; // fixed on both runs -- see types.ts AccrualInput

describe("reproducibility", () => {
  it("mutating the current tree and grades does not change a historical accrual", () => {
    const originalOrg = makeOrg([
      { associateId: "seller", code: "A-0001", gradeCode: "G4", gradeRank: 4, parentAssociateId: "l1" },
      { associateId: "l1", code: "A-0002", gradeCode: "G5", gradeRank: 5, parentAssociateId: "l2" },
      { associateId: "l2", code: "A-0003", gradeCode: "G6", gradeRank: 6, parentAssociateId: null },
    ]);

    const input: AccrualInput = {
      bookingId: "booking_repro",
      bookingDate: BOOKING_DATE,
      commissionableValue: D("10000000"),
      saleableAreaAtBooking: D("1200"),
      scheme: makeScheme(),
      seller: { associateId: "seller" },
      computedAt: COMPUTED_AT,
    };

    const before = accrue(input, originalOrg);

    // Mutate a CLONE -- append-only, exactly as the real system does: close
    // the old record's validTo and add a new one. The old record stays.
    const mutatedOrg = cloneOrg(originalOrg);

    // 1. Move the seller under a different manager, effective AFTER the booking.
    const sellerHierarchy = mutatedOrg.hierarchyHistory.get("seller")!;
    sellerHierarchy[0]!.validTo = "2026-08-01";
    sellerHierarchy.push({
      parentAssociateId: "l1", // reassigned to a different (hypothetical) manager id in reality;
                                 // using the same id here still proves the point: the OLD row,
                                 // not this new one, is what a March date must resolve to.
      validFrom: "2026-08-01",
      validTo: null,
    });

    // 2. Promote the seller two grades, effective AFTER the booking.
    const sellerGrades = mutatedOrg.gradeHistory.get("seller")!;
    sellerGrades[0]!.validTo = "2026-09-01";
    sellerGrades.push({
      gradeCode: "G6",
      gradeRank: 6,
      validFrom: "2026-09-01",
      validTo: null,
    });

    // 3. Move L1 under a new manager and promote them too -- proving the
    //    guarantee holds for the WHOLE chain, not just the seller.
    const l1Hierarchy = mutatedOrg.hierarchyHistory.get("l1")!;
    l1Hierarchy[0]!.validTo = "2026-08-01";
    l1Hierarchy.push({ parentAssociateId: null, validFrom: "2026-08-01", validTo: null });

    const l1Grades = mutatedOrg.gradeHistory.get("l1")!;
    l1Grades[0]!.validTo = "2026-09-01";
    l1Grades.push({ gradeCode: "G6", gradeRank: 6, validFrom: "2026-09-01", validTo: null });

    // Re-run the SAME historical accrual against the mutated (now longer)
    // history, with the SAME booking date and the SAME computedAt.
    const after = accrue(input, mutatedOrg);

    expect(serialize(after)).toEqual(serialize(before));
  });

  it("sanity check: the mutation actually would change a CURRENT-dated accrual", () => {
    // This is the negative control for the test above. If mutating the org
    // had no effect on ANY accrual, the reproducibility test would be
    // vacuous -- it could pass even if bookingDate resolution were silently
    // broken and everything just used "current" data by accident. This
    // proves the mutation is real and the resolver is date-sensitive.
    const originalOrg = makeOrg([
      { associateId: "seller", code: "A-0001", gradeCode: "G4", gradeRank: 4, parentAssociateId: null },
    ]);
    const mutatedOrg = cloneOrg(originalOrg);
    const sellerGrades = mutatedOrg.gradeHistory.get("seller")!;
    sellerGrades[0]!.validTo = "2026-01-01";
    sellerGrades.push({ gradeCode: "G6", gradeRank: 6, validFrom: "2026-01-01", validTo: null });

    const currentDatedInput: AccrualInput = {
      bookingId: "booking_current",
      bookingDate: "2026-06-01", // AFTER the mutation takes effect
      commissionableValue: D("10000000"),
      saleableAreaAtBooking: D("1200"),
      scheme: makeScheme(),
      seller: { associateId: "seller" },
      computedAt: COMPUTED_AT,
    };

    const before = accrue(currentDatedInput, originalOrg);
    const after = accrue(currentDatedInput, mutatedOrg);

    expect(before.entries[0]?.grossAmount.toString()).toBe("150000"); // G4 rate
    expect(after.entries[0]?.grossAmount.toString()).toBe("250000"); // G6 rate -- genuinely different
    expect(serialize(after)).not.toEqual(serialize(before));
  });
});

// Decimal instances compare by reference under toEqual, not by value -- this
// normalises every Decimal to its string form so the comparison is on the
// actual numbers, matching how the real system would serialize a
// CommissionEntry to JSON before persisting it.
function serialize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v) =>
      v && typeof v === "object" && "toFixed" in v ? v.toString() : v,
    ),
  );
}
