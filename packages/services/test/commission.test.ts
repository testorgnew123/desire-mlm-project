// The accrual wiring GATE -- Phase 3 Slice 2 (PROGRESS.md's stated Phase 3
// exit criterion: "a full sale produces correct entries for seller + 3
// uplines"). Runs against real Postgres, through a real confirmBooking call
// -- proving the service-layer wiring, not re-proving the pure engine
// (packages/commission already has its own 100%-branch-covered suite).
//
// The fixture is built so commissionableValue lands on EXACTLY ₹1,00,00,000
// (a 1000 sqft unit at ₹10,000/sqft, no PLC or other commissionable charges)
// so the entries can be checked against docs/04-COMMISSION-SPEC.md's own
// worked example verbatim: self 1.5% = ₹1,50,000; L1 10% = ₹15,000; L2 5% =
// ₹7,500; L3 2% = ₹3,000; total ₹1,75,500 = 1.755% of base.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, getPrismaClient } from "@desire/db";
import { CommissionSchemeMisconfiguredError } from "@desire/commission";
import { acquireHold } from "../src/holds";
import { confirmBooking, createDraftBooking } from "../src/bookings";
import { assignGrade } from "../src/grades";
import { createScheme, publishScheme } from "../src/schemes";
import type { ChargeHeadSpec } from "../src/cost-sheet";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_commission";
const D = (v: string | number) => new Prisma.Decimal(v);

async function reset() {
  await db.commissionEntry.deleteMany({ where: { orgId: ORG } });
  await db.schemeLevelRate.deleteMany({ where: { scheme: { orgId: ORG } } });
  await db.schemeGradeRate.deleteMany({ where: { scheme: { orgId: ORG } } });
  await db.commissionScheme.deleteMany({ where: { orgId: ORG } });
  await db.demand.deleteMany({ where: { booking: { orgId: ORG } } });
  await db.costSheetLine.deleteMany({ where: { booking: { orgId: ORG } } });
  await db.bookingStatusHistory.deleteMany({ where: { booking: { orgId: ORG } } });
  await db.booking.deleteMany({ where: { orgId: ORG } });
  await db.customer.deleteMany({ where: { orgId: ORG } });
  await db.auditLog.deleteMany({ where: { orgId: ORG } });
  await db.unitStatusHistory.deleteMany({ where: { unit: { orgId: ORG } } });
  await db.unitHold.deleteMany({ where: { orgId: ORG } });
  await db.unit.deleteMany({ where: { orgId: ORG } });
  await db.priceListItem.deleteMany({ where: { priceList: { orgId: ORG } } });
  await db.priceList.deleteMany({ where: { orgId: ORG } });
  await db.chargeHead.deleteMany({ where: { orgId: ORG } });
  await db.unitType.deleteMany({ where: { orgId: ORG } });
  await db.associateGrade.deleteMany({ where: { associate: { orgId: ORG } } });
  await db.associateHierarchy.deleteMany({ where: { associate: { orgId: ORG } } });
  await db.associate.deleteMany({ where: { orgId: ORG } });
  await db.userRole.deleteMany({ where: { role: { orgId: ORG } } });
  await db.rolePermission.deleteMany({ where: { role: { orgId: ORG } } });
  await db.role.deleteMany({ where: { orgId: ORG } });
  await db.user.deleteMany({ where: { orgId: ORG } });
  await db.project.deleteMany({ where: { orgId: ORG } });
  await db.grade.deleteMany({ where: { orgId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function makeUser(label: string, codes: string[]) {
  const user = await db.user.create({
    data: { orgId: ORG, email: `${label}@test.local`, name: label, passwordHash: "unused" },
  });
  const role = await db.role.create({ data: { orgId: ORG, code: `ROLE_${label}`, name: label } });
  for (const code of codes) {
    const [resource, action] = code.split(".");
    const perm = await db.permission.upsert({ where: { code }, update: {}, create: { code, resource: resource!, action: action! } });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  }
  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });
  return user;
}

async function makeAssociate(label: string, codes: string[] = [], status: "ACTIVE" | "ONBOARDING" = "ACTIVE") {
  const user = await makeUser(label, codes);
  const associate = await db.associate.create({
    data: { orgId: ORG, userId: user.id, code: `A-${label}`, engagementType: "EMPLOYEE", joinDate: new Date("2020-01-01"), status },
  });
  return { user, associate };
}

/** A bookable fixture priced so commissionableValue lands on exactly
 *  ₹1,00,00,000: 1000 sqft at ₹10,000/sqft, no PLC or other commissionable
 *  charges. Also builds a 3-level upline chain, each ACTIVE, over the
 *  seller: seller -> l1 -> l2 -> l3. */
async function seedFixture() {
  await db.organization.create({ data: { id: ORG, name: "Commission Test Org", legalName: "Commission Test Org Pvt Ltd" } });
  const project = await db.project.create({
    data: { orgId: ORG, code: "COMM", name: "Commission Project", city: "Pune", state: "Maharashtra", reraRegNo: "P-COMM-1", reraValidTill: new Date("2030-01-01") },
  });
  const unitType = await db.unitType.create({
    data: { orgId: ORG, projectId: project.id, code: "3BHK", name: "3BHK", carpetArea: "700.00", builtUpArea: "850.00", saleableArea: "1000.00" },
  });
  const unit = await db.unit.create({ data: { orgId: ORG, projectId: project.id, unitTypeId: unitType.id, unitNumber: "B-1", floor: 1 } });

  const bspHead: ChargeHeadSpec & { isRefundable: boolean } = {
    code: "BSP", name: "Basic Sale Price", category: "BASE_PRICE", isTaxable: true, gstRatePct: D("5.00"), countsTowardCommission: true, displayOrder: 1, isRefundable: false,
  };
  await db.chargeHead.create({ data: { orgId: ORG, ...bspHead, gstRatePct: "5.00" } });

  const priceList = await db.priceList.create({
    data: {
      orgId: ORG, projectId: project.id, version: 1, name: "v1", status: "ACTIVE", validFrom: new Date("2020-01-01"),
      preparedById: "u_test",
      items: { create: [{ unitTypeId: unitType.id, baseRatePerSqft: "10000.00" }] },
    },
  });
  const customer = await db.customer.create({ data: { orgId: ORG, name: "Test Buyer", phone: "9999999999" } });

  const admin = await makeUser("admin", ["booking.create", "booking.confirm", "hold.create", "grade.change"]);
  const grade = await db.grade.create({ data: { orgId: ORG, code: "G4", name: "Manager", rank: 4 } });
  const uplineGrade = await db.grade.create({ data: { orgId: ORG, code: "G1", name: "Executive", rank: 1 } });

  const { user: sellerUser, associate: seller } = await makeAssociate("seller", ["booking.create", "hold.create"]);
  const { associate: l1 } = await makeAssociate("l1");
  const { associate: l2 } = await makeAssociate("l2");
  const { associate: l3 } = await makeAssociate("l3");

  await db.associateGrade.create({ data: { associateId: seller.id, gradeId: grade.id, validFrom: new Date("2020-01-01") } });
  for (const upline of [l1, l2, l3]) {
    await db.associateGrade.create({ data: { associateId: upline.id, gradeId: uplineGrade.id, validFrom: new Date("2020-01-01") } });
  }

  await db.associateHierarchy.create({ data: { associateId: seller.id, parentId: l1.id, path: "/", depth: 0, validFrom: new Date("2020-01-01") } });
  await db.associateHierarchy.create({ data: { associateId: l1.id, parentId: l2.id, path: "/", depth: 0, validFrom: new Date("2020-01-01") } });
  await db.associateHierarchy.create({ data: { associateId: l2.id, parentId: l3.id, path: "/", depth: 0, validFrom: new Date("2020-01-01") } });
  await db.associateHierarchy.create({ data: { associateId: l3.id, parentId: null, path: "/", depth: 0, validFrom: new Date("2020-01-01") } });

  const preparer = await makeUser("scheme_preparer", ["scheme.prepare"]);
  const approver = await makeUser("scheme_approver", ["scheme.approve"]);

  return { project, unit, priceList, customer, admin, sellerUser, seller, l1, l2, l3, grade, preparer, approver };
}

async function publishTestScheme(
  projectId: string, gradeId: string, preparer: { id: string }, approver: { id: string },
  opts: { maxTotalPct?: string } = {},
) {
  const draft = await createScheme(db, {
    projectId, name: "v1", validFrom: new Date("2020-01-01"),
    baseDefinition: { chargeHeadCodes: ["BSP"], netOfDiscount: true, netOfGst: true },
    maxTotalPct: opts.maxTotalPct ?? "3.0",
    gradeRates: [{ gradeId, rateValue: "1.5" }],
    levelRates: [
      { level: 1, pctOfSellerCommission: "10" },
      { level: 2, pctOfSellerCommission: "5" },
      { level: 3, pctOfSellerCommission: "2" },
    ],
    audit: ctx(preparer.id, "preparer"),
  });
  return publishScheme(db, { schemeId: draft.schemeId, audit: ctx(approver.id, "approver") });
}

function ctx(userId: string | null, label: string): AuditContext {
  return { orgId: ORG, actorId: userId, actorLabel: label };
}

async function draftAndConfirm(
  unit: { id: string }, priceListId: string, customerId: string,
  sellerUser: { id: string }, admin: { id: string }, bookingDate?: Date,
) {
  await acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: (await db.associate.findUniqueOrThrow({ where: { userId: sellerUser.id } })).id, audit: ctx(sellerUser.id, "seller") });
  const draft = await createDraftBooking(db, {
    unitId: unit.id, priceListId, customerId, bookingDate, audit: ctx(sellerUser.id, "seller"),
  });
  return confirmBooking(db, { bookingId: draft.id, audit: ctx(admin.id, "admin") });
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("accrueCommission, wired into confirmBooking", () => {
  it("produces correct entries for seller + 3 uplines, matching docs' worked example exactly", async () => {
    const f = await seedFixture();
    await publishTestScheme(f.project.id, f.grade.id, f.preparer, f.approver);

    const confirmed = await draftAndConfirm(f.unit, f.priceList.id, f.customer.id, f.sellerUser, f.admin);
    expect(confirmed.commissionableValue.toString()).toBe("10000000");

    const entries = await db.commissionEntry.findMany({ where: { bookingId: confirmed.id }, orderBy: [{ role: "asc" }, { level: "asc" }] });
    expect(entries).toHaveLength(4);

    const self = entries.find((e) => e.role === "SELF")!;
    expect(self.beneficiaryAssociateId).toBe(f.seller.id);
    expect(self.grossAmount.toString()).toBe("150000");

    const l1Entry = entries.find((e) => e.role === "OVERRIDE" && e.level === 1)!;
    expect(l1Entry.beneficiaryAssociateId).toBe(f.l1.id);
    expect(l1Entry.grossAmount.toString()).toBe("15000");

    const l2Entry = entries.find((e) => e.role === "OVERRIDE" && e.level === 2)!;
    expect(l2Entry.beneficiaryAssociateId).toBe(f.l2.id);
    expect(l2Entry.grossAmount.toString()).toBe("7500");

    const l3Entry = entries.find((e) => e.role === "OVERRIDE" && e.level === 3)!;
    expect(l3Entry.beneficiaryAssociateId).toBe(f.l3.id);
    expect(l3Entry.grossAmount.toString()).toBe("3000");

    const total = entries.reduce((sum, e) => sum.plus(e.grossAmount), D(0));
    expect(total.toString()).toBe("175500");

    const accrualAudit = await db.auditLog.findFirstOrThrow({ where: { entity: "CommissionAccrual", entityId: confirmed.id } });
    expect((accrualAudit.after as { breakage: string }).breakage).toBe("0.00");
  });

  it("a maxTotalPct breach refuses to persist ANYTHING and rolls back the whole confirm", async () => {
    const f = await seedFixture();
    // Ceiling of 1% of base = 100,000, well under the 175,500 total.
    await publishTestScheme(f.project.id, f.grade.id, f.preparer, f.approver, { maxTotalPct: "1.0" });

    await acquireHold(db, { orgId: ORG, unitId: f.unit.id, associateId: f.seller.id, audit: ctx(f.sellerUser.id, "seller") });
    const draft = await createDraftBooking(db, { unitId: f.unit.id, priceListId: f.priceList.id, customerId: f.customer.id, audit: ctx(f.sellerUser.id, "seller") });

    await expect(
      confirmBooking(db, { bookingId: draft.id, audit: ctx(f.admin.id, "admin") }),
    ).rejects.toThrow(CommissionSchemeMisconfiguredError);

    const afterBooking = await db.booking.findUniqueOrThrow({ where: { id: draft.id } });
    expect(afterBooking.status).toBe("DRAFT");
    expect(await db.commissionEntry.count({ where: { bookingId: draft.id } })).toBe(0);
  });

  it("a project with no ACTIVE scheme confirms the booking with zero commission entries", async () => {
    const f = await seedFixture();
    const confirmed = await draftAndConfirm(f.unit, f.priceList.id, f.customer.id, f.sellerUser, f.admin);
    expect(confirmed.status).toBe("CONFIRMED");
    expect(await db.commissionEntry.count({ where: { bookingId: confirmed.id } })).toBe(0);
  });

  it("resolves the grade valid AT bookingDate, not the CURRENT grade after a later promotion", async () => {
    const f = await seedFixture();
    await publishTestScheme(f.project.id, f.grade.id, f.preparer, f.approver);

    // A grade with no rate on the scheme -- if accrual used the CURRENT
    // (post-promotion) grade instead of the one valid at bookingDate, this
    // would throw CommissionSchemeMisconfiguredError.
    const higherGrade = await db.grade.create({ data: { orgId: ORG, code: "G5", name: "Senior Manager", rank: 5 } });
    await assignGrade(db, { associateId: f.seller.id, gradeId: higherGrade.id, effectiveFrom: new Date("2025-01-01"), audit: ctx(f.admin.id, "admin") });

    const confirmed = await draftAndConfirm(f.unit, f.priceList.id, f.customer.id, f.sellerUser, f.admin, new Date("2021-06-01"));

    const self = await db.commissionEntry.findFirstOrThrow({ where: { bookingId: confirmed.id, role: "SELF" } });
    expect(self.grossAmount.toString()).toBe("150000");
    expect((self.snapshot as { gradeCode: string }).gradeCode).toBe("G4");
  });
});
