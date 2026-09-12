// Release engine wiring -- Phase 3 Slice 3 (PROGRESS.md's "Release engine --
// all three modes"). PRO_RATA_COLLECTION is already covered by
// receipts.test.ts (Phase 2 Slice 5); this file covers the two modes Slice 3
// adds: ON_BOOKING (100% immediate, wired into accrueCommission itself) and
// MILESTONE (DEMAND_PAID-triggered, wired into receipts.ts's syncDemandStatus).
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, getPrismaClient } from "@desire/db";
import { acquireHold } from "../src/holds";
import { confirmBooking, createDraftBooking } from "../src/bookings";
import { createScheme, publishScheme } from "../src/schemes";
import { createPaymentPlan } from "../src/payment-plans";
import { enterReceipt, verifyReceipt, allocateReceipt } from "../src/receipts";
import type { ChargeHeadSpec } from "../src/cost-sheet";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_commission_release";
const D = (v: string | number) => new Prisma.Decimal(v);

async function reset() {
  await db.commissionRelease.deleteMany({ where: { entry: { orgId: ORG } } });
  await db.commissionEntry.deleteMany({ where: { orgId: ORG } });
  await db.payoutScheduleSlab.deleteMany({ where: { schedule: { scheme: { orgId: ORG } } } });
  await db.payoutSchedule.deleteMany({ where: { scheme: { orgId: ORG } } });
  await db.schemeLevelRate.deleteMany({ where: { scheme: { orgId: ORG } } });
  await db.schemeGradeRate.deleteMany({ where: { scheme: { orgId: ORG } } });
  await db.commissionScheme.deleteMany({ where: { orgId: ORG } });
  await db.receiptAllocation.deleteMany({ where: { receipt: { orgId: ORG } } });
  await db.receipt.deleteMany({ where: { orgId: ORG } });
  await db.demand.deleteMany({ where: { orgId: ORG } });
  await db.paymentPlanMilestone.deleteMany({ where: { paymentPlan: { orgId: ORG } } });
  await db.paymentPlan.deleteMany({ where: { orgId: ORG } });
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
  const user = await db.user.create({ data: { orgId: ORG, email: `${label}@test.local`, name: label, passwordHash: "unused" } });
  const role = await db.role.create({ data: { orgId: ORG, code: `ROLE_${label}`, name: label } });
  for (const code of codes) {
    const [resource, action] = code.split(".");
    const perm = await db.permission.upsert({ where: { code }, update: {}, create: { code, resource: resource!, action: action! } });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  }
  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });
  return user;
}

async function makeAssociate(label: string, codes: string[] = []) {
  const user = await makeUser(label, codes);
  const associate = await db.associate.create({
    data: { orgId: ORG, userId: user.id, code: `A-${label}`, engagementType: "EMPLOYEE", joinDate: new Date("2020-01-01"), status: "ACTIVE" },
  });
  return { user, associate };
}

/** 1000 sqft at ₹10,000/sqft, no PLC/other commissionable charges --
 *  commissionableValue lands on exactly ₹1,00,00,000, so a 1.5% self rate
 *  gives a round ₹1,50,000 to release against. */
async function seedFixture() {
  await db.organization.create({ data: { id: ORG, name: "Release Test Org", legalName: "Release Test Org Pvt Ltd" } });
  const project = await db.project.create({
    data: { orgId: ORG, code: "REL", name: "Release Project", city: "Pune", state: "Maharashtra", reraRegNo: "P-REL-1", reraValidTill: new Date("2030-01-01") },
  });
  const unitType = await db.unitType.create({
    data: { orgId: ORG, projectId: project.id, code: "3BHK", name: "3BHK", carpetArea: "700.00", builtUpArea: "850.00", saleableArea: "1000.00" },
  });

  const bspHead: ChargeHeadSpec & { isRefundable: boolean } = {
    code: "BSP", name: "Basic Sale Price", category: "BASE_PRICE", isTaxable: true, gstRatePct: D("5.00"), countsTowardCommission: true, displayOrder: 1, isRefundable: false,
  };
  await db.chargeHead.create({ data: { orgId: ORG, ...bspHead, gstRatePct: "5.00" } });

  const priceList = await db.priceList.create({
    data: {
      orgId: ORG, projectId: project.id, version: 1, name: "v1", status: "ACTIVE", validFrom: new Date("2020-01-01"), preparedById: "u_test",
      items: { create: [{ unitTypeId: unitType.id, baseRatePerSqft: "10000.00" }] },
    },
  });
  const customer = await db.customer.create({ data: { orgId: ORG, name: "Test Buyer", phone: "9999999999" } });

  const admin = await makeUser("admin", ["booking.create", "booking.confirm", "hold.create", "receipt.enter", "demand.raise", "project.write"]);
  const verifier = await makeUser("verifier", ["receipt.verify"]);
  const grade = await db.grade.create({ data: { orgId: ORG, code: "G4", name: "Manager", rank: 4 } });
  const { user: sellerUser, associate: seller } = await makeAssociate("seller", ["booking.create", "hold.create"]);
  await db.associateGrade.create({ data: { associateId: seller.id, gradeId: grade.id, validFrom: new Date("2020-01-01") } });

  const preparer = await makeUser("scheme_preparer", ["scheme.prepare"]);
  const approver = await makeUser("scheme_approver", ["scheme.approve"]);

  return { project, unitType, priceList, customer, admin, verifier, sellerUser, seller, grade, preparer, approver };
}

function ctx(userId: string | null, label: string): AuditContext {
  return { orgId: ORG, actorId: userId, actorLabel: label };
}

async function bookUnit(unitNumber: string, f: Awaited<ReturnType<typeof seedFixture>>, paymentPlanId?: string) {
  const unit = await db.unit.create({ data: { orgId: ORG, projectId: f.project.id, unitTypeId: f.unitType.id, unitNumber, floor: 1 } });
  await acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: f.seller.id, audit: ctx(f.sellerUser.id, "seller") });
  const draft = await createDraftBooking(db, {
    unitId: unit.id, priceListId: f.priceList.id, customerId: f.customer.id, paymentPlanId, audit: ctx(f.sellerUser.id, "seller"),
  });
  return confirmBooking(db, { bookingId: draft.id, audit: ctx(f.admin.id, "admin") });
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("ON_BOOKING: releases 100% immediately, in the same transaction as accrual", () => {
  it("creates a CommissionRelease at 100% and marks the entry PAYABLE", async () => {
    const f = await seedFixture();
    const draft = await createScheme(db, {
      projectId: f.project.id, name: "v1", validFrom: new Date("2020-01-01"),
      baseDefinition: { chargeHeadCodes: ["BSP"] }, maxTotalPct: "3.0",
      gradeRates: [{ gradeId: f.grade.id, rateValue: "1.5" }],
      audit: ctx(f.preparer.id, "preparer"),
    });
    await publishScheme(db, { schemeId: draft.schemeId, audit: ctx(f.approver.id, "approver") });
    await db.payoutSchedule.create({ data: { schemeId: draft.schemeId, mode: "ON_BOOKING", name: "Immediate" } });

    const confirmed = await bookUnit("R-1", f);

    const entry = await db.commissionEntry.findFirstOrThrow({ where: { bookingId: confirmed.id, role: "SELF" } });
    expect(entry.status).toBe("PAYABLE");
    expect(entry.grossAmount.toString()).toBe("150000");

    const release = await db.commissionRelease.findFirstOrThrow({ where: { entryId: entry.id } });
    expect(release.triggerType).toBe("BOOKING_CONFIRMED");
    expect(release.cumulativePct.toString()).toBe("100");
    expect(release.amount.toString()).toBe("150000");
  });
});

describe("MILESTONE: releases the correct cumulative pct as DEMAND_PAID slabs fire one at a time", () => {
  async function seedMilestoneScheme(f: Awaited<ReturnType<typeof seedFixture>>) {
    const draft = await createScheme(db, {
      projectId: f.project.id, name: "v1", validFrom: new Date("2020-01-01"),
      baseDefinition: { chargeHeadCodes: ["BSP"] }, maxTotalPct: "3.0",
      gradeRates: [{ gradeId: f.grade.id, rateValue: "1.5" }],
      audit: ctx(f.preparer.id, "preparer"),
    });
    await publishScheme(db, { schemeId: draft.schemeId, audit: ctx(f.approver.id, "approver") });
    const schedule = await db.payoutSchedule.create({ data: { schemeId: draft.schemeId, mode: "MILESTONE", name: "Milestone-based" } });
    return schedule;
  }

  it("releases 40% then the remaining 60% as each milestone's demand is paid off in full", async () => {
    const f = await seedFixture();
    const schedule = await seedMilestoneScheme(f);

    const plan = await createPaymentPlan(db, {
      code: "MS", name: "40-60", projectId: f.project.id,
      milestones: [
        { sequence: 1, label: "On booking", pctOfAgreementValue: "40", dueDaysOffset: 0 },
        { sequence: 2, label: "On possession", pctOfAgreementValue: "60", dueDaysOffset: 365 },
      ],
      audit: ctx(f.admin.id, "admin"),
    });
    await db.payoutScheduleSlab.create({ data: { scheduleId: schedule.id, sequence: 1, triggerType: "DEMAND_PAID", triggerRef: plan.milestones[0]!.id, releasePct: "40" } });
    await db.payoutScheduleSlab.create({ data: { scheduleId: schedule.id, sequence: 2, triggerType: "DEMAND_PAID", triggerRef: plan.milestones[1]!.id, releasePct: "100" } });

    const confirmed = await bookUnit("R-2", f, plan.id);
    const entry = await db.commissionEntry.findFirstOrThrow({ where: { bookingId: confirmed.id, role: "SELF" } });
    expect(entry.status).toBe("ACCRUED");

    const [d1, d2] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });

    // Raise and fully pay off the FIRST milestone only.
    await db.demand.update({ where: { id: d1!.id }, data: { status: "RAISED", raisedAt: new Date() } });
    const r1 = await enterReceipt(db, { bookingId: confirmed.id, amount: d1!.amount.toString(), mode: "NEFT", receivedOn: new Date(), audit: ctx(f.admin.id, "admin") });
    await verifyReceipt(db, { receiptId: r1.id, audit: ctx(f.verifier.id, "verifier") });
    await allocateReceipt(db, { receiptId: r1.id, allocations: [{ demandId: d1!.id, amount: d1!.amount }], audit: ctx(f.verifier.id, "verifier") });

    const afterFirst = await db.commissionRelease.findMany({ where: { entryId: entry.id } });
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.cumulativePct.toString()).toBe("40");
    expect(afterFirst[0]!.amount.toString()).toBe("60000"); // 40% of 150000
    const entryAfterFirst = await db.commissionEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(entryAfterFirst.status).toBe("PAYABLE");

    // Now pay off the SECOND milestone -- only the incremental 60% releases.
    await db.demand.update({ where: { id: d2!.id }, data: { status: "RAISED", raisedAt: new Date() } });
    const r2 = await enterReceipt(db, { bookingId: confirmed.id, amount: d2!.amount.toString(), mode: "NEFT", receivedOn: new Date(), audit: ctx(f.admin.id, "admin") });
    await verifyReceipt(db, { receiptId: r2.id, audit: ctx(f.verifier.id, "verifier") });
    await allocateReceipt(db, { receiptId: r2.id, allocations: [{ demandId: d2!.id, amount: d2!.amount }], audit: ctx(f.verifier.id, "verifier") });

    const afterSecond = await db.commissionRelease.findMany({ where: { entryId: entry.id }, orderBy: { releasedAt: "asc" } });
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond[1]!.cumulativePct.toString()).toBe("100");
    expect(afterSecond[1]!.amount.toString()).toBe("90000"); // remaining 60% of 150000

    const total = afterSecond.reduce((sum, r) => sum.plus(r.amount), D(0));
    expect(total.toString()).toBe("150000");
  });

  it("a scheme with no matching DEMAND_PAID slabs is skipped, not half-computed", async () => {
    const f = await seedFixture();
    const schedule = await seedMilestoneScheme(f);
    // Only an AGREEMENT_SIGNED slab exists -- not fireable today (no code
    // moves Booking.status past CONFIRMED), and not DEMAND_PAID either way.
    await db.payoutScheduleSlab.create({ data: { scheduleId: schedule.id, sequence: 1, triggerType: "AGREEMENT_SIGNED", releasePct: "100" } });

    const plan = await createPaymentPlan(db, {
      code: "FULL", name: "100 on booking", projectId: f.project.id,
      milestones: [{ sequence: 1, label: "On booking", pctOfAgreementValue: "100", dueDaysOffset: 0 }],
      audit: ctx(f.admin.id, "admin"),
    });

    const confirmed = await bookUnit("R-3", f, plan.id);
    const entry = await db.commissionEntry.findFirstOrThrow({ where: { bookingId: confirmed.id, role: "SELF" } });

    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id } });
    await db.demand.update({ where: { id: d1!.id }, data: { status: "RAISED", raisedAt: new Date() } });
    const r1 = await enterReceipt(db, { bookingId: confirmed.id, amount: d1!.amount.toString(), mode: "NEFT", receivedOn: new Date(), audit: ctx(f.admin.id, "admin") });
    await verifyReceipt(db, { receiptId: r1.id, audit: ctx(f.verifier.id, "verifier") });
    await allocateReceipt(db, { receiptId: r1.id, allocations: [{ demandId: d1!.id, amount: d1!.amount }], audit: ctx(f.verifier.id, "verifier") });

    expect(await db.commissionRelease.count({ where: { entryId: entry.id } })).toBe(0);
    const refreshed = await db.commissionEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(refreshed.status).toBe("ACCRUED");
  });
});
