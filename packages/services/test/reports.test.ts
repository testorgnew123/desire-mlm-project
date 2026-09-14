// Phase 5's six flagship reports -- real Postgres. Focus: row scoping
// (own/downline/admin, and the finance-only gate on the two finance
// reports), and the calculation/labeling logic specific to each report
// (funnel conversion, aging buckets, liability totals). getCollectionsConsole
// and listReceipts's own correctness is already covered by their own test
// files -- outstanding-aging's test here only checks that the wrapping
// (bucket labeling) is correct, not that collections math itself is.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import {
  getAuditTrailReport,
  getCommissionLiabilityReport,
  getOutstandingAgingReport,
  getSalesFunnelReport,
  getStockStatementReport,
  getTallyTransactionExport,
} from "../src/reports";

const db = getPrismaClient();
const ORG = "org_test_reports";

async function reset() {
  await db.payoutLineEntry.deleteMany({ where: { payoutLine: { batch: { orgId: ORG } } } });
  await db.payoutLine.deleteMany({ where: { batch: { orgId: ORG } } });
  await db.payoutBatch.deleteMany({ where: { orgId: ORG } });
  await db.commissionEntry.deleteMany({ where: { orgId: ORG } });
  await db.commissionScheme.deleteMany({ where: { orgId: ORG } });
  await db.receiptAllocation.deleteMany({ where: { receipt: { orgId: ORG } } });
  await db.receipt.deleteMany({ where: { orgId: ORG } });
  await db.demand.deleteMany({ where: { orgId: ORG } });
  await db.leadClaim.deleteMany({ where: { lead: { orgId: ORG } } });
  await db.lead.deleteMany({ where: { orgId: ORG } });
  await db.booking.deleteMany({ where: { orgId: ORG } });
  await db.customer.deleteMany({ where: { orgId: ORG } });
  await db.priceList.deleteMany({ where: { orgId: ORG } });
  await db.unit.deleteMany({ where: { orgId: ORG } });
  await db.unitType.deleteMany({ where: { orgId: ORG } });
  await db.auditLog.deleteMany({ where: { orgId: ORG } });
  await db.associateHierarchy.deleteMany({ where: { associate: { orgId: ORG } } });
  await db.associate.deleteMany({ where: { orgId: ORG } });
  await db.userRole.deleteMany({ where: { role: { orgId: ORG } } });
  await db.rolePermission.deleteMany({ where: { role: { orgId: ORG } } });
  await db.role.deleteMany({ where: { orgId: ORG } });
  await db.user.deleteMany({ where: { orgId: ORG } });
  await db.project.deleteMany({ where: { orgId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function makeUser(label: string, codes: string[], opts: { associate?: boolean } = {}) {
  const user = await db.user.create({ data: { orgId: ORG, email: `${label}@test.local`, name: label, passwordHash: "unused" } });
  const role = await db.role.create({ data: { orgId: ORG, code: `ROLE_${label}`, name: label } });
  for (const code of codes) {
    const [resource, action] = code.split(".");
    const perm = await db.permission.upsert({ where: { code }, update: {}, create: { code, resource: resource!, action: action! } });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  }
  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });

  let associate = null;
  if (opts.associate) {
    associate = await db.associate.create({
      data: { orgId: ORG, userId: user.id, code: `A-${label}`, engagementType: "EMPLOYEE", joinDate: new Date("2024-01-01") },
    });
    await db.associateHierarchy.create({
      data: { associateId: associate.id, parentId: null, path: "/", depth: 0, validFrom: new Date("2024-01-01") },
    });
  }
  return { user, associate };
}

async function renameRole(fromCode: string, toCode: string) {
  await db.role.updateMany({ where: { orgId: ORG, code: fromCode }, data: { code: toCode } });
}

async function seedOrgAndProject() {
  await db.organization.create({ data: { id: ORG, name: "Reports Test Org", legalName: "Reports Test Org Pvt Ltd" } });
  return db.project.create({
    data: { orgId: ORG, code: "RPT", name: "Reports Project", city: "Pune", state: "Maharashtra", reraRegNo: "P-RPT-0001", reraValidTill: new Date("2030-01-01") },
  });
}

async function makeUnit(projectId: string, unitNumber: string, status: "AVAILABLE" | "BOOKED" = "AVAILABLE") {
  const unitType = await db.unitType.create({
    data: { orgId: ORG, projectId, code: `UT-${unitNumber}`, name: "2BHK", carpetArea: "650.00", builtUpArea: "780.00", saleableArea: "975.00" },
  });
  return db.unit.create({ data: { orgId: ORG, projectId, unitTypeId: unitType.id, unitNumber, floor: 1, status } });
}

async function makeBooking(params: { projectId: string; unitId: string; sellingAssociateId: string; agreementValue?: string }) {
  const customer = await db.customer.create({ data: { orgId: ORG, name: "Test Customer", phone: "9000000000" } });
  const priceList = await db.priceList.create({
    data: { orgId: ORG, projectId: params.projectId, version: Math.floor(Math.random() * 1_000_000), name: "PL", status: "ACTIVE", validFrom: new Date("2020-01-01"), preparedById: "u_test" },
  });
  return db.booking.create({
    data: {
      orgId: ORG, projectId: params.projectId, unitId: params.unitId, customerId: customer.id, priceListId: priceList.id,
      bookingNumber: `BK-${params.unitId.slice(-6)}`, bookingDate: new Date(), status: "CONFIRMED", sellingAssociateId: params.sellingAssociateId,
      baseAmount: "100.00", plcAmount: "0.00", otherChargesAmount: "0.00", discountAmount: "0.00",
      gstAmount: "0.00", stampDutyAmount: "0.00", registrationAmount: "0.00",
      agreementValue: params.agreementValue ?? "100.00", commissionableValue: "100.00", saleableAreaAtBooking: "975.00", carpetAreaAtBooking: "650.00",
    },
  });
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("getStockStatementReport", () => {
  it("returns unit-level rows including the booking number for a booked unit", async () => {
    const project = await seedOrgAndProject();
    const { associate } = await makeUser("stockassoc", ["report.read"], { associate: true });
    const unit = await makeUnit(project.id, "U-101", "BOOKED");
    const booking = await makeBooking({ projectId: project.id, unitId: unit.id, sellingAssociateId: associate!.id });

    const { user: admin } = await makeUser("stockadmin", ["report.read"]);
    await renameRole("ROLE_stockadmin", "SUPER_ADMIN");

    const result = await getStockStatementReport(db, { orgId: ORG, actorId: admin.id });
    const row = result.rows.find((r) => r[2] === "U-101");
    expect(row).toBeDefined();
    expect(row?.[5]).toBe("BOOKED");
    expect(row?.[6]).toBe(booking.bookingNumber);
  });
});

describe("getSalesFunnelReport", () => {
  it("counts leads per stage and computes conversion against the previous stage", async () => {
    const project = await seedOrgAndProject();
    const { user: admin } = await makeUser("funneladmin", ["report.read"]);
    await renameRole("ROLE_funneladmin", "SUPER_ADMIN");

    await db.lead.createMany({
      data: [
        { orgId: ORG, projectId: project.id, name: "L1", phone: "9000000001", phoneHash: "h1", source: "WEBSITE", stage: "NEW" },
        { orgId: ORG, projectId: project.id, name: "L2", phone: "9000000002", phoneHash: "h2", source: "WEBSITE", stage: "NEW" },
        { orgId: ORG, projectId: project.id, name: "L3", phone: "9000000003", phoneHash: "h3", source: "WEBSITE", stage: "CONTACTED" },
        { orgId: ORG, projectId: project.id, name: "L4", phone: "9000000004", phoneHash: "h4", source: "WEBSITE", stage: "LOST" },
      ],
    });

    const result = await getSalesFunnelReport(db, { orgId: ORG, actorId: admin.id });
    const newRow = result.rows.find((r) => r[0] === "NEW")!;
    const contactedRow = result.rows.find((r) => r[0] === "CONTACTED")!;
    const lostRow = result.rows.find((r) => r[0] === "LOST")!;

    expect(newRow[1]).toBe("2");
    expect(contactedRow[1]).toBe("1");
    expect(contactedRow[2]).toBe("50.0"); // 1 of 2 NEW converted
    expect(lostRow[1]).toBe("1");
  });

  it("scopes a TEAM_LEAD to their own + downline leads only", async () => {
    const project = await seedOrgAndProject();
    const { user: lead, associate: leadAssociate } = await makeUser("tl", ["report.read"], { associate: true });
    await renameRole("ROLE_tl", "TEAM_LEAD");
    const { associate: report } = await makeUser("report1", ["report.read"], { associate: true });
    await db.associateHierarchy.updateMany({
      where: { associateId: report!.id },
      data: { parentId: leadAssociate!.id, path: `/${leadAssociate!.id}/`, depth: 1 },
    });
    const { associate: stranger } = await makeUser("stranger1", ["report.read"], { associate: true });

    await db.lead.createMany({
      data: [
        { orgId: ORG, projectId: project.id, name: "Own lead", phone: "9000000010", phoneHash: "h10", source: "WEBSITE", stage: "NEW", assignedAssociateId: leadAssociate!.id },
        { orgId: ORG, projectId: project.id, name: "Downline lead", phone: "9000000011", phoneHash: "h11", source: "WEBSITE", stage: "NEW", assignedAssociateId: report!.id },
        { orgId: ORG, projectId: project.id, name: "Stranger lead", phone: "9000000012", phoneHash: "h12", source: "WEBSITE", stage: "NEW", assignedAssociateId: stranger!.id },
      ],
    });

    const result = await getSalesFunnelReport(db, { orgId: ORG, actorId: lead.id });
    const newRow = result.rows.find((r) => r[0] === "NEW")!;
    expect(newRow[1]).toBe("2"); // own + downline, not the stranger's
  });
});

describe("getOutstandingAgingReport", () => {
  it("labels a demand's bucket correctly from its days overdue", async () => {
    const project = await seedOrgAndProject();
    const { user: admin, associate } = await makeUser("agingadmin", ["report.read"], { associate: true });
    await renameRole("ROLE_agingadmin", "SUPER_ADMIN");
    const unit = await makeUnit(project.id, "U-AGE");
    const booking = await makeBooking({ projectId: project.id, unitId: unit.id, sellingAssociateId: associate!.id });

    await db.demand.create({
      data: {
        orgId: ORG, bookingId: booking.id, sequence: 1, description: "Milestone 1",
        amount: "50.00", dueDate: new Date(Date.now() - 40 * 24 * 60 * 60_000), status: "RAISED",
      },
    });

    const result = await getOutstandingAgingReport(db, { orgId: ORG, actorId: admin.id });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.[7]).toBe("31-60 days");
  });
});

describe("getCommissionLiabilityReport", () => {
  it("sums accrued/payable/paid per associate and refuses a non-finance role", async () => {
    const project = await seedOrgAndProject();
    const { associate } = await makeUser("commassoc", ["report.read"], { associate: true });
    const unit = await makeUnit(project.id, "U-COMM");
    const booking = await makeBooking({ projectId: project.id, unitId: unit.id, sellingAssociateId: associate!.id });
    const scheme = await db.commissionScheme.create({
      data: { orgId: ORG, projectId: project.id, version: 1, name: "S", status: "ACTIVE", validFrom: new Date("2020-01-01"), maxTotalPct: "10.00", preparedById: "u", approvedById: "u", baseDefinition: {} },
    });

    await db.commissionEntry.createMany({
      data: [
        { orgId: ORG, bookingId: booking.id, schemeId: scheme.id, beneficiaryAssociateId: associate!.id, role: "SELF", level: 0, baseAmount: "100.00", grossAmount: "10.00", status: "ACCRUED", idempotencyKey: "k1", snapshot: {} },
        { orgId: ORG, bookingId: booking.id, schemeId: scheme.id, beneficiaryAssociateId: associate!.id, role: "SELF", level: 0, baseAmount: "100.00", grossAmount: "5.00", status: "PAID", idempotencyKey: "k2", snapshot: {} },
      ],
    });

    const { user: admin } = await makeUser("commadmin", ["report.read"]);
    await renameRole("ROLE_commadmin", "SUPER_ADMIN");
    const result = await getCommissionLiabilityReport(db, { orgId: ORG, actorId: admin.id });
    const row = result.rows.find((r) => r[0] === associate!.code)!;
    expect(row[2]).toBe("10.00"); // accrued
    expect(row[4]).toBe("5.00"); // paid

    await expect(getCommissionLiabilityReport(db, { orgId: ORG, actorId: associate!.userId })).rejects.toThrow(ForbiddenError);
  });
});

describe("getAuditTrailReport", () => {
  it("returns audited actions and refuses without audit.read", async () => {
    await seedOrgAndProject();
    const { user: auditor } = await makeUser("auditor1", ["audit.read"]);
    await db.auditLog.create({ data: { orgId: ORG, actorId: auditor.id, actorLabel: "auditor1", action: "CREATE", entity: "Lead", entityId: "l1" } });

    const result = await getAuditTrailReport(db, { orgId: ORG, actorId: auditor.id });
    expect(result.rows.some((r) => r[3] === "Lead" && r[4] === "l1")).toBe(true);

    const { user: noPerms } = await makeUser("noperms1", []);
    await expect(getAuditTrailReport(db, { orgId: ORG, actorId: noPerms.id })).rejects.toThrow(ForbiddenError);
  });
});

describe("getTallyTransactionExport", () => {
  it("includes bookings, receipts and paid payout lines as typed rows", async () => {
    const project = await seedOrgAndProject();
    const { associate } = await makeUser("tallyassoc", ["report.read"], { associate: true });
    const unit = await makeUnit(project.id, "U-TALLY");
    const booking = await makeBooking({ projectId: project.id, unitId: unit.id, sellingAssociateId: associate!.id, agreementValue: "500.00" });
    await db.receipt.create({
      data: { orgId: ORG, bookingId: booking.id, receiptNumber: "R-1", amount: "50.00", mode: "UPI", status: "CLEARED", receivedOn: new Date(), enteredById: "u" },
    });
    const batch = await db.payoutBatch.create({
      data: { orgId: ORG, batchNumber: "PB-T-1", periodStart: new Date("2024-01-01"), periodEnd: new Date("2024-01-31"), status: "PAID", preparedById: "u", paidAt: new Date() },
    });
    await db.payoutLine.create({
      data: { batchId: batch.id, associateId: associate!.id, grossAmount: "10.00", tdsSection: "SEC_192", tdsRatePct: "10.00", tdsAmount: "1.00", netPayable: "9.00" },
    });

    const { user: admin } = await makeUser("tallyadmin", ["report.read"]);
    await renameRole("ROLE_tallyadmin", "SUPER_ADMIN");
    const result = await getTallyTransactionExport(db, { orgId: ORG, actorId: admin.id });

    expect(result.rows.some((r) => r[0] === "BOOKING" && r[4] === "500.00")).toBe(true);
    expect(result.rows.some((r) => r[0] === "RECEIPT" && r[4] === "50.00")).toBe(true);
    expect(result.rows.some((r) => r[0] === "PAYOUT" && r[4] === "9.00")).toBe(true);
  });
});
