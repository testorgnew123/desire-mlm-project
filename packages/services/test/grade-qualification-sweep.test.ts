// Grade auto-qualification sweep -- Phase 3 Slice 6. Copies expireStaleHolds/
// runCollectionsSweep's own real-Postgres testing convention.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { runGradeQualificationSweep } from "../src/grades";

const db = getPrismaClient();
const ORG = "org_test_grade_sweep";
const NOW = new Date("2026-06-15");

async function reset() {
  await db.payoutBatch.deleteMany({ where: { orgId: ORG } });
  await db.commissionEntry.deleteMany({ where: { orgId: ORG } });
  await db.commissionScheme.deleteMany({ where: { orgId: ORG } });
  await db.booking.deleteMany({ where: { orgId: ORG } });
  await db.customer.deleteMany({ where: { orgId: ORG } });
  await db.priceList.deleteMany({ where: { orgId: ORG } });
  await db.unit.deleteMany({ where: { orgId: ORG } });
  await db.unitType.deleteMany({ where: { orgId: ORG } });
  await db.auditLog.deleteMany({ where: { orgId: ORG } });
  await db.associateHierarchy.deleteMany({ where: { associate: { orgId: ORG } } });
  await db.associateGrade.deleteMany({ where: { associate: { orgId: ORG } } });
  await db.associate.deleteMany({ where: { orgId: ORG } });
  await db.user.deleteMany({ where: { orgId: ORG } });
  await db.project.deleteMany({ where: { orgId: ORG } });
  await db.grade.deleteMany({ where: { orgId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function makeAssociate(label: string, joinDate: Date) {
  const user = await db.user.create({ data: { orgId: ORG, email: `${label}@test.local`, name: label, passwordHash: "unused" } });
  return db.associate.create({
    data: { orgId: ORG, userId: user.id, code: `A-${label}`, engagementType: "EMPLOYEE", joinDate, status: "ACTIVE" },
  });
}

async function seedOrgAndGrades() {
  await db.organization.create({ data: { id: ORG, name: "Grade Sweep Test Org", legalName: "Grade Sweep Test Org Pvt Ltd" } });
  const project = await db.project.create({
    data: { orgId: ORG, code: "GSW", name: "Grade Sweep Project", city: "Pune", state: "Maharashtra", reraRegNo: "P-GSW-1", reraValidTill: new Date("2030-01-01") },
  });
  const g1 = await db.grade.create({ data: { orgId: ORG, code: "G1", name: "Executive", rank: 1 } });
  const g2 = await db.grade.create({
    data: { orgId: ORG, code: "G2", name: "Senior Executive", rank: 2, minTenureMonths: 6 },
  });
  const g3vacuous = await db.grade.create({ data: { orgId: ORG, code: "G3", name: "Manager", rank: 3 } }); // all thresholds null
  return { project, g1, g2, g3vacuous };
}

async function seedScheme(projectId: string) {
  return db.commissionScheme.create({
    data: { orgId: ORG, projectId, name: "v1", version: 1, status: "DRAFT", validFrom: new Date("2020-01-01"), baseDefinition: { chargeHeadCodes: ["BSP"] }, preparedById: "u_test" },
  });
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("runGradeQualificationSweep", () => {
  it("promotes an associate who meets a grade's tenure threshold", async () => {
    const { g1, g2 } = await seedOrgAndGrades();
    const associate = await makeAssociate("tenured", new Date("2025-01-01")); // 17 months tenure at NOW
    await db.associateGrade.create({ data: { associateId: associate.id, gradeId: g1.id, validFrom: new Date("2025-01-01") } });

    const result = await runGradeQualificationSweep(db, { now: NOW });
    expect(result.evaluated).toBeGreaterThanOrEqual(1);
    expect(result.promoted).toBe(1);

    const current = await db.associateGrade.findFirstOrThrow({ where: { associateId: associate.id, validTo: null } });
    expect(current.gradeId).toBe(g2.id);
    expect(current.approvedById).toBeNull();
    expect(current.reason).toContain("Auto-qualified");

    const old = await db.associateGrade.findFirstOrThrow({ where: { associateId: associate.id, gradeId: g1.id } });
    expect(old.validTo).not.toBeNull();
  });

  it("does not promote an associate who has not met the threshold", async () => {
    const { g1 } = await seedOrgAndGrades();
    const associate = await makeAssociate("new", new Date("2026-06-01")); // 0 months tenure
    await db.associateGrade.create({ data: { associateId: associate.id, gradeId: g1.id, validFrom: new Date("2026-06-01") } });

    const result = await runGradeQualificationSweep(db, { now: NOW });
    expect(result.promoted).toBe(0);

    const current = await db.associateGrade.findFirstOrThrow({ where: { associateId: associate.id, validTo: null } });
    expect(current.gradeId).toBe(g1.id);
  });

  it("a grade with all-null thresholds never auto-promotes anyone into it", async () => {
    const { g2 } = await seedOrgAndGrades();
    // Tenured well past G2's own 6-month threshold, sitting AT G2 already --
    // G3 (vacuous, rank 3) must never be reached no matter how long they wait.
    const associate = await makeAssociate("veteran", new Date("2020-01-01"));
    await db.associateGrade.create({ data: { associateId: associate.id, gradeId: g2.id, validFrom: new Date("2020-01-01") } });

    const result = await runGradeQualificationSweep(db, { now: NOW });
    expect(result.promoted).toBe(0);

    const current = await db.associateGrade.findFirstOrThrow({ where: { associateId: associate.id, validTo: null } });
    expect(current.gradeId).toBe(g2.id);
  });

  it("promotes based on cumulative sales value from real CommissionEntry rows", async () => {
    const { project, g1 } = await seedOrgAndGrades();
    const salesGrade = await db.grade.create({
      data: { orgId: ORG, code: "GSALES", name: "Top Seller", rank: 5, minCumulativeSalesValue: "1000000" },
    });
    const associate = await makeAssociate("seller", new Date("2026-01-01"));
    await db.associateGrade.create({ data: { associateId: associate.id, gradeId: g1.id, validFrom: new Date("2026-01-01") } });

    const scheme = await seedScheme(project.id);
    const unitType = await db.unitType.create({
      data: { orgId: ORG, projectId: project.id, code: "3BHK", name: "3BHK", carpetArea: "700.00", builtUpArea: "850.00", saleableArea: "1000.00" },
    });
    const unit = await db.unit.create({ data: { orgId: ORG, projectId: project.id, unitTypeId: unitType.id, unitNumber: "A-1", floor: 1 } });
    const priceList = await db.priceList.create({
      data: { orgId: ORG, projectId: project.id, version: 1, name: "v1", status: "ACTIVE", validFrom: new Date("2020-01-01"), preparedById: "u_test" },
    });
    const customer = await db.customer.create({ data: { orgId: ORG, name: "Test Buyer", phone: "9999999999" } });
    const booking = await db.booking.create({
      data: {
        orgId: ORG, projectId: project.id, unitId: unit.id, customerId: customer.id, bookingNumber: "BK-GSW-1", bookingDate: new Date("2026-03-01"),
        status: "CONFIRMED", sellingAssociateId: associate.id, priceListId: priceList.id,
        baseAmount: "1200000", agreementValue: "1200000", commissionableValue: "1200000",
        saleableAreaAtBooking: "1000.00", carpetAreaAtBooking: "700.00",
      },
    });
    await db.commissionEntry.create({
      data: {
        orgId: ORG, bookingId: booking.id, schemeId: scheme.id, beneficiaryAssociateId: associate.id, role: "SELF", level: 0,
        baseAmount: "1200000", grossAmount: "18000", status: "ACCRUED", snapshot: {},
        idempotencyKey: `${booking.id}:${associate.id}:0:${scheme.id}`,
      },
    });

    const result = await runGradeQualificationSweep(db, { now: NOW });
    expect(result.promoted).toBe(1);

    const current = await db.associateGrade.findFirstOrThrow({ where: { associateId: associate.id, validTo: null } });
    expect(current.gradeId).toBe(salesGrade.id);
  });

  it("Phase 4: skips promoting an otherwise-qualifying associate while their org has an open payout batch", async () => {
    const { g1 } = await seedOrgAndGrades();
    // Identical to the "promotes an associate who meets a grade's tenure
    // threshold" case above -- the only difference is the open batch.
    const associate = await makeAssociate("tenured-frozen", new Date("2025-01-01"));
    await db.associateGrade.create({ data: { associateId: associate.id, gradeId: g1.id, validFrom: new Date("2025-01-01") } });
    await db.payoutBatch.create({
      data: { orgId: ORG, batchNumber: "PB-SWEEP-001", periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-02-01"), status: "DRAFT", preparedById: "u_test" },
    });

    const result = await runGradeQualificationSweep(db, { now: NOW });
    expect(result.evaluated).toBeGreaterThanOrEqual(1);
    expect(result.promoted).toBe(0);

    const current = await db.associateGrade.findFirstOrThrow({ where: { associateId: associate.id, validTo: null } });
    expect(current.gradeId).toBe(g1.id);
  });
});
