// Payout batch -- Phase 3 Slice 4. Runs against real Postgres, working
// directly off pre-seeded PAYABLE CommissionEntry/Recovery/TaxRate rows (the
// same posture as receipts.test.ts's own fixture) -- accrual correctness
// itself is commission.test.ts's job, not this file's.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import { encryptField } from "../src/encryption";
import {
  DuplicatePayoutPeriodError,
  NoTaxRateConfiguredError,
  PayoutBatchNotApprovableError,
  PayoutLineNotFoundError,
  PayoutMakerCheckerViolationError,
  RecoveryAlreadyResolvedError,
  RecoveryNotFoundError,
  approveBatch,
  exportBatch,
  getPayoutBatch,
  getPayoutLineStatement,
  listAdjustments,
  listPayoutBatches,
  listRecoveries,
  prepareBatch,
  writeOffRecovery,
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
    await db.adjustment.deleteMany({ where: { orgId } });
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
    await db.associateHierarchy.deleteMany({ where: { associate: { orgId } } });
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

async function makeAssociate(
  orgId: string,
  label: string,
  engagementType: "EMPLOYEE" | "CONSULTANT" | "CHANNEL_PARTNER",
  opts: { isGstRegistered?: boolean; hasPan?: boolean; bankAccountNumber?: string; bankIfsc?: string; bankName?: string } = {},
) {
  const user = await makeUser(orgId, label, []);
  return db.associate.create({
    data: {
      orgId, userId: user.id, code: `A-${label}`, engagementType, joinDate: new Date("2020-01-01"),
      status: "ACTIVE", isGstRegistered: opts.isGstRegistered ?? false,
      panEncrypted: opts.hasPan ? encryptField("ABCDE1234F") : undefined,
      bankAccountEncrypted: opts.bankAccountNumber ? encryptField(opts.bankAccountNumber) : undefined,
      bankIfsc: opts.bankIfsc,
      bankName: opts.bankName,
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

async function renameRole(orgId: string, fromCode: string, toCode: string) {
  const role = await db.role.findFirstOrThrow({ where: { orgId, code: fromCode } });
  await db.role.update({ where: { id: role.id }, data: { code: toCode } });
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

  it("applies the higher Sec. 206AA rate when the beneficiary has no PAN on file", async () => {
    const { booking, scheme } = await seedBookingAndScheme(ORG);
    const noPan = await makeAssociate(ORG, "nopan", "EMPLOYEE", { hasPan: false });
    await db.taxRate.create({ data: { orgId: ORG, section: "SEC_192", ratePct: "10.00", noPanRatePct: "20.00", validFrom: new Date("2020-01-01") } });
    await seedEntry(ORG, booking.id, scheme.id, noPan.id, "50000", new Date("2026-01-15"));
    const preparer = await makeUser(ORG, "preparer", ["payout.prepare"]);

    const result = await prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, preparer.id, "preparer") });
    const line = await db.payoutLine.findFirstOrThrow({ where: { batchId: result.batchId, associateId: noPan.id } });
    expect(line.tdsRatePct.toString()).toBe("20");
    expect(line.tdsAmount.toString()).toBe("10000"); // 20% of 50000, not 10%
  });

  it("uses the base rate when the beneficiary HAS a PAN on file, even if a no-PAN rate is configured", async () => {
    const { booking, scheme } = await seedBookingAndScheme(ORG);
    const hasPan = await makeAssociate(ORG, "haspan", "EMPLOYEE", { hasPan: true });
    await db.taxRate.create({ data: { orgId: ORG, section: "SEC_192", ratePct: "10.00", noPanRatePct: "20.00", validFrom: new Date("2020-01-01") } });
    await seedEntry(ORG, booking.id, scheme.id, hasPan.id, "50000", new Date("2026-01-15"));
    const preparer = await makeUser(ORG, "preparer", ["payout.prepare"]);

    const result = await prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, preparer.id, "preparer") });
    const line = await db.payoutLine.findFirstOrThrow({ where: { batchId: result.batchId, associateId: hasPan.id } });
    expect(line.tdsRatePct.toString()).toBe("10");
    expect(line.tdsAmount.toString()).toBe("5000");
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

describe("exportBatch: real CSVs, split by destination (Phase 4 -- confirmed gap)", () => {
  it("routes an EMPLOYEE line to the payroll handoff CSV, not the bank file", async () => {
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
    expect(exported.bankFileLineCount).toBe(0);
    expect(exported.payrollLineCount).toBe(1);
    expect(exported.payrollHandoffCsv).toContain("emp");
    expect(exported.bankFileCsv).not.toContain("emp");
    // Real, not a fake stub -- still a queryable reference, not blob storage.
    expect(exported.bankFileStorageKey).toContain(result.batchId);
  });

  it("routes a CONSULTANT line to the bank file with the decrypted account number, and audits the reveal", async () => {
    const { booking, scheme } = await seedBookingAndScheme(ORG);
    const consultant = await makeAssociate(ORG, "cons", "CONSULTANT", { bankAccountNumber: "000111222333", bankIfsc: "HDFC0001234", bankName: "HDFC Bank" });
    await db.taxRate.create({ data: { orgId: ORG, section: "SEC_194J", ratePct: "10.00", validFrom: new Date("2020-01-01") } });
    await seedEntry(ORG, booking.id, scheme.id, consultant.id, "50000", new Date("2026-01-15"));
    const preparer = await makeUser(ORG, "preparer", ["payout.prepare"]);
    const approver = await makeUser(ORG, "approver", ["payout.approve", "payout.export"]);

    const result = await prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, preparer.id, "preparer") });
    await approveBatch(db, { batchId: result.batchId, audit: ctx(ORG, approver.id, "approver") });
    const exported = await exportBatch(db, { batchId: result.batchId, audit: ctx(ORG, approver.id, "approver") });

    expect(exported.bankFileLineCount).toBe(1);
    expect(exported.payrollLineCount).toBe(0);
    expect(exported.bankFileCsv).toContain("000111222333");
    expect(exported.bankFileCsv).toContain("HDFC0001234");
    expect(exported.bankFileCsv).toContain("HDFC Bank");

    const revealRow = await db.auditLog.findFirstOrThrow({
      where: { entity: "Associate", entityId: consultant.id, action: "VIEW_SENSITIVE" },
    });
    expect(revealRow.reason).toContain(result.batchNumber);
  });

  it("refuses without payout.export", async () => {
    const { booking, scheme } = await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "emp", "EMPLOYEE");
    await db.taxRate.create({ data: { orgId: ORG, section: "SEC_192", ratePct: "10.00", validFrom: new Date("2020-01-01") } });
    await seedEntry(ORG, booking.id, scheme.id, employee.id, "50000", new Date("2026-01-15"));
    const preparer = await makeUser(ORG, "preparer", ["payout.prepare"]);

    const result = await prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, preparer.id, "preparer") });
    await expect(exportBatch(db, { batchId: result.batchId, audit: ctx(ORG, preparer.id, "preparer") })).rejects.toThrow(ForbiddenError);
  });

  it("refuses a batch that is not yet APPROVED", async () => {
    const { booking, scheme } = await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "emp", "EMPLOYEE");
    await db.taxRate.create({ data: { orgId: ORG, section: "SEC_192", ratePct: "10.00", validFrom: new Date("2020-01-01") } });
    await seedEntry(ORG, booking.id, scheme.id, employee.id, "50000", new Date("2026-01-15"));
    const preparer = await makeUser(ORG, "preparer", ["payout.prepare", "payout.export"]);

    const result = await prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, preparer.id, "preparer") });
    await expect(exportBatch(db, { batchId: result.batchId, audit: ctx(ORG, preparer.id, "preparer") })).rejects.toThrow("cannot be exported from status DRAFT");
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

describe("listPayoutBatches / getPayoutBatch (Phase 3.5 Slice 14 -- confirmed gap, no read existed at all)", () => {
  it("lists batches for the org and returns one batch's lines with associate info", async () => {
    const { booking, scheme } = await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "emp", "EMPLOYEE");
    await db.taxRate.create({ data: { orgId: ORG, section: "SEC_192", ratePct: "10.00", validFrom: new Date("2020-01-01") } });
    await seedEntry(ORG, booking.id, scheme.id, employee.id, "50000", new Date("2026-01-15"));
    const preparer = await makeUser(ORG, "preparer", ["payout.prepare"]);

    const result = await prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, preparer.id, "preparer") });

    const batches = await listPayoutBatches(db, { orgId: ORG, actorId: preparer.id });
    expect(batches.map((b) => b.id)).toEqual([result.batchId]);

    const detail = await getPayoutBatch(db, { orgId: ORG, actorId: preparer.id, batchId: result.batchId });
    expect(detail?.lines).toHaveLength(1);
    expect(detail?.lines[0]!.associate.code).toBe(employee.code);
  });

  it("getPayoutBatch returns null for a batch in another org", async () => {
    const other = await seedBookingAndScheme(OTHER_ORG);
    const otherEmployee = await makeAssociate(OTHER_ORG, "otheremp", "EMPLOYEE");
    await db.taxRate.create({ data: { orgId: OTHER_ORG, section: "SEC_192", ratePct: "10.00", validFrom: new Date("2020-01-01") } });
    await seedEntry(OTHER_ORG, other.booking.id, other.scheme.id, otherEmployee.id, "50000", new Date("2026-01-15"));
    const otherPreparer = await makeUser(OTHER_ORG, "otherpreparer", ["payout.prepare"]);
    const otherResult = await prepareBatch(db, { orgId: OTHER_ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(OTHER_ORG, otherPreparer.id, "preparer") });

    await seedBookingAndScheme(ORG);
    const preparer = await makeUser(ORG, "preparer", ["payout.prepare"]);
    const detail = await getPayoutBatch(db, { orgId: ORG, actorId: preparer.id, batchId: otherResult.batchId });
    expect(detail).toBeNull();
  });

  it("refuses without payout.prepare", async () => {
    await seedBookingAndScheme(ORG);
    const noPerms = await makeUser(ORG, "noperms2", []);
    await expect(listPayoutBatches(db, { orgId: ORG, actorId: noPerms.id })).rejects.toThrow(ForbiddenError);
  });
});

describe("listRecoveries / listAdjustments (Phase 3.5 Slice 14 -- confirmed gap)", () => {
  it("lists recoveries for the org with associate info", async () => {
    await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "recemp", "EMPLOYEE");
    const recovery = await db.recovery.create({
      data: { orgId: ORG, associateId: employee.id, amount: "1000", outstandingAmount: "1000", reason: "Booking cancelled" },
    });
    const preparer = await makeUser(ORG, "recpreparer", ["payout.prepare"]);

    const rows = await listRecoveries(db, { orgId: ORG, actorId: preparer.id });
    expect(rows.map((r) => r.id)).toEqual([recovery.id]);
    expect(rows[0]!.associate.code).toBe(employee.code);
  });

  it("filters recoveries by status", async () => {
    await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "recemp2", "EMPLOYEE");
    const outstanding = await db.recovery.create({
      data: { orgId: ORG, associateId: employee.id, amount: "1000", outstandingAmount: "1000", reason: "x", status: "OUTSTANDING" },
    });
    await db.recovery.create({
      data: { orgId: ORG, associateId: employee.id, amount: "500", outstandingAmount: "0", reason: "y", status: "RECOVERED" },
    });
    const preparer = await makeUser(ORG, "recpreparer2", ["payout.prepare"]);

    const rows = await listRecoveries(db, { orgId: ORG, actorId: preparer.id, status: "OUTSTANDING" });
    expect(rows.map((r) => r.id)).toEqual([outstanding.id]);
  });

  it("lists adjustments for the org with associate info", async () => {
    await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "adjemp", "EMPLOYEE");
    const adjustment = await db.adjustment.create({
      data: { orgId: ORG, associateId: employee.id, type: "CREDIT", amount: "2000", reason: "Migrated opening balance", requestedById: "u_test" },
    });
    const preparer = await makeUser(ORG, "adjpreparer", ["payout.prepare"]);

    const rows = await listAdjustments(db, { orgId: ORG, actorId: preparer.id });
    expect(rows.map((r) => r.id)).toEqual([adjustment.id]);
    expect(rows[0]!.associate.code).toBe(employee.code);
  });

  it("refuses without payout.prepare", async () => {
    await seedBookingAndScheme(ORG);
    const noPerms = await makeUser(ORG, "noperms3", []);
    await expect(listRecoveries(db, { orgId: ORG, actorId: noPerms.id })).rejects.toThrow(ForbiddenError);
    await expect(listAdjustments(db, { orgId: ORG, actorId: noPerms.id })).rejects.toThrow(ForbiddenError);
  });
});

describe("writeOffRecovery (Phase 4 -- confirmed gap: recovery.write_off + RecoveryStatus.WRITTEN_OFF existed, nothing implemented it)", () => {
  it("writes off an outstanding recovery, zeroing the outstanding amount", async () => {
    await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "woemp", "EMPLOYEE");
    const recovery = await db.recovery.create({
      data: { orgId: ORG, associateId: employee.id, amount: "5000", outstandingAmount: "5000", reason: "test clawback" },
    });
    const finance = await makeUser(ORG, "wofinance", ["recovery.write_off"]);

    const written = await writeOffRecovery(db, { recoveryId: recovery.id, reason: "Uncollectible, associate exited", audit: ctx(ORG, finance.id, "wofinance") });
    expect(written.status).toBe("WRITTEN_OFF");
    expect(written.outstandingAmount.toString()).toBe("0");
    expect(written.writtenOffById).toBe(finance.id);
    expect(written.writtenOffAt).not.toBeNull();

    const auditRow = await db.auditLog.findFirstOrThrow({ where: { entity: "Recovery", entityId: recovery.id, action: "UPDATE" } });
    expect(auditRow.reason).toBe("Uncollectible, associate exited");
  });

  it("refuses a recovery that is already RECOVERED or WRITTEN_OFF", async () => {
    await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "woemp2", "EMPLOYEE");
    const recovery = await db.recovery.create({
      data: { orgId: ORG, associateId: employee.id, amount: "5000", outstandingAmount: "0", status: "RECOVERED", reason: "test clawback" },
    });
    const finance = await makeUser(ORG, "wofinance2", ["recovery.write_off"]);

    await expect(
      writeOffRecovery(db, { recoveryId: recovery.id, reason: "x", audit: ctx(ORG, finance.id, "wofinance2") }),
    ).rejects.toThrow(RecoveryAlreadyResolvedError);
  });

  it("throws for a recovery that does not exist", async () => {
    await seedBookingAndScheme(ORG);
    const finance = await makeUser(ORG, "wofinance3", ["recovery.write_off"]);
    await expect(
      writeOffRecovery(db, { recoveryId: "nope", reason: "x", audit: ctx(ORG, finance.id, "wofinance3") }),
    ).rejects.toThrow(RecoveryNotFoundError);
  });

  it("refuses a recovery belonging to another organisation", async () => {
    await seedBookingAndScheme(ORG);
    await seedBookingAndScheme(OTHER_ORG);
    const otherEmployee = await makeAssociate(OTHER_ORG, "woother", "EMPLOYEE");
    const otherRecovery = await db.recovery.create({
      data: { orgId: OTHER_ORG, associateId: otherEmployee.id, amount: "5000", outstandingAmount: "5000", reason: "test clawback" },
    });
    const finance = await makeUser(ORG, "wofinance4", ["recovery.write_off"]);

    await expect(
      writeOffRecovery(db, { recoveryId: otherRecovery.id, reason: "x", audit: ctx(ORG, finance.id, "wofinance4") }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses without recovery.write_off", async () => {
    await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "woemp5", "EMPLOYEE");
    const recovery = await db.recovery.create({
      data: { orgId: ORG, associateId: employee.id, amount: "5000", outstandingAmount: "5000", reason: "test clawback" },
    });
    const noPerms = await makeUser(ORG, "wonoperms", []);

    await expect(
      writeOffRecovery(db, { recoveryId: recovery.id, reason: "x", audit: ctx(ORG, noPerms.id, "wonoperms") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("getPayoutLineStatement (Phase 4 -- data behind the commission statement PDF)", () => {
  async function grantPermission(roleCode: string, permissionCode: string) {
    const role = await db.role.findFirstOrThrow({ where: { orgId: ORG, code: roleCode } });
    const [resource, action] = permissionCode.split(".");
    const perm = await db.permission.upsert({
      where: { code: permissionCode },
      update: {},
      create: { code: permissionCode, resource: resource!, action: action! },
    });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  }

  async function seedStatementFixture() {
    const { booking, scheme } = await seedBookingAndScheme(ORG);
    const employee = await makeAssociate(ORG, "stmt", "EMPLOYEE");
    await renameRole(ORG, "ROLE_stmt", "ASSOCIATE");
    await grantPermission("ASSOCIATE", "commission.read");
    await db.taxRate.create({ data: { orgId: ORG, section: "SEC_192", ratePct: "10.00", validFrom: new Date("2020-01-01") } });
    await seedEntry(ORG, booking.id, scheme.id, employee.id, "50000", new Date("2026-01-15"));
    const preparer = await makeUser(ORG, "stmtpreparer", ["payout.prepare"]);
    const result = await prepareBatch(db, { orgId: ORG, periodStart: PERIOD_START, periodEnd: PERIOD_END, audit: ctx(ORG, preparer.id, "preparer") });
    const line = await db.payoutLine.findFirstOrThrow({ where: { batchId: result.batchId, associateId: employee.id } });
    return { employee, line, batchNumber: result.batchNumber };
  }

  it("returns the line, its batch, and the commission entries backing it, for the beneficiary's own user", async () => {
    const f = await seedStatementFixture();
    const employeeUser = await db.user.findFirstOrThrow({ where: { orgId: ORG, email: `stmt-${ORG}@test.local` } });

    const statement = await getPayoutLineStatement(db, { orgId: ORG, actorId: employeeUser.id, payoutLineId: f.line.id });
    expect(statement.line.id).toBe(f.line.id);
    expect(statement.batch.batchNumber).toBe(f.batchNumber);
    expect(statement.entries).toHaveLength(1);
    expect(statement.entries[0]!.entry.grossAmount.toString()).toBe("50000");
  });

  it("an admin-shaped role may view any line in the org", async () => {
    const f = await seedStatementFixture();
    const admin = await makeUser(ORG, "stmtadmin", ["commission.read"]);
    await renameRole(ORG, "ROLE_stmtadmin", "SUPER_ADMIN");

    const statement = await getPayoutLineStatement(db, { orgId: ORG, actorId: admin.id, payoutLineId: f.line.id });
    expect(statement.line.id).toBe(f.line.id);
  });

  it("refuses a stranger with no relation to the beneficiary", async () => {
    const f = await seedStatementFixture();
    const stranger = await makeUser(ORG, "stmtstranger", ["commission.read"]);

    await expect(
      getPayoutLineStatement(db, { orgId: ORG, actorId: stranger.id, payoutLineId: f.line.id }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("throws for a payout line that does not exist", async () => {
    await seedBookingAndScheme(ORG);
    const admin = await makeUser(ORG, "stmtadmin2", ["commission.read"]);
    await renameRole(ORG, "ROLE_stmtadmin2", "SUPER_ADMIN");

    await expect(
      getPayoutLineStatement(db, { orgId: ORG, actorId: admin.id, payoutLineId: "nope" }),
    ).rejects.toThrow(PayoutLineNotFoundError);
  });
});
