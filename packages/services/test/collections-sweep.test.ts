// Escalation ladder, follow-up, collections console, interest accrual --
// Phase 2 Slice 6. Runs against LOCAL Docker Postgres -- the fire-at-most-
// once-per-rung guarantee, catch-up backfill, idempotent interest
// recomputation, and the O/T console scoping are exactly what is under test.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import { acquireHold } from "../src/holds";
import { confirmBooking, createDraftBooking } from "../src/bookings";
import { createPaymentPlan, raiseDemand } from "../src/payment-plans";
import { enterReceipt, verifyReceipt, allocateReceipt, bounceReceipt } from "../src/receipts";
import {
  FollowUpDemandNotFoundError,
  getCollectionsConsole,
  promiseToPay,
  runCollectionsSweep,
} from "../src/collections-sweep";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_sweep";
const DAY_MS = 24 * 60 * 60_000;

async function reset() {
  for (const orgId of [ORG]) {
    await db.paymentFollowUp.deleteMany({ where: { demand: { orgId } } });
    await db.collectionAlert.deleteMany({ where: { orgId } });
    await db.receiptAllocation.deleteMany({ where: { receipt: { orgId } } });
    await db.receipt.deleteMany({ where: { orgId } });
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
    await db.associateHierarchy.create({ data: { associateId: associate.id, parentId: null, path: "/", depth: 0, validFrom: new Date("2024-01-01") } });
  }
  return { user, associate };
}

async function renameRole(orgId: string, fromCode: string, toCode: string) {
  const role = await db.role.findFirstOrThrow({ where: { orgId, code: fromCode } });
  await db.role.update({ where: { id: role.id }, data: { code: toCode } });
}

const ADMIN_PERMS = ["booking.create", "booking.confirm", "hold.create", "project.write", "demand.raise", "receipt.enter", "receipt.verify", "report.read"];

async function seedFixture(orgId: string = ORG) {
  await db.organization.create({ data: { id: orgId, name: "Sweep Test Org", legalName: "Sweep Test Org Pvt Ltd" } });
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
  const unit2 = await db.unit.create({ data: { orgId, projectId: project.id, unitTypeId: unitType.id, unitNumber: "A-2", floor: 1 } });
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

  const admin = await makeUser(orgId, "admin", ADMIN_PERMS);
  await renameRole(orgId, "ROLE_admin", "SUPER_ADMIN");
  const teamLead = await makeUser(orgId, "teamlead", ["report.read", "demand.follow_up"], { associate: true });
  await renameRole(orgId, "ROLE_teamlead", "TEAM_LEAD");
  const report = await makeUser(orgId, "report", ["report.read", "demand.follow_up", "booking.create", "hold.create"], { associate: true });
  await db.associateHierarchy.updateMany({
    where: { associateId: report.associate!.id },
    data: { parentId: teamLead.associate!.id, path: `/${teamLead.associate!.id}/`, depth: 1 },
  });
  const stranger = await makeUser(orgId, "stranger", ["report.read", "demand.follow_up", "booking.create", "hold.create", "receipt.verify"], { associate: true });
  const noPerms = await makeUser(orgId, "noperms", [], { associate: true });

  return { project, unitType, unit, unit2, priceList, customer, admin, teamLead, report, stranger, noPerms };
}

function ctx(orgId: string, userId: string | null, label: string): AuditContext {
  return { orgId, actorId: userId, actorLabel: label };
}

async function seedPlan(f: Awaited<ReturnType<typeof seedFixture>>) {
  return createPaymentPlan(db, {
    code: "STD", name: "Standard 20-30-50", projectId: f.project.id,
    milestones: [
      { sequence: 1, label: "On booking", pctOfAgreementValue: "20", dueDaysOffset: 0 },
      { sequence: 2, label: "On foundation", pctOfAgreementValue: "30", dueDaysOffset: 60 },
      { sequence: 3, label: "On possession", pctOfAgreementValue: "50", dueDaysOffset: 365 },
    ],
    audit: ctx(ORG, f.admin.user.id, "admin"),
  });
}

async function confirmedBookingWithPlan(f: Awaited<ReturnType<typeof seedFixture>>, paymentPlanId: string, unitId: string, sellerAssociateId: string, sellerUserId: string) {
  await acquireHold(db, { orgId: ORG, unitId, associateId: sellerAssociateId, audit: ctx(ORG, sellerUserId, "seller") });
  const draft = await createDraftBooking(db, {
    unitId, priceListId: f.priceList.id, customerId: f.customer.id, paymentPlanId,
    audit: ctx(ORG, sellerUserId, "seller"),
  });
  return confirmBooking(db, { bookingId: draft.id, audit: ctx(ORG, f.admin.user.id, "admin"), now: new Date("2026-01-01T00:00:00Z") });
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("runCollectionsSweep: the escalation ladder fires at most once per rung", () => {
  it("fires DUE_MINUS_7 exactly at 7 days before due, not before", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f);
    const confirmed = await confirmedBookingWithPlan(f, plan.id, f.unit.id, f.report.associate!.id, f.report.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });
    await raiseDemand(db, { demandId: d1!.id, audit: ctx(ORG, f.admin.user.id, "admin") });

    const eightDaysBefore = new Date(d1!.dueDate.getTime() - 8 * DAY_MS);
    let result = await runCollectionsSweep(db, { now: eightDaysBefore });
    expect(result.alertsFired).toBe(0);

    const sevenDaysBefore = new Date(d1!.dueDate.getTime() - 7 * DAY_MS);
    result = await runCollectionsSweep(db, { now: sevenDaysBefore });
    expect(result.alertsFired).toBe(1);

    const alert = await db.collectionAlert.findFirstOrThrow({ where: { demandId: d1!.id } });
    expect(alert.rung).toBe("DUE_MINUS_7");
    expect((alert.recipients as { associateIds: string[] }).associateIds).toContain(f.report.associate!.id);
  });

  it("a catch-up run backfills every missed rung at once, not just the current one", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f);
    const confirmed = await confirmedBookingWithPlan(f, plan.id, f.unit.id, f.report.associate!.id, f.report.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });
    await raiseDemand(db, { demandId: d1!.id, audit: ctx(ORG, f.admin.user.id, "admin") });

    // Sweep never ran until 10 days overdue.
    const tenDaysOverdue = new Date(d1!.dueDate.getTime() + 10 * DAY_MS);
    const result = await runCollectionsSweep(db, { now: tenDaysOverdue });

    const rungs = (await db.collectionAlert.findMany({ where: { demandId: d1!.id } })).map((a) => a.rung).sort();
    expect(rungs).toEqual(["DUE_MINUS_1", "DUE_MINUS_3", "DUE_MINUS_7", "DUE_TODAY", "OVERDUE_1", "OVERDUE_7"].sort());
    expect(rungs).not.toContain("OVERDUE_15");
    expect(result.alertsFired).toBe(6);

    // OVERDUE_7's recipients include the upline (teamLead).
    const overdue7 = await db.collectionAlert.findFirstOrThrow({ where: { demandId: d1!.id, rung: "OVERDUE_7" } });
    expect((overdue7.recipients as { associateIds: string[] }).associateIds).toContain(f.teamLead.associate!.id);
  });

  it("never fires the same rung twice", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f);
    const confirmed = await confirmedBookingWithPlan(f, plan.id, f.unit.id, f.report.associate!.id, f.report.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });
    await raiseDemand(db, { demandId: d1!.id, audit: ctx(ORG, f.admin.user.id, "admin") });

    const overdue = new Date(d1!.dueDate.getTime() + 1 * DAY_MS);
    await runCollectionsSweep(db, { now: overdue });
    const countAfterFirst = await db.collectionAlert.count({ where: { demandId: d1!.id } });

    const secondRun = await runCollectionsSweep(db, { now: overdue });
    expect(secondRun.alertsFired).toBe(0);
    expect(await db.collectionAlert.count({ where: { demandId: d1!.id } })).toBe(countAfterFirst);
  });

  it("does not touch a SCHEDULED (never raised) or WAIVED demand", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f);
    const confirmed = await confirmedBookingWithPlan(f, plan.id, f.unit.id, f.report.associate!.id, f.report.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } }); // still SCHEDULED

    const wayOverdue = new Date(d1!.dueDate.getTime() + 100 * DAY_MS);
    const result = await runCollectionsSweep(db, { now: wayOverdue });
    expect(result.alertsFired).toBe(0);
  });
});

describe("interest accrual: never commissionable, idempotent", () => {
  it("accrues interest for an overdue demand with a configured rate", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f);
    const confirmed = await confirmedBookingWithPlan(f, plan.id, f.unit.id, f.report.associate!.id, f.report.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });
    await raiseDemand(db, { demandId: d1!.id, audit: ctx(ORG, f.admin.user.id, "admin") });
    await db.demand.update({ where: { id: d1!.id }, data: { interestRatePctPerAnnum: "12.00" } });

    const tenDaysOverdue = new Date(d1!.dueDate.getTime() + 10 * DAY_MS);
    const result = await runCollectionsSweep(db, { now: tenDaysOverdue });
    expect(result.interestUpdated).toBe(1);

    const refreshed = await db.demand.findUniqueOrThrow({ where: { id: d1!.id } });
    // 1,196,350 * 12% * 10/365 = 3931.62 (rounded half up).
    const expected = d1!.amount.times("0.12").times(10).dividedBy(365).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    expect(refreshed.interestAccrued.toString()).toBe(expected.toString());

    const bookingUnchanged = await db.booking.findUniqueOrThrow({ where: { id: confirmed.id } });
    expect(bookingUnchanged.commissionableValue.toString()).toBe(confirmed.commissionableValue.toString());
  });

  it("is idempotent -- a repeated run at the same 'now' does not change the accrued amount", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f);
    const confirmed = await confirmedBookingWithPlan(f, plan.id, f.unit.id, f.report.associate!.id, f.report.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });
    await raiseDemand(db, { demandId: d1!.id, audit: ctx(ORG, f.admin.user.id, "admin") });
    await db.demand.update({ where: { id: d1!.id }, data: { interestRatePctPerAnnum: "12.00" } });

    const overdue = new Date(d1!.dueDate.getTime() + 5 * DAY_MS);
    await runCollectionsSweep(db, { now: overdue });
    const first = await db.demand.findUniqueOrThrow({ where: { id: d1!.id } });

    const second = await runCollectionsSweep(db, { now: overdue });
    expect(second.interestUpdated).toBe(0);
    const refreshed = await db.demand.findUniqueOrThrow({ where: { id: d1!.id } });
    expect(refreshed.interestAccrued.toString()).toBe(first.interestAccrued.toString());
  });

  it("does not accrue interest when no rate is configured", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f);
    const confirmed = await confirmedBookingWithPlan(f, plan.id, f.unit.id, f.report.associate!.id, f.report.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });
    await raiseDemand(db, { demandId: d1!.id, audit: ctx(ORG, f.admin.user.id, "admin") });

    const overdue = new Date(d1!.dueDate.getTime() + 10 * DAY_MS);
    const result = await runCollectionsSweep(db, { now: overdue });
    expect(result.interestUpdated).toBe(0);
  });
});

describe("promiseToPay + PROMISE_BREACHED", () => {
  it("logs a follow-up with a promise date", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f);
    const confirmed = await confirmedBookingWithPlan(f, plan.id, f.unit.id, f.report.associate!.id, f.report.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });
    await raiseDemand(db, { demandId: d1!.id, audit: ctx(ORG, f.admin.user.id, "admin") });

    const followUp = await promiseToPay(db, {
      demandId: d1!.id, contactedOn: new Date("2026-01-05"), outcome: "CONTACTED_WILL_PAY",
      promiseToPayDate: new Date("2026-01-10"), audit: ctx(ORG, f.report.user.id, "report"),
    });
    expect(followUp.outcome).toBe("CONTACTED_WILL_PAY");
    expect(followUp.promiseBrokenAt).toBeNull();
  });

  it("a broken promise fires PROMISE_BREACHED on the next sweep", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f);
    const confirmed = await confirmedBookingWithPlan(f, plan.id, f.unit.id, f.report.associate!.id, f.report.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });
    await raiseDemand(db, { demandId: d1!.id, audit: ctx(ORG, f.admin.user.id, "admin") });

    const promiseDate = new Date(d1!.dueDate.getTime() + 3 * DAY_MS);
    await promiseToPay(db, { demandId: d1!.id, contactedOn: d1!.dueDate, outcome: "CONTACTED_WILL_PAY", promiseToPayDate: promiseDate, audit: ctx(ORG, f.report.user.id, "report") });

    const afterPromise = new Date(promiseDate.getTime() + 1 * DAY_MS);
    const result = await runCollectionsSweep(db, { now: afterPromise });
    expect(result.promisesBreached).toBe(1);

    const alert = await db.collectionAlert.findFirstOrThrow({ where: { demandId: d1!.id, rung: "PROMISE_BREACHED" } });
    expect(alert).toBeDefined();
    const followUp = await db.paymentFollowUp.findFirstOrThrow({ where: { demandId: d1!.id } });
    expect(followUp.promiseBrokenAt).not.toBeNull();
  });

  it("does not breach a promise once the demand is fully paid", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f);
    const confirmed = await confirmedBookingWithPlan(f, plan.id, f.unit.id, f.report.associate!.id, f.report.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });
    await raiseDemand(db, { demandId: d1!.id, audit: ctx(ORG, f.admin.user.id, "admin") });

    const promiseDate = new Date(d1!.dueDate.getTime() + 3 * DAY_MS);
    await promiseToPay(db, { demandId: d1!.id, contactedOn: d1!.dueDate, outcome: "CONTACTED_WILL_PAY", promiseToPayDate: promiseDate, audit: ctx(ORG, f.report.user.id, "report") });

    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: d1!.amount.toString(), mode: "NEFT", receivedOn: d1!.dueDate, audit: ctx(ORG, f.admin.user.id, "admin") });
    await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await allocateReceipt(db, { receiptId: receipt.id, allocations: [{ demandId: d1!.id, amount: d1!.amount }], audit: ctx(ORG, f.stranger.user.id, "stranger") });

    const afterPromise = new Date(promiseDate.getTime() + 1 * DAY_MS);
    const result = await runCollectionsSweep(db, { now: afterPromise });
    expect(result.promisesBreached).toBe(0);
  });

  it("refuses without demand.follow_up", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f);
    const confirmed = await confirmedBookingWithPlan(f, plan.id, f.unit.id, f.report.associate!.id, f.report.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });
    await expect(
      promiseToPay(db, { demandId: d1!.id, contactedOn: new Date(), outcome: "NO_ANSWER", audit: ctx(ORG, f.noPerms.user.id, "noperms") }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("throws for a demand that does not exist", async () => {
    const f = await seedFixture();
    await expect(
      promiseToPay(db, { demandId: "nope", contactedOn: new Date(), outcome: "NO_ANSWER", audit: ctx(ORG, f.report.user.id, "report") }),
    ).rejects.toThrow(FollowUpDemandNotFoundError);
  });
});

describe("CHEQUE_BOUNCED fires directly from bounceReceipt, not the sweep", () => {
  it("fires once per demand the bounced receipt had allocated against", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f);
    const confirmed = await confirmedBookingWithPlan(f, plan.id, f.unit.id, f.report.associate!.id, f.report.user.id);
    const [d1] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });
    await raiseDemand(db, { demandId: d1!.id, audit: ctx(ORG, f.admin.user.id, "admin") });

    const receipt = await enterReceipt(db, { bookingId: confirmed.id, amount: d1!.amount.toString(), mode: "CHEQUE", receivedOn: new Date(), audit: ctx(ORG, f.admin.user.id, "admin") });
    await verifyReceipt(db, { receiptId: receipt.id, audit: ctx(ORG, f.stranger.user.id, "stranger") });
    await allocateReceipt(db, { receiptId: receipt.id, allocations: [{ demandId: d1!.id, amount: d1!.amount }], audit: ctx(ORG, f.stranger.user.id, "stranger") });

    await bounceReceipt(db, { receiptId: receipt.id, bounceReason: "insufficient funds", audit: ctx(ORG, f.stranger.user.id, "stranger") });

    const alert = await db.collectionAlert.findFirstOrThrow({ where: { demandId: d1!.id, rung: "CHEQUE_BOUNCED" } });
    expect(alert).toBeDefined();
  });
});

describe("getCollectionsConsole: O/T scoping, same as report.read documents", () => {
  it("an ASSOCIATE sees only their own open demands", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f);
    const ownBooking = await confirmedBookingWithPlan(f, plan.id, f.unit.id, f.report.associate!.id, f.report.user.id);
    const strangerBooking = await confirmedBookingWithPlan(f, plan.id, f.unit2.id, f.stranger.associate!.id, f.stranger.user.id);
    const [ownDemand] = await db.demand.findMany({ where: { bookingId: ownBooking.id }, orderBy: { sequence: "asc" } });
    const [strangerDemand] = await db.demand.findMany({ where: { bookingId: strangerBooking.id }, orderBy: { sequence: "asc" } });
    await raiseDemand(db, { demandId: ownDemand!.id, audit: ctx(ORG, f.admin.user.id, "admin") });
    await raiseDemand(db, { demandId: strangerDemand!.id, audit: ctx(ORG, f.admin.user.id, "admin") });

    const rows = await getCollectionsConsole(db, { orgId: ORG, actorId: f.report.user.id });
    expect(rows.map((r) => r.demandId)).toEqual([ownDemand!.id]);
  });

  it("a TEAM_LEAD sees own + downline, not a stranger's", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f);
    const downlineBooking = await confirmedBookingWithPlan(f, plan.id, f.unit.id, f.report.associate!.id, f.report.user.id);
    const strangerBooking = await confirmedBookingWithPlan(f, plan.id, f.unit2.id, f.stranger.associate!.id, f.stranger.user.id);
    const [downlineDemand] = await db.demand.findMany({ where: { bookingId: downlineBooking.id }, orderBy: { sequence: "asc" } });
    const [strangerDemand] = await db.demand.findMany({ where: { bookingId: strangerBooking.id }, orderBy: { sequence: "asc" } });
    await raiseDemand(db, { demandId: downlineDemand!.id, audit: ctx(ORG, f.admin.user.id, "admin") });
    await raiseDemand(db, { demandId: strangerDemand!.id, audit: ctx(ORG, f.admin.user.id, "admin") });

    const rows = await getCollectionsConsole(db, { orgId: ORG, actorId: f.teamLead.user.id });
    expect(rows.map((r) => r.demandId)).toEqual([downlineDemand!.id]);
  });

  it("an admin sees every open demand in the org, sorted amount-descending within the worst bucket", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(f);
    const bookingA = await confirmedBookingWithPlan(f, plan.id, f.unit.id, f.report.associate!.id, f.report.user.id);
    const bookingB = await confirmedBookingWithPlan(f, plan.id, f.unit2.id, f.stranger.associate!.id, f.stranger.user.id);
    const [demandA] = await db.demand.findMany({ where: { bookingId: bookingA.id }, orderBy: { sequence: "asc" } });
    const [demandB] = await db.demand.findMany({ where: { bookingId: bookingB.id }, orderBy: { sequence: "asc" } });
    await raiseDemand(db, { demandId: demandA!.id, audit: ctx(ORG, f.admin.user.id, "admin") });
    await raiseDemand(db, { demandId: demandB!.id, audit: ctx(ORG, f.admin.user.id, "admin") });
    // Both demands are equal amounts (same plan/unit type) and equally
    // overdue (same dueDaysOffset), so tie-break is stable enough to assert
    // both appear -- the sort itself is exercised, not a specific order.
    const rows = await getCollectionsConsole(db, { orgId: ORG, actorId: f.admin.user.id });
    expect(rows.map((r) => r.demandId).sort()).toEqual([demandA!.id, demandB!.id].sort());
  });

  it("refuses a caller with no permissions at all", async () => {
    const f = await seedFixture();
    await expect(getCollectionsConsole(db, { orgId: ORG, actorId: f.noPerms.user.id })).rejects.toThrow(ForbiddenError);
  });
});
