// Payout batch -- Phase 3 Slice 4. Runs against real Postgres, working
// directly off pre-seeded PAYABLE CommissionEntry/Recovery/TaxRate rows (the
// same posture as receipts.test.ts's own fixture) -- accrual correctness
// itself is commission.test.ts's job, not this file's.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import {
  DuplicatePayoutPeriodError,
  NoTaxRateConfiguredError,
  PayoutBatchNotApprovableError,
  PayoutMakerCheckerViolationError,
  approveBatch,
  exportBatch,
  prepareBatch,
} from "../src/payouts";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_payouts";
const OTHER_ORG = "org_test_payouts_other";
const D = (v: string | number) => new Prisma.Decimal(v);
const PERIOD_START = new Date("2026-01-01");
const PERIOD_END = new Date("2026-02-01");

async function reset() {
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.payoutLineEntry.deleteMany({ where: { payoutLine: { batch: { orgId } } } });
    await db.payoutLine.deleteMany({ where: { batch: { orgId } } });
    await db.payoutBatch.deleteMany({ where: { orgId } });
    await db.recovery.deleteMany({ where: { orgId } });
    await db.commissionEntry.deleteMany({ where: { orgId } });
    await db.commissionScheme.deleteMany({ where: { orgId } });
    await db.taxRate.deleteMany({ where: { orgId } });
    await db.booking.deleteMany({ where: { orgId } });
    await db.customer.deleteMany({ where: { orgId } });
    await db.auditLog.deleteMany({ where: { orgId } });
    await db.unit.deleteMany({ where: { orgId } });
    await db.priceListItem.deleteMany({ where: { priceList: { orgId } } });
    await db.priceList.deleteMany({ where: { orgId } });
    await db.unitType.deleteMany({ where: { orgId } });
    await db.associate.deleteMany({ where: { orgId } });
    await db.userRole.deleteMany({ where: { role: { orgId } } });
    await db.rolePermission.deleteMany({ where: { role: { orgId } } });
    await db.role.deleteMany({ where: { orgId } });
    await db.user.deleteMany({ where: { orgId } });
    await db.project.deleteMany({ where: { orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
  }
}

async function makeUser(orgId: string, label: string, codes: string[]) {
  const user = await db.user.create({ data: { orgId, email: `${label}-${orgId}@test.local`, name: label, passwordHash: "unused" } });
  const role = await db.role.create({ data: { orgId, code: `ROLE_${label}`, name: label } });
  for (const code of codes) {
    const [resource, action] = code.split(".");
    const perm = await db.permission.upsert({ where: { code }, update: {}, create: { code, resource: resource!, action: action! } });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  }
  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });
  return user;
}

async function makeAssociate(orgId: string, label: string, engagementType: "EMPLOYEE" | "CONSULTANT", opts: { isGstRegistered?: boolean } = {}) {
  const user = await makeUser(orgId, label, []);
  return db.associate.create({
    data: {
      orgId, userId: user.id, code: `A-${label}`, engagementType, joinDate: new Date("2020-01-01"),
      status: "ACTIVE", isGstRegistered: opts.isGstRegistered ?? false,
    },
  });
}

/** A minimal booking + scheme, just enough for CommissionEntry's FKs --
 *  the entries' own numbers are what this file actually exercises. */
async function seedBookingAndScheme(orgId: string) {
  await db.organization.create({ data: { id: orgId, name: "Payouts Test Org", legalName: "Payouts Test Org Pvt Ltd" } });
  const project = await db.project.create({
    data: { orgId, code: "PO", name: "Payout Project", city: "Pune", state: "Maharashtra", reraRegNo: `P-PO-${orgId}`, reraValidTill: new Date("2030-01-01") },
  });
  const unitType = await db.unitType.create({
    data: { orgId, projectId: project.id, code: "2BHK", name: "2BHK", carpetArea: "650.00", builtUpArea: "780.00", saleableArea: "975.00" },
  });
  const unit = await db.unit.create({ data: { orgId, projectId: project.id, unitTypeId: unitType.id, unitNumber: "A-1", floor: 1 } });
  const priceList = await db.priceList.create({
    data: { orgId, projectId: project.id, version: 1, name: "v1", status: "ACTIVE", validFrom: new Date("2020-01-01"), preparedById: "u_test" },
  });
  const customer = await db.customer.create({ data: { orgId, name: "Test Buyer", phone: "9999999999" } });
  const sellerUser = await makeUser(orgId, "bookingseller", []);
  const seller = await db.associate.create({
    data: { orgId, userId: sellerUser.id, code: "A-bookingseller", engagementType: "EMPLOYEE", joinDate: new Date("2020-01-01"), status: "ACTIVE" },
  });
  const scheme = await db.commissionScheme.create({
    data: { orgId, projectId: project.id, name: "v1", version: 1, status: "DRAFT", validFrom: new Date("2020-01-01"), baseDefinition: { chargeHeadCodes: ["BSP"] }, preparedById: "u_test" },
  });
  const booking = await db.booking.create({
    data: {
      orgId, projectId: project.id, unitId: unit.id, customerId: customer.id, bookingNumber: `BK-${orgId}`, bookingDate: new Date("2026-01-10"),
      status: "CONFIRMED", sellingAssociateId: seller.id, priceListId: priceList.id,
      baseAmount: "1000000", agreementValue: "1000000", commissionableValue: "1000000",
      saleableAreaAtBooking: "975.00", carpetAreaAtBooking: "650.00",
    },
  });
  return { booking, scheme };
}

async function seedEntry(orgId: string, bookingId: string, schemeId: string, beneficiaryAssociateId: string, grossAmount: string, accruedAt: Date) {
  return db.commissionEntry.create({
    data: {
      orgId, bookingId, schemeId, beneficiaryAssociateId, role: "SELF", level: 0,
      baseAmount: D(grossAmount), grossAmount: D(grossAmount), status: "PAYABLE", snapshot: {}, accruedAt,
      idempotencyKey: `${bookingId}:${beneficiaryAssociateId}:0:${schemeId}:${Math.random()}`,
    },
  });
}

function ctx(orgId: string, userId: string, label: string): AuditContext {
  return { orgId, actorId: userId, actorLabel: label };
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("prepareBatch: tax resolved per engagementType, PayoutLineEntry provenance", () => {
  it("groups entries by beneficiary, resolves TDS from TaxRate, and records provenance", async () => {
    const { booking, scheme } = await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "emp", "EMPLOYEE");
    await db.taxRate.create({ data: { orgId: ORG, section: "SEC_192", ratePct: "10.00", validFrom: new Date("2020-01-01") } });
    const e1 = await seedEntry(ORG, booking.id, scheme.id, employee.id, "50000", new Date("2026-01-15"));
    const e2 = await seedEntry(ORG, booking.id, scheme.id, employee.id, "20000", new Date("2026-01-20"));
    const preparer = await makeUser(ORG, "preparer", ["payout.prepare"]);

    const result = await prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, preparer.id, "preparer") });
    expect(result.lineCount).toBe(1);

    const line = await db.payoutLine.findFirstOrThrow({ where: { batchId: result.batchId, associateId: employee.id } });
    expect(line.grossAmount.toString()).toBe("70000");
    expect(line.tdsSection).toBe("SEC_192");
    expect(line.tdsAmount.toString()).toBe("7000"); // 10% of 70000
    expect(line.netPayable.toString()).toBe("63000");

    const provenance = await db.payoutLineEntry.findMany({ where: { payoutLineId: line.id }, orderBy: { entryId: "asc" } });
    expect(provenance.map((p) => p.entryId).sort()).toEqual([e1.id, e2.id].sort());
  });

  it("applies GST for a GST-registered CONSULTANT, not for an EMPLOYEE", async () => {
    const { booking, scheme } = await seedBookingAndScheme(ORG);
    const consultant = await makeAssociate(ORG, "cons", "CONSULTANT", { isGstRegistered: true });
    await db.taxRate.create({ data: { orgId: ORG, section: "SEC_194J", ratePct: "10.00", validFrom: new Date("2020-01-01") } });
    await seedEntry(ORG, booking.id, scheme.id, consultant.id, "100000", new Date("2026-01-15"));
    const preparer = await makeUser(ORG, "preparer", ["payout.prepare"]);

    const result = await prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, preparer.id, "preparer") });
    const line = await db.payoutLine.findFirstOrThrow({ where: { batchId: result.batchId, associateId: consultant.id } });
    expect(line.tdsSection).toBe("SEC_194J");
    expect(line.gstRatePct?.toString()).toBe("18");
    expect(line.gstAmount.toString()).toBe("18000");
    expect(line.netPayable.toString()).toBe("108000"); // 100000 + 18000 gst - 10000 tds
  });

  it("throws when no TaxRate is configured for the section", async () => {
    const { booking, scheme } = await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "emp", "EMPLOYEE");
    await seedEntry(ORG, booking.id, scheme.id, employee.id, "50000", new Date("2026-01-15"));
    const preparer = await makeUser(ORG, "preparer", ["payout.prepare"]);

    await expect(
      prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, preparer.id, "preparer") }),
    ).rejects.toThrow(NoTaxRateConfiguredError);
  });

  it("refuses without payout.prepare", async () => {
    await seedBookingAndScheme(ORG);
    const noPerms = await makeUser(ORG, "noperms", []);
    await expect(
      prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, noPerms.id, "noperms") }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("two prepareBatch calls for the same period -- only one succeeds", async () => {
    await seedBookingAndScheme(ORG);
    const preparer = await makeUser(ORG, "preparer", ["payout.prepare"]);

    const results = await Promise.allSettled([
      prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, preparer.id, "preparer") }),
      prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, preparer.id, "preparer") }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DuplicatePayoutPeriodError);

    expect(await db.payoutBatch.count({ where: { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END } })).toBe(1);
  });
});

describe("recovery deduction cap: never exceeds PAYOUT_RECOVERY_MAX_DEDUCTION_PCT of gross", () => {
  it("deducts up to 50% of gross even when the outstanding recovery is larger", async () => {
    const { booking, scheme } = await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "emp", "EMPLOYEE");
    await db.taxRate.create({ data: { orgId: ORG, section: "SEC_192", ratePct: "0", validFrom: new Date("2020-01-01") } });
    await seedEntry(ORG, booking.id, scheme.id, employee.id, "100000", new Date("2026-01-15"));
    await db.recovery.create({
      data: { orgId: ORG, associateId: employee.id, amount: "80000", outstandingAmount: "80000", reason: "test clawback" },
    });
    const preparer = await makeUser(ORG, "preparer", ["payout.prepare"]);

    const result = await prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, preparer.id, "preparer") });
    const line = await db.payoutLine.findFirstOrThrow({ where: { batchId: result.batchId, associateId: employee.id } });
    expect(line.recoveryAdjustment.toString()).toBe("50000"); // capped at 50% of 100000, not the full 80000
    expect(line.netPayable.toString()).toBe("50000");

    const recovery = await db.recovery.findFirstOrThrow({ where: { associateId: employee.id } });
    expect(recovery.recoveredAmount.toString()).toBe("50000");
    expect(recovery.outstandingAmount.toString()).toBe("30000");
    expect(recovery.status).toBe("PARTIALLY_RECOVERED");
  });

  it("fully recovers a small outstanding recovery without hitting the cap", async () => {
    const { booking, scheme } = await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "emp", "EMPLOYEE");
    await db.taxRate.create({ data: { orgId: ORG, section: "SEC_192", ratePct: "0", validFrom: new Date("2020-01-01") } });
    await seedEntry(ORG, booking.id, scheme.id, employee.id, "100000", new Date("2026-01-15"));
    await db.recovery.create({
      data: { orgId: ORG, associateId: employee.id, amount: "10000", outstandingAmount: "10000", reason: "test clawback" },
    });
    const preparer = await makeUser(ORG, "preparer", ["payout.prepare"]);

    const result = await prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, preparer.id, "preparer") });
    const line = await db.payoutLine.findFirstOrThrow({ where: { batchId: result.batchId, associateId: employee.id } });
    expect(line.recoveryAdjustment.toString()).toBe("10000");

    const recovery = await db.recovery.findFirstOrThrow({ where: { associateId: employee.id } });
    expect(recovery.status).toBe("RECOVERED");
    expect(recovery.outstandingAmount.toString()).toBe("0");
  });
});

describe("approveBatch: maker-checker", () => {
  it("refuses the same preparer approving their own batch", async () => {
    const { booking, scheme } = await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "emp", "EMPLOYEE");
    await db.taxRate.create({ data: { orgId: ORG, section: "SEC_192", ratePct: "10.00", validFrom: new Date("2020-01-01") } });
    await seedEntry(ORG, booking.id, scheme.id, employee.id, "50000", new Date("2026-01-15"));
    const both = await makeUser(ORG, "both", ["payout.prepare", "payout.approve"]);

    const result = await prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, both.id, "both") });
    await expect(
      approveBatch(db, { batchId: result.batchId, audit: ctx(ORG, both.id, "both") }),
    ).rejects.toThrow(PayoutMakerCheckerViolationError);
  });

  it("a DIFFERENT approver marks the batch APPROVED and its entries PAID", async () => {
    const { booking, scheme } = await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "emp", "EMPLOYEE");
    await db.taxRate.create({ data: { orgId: ORG, section: "SEC_192", ratePct: "10.00", validFrom: new Date("2020-01-01") } });
    const entry = await seedEntry(ORG, booking.id, scheme.id, employee.id, "50000", new Date("2026-01-15"));
    const preparer = await makeUser(ORG, "preparer", ["payout.prepare"]);
    const approver = await makeUser(ORG, "approver", ["payout.approve"]);

    const result = await prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, preparer.id, "preparer") });
    const approved = await approveBatch(db, { batchId: result.batchId, audit: ctx(ORG, approver.id, "approver") });
    expect(approved.status).toBe("APPROVED");
    expect(approved.approvedById).toBe(approver.id);

    const refreshedEntry = await db.commissionEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(refreshedEntry.status).toBe("PAID");
    expect(refreshedEntry.paidAt).not.toBeNull();
  });

  it("refuses to approve a batch that is not DRAFT (no double-approve)", async () => {
    const { booking, scheme } = await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "emp", "EMPLOYEE");
    await db.taxRate.create({ data: { orgId: ORG, section: "SEC_192", ratePct: "10.00", validFrom: new Date("2020-01-01") } });
    await seedEntry(ORG, booking.id, scheme.id, employee.id, "50000", new Date("2026-01-15"));
    const preparer = await makeUser(ORG, "preparer", ["payout.prepare"]);
    const approver = await makeUser(ORG, "approver", ["payout.approve"]);

    const result = await prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, preparer.id, "preparer") });
    await approveBatch(db, { batchId: result.batchId, audit: ctx(ORG, approver.id, "approver") });

    await expect(
      approveBatch(db, { batchId: result.batchId, audit: ctx(ORG, approver.id, "approver") }),
    ).rejects.toThrow(PayoutBatchNotApprovableError);
  });

  it("refuses a batch belonging to another organisation", async () => {
    await seedBookingAndScheme(ORG);
    const { booking: otherBooking, scheme: otherScheme } = await seedBookingAndScheme(OTHER_ORG);
    const otherEmployee = await makeAssociate(OTHER_ORG, "emp", "EMPLOYEE");
    await db.taxRate.create({ data: { orgId: OTHER_ORG, section: "SEC_192", ratePct: "10.00", validFrom: new Date("2020-01-01") } });
    await seedEntry(OTHER_ORG, otherBooking.id, otherScheme.id, otherEmployee.id, "50000", new Date("2026-01-15"));
    const otherPreparer = await makeUser(OTHER_ORG, "preparer", ["payout.prepare"]);
    const approver = await makeUser(ORG, "approver", ["payout.approve"]);

    const result = await prepareBatch(db, { orgId: OTHER_ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(OTHER_ORG, otherPreparer.id, "preparer") });
    await expect(
      approveBatch(db, { batchId: result.batchId, audit: ctx(ORG, approver.id, "approver") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("exportBatch: structural stub", () => {
  it("sets a stub bankFileStorageKey and moves the batch to EXPORTED", async () => {
    const { booking, scheme } = await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "emp", "EMPLOYEE");
    await db.taxRate.create({ data: { orgId: ORG, section: "SEC_192", ratePct: "10.00", validFrom: new Date("2020-01-01") } });
    await seedEntry(ORG, booking.id, scheme.id, employee.id, "50000", new Date("2026-01-15"));
    const preparer = await makeUser(ORG, "preparer", ["payout.prepare"]);
    const approver = await makeUser(ORG, "approver", ["payout.approve", "payout.export"]);

    const result = await prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, preparer.id, "preparer") });
    await approveBatch(db, { batchId: result.batchId, audit: ctx(ORG, approver.id, "approver") });
    const exported = await exportBatch(db, { batchId: result.batchId, audit: ctx(ORG, approver.id, "approver") });

    expect(exported.status).toBe("EXPORTED");
    expect(exported.bankFileStorageKey).toBe(`stub/payout-batches/${result.batchId}.bank-file`);
  });
});

describe("audit: prepare and approve each write a row", () => {
  it("writes CREATE on prepare and APPROVE on approve", async () => {
    const { booking, scheme } = await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "emp", "EMPLOYEE");
    await db.taxRate.create({ data: { orgId: ORG, section: "SEC_192", ratePct: "10.00", validFrom: new Date("2020-01-01") } });
    await seedEntry(ORG, booking.id, scheme.id, employee.id, "50000", new Date("2026-01-15"));
    const preparer = await makeUser(ORG, "preparer", ["payout.prepare"]);
    const approver = await makeUser(ORG, "approver", ["payout.approve"]);

    const result = await prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, preparer.id, "preparer") });
    await approveBatch(db, { batchId: result.batchId, audit: ctx(ORG, approver.id, "approver") });

    expect(await db.auditLog.count({ where: { entity: "PayoutBatch", entityId: result.batchId, action: "CREATE" } })).toBe(1);
    expect(await db.auditLog.count({ where: { entity: "PayoutBatch", entityId: result.batchId, action: "APPROVE" } })).toBe(1);
  });
});
