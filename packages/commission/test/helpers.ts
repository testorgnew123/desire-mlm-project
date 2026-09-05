// Fixture builders shared across the golden-file suite. Kept here rather than
// duplicated per test so every scenario starts from the same, obviously
// correct baseline and only varies what the test is actually about.
import Decimal from "decimal.js";
import type {
  AssociateSnapshot,
  GradeAssignmentRecord,
  GradeRate,
  HierarchyAssignmentRecord,
  LevelRate,
  OrgSnapshot,
  SchemeConfig,
} from "../src/types";

export const D = (v: number | string): Decimal => new Decimal(v);

// PLACEHOLDER rates throughout -- see docs/04-COMMISSION-SPEC.md worked example
// and plan.md Open Items 4-5. Only the numbers are unconfirmed; the structure
// and the test cases exercising it do not change when real figures arrive.
export function makeScheme(overrides: Partial<SchemeConfig> = {}): SchemeConfig {
  const gradeRates: GradeRate[] = [
    { gradeCode: "G4", rateType: "PCT_OF_BASE", rateValue: D(1.5) }, // Manager
    { gradeCode: "G5", rateType: "PCT_OF_BASE", rateValue: D(2.0) }, // Senior Manager
    { gradeCode: "G6", rateType: "PCT_OF_BASE", rateValue: D(2.5) }, // VP
  ];
  const levelRates: LevelRate[] = [
    { level: 1, pctOfSellerCommission: D(10) },
    { level: 2, pctOfSellerCommission: D(5) },
    { level: 3, pctOfSellerCommission: D(2) },
  ];
  return {
    schemeId: "scheme_v1",
    schemeVersion: 1,
    maxLevel: 3,
    compressionMode: "NONE",
    maxTotalPct: D(3.0),
    gradeRates,
    levelRates,
    ...overrides,
  };
}

export interface OrgBuilderAssociate {
  associateId: string;
  code: string;
  status?: string;
  gradeCode: string;
  gradeRank: number;
  gradeValidFrom?: string;
  gradeValidTo?: string | null;
  parentAssociateId: string | null;
  hierarchyValidFrom?: string;
  hierarchyValidTo?: string | null;
}

/** Builds an OrgSnapshot from a flat list -- each entry becomes exactly one
 *  effective-dated grade record and one effective-dated hierarchy record.
 *  Call it again with an extra record appended (not replacing an existing
 *  one) to simulate a later promotion or tree move without disturbing
 *  history -- see resolve.ts. */
export function makeOrg(people: OrgBuilderAssociate[]): OrgSnapshot {
  const associates = new Map<string, AssociateSnapshot>();
  const gradeHistory = new Map<string, GradeAssignmentRecord[]>();
  const hierarchyHistory = new Map<string, HierarchyAssignmentRecord[]>();

  for (const p of people) {
    associates.set(p.associateId, {
      associateId: p.associateId,
      code: p.code,
      status: p.status ?? "ACTIVE",
    });
    pushHistory(gradeHistory, p.associateId, {
      gradeCode: p.gradeCode,
      gradeRank: p.gradeRank,
      validFrom: p.gradeValidFrom ?? "2020-01-01",
      validTo: p.gradeValidTo ?? null,
    });
    pushHistory(hierarchyHistory, p.associateId, {
      parentAssociateId: p.parentAssociateId,
      validFrom: p.hierarchyValidFrom ?? "2020-01-01",
      validTo: p.hierarchyValidTo ?? null,
    });
  }

  return { associates, gradeHistory, hierarchyHistory };
}

function pushHistory<T>(map: Map<string, T[]>, key: string, record: T): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(record);
  } else {
    map.set(key, [record]);
  }
}

/** Deep-clones an OrgSnapshot -- Maps, arrays, AND the record objects inside
 *  them -- so a test can mutate the clone (close a record's validTo, append a
 *  new one) without disturbing the original. Cloning only the array
 *  containers is not enough: `[...v]` copies references to the same record
 *  objects, so `clone[0].validTo = x` would silently mutate the original's
 *  record too. Used by the reproducibility test to prove that appending
 *  history never changes what an old booking date resolves to -- a test that
 *  is meaningless if the "original" it compares against was itself
 *  corrupted by the act of cloning. */
export function cloneOrg(org: OrgSnapshot): OrgSnapshot {
  return {
    associates: new Map(org.associates),
    gradeHistory: new Map(
      Array.from(org.gradeHistory.entries()).map(([k, v]) => [k, v.map((r) => ({ ...r }))]),
    ),
    hierarchyHistory: new Map(
      Array.from(org.hierarchyHistory.entries()).map(([k, v]) => [k, v.map((r) => ({ ...r }))]),
    ),
  };
}
