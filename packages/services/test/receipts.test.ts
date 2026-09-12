// Receipts: entry, the maker-checker verify GATE, clearance triggering
// commission release, allocation, bounce reversal -- Phase 2 Slice 5. Runs
// against LOCAL Docker Postgres -- the GATE's three assertions, the
// pro-rata release math, the allocation invariants, and bounce's reversal
// cascade are exactly what is under test. No commission-accrual service
// exists anywhere in this codebase yet (Phase 3, not this slice), so
// CommissionEntry rows are seeded directly, same as cancellation.test.ts.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import { acquireHold } from "../src/holds";
import { confirmBooking, createDraftBooking } from "../src/bookings";
import { createPaymentPlan, raiseDemand } from "../src/payment-plans";
import {
  AllocationDemandNotFoundError,
  AllocationExceedsDemandError,
  AllocationExceedsReceiptError,
  BounceReasonRequiredError,
  DemandNotRaisedError,
  InvalidReceiptStateError,
  ReceiptNotFoundError,
  SameEntererVerifierError,
  SellerOrUplineVerifyError,
  allocateReceipt,
  bounceReceipt,
  clearReceipt,
  enterReceipt,
  verifyReceipt,
} from "../src/receipts";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_receipts";
const OTHER_ORG = "org_test_receipts_other";
const D = (v: string | number) => new Prisma.Decimal(v);

async function reset() {
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.receiptAllocation.deleteMany({ where: { receipt: { orgId } } });
    await db.receipt.deleteMany({ where: { orgId } });
    await db.commissionRelease.deleteMany({ where: { entry: { orgId } } });
    await db.commissionEntry.deleteMany({ where: { orgId } });
    await db.payoutScheduleSlab.deleteMany({ where: { schedule: { scheme: { orgId } } } });
    await db.payoutSchedule.deleteMany({ where: { scheme: { orgId } } });
    await db.commissionScheme.deleteMany({ where: { orgId } });
    await db.demand.deleteMany({ where: { orgId } });
    await db.costSheetLine.deleteMany({ where: { booking: { orgId } } });
    await db.bookingStatusHistory.deleteMany({ where: { booking: { orgId } } });
    await db.booking.deleteMany({ where: { orgId } });
    await db.paymentPlanMilestone.deleteMany({ where: { paymentPlan: { orgId } } });
    await db.paymentPlan.deleteMany({ where: { orgId } });
    await db.customer.deleteMany({ where: { orgId } });
    await db.auditLog.deleteMany({ where: { orgId } });
    await db.unitStatusHistory.deleteMany({ where: { unit: { orgId } } });
    await db.unitHold.deleteMany({ where: { orgId } });
    await db.unit.deleteMany({ where: { orgId } });
    await db.priceListItem.deleteMany({ where: { priceList: { orgId } } });
    await db.priceList.deleteMany({ where: { orgId } });
    await db.chargeHead.deleteMany({ where: { orgId } });
    await db.unitType.deleteMany({ where: { orgId } });
    await db.associateHierarchy.deleteMany({ where: { associate: { orgId } } });
    await db.associateGrade.deleteMany({ where: { associate: { orgId } } });
    await db.associate.deleteMany({ where: { orgId } });
    await db.userRole.deleteMany({ where: { role: { orgId } } });
    await db.rolePermission.deleteMany({ where: { role: { orgId } } });
    await db.role.deleteMany({ where: { orgId } });
    await db.user.deleteMany({ where: { orgId } });
    await db.project.deleteMany({ where: { orgId } });
    await db.grade.deleteMany({ where: { orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
  }
  // Permission is global config -- upsert-if-missing only, never deleted
  // here (the parallel-test-file race this project already found and fixed).
}

async function makeUser(orgId: string, label: string, codes: string[], opts: { associate?: boolean } = {}) {
  const user = await db.user.create({
    data: { orgId, email: `${label}-${orgId}@test.local`, name: label, passwordHash: "unused" },
  });
  const role = await db.role.create({ data: { orgId, code: `ROLE_${label}`, name: label } });
  for (const code of codes) {
    const [resource, action] = code.split(".");
    const perm = await db.permission.upsert({
      where: { code },
      update: {},
      create: { code, resource: resource!, action: action! },
    });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  }
  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });

  let associate = null;
  if (opts.associate) {
    const grade = await db.grade.upsert({
      where: { orgId_code: { orgId, code: "GT" } },
      update: {},
      create: { orgId, code: "GT", name: "Test Grade", rank: 1, holdQuota: 5 },
    });
    associate = await db.associate.create({
      data: { orgId, userId: user.id, code: `A-${label}`, engagementType: "EMPLOYEE", joinDate: new Date("2024-01-01") },
    });
    await db.associateGrade.create({ data: { associateId: associate.id, gradeId: grade.id, validFrom: new Date("2024-01-01") } });
  }
  return { user, associate };
}

const FINANCE_PERMS = ["receipt.enter", "receipt.verify", "booking.create", "booking.confirm", "hold.create", "project.write", "demand.raise"];

async function seedFixture(orgId: string = ORG) {
  await db.organization.create({ data: { id: orgId, name: "Receipts Test Org", legalName: "Receipts Test Org Pvt Ltd" } });
  const project = await db.project.create({
    data: {
      orgId, code: "SKY", name: "Skyline", city: "Pune", state: "Maharashtra",
      reraRegNo: "P-TEST-0001", reraValidTill: new Date("2030-01-01"),
      holdTtlMinutes: 60, holdExtensionMinutes: 30, maxHoldExtensions: 1,
    },
  });
  const unitType = await db.unitType.create({
    data: { orgId, projectId: project.id, code: "2BHK", name: "2BHK", carpetArea: "650.00", builtUpArea: "780.00", saleableArea: "975.00" },
  });
  const unit = await db.unit.create({ data: { orgId, projectId: project.id, unitTypeId: unitType.id, unitNumber: "A-1", floor: 1 } });
  await db.chargeHead.create({
    data: { orgId, code: "BSP", name: "Basic Sale Price", category: "BASE_PRICE", isTaxable: true, gstRatePct: "5.00", countsTowardCommission: true, isRefundable: false, displayOrder: 1 },
  });
  const priceList = await db.priceList.create({
    data: {
      orgId, projectId: project.id, version: 1, name: "v1", status: "ACTIVE",
      validFrom: new Date("2020-01-01"), preparedById: "u_test",
      items: { create: [{ unitTypeId: unitType.id, baseRatePerSqft: "5000.00", plcCharges: {}, otherCharges: [] }] },
    },
  });
  const customer = await db.customer.create({ data: { orgId, name: "Test Buyer", phone: "9999999999" } });

  const admin = await makeUser(orgId, "admin", FINANCE_PERMS);
  // Seller and upline sit in a real hierarchy: upline is seller's parent.
  const seller = await makeUser(orgId, "seller", ["booking.create", "hold.create"], { associate: true });
  const upline = await makeUser(orgId, "upline", ["receipt.verify"], { associate: true });
  const downline = await makeUser(orgId, "downline", ["receipt.verify"], { associate: true });
  const stranger = await makeUser(orgId, "stranger", ["receipt.verify"], { associate: true });

  await db.associateHierarchy.create({ data: { associateId: upline.associate!.id, parentId: null, path: "/", depth: 0, validFrom: new Date("2024-01-01") } });
  await db.associateHierarchy.create({
    data: { associateId: seller.associate!.id, parentId: upline.associate!.id, path: `/${upline.associate!.id}/`, depth: 1, validFrom: new Date("2024-01-01") },
  });
  await db.associateHierarchy.create({
    data: { associateId: downline.associate!.id, parentId: seller.associate!.id, path: `/${upline.associate!.id}/${seller.associate!.id}/`, depth: 2, validFrom: new Date("2024-01-01") },
  });
  await db.associateHierarchy.create({ data: { associateId: stranger.associate!.id, parentId: null, path: "/", depth: 0, validFrom: new Date("2024-01-01") } });

  const scheme = await db.commissionScheme.create({
    data: {
      orgId, projectId: project.id, name: "Standard", version: 1, status: "ACTIVE",
      validFrom: new Date("2020-01-01"), baseDefinition: { chargeHeadCodes: ["BSP"] }, preparedById: admin.user.id,
    },
  });
  await db.payoutSchedule.create({ data: { schemeId: scheme.id, mode: "PRO_RATA_COLLECTION", name: "Pro-rata on collection" } });

  const milestoneScheme = await db.commissionScheme.create({
    data: {
      orgId, projectId: project.id, name: "Milestone", version: 2, status: "ACTIVE",
      validFrom: new Date("2020-01-01"), baseDefinition: { chargeHeadCodes: ["BSP"] }, preparedById: admin.user.id,
    },
  });
  await db.payoutSchedule.create({ data: { schemeId: milestoneScheme.id, mode: "MILESTONE", name: "Milestone-based" } });

  return { project, unitType, unit, priceList, customer, admin, seller, upline, downline, stranger, scheme, milestoneScheme };
}

function ctx(orgId: string, userId: string | null, label: string): AuditContext {
  return { orgId, actorId: userId, actorLabel: label };
}

async function seedPlan(f: Awaited<ReturnType<typeof seedFixture>>, orgId: string) {
  return createPaymentPlan(db, {
    code: "STD", name: "Standard 20-30-50", projectId: f.project.id,
    milestones: [
      { sequence: 1, label: "On booking", pctOfAgreementValue: "20", dueDaysOffset: 0 },
      { sequence: 2, label: "On foundation", pctOfAgreementValue: "30", dueDaysOffset: 60 },
      { sequence: 3, label: "On possession", pctOfAgreementValue: "50", dueDaysOffset: 365 },
    ],
    audit: ctx(orgId, f.admin.user.id, "admin"),
  });
}

async function confirmedBookingWithPlan(f: Awaited<ReturnType<typeof seedFixture>>, orgId: string, paymentPlanId: string, unitId?: string) {
  const targetUnitId = unitId ?? f.unit.id;
  await acquireHold(db, { orgId, unitId: targetUnitId, associateId: f.seller.associate!.id, audit: ctx(orgId, f.seller.user.id, "seller") });
  const draft = await createDraftBooking(db, {
    unitId: targetUnitId, priceListId: f.priceList.id, customerId: f.customer.id, paymentPlanId,
    audit: ctx(orgId, f.seller.user.id, "seller"),
  });
  return confirmBooking(db, { bookingId: draft.id, audit: ctx(orgId, f.admin.user.id, "admin") });
}

async function seedEntry(orgId: string, booking: { id: string }, schemeId: string, beneficiaryAssociateId: string, grossAmount: string) {
  return db.commissionEntry.create({
    data: {
      orgId, bookingId: booking.id, schemeId, beneficiaryAssociateId, role: "SELF", level: 0,
      baseAmount: D(grossAmount), grossAmount: D(grossAmount), status: "ACCRUED", snapshot: {},
      idempotencyKey: `${booking.id}:${beneficiaryAssociateId}:0:${schemeId}`,
    },
  });
}

async function raiseAllDemands(bookingId: string, adminUserId: string) {
  const demands = await db.demand.findMany({ where: { bookingId }, orderBy: { sequence: "asc" } });
  const raised = [];
  for (const d of demands) {
    raised.push(await raiseDemand(db, { demandId: d.id, audit: ctx(ORG, adminUserId, "admin") }));
  }
  return raised;
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("enterReceipt", () => {
  it("creates an ENTERED receipt with a generated receiptNumber", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);

    const receipt = await enterReceipt(db, {
      bookingId: confirmed.id, amount: "1196350", mode: "NEFT", receivedOn: new Date("2026-02-01"),
      audit: ctx(ORG, f.admin.user.id, "admin"),
    });
    expect(receipt.status).toBe("ENTERED");
    expect(receipt.receiptNumber).toMatch(/^RCPT-\d{6}$/);
    expect(receipt.enteredById).toBe(f.admin.user.id);
  });

  it("refuses without receipt.enter", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    await expect(
      enterReceipt(db, { bookingId: confirmed.id, amount: "1000", mode: "CASH", receivedOn: new Date(), audit: ctx(ORG, f.seller.user.id, "seller") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("verifyReceipt: the maker-checker GATE", () => {
  it("succeeds for a verifier unrelated to the seller", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: "1000", mode: "CASH", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });

    const verified = await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    expect(verified.status).toBe("VERIFIED");
    expect(verified.verifiedById).toBe(f.stranger.user.id);
  });

  it("a downline of the seller MAY verify -- only ancestors are excluded", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: "1000", mode: "CASH", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });

    const verified = await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.downline.user.id, "downline") });
    expect(verified.status).toBe("VERIFIED");
  });

  it("refuses the same person who entered it", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    // admin holds both receipt.enter and receipt.verify.
    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: "1000", mode: "CASH", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await expect(verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.admin.user.id, "admin") })).rejects.toThrow(SameEntererVerifierError);
  });

  it("refuses the booking's own selling associate", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: "1000", mode: "CASH", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await db.rolePermission.create({
      data: {
        roleId: (await db.role.findFirstOrThrow({ where: { orgId: ORG, code: "ROLE_seller" } })).id,
        permissionId: (await db.permission.upsert({ where: { code: "receipt.verify" }, update: {}, create: { code: "receipt.verify", resource: "receipt", action: "verify" } })).id,
      },
    });
    await expect(verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.seller.user.id, "seller") })).rejects.toThrow(SellerOrUplineVerifyError);
  });

  it("refuses an upline of the selling associate", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: "1000", mode: "CASH", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await expect(verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.upline.user.id, "upline") })).rejects.toThrow(SellerOrUplineVerifyError);
  });

  it("refuses without receipt.verify", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: "1000", mode: "CASH", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await expect(verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.seller.user.id, "seller") })).rejects.toThrow(ForbiddenError);
  });

  it("refuses a receipt that is not ENTERED", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: "1000", mode: "CASH", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await expect(verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") })).rejects.toThrow(InvalidReceiptStateError);
  });

  it("throws for a receipt that does not exist", async () => {
    const f = await seedFixture();
    await expect(verifyReceipt(db, { receiptId: "nope", audit: ctx(ORG, f.stranger.user.id, "stranger") })).rejects.toThrow(ReceiptNotFoundError);
  });
});

describe("clearReceipt: triggers pro-rata commission release", () => {
  it("releases exactly the cumulative percentage cleared-and-allocated so far", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    const entry = await seedEntry(ORG, confirmed, f.scheme.id, f.seller.associate!.id, "100000");
    await raiseAllDemands(confirmed.id, f.admin.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });

    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: d1!.amount.toString(), mode: "NEFT", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await allocateReceipt(db, { receiptId: receipt.id, allocations: [{ demandId: d1!.id, amount: d1!.amount }], audit: ctx(ORG, f.stranger.user.id, "stranger") });

    await clearReceipt(db, { receiptId: receipt.id, clearedOn: new Date("2026-03-01"), audit: ctx(ORG, f.stranger.user.id, "stranger") });

    // d1 is 20% of agreementValue -> cumulativeReleasePct = 20% -> 20% of the 100000 entry = 20000.
    const release = await db.commissionRelease.findFirstOrThrow({ where: { entryId: entry.id } });
    expect(release.amount.toString()).toBe("20000");
    expect(release.cumulativePct.toString()).toBe("20");

    const refreshedEntry = await db.commissionEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(refreshedEntry.status).toBe("PAYABLE");
  });

  it("a second cleared receipt releases only the incremental delta", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    const entry = await seedEntry(ORG, confirmed, f.scheme.id, f.seller.associate!.id, "100000");
    await raiseAllDemands(confirmed.id, f.admin.user.id);
    const [d1, d2] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });

    const r1 = await enterReceipt(db, { bookingId: confirmed.id, amount: d1!.amount.toString(), mode: "NEFT", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await verifyReceipt(db, { receiptId: r1.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await allocateReceipt(db, { receiptId: r1.id, allocations: [{ demandId: d1!.id, amount: d1!.amount }], audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await clearReceipt(db, { receiptId: r1.id, clearedOn: new Date("2026-03-01"), audit: ctx(ORG, f.stranger.user.id, "stranger") });

    const r2 = await enterReceipt(db, { bookingId: confirmed.id, amount: d2!.amount.toString(), mode: "NEFT", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await verifyReceipt(db, { receiptId: r2.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await allocateReceipt(db, { receiptId: r2.id, allocations: [{ demandId: d2!.id, amount: d2!.amount }], audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await clearReceipt(db, { receiptId: r2.id, clearedOn: new Date("2026-04-01"), audit: ctx(ORG, f.stranger.user.id, "stranger") });

    // Cumulative now 20% + 30% = 50% -> total released should be 50000, delta on r2 = 30000.
    const releases = await db.commissionRelease.findMany({ where: { entryId: entry.id }, orderBy: { releasedAt: "asc" } });
    expect(releases).toHaveLength(2);
    expect(releases[1]!.amount.toString()).toBe("30000");
    const total = releases.reduce((sum, r) => sum.plus(r.amount), D(0));
    expect(total.toString()).toBe("50000");
  });

  it("skips entries under a non-PRO_RATA_COLLECTION scheme", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    const milestoneEntry = await seedEntry(ORG, confirmed, f.milestoneScheme.id, f.seller.associate!.id, "50000");
    await raiseAllDemands(confirmed.id, f.admin.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });

    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: d1!.amount.toString(), mode: "NEFT", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await allocateReceipt(db, { receiptId: receipt.id, allocations: [{ demandId: d1!.id, amount: d1!.amount }], audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await clearReceipt(db, { receiptId: receipt.id, clearedOn: new Date(), audit: ctx(ORG, f.stranger.user.id, "stranger") });

    expect(await db.commissionRelease.count({ where: { entryId: milestoneEntry.id } })).toBe(0);
    const refreshed = await db.commissionEntry.findUniqueOrThrow({ where: { id: milestoneEntry.id } });
    expect(refreshed.status).toBe("ACCRUED");
  });

  it("refuses a receipt that is not VERIFIED", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: "1000", mode: "CASH", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await expect(clearReceipt(db, { receiptId: receipt.id, clearedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") })).rejects.toThrow(InvalidReceiptStateError);
  });
});

describe("allocateReceipt", () => {
  it("respects explicit allocations and updates demand status to PARTIALLY_PAID / PAID", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    await raiseAllDemands(confirmed.id, f.admin.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });

    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: d1!.amount.toString(), mode: "NEFT", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    const allocations = await allocateReceipt(db, { receiptId: receipt.id, allocations: [{ demandId: d1!.id, amount: d1!.amount }], audit: ctx(ORG, f.stranger.user.id, "stranger") });
    expect(allocations).toHaveLength(1);

    const refreshedDemand = await db.demand.findUniqueOrThrow({ where: { id: d1!.id } });
    expect(refreshedDemand.status).toBe("PAID");
  });

  it("auto-allocates oldest-unpaid-first when no explicit allocations are given", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    await raiseAllDemands(confirmed.id, f.admin.user.id);
    const [d1, d2] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });

    // Enough to fully pay d1 and partially pay d2.
    const amount = d1!.amount.plus(D("100000"));
    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: amount.toString(), mode: "NEFT", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    const allocations = await allocateReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });

    expect(allocations).toHaveLength(2);
    expect(allocations.find((a) => a.demandId === d1!.id)!.amount.toString()).toBe(d1!.amount.toString());
    expect(allocations.find((a) => a.demandId === d2!.id)!.amount.toString()).toBe("100000");
  });

  it("overflow beyond outstanding demands becomes Booking.creditBalance", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    await raiseAllDemands(confirmed.id, f.admin.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });

    const overpay = d1!.amount.plus(D("500"));
    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: overpay.toString(), mode: "NEFT", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await allocateReceipt(db, { receiptId: receipt.id, allocations: [{ demandId: d1!.id, amount: d1!.amount }], audit: ctx(ORG, f.stranger.user.id, "stranger") });

    const refreshedBooking = await db.booking.findUniqueOrThrow({ where: { id: confirmed.id } });
    expect(refreshedBooking.creditBalance.toString()).toBe("500");
  });

  it("refuses an allocation exceeding the receipt's own amount", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    await raiseAllDemands(confirmed.id, f.admin.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });

    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: "100", mode: "CASH", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await expect(
      allocateReceipt(db, { receiptId: receipt.id, allocations: [{ demandId: d1!.id, amount: "200" }], audit: ctx(ORG, f.stranger.user.id, "stranger") }),
    ).rejects.toThrow(AllocationExceedsReceiptError);
  });

  it("refuses an allocation exceeding the demand's outstanding balance", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    await raiseAllDemands(confirmed.id, f.admin.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });

    const tooMuch = d1!.amount.plus(D("1000"));
    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: tooMuch.toString(), mode: "CASH", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await expect(
      allocateReceipt(db, { receiptId: receipt.id, allocations: [{ demandId: d1!.id, amount: tooMuch.toString() }], audit: ctx(ORG, f.stranger.user.id, "stranger") }),
    ).rejects.toThrow(AllocationExceedsDemandError);
  });

  it("refuses allocating against a demand that has not been raised", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } }); // still SCHEDULED

    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: "100", mode: "CASH", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await expect(
      allocateReceipt(db, { receiptId: receipt.id, allocations: [{ demandId: d1!.id, amount: "100" }], audit: ctx(ORG, f.stranger.user.id, "stranger") }),
    ).rejects.toThrow(DemandNotRaisedError);
  });

  it("throws for a demand that does not exist", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: "100", mode: "CASH", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await expect(
      allocateReceipt(db, { receiptId: receipt.id, allocations: [{ demandId: "nope", amount: "100" }], audit: ctx(ORG, f.stranger.user.id, "stranger") }),
    ).rejects.toThrow(AllocationDemandNotFoundError);
  });

  it("refuses allocating against an ENTERED (not yet verified) receipt", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    await raiseAllDemands(confirmed.id, f.admin.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });
    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: "100", mode: "CASH", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await expect(
      allocateReceipt(db, { receiptId: receipt.id, allocations: [{ demandId: d1!.id, amount: "100" }], audit: ctx(ORG, f.stranger.user.id, "stranger") }),
    ).rejects.toThrow(InvalidReceiptStateError);
  });
});

describe("credit balance auto-applies to the next demand raised", () => {
  it("pulls room from a cleared receipt to pay down a newly-raised demand", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });
    await raiseDemand(db, { demandId: d1!.id, audit: ctx(ORG, f.admin.user.id, "admin") });

    const overpay = d1!.amount.plus(D("50000"));
    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: overpay.toString(), mode: "NEFT", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await allocateReceipt(db, { receiptId: receipt.id, allocations: [{ demandId: d1!.id, amount: d1!.amount }], audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await clearReceipt(db, { receiptId: receipt.id, clearedOn: new Date(), audit: ctx(ORG, f.stranger.user.id, "stranger") });

    let refreshedBooking = await db.booking.findUniqueOrThrow({ where: { id: confirmed.id } });
    expect(refreshedBooking.creditBalance.toString()).toBe("50000");

    const [, d2] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });
    const raisedD2 = await raiseDemand(db, { demandId: d2!.id, audit: ctx(ORG, f.admin.user.id, "admin") });

    expect(raisedD2.status).toBe("PARTIALLY_PAID");
    refreshedBooking = await db.booking.findUniqueOrThrow({ where: { id: confirmed.id } });
    expect(refreshedBooking.creditBalance.toString()).toBe("0");

    const d2Allocations = await db.receiptAllocation.findMany({ where: { demandId: d2!.id, reversedAt: null } });
    expect(d2Allocations).toHaveLength(1);
    expect(d2Allocations[0]!.amount.toString()).toBe("50000");
    expect(d2Allocations[0]!.receiptId).toBe(receipt.id);
  });
});

describe("bounceReceipt", () => {
  it("reverses allocations, reverts demand status, and reverses commission releases it triggered", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    const entry = await seedEntry(ORG, confirmed, f.scheme.id, f.seller.associate!.id, "100000");
    await raiseAllDemands(confirmed.id, f.admin.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });

    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: d1!.amount.toString(), mode: "CHEQUE", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await allocateReceipt(db, { receiptId: receipt.id, allocations: [{ demandId: d1!.id, amount: d1!.amount }], audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await clearReceipt(db, { receiptId: receipt.id, clearedOn: new Date(), audit: ctx(ORG, f.stranger.user.id, "stranger") });

    const bounced = await bounceReceipt(db, { receiptId: receipt.id, bounceReason: "Cheque bounced -- insufficient funds", audit: ctx(ORG, f.stranger.user.id, "stranger") });
    expect(bounced.status).toBe("BOUNCED");

    const allocation = await db.receiptAllocation.findFirstOrThrow({ where: { receiptId: receipt.id } });
    expect(allocation.reversedAt).not.toBeNull();

    const refreshedDemand = await db.demand.findUniqueOrThrow({ where: { id: d1!.id } });
    expect(refreshedDemand.status).toBe("RAISED");

    const release = await db.commissionRelease.findFirstOrThrow({ where: { entryId: entry.id } });
    expect(release.reversedAt).not.toBeNull();
  });

  it("claws back the portion of creditBalance that came from this receipt's overflow", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    await raiseAllDemands(confirmed.id, f.admin.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });

    const overpay = d1!.amount.plus(D("500"));
    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: overpay.toString(), mode: "CHEQUE", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await allocateReceipt(db, { receiptId: receipt.id, allocations: [{ demandId: d1!.id, amount: d1!.amount }], audit: ctx(ORG, f.stranger.user.id, "stranger") });

    let refreshedBooking = await db.booking.findUniqueOrThrow({ where: { id: confirmed.id } });
    expect(refreshedBooking.creditBalance.toString()).toBe("500");

    await bounceReceipt(db, { receiptId: receipt.id, bounceReason: "bounced", audit: ctx(ORG, f.stranger.user.id, "stranger") });

    refreshedBooking = await db.booking.findUniqueOrThrow({ where: { id: confirmed.id } });
    expect(refreshedBooking.creditBalance.toString()).toBe("0");
  });

  it("requires a reason", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: "100", mode: "CASH", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await expect(bounceReceipt(db, { receiptId: receipt.id, bounceReason: "  ", audit: ctx(ORG, f.stranger.user.id, "stranger") })).rejects.toThrow(BounceReasonRequiredError);
  });

  it("refuses a receipt still ENTERED (never verified)", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: "100", mode: "CASH", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await expect(bounceReceipt(db, { receiptId: receipt.id, bounceReason: "test", audit: ctx(ORG, f.stranger.user.id, "stranger") })).rejects.toThrow(InvalidReceiptStateError);
  });
});

describe("tenancy: cross-org receipt access is refused", () => {
  it("refuses verifying a receipt belonging to another org", async () => {
    const f = await seedFixture(ORG);
    const other = await seedFixture(OTHER_ORG);
    const otherPlan = await seedPlan(other, OTHER_ORG);
    const otherBooking = await confirmedBookingWithPlan(other, OTHER_ORG, otherPlan.id);
    const otherReceipt = await enterReceipt(db, { bookingId: otherBooking.id, amount: "100", mode: "CASH", receivedOn: new Date(), audit: ctx(OTHER_ORG, other.admin.user.id, "admin") });

    await expect(verifyReceipt(db, { receiptId: otherReceipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") })).rejects.toThrow(ForbiddenError);
  });
});

describe("audit: entry, verify, clear and bounce each write a row", () => {
  it("records the expected action for each transition", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f, ORG);
    const confirmed = await confirmedBookingWithPlan(f, ORG, plan.id);
    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: "100", mode: "CASH", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    expect(await db.auditLog.count({ where: { entity: "Receipt", entityId: receipt.id, action: "CREATE" } })).toBe(1);

    await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    expect(await db.auditLog.count({ where: { entity: "Receipt", entityId: receipt.id, action: "UPDATE" } })).toBe(1);

    await clearReceipt(db, { receiptId: receipt.id, clearedOn: new Date(), audit: ctx(ORG, f.stranger.user.id, "stranger") });
    expect(await db.auditLog.count({ where: { entity: "Receipt", entityId: receipt.id, action: "UPDATE" } })).toBe(2);

    await bounceReceipt(db, { receiptId: receipt.id, bounceReason: "test", audit: ctx(ORG, f.stranger.user.id, "stranger") });
    expect(await db.auditLog.count({ where: { entity: "Receipt", entityId: receipt.id, action: "UPDATE" } })).toBe(3);
  });
});
