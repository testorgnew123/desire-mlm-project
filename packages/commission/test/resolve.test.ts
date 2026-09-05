// gradeAsOf and uplineChainAsOf are exercised indirectly through nearly every
// accrue.test.ts case, but this file targets their edge behaviour directly so
// coverage does not depend on accrue.ts happening to exercise every branch.
import { describe, expect, it } from "vitest";
import { gradeAsOf, uplineChainAsOf } from "../src/resolve";
import { makeOrg } from "./helpers";

describe("gradeAsOf", () => {
  it("returns undefined when the associate has no grade history at all", () => {
    expect(gradeAsOf([], "2026-03-14")).toBeUndefined();
  });

  it("returns undefined when the date falls before the earliest record", () => {
    const history = [{ gradeCode: "G4", gradeRank: 4, validFrom: "2026-01-01", validTo: null }];
    expect(gradeAsOf(history, "2025-12-31")).toBeUndefined();
  });

  it("returns undefined when the date falls exactly on a closed record's validTo", () => {
    // validTo is exclusive -- the record is no longer in force ON that date.
    const history = [{ gradeCode: "G4", gradeRank: 4, validFrom: "2026-01-01", validTo: "2026-06-01" }];
    expect(gradeAsOf(history, "2026-06-01")).toBeUndefined();
  });
});

describe("uplineChainAsOf", () => {
  it("returns an empty chain when the seller has no hierarchy record", () => {
    const org = makeOrg([]);
    expect(uplineChainAsOf("seller", "2026-03-14", 3, org)).toEqual([]);
  });

  it("stops (does not fabricate a node) when a parent's grade cannot be resolved", () => {
    // l1 exists in the hierarchy but has no grade history -- a data gap.
    const org = makeOrg([
      { associateId: "seller", code: "A-0001", gradeCode: "G4", gradeRank: 4, parentAssociateId: "l1" },
    ]);
    // Deliberately corrupt: remove l1's grade history that makeOrg would
    // otherwise have created for it, simulating a genuine data gap.
    org.gradeHistory.delete("l1");
    org.associates.set("l1", { associateId: "l1", code: "A-0002", status: "ACTIVE" });
    org.hierarchyHistory.set("l1", [{ parentAssociateId: null, validFrom: "2020-01-01", validTo: null }]);

    expect(uplineChainAsOf("seller", "2026-03-14", 3, org)).toEqual([]);
  });

  it("respects maxLevel even when the real chain is longer", () => {
    const org = makeOrg([
      { associateId: "seller", code: "A-0001", gradeCode: "G4", gradeRank: 4, parentAssociateId: "l1" },
      { associateId: "l1", code: "A-0002", gradeCode: "G5", gradeRank: 5, parentAssociateId: "l2" },
      { associateId: "l2", code: "A-0003", gradeCode: "G6", gradeRank: 6, parentAssociateId: null },
    ]);

    const chain = uplineChainAsOf("seller", "2026-03-14", 1, org);
    expect(chain).toHaveLength(1);
    expect(chain[0]?.associateId).toBe("l1");
  });
});
