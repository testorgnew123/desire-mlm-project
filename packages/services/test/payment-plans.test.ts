// Payment plans + demand generation -- Phase 2 Slice 4. Runs against LOCAL
// Docker Postgres -- the 100%-sum invariant, the residual-on-last-milestone
// rounding, and generateDemandSchedule's wiring into confirmBooking are
// exactly what is under test.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import { acquireHold } from "../src/holds";
import { confirmBooking, createDraftBooking } from "../src/bookings";
import {
  DemandNotFoundError,
  DemandNotScheduledError,
  DuplicatePaymentPlanCodeError,
  InvalidMilestoneScheduleError,
  PaymentPlanNotFoundError,
  WaiveReasonRequiredError,
  addMilestone,
  createPaymentPlan,
  getDemandsForBooking,
  raiseDemand,
  waiveDemand,
} from "../src/payment-plans";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_payment_plans";
const OTHER_ORG = "org_test_payment_plans_other";
const D = (v: string | number) => new Prisma.Decimal(v);

async function reset() {
  for (const orgId of [ORG, OTHER_ORG]) {
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
    await db.associateGrade.create({
      data: { associateId: associate.id, gradeId: grade.id, validFrom: new Date("2024-01-01") },
    });
  }
  return { user, associate };
}

const ADMIN_PERMS = ["booking.create", "booking.confirm", "hold.create", "project.write", "demand.raise", "demand.waive", "booking.read"];

async function seedFixture(orgId: string = ORG) {
  await db.organization.create({ data: { id: orgId, name: "Payment Plans Test Org", legalName: "Payment Plans Test Org Pvt Ltd" } });
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

  const admin = await makeUser(orgId, "admin", ADMIN_PERMS);
  const seller = await makeUser(orgId, "seller", ["booking.create", "hold.create"], { associate: true });

  return { project, unitType, unit, priceList, customer, admin, seller };
}

function ctx(orgId: string, userId: string | null, label: string): AuditContext {
  return { orgId, actorId: userId, actorLabel: label };
}

/** A standard 20/30/50 plan across booking/foundation/possession. */
async function seedPlan(orgId: string, projectId: string, adminUserId: string) {
  return createPaymentPlan(db, {
    code: "STD",
    name: "Standard 20-30-50",
    projectId,
    milestones: [
      { sequence: 1, label: "On booking", pctOfAgreementValue: "20", dueDaysOffset: 0 },
      { sequence: 2, label: "On foundation", pctOfAgreementValue: "30", dueDaysOffset: 60 },
      { sequence: 3, label: "On possession", pctOfAgreementValue: "50", dueDaysOffset: 365 },
    ],
    audit: ctx(orgId, adminUserId, "admin"),
  });
}

/** Drafts and confirms a booking against the given payment plan (or none). */
async function confirmedBookingWithPlan(f: Awaited<ReturnType<typeof seedFixture>>, paymentPlanId: string | undefined, now?: Date) {
  await acquireHold(db, { orgId: ORG, unitId: f.unit.id, associateId: f.seller.associate!.id, audit: ctx(ORG, f.seller.user.id, "seller") });
  const draft = await createDraftBooking(db, {
    unitId: f.unit.id, priceListId: f.priceList.id, customerId: f.customer.id, paymentPlanId,
    audit: ctx(ORG, f.seller.user.id, "seller"),
  });
  return confirmBooking(db, { bookingId: draft.id, audit: ctx(ORG, f.admin.user.id, "admin"), now });
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("createPaymentPlan: milestones must sum to exactly 100%", () => {
  it("creates a plan with its milestones", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(ORG, f.project.id, f.admin.user.id);
    expect(plan.milestones).toHaveLength(3);
    expect(plan.milestones.map((m) => m.label)).toEqual(["On booking", "On foundation", "On possession"]);
  });

  it("refuses a schedule that does not sum to 100%", async () => {
    const f = await seedFixture();
    await expect(
      createPaymentPlan(db, {
        code: "BAD", name: "Bad plan", projectId: f.project.id,
        milestones: [{ sequence: 1, label: "Only half", pctOfAgreementValue: "50" }],
        audit: ctx(ORG, "system", "system"),
      }),
    ).rejects.toThrow(InvalidMilestoneScheduleError);
  });

  it("rejects a duplicate plan code", async () => {
    const f = await seedFixture();
    await seedPlan(ORG, f.project.id, f.admin.user.id);
    await expect(seedPlan(ORG, f.project.id, f.admin.user.id)).rejects.toThrow(DuplicatePaymentPlanCodeError);
  });

  it("refuses without project.write", async () => {
    const f = await seedFixture();
    await expect(
      createPaymentPlan(db, {
        code: "STD2", name: "x", projectId: f.project.id,
        milestones: [{ sequence: 1, label: "All", pctOfAgreementValue: "100" }],
        audit: ctx(ORG, f.seller.user.id, "seller"),
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("addMilestone: re-validates the WHOLE plan sums to 100%", () => {
  it("appends a milestone that completes an in-progress plan to exactly 100%", async () => {
    const f = await seedFixture();
    // createPaymentPlan itself always requires 100% up front; a partial plan
    // (e.g. authored incrementally, or migrated from elsewhere) is seeded
    // directly here to exercise addMilestone's own success path.
    const plan = await db.paymentPlan.create({
      data: {
        orgId: ORG, projectId: f.project.id, code: "INPROGRESS", name: "In progress",
        milestones: { create: [{ sequence: 1, label: "On booking", pctOfAgreementValue: "60" }] },
      },
    });

    const added = await addMilestone(db, {
      paymentPlanId: plan.id, sequence: 2, label: "On possession", pctOfAgreementValue: "40",
      audit: ctx(ORG, f.admin.user.id, "admin"),
    });
    expect(added.label).toBe("On possession");

    const totalPct = await db.paymentPlanMilestone.aggregate({ where: { paymentPlanId: plan.id }, _sum: { pctOfAgreementValue: true } });
    expect(totalPct._sum.pctOfAgreementValue?.toString()).toBe("100");
  });

  it("rejects an addition that would push the total past 100%", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(ORG, f.project.id, f.admin.user.id);
    await expect(
      addMilestone(db, { paymentPlanId: plan.id, sequence: 4, label: "Extra", pctOfAgreementValue: "10", audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(InvalidMilestoneScheduleError);
  });

  it("throws for a plan that does not exist", async () => {
    const f = await seedFixture();
    await expect(
      addMilestone(db, { paymentPlanId: "nope", sequence: 1, label: "x", pctOfAgreementValue: "10", audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(PaymentPlanNotFoundError);
  });
});

describe("generateDemandSchedule (via confirmBooking)", () => {
  it("generates one Demand per milestone, summing exactly to agreementValue via the residual on the last milestone", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(ORG, f.project.id, f.admin.user.id);
    const confirmed = await confirmedBookingWithPlan(f, plan.id, new Date("2026-01-01T00:00:00Z"));

    const demands = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });
    expect(demands).toHaveLength(3);

    const total = demands.reduce((sum, d) => sum.plus(d.amount), D(0));
    expect(total.toString()).toBe(confirmed.agreementValue.toString());

    expect(demands[0]!.description).toBe("On booking");
    expect(demands[0]!.dueDate.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(demands[1]!.dueDate.toISOString()).toBe("2026-03-02T00:00:00.000Z"); // +60 days
    expect(demands[2]!.dueDate.toISOString()).toBe("2027-01-01T00:00:00.000Z"); // +365 days
    expect(demands.every((d) => d.status === "SCHEDULED")).toBe(true);
  });

  it("a booking with no payment plan gets no demand schedule -- not an error", async () => {
    const f = await seedFixture();
    const confirmed = await confirmedBookingWithPlan(f, undefined);
    const demands = await db.demand.findMany({ where: { bookingId: confirmed.id } });
    expect(demands).toEqual([]);
  });

  it("each demand's milestoneRef points back at its PaymentPlanMilestone", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(ORG, f.project.id, f.admin.user.id);
    const confirmed = await confirmedBookingWithPlan(f, plan.id);
    const demands = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });
    expect(demands.map((d) => d.milestoneRef)).toEqual(plan.milestones.map((m) => m.id));
  });
});

describe("raiseDemand: only legal from SCHEDULED", () => {
  it("moves SCHEDULED -> RAISED and sets raisedAt", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(ORG, f.project.id, f.admin.user.id);
    const confirmed = await confirmedBookingWithPlan(f, plan.id);
    const demand = await db.demand.findFirstOrThrow({ where: { bookingId: confirmed.id, sequence: 1 } });

    const raised = await raiseDemand(db, { demandId: demand.id, audit: ctx(ORG, f.admin.user.id, "admin") });
    expect(raised.status).toBe("RAISED");
    expect(raised.raisedAt).not.toBeNull();
  });

  it("refuses a demand that is not SCHEDULED", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(ORG, f.project.id, f.admin.user.id);
    const confirmed = await confirmedBookingWithPlan(f, plan.id);
    const demand = await db.demand.findFirstOrThrow({ where: { bookingId: confirmed.id, sequence: 1 } });
    await raiseDemand(db, { demandId: demand.id, audit: ctx(ORG, f.admin.user.id, "admin") });

    await expect(raiseDemand(db, { demandId: demand.id, audit: ctx(ORG, f.admin.user.id, "admin") })).rejects.toThrow(DemandNotScheduledError);
  });

  it("refuses without demand.raise", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(ORG, f.project.id, f.admin.user.id);
    const confirmed = await confirmedBookingWithPlan(f, plan.id);
    const demand = await db.demand.findFirstOrThrow({ where: { bookingId: confirmed.id, sequence: 1 } });
    await expect(raiseDemand(db, { demandId: demand.id, audit: ctx(ORG, f.seller.user.id, "seller") })).rejects.toThrow(ForbiddenError);
  });

  it("throws for a demand that does not exist", async () => {
    const f = await seedFixture();
    await expect(raiseDemand(db, { demandId: "nope", audit: ctx(ORG, f.admin.user.id, "admin") })).rejects.toThrow(DemandNotFoundError);
  });
});

describe("waiveDemand: any status -> WAIVED, reason mandatory", () => {
  it("waives a SCHEDULED demand with a reason", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(ORG, f.project.id, f.admin.user.id);
    const confirmed = await confirmedBookingWithPlan(f, plan.id);
    const demand = await db.demand.findFirstOrThrow({ where: { bookingId: confirmed.id, sequence: 3 } });

    const waived = await waiveDemand(db, { demandId: demand.id, reason: "Buyer negotiated final waiver", audit: ctx(ORG, f.admin.user.id, "admin") });
    expect(waived.status).toBe("WAIVED");
    expect(waived.waiveReason).toBe("Buyer negotiated final waiver");
    expect(waived.waivedById).toBe(f.admin.user.id);
  });

  it("requires a reason", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(ORG, f.project.id, f.admin.user.id);
    const confirmed = await confirmedBookingWithPlan(f, plan.id);
    const demand = await db.demand.findFirstOrThrow({ where: { bookingId: confirmed.id, sequence: 1 } });
    await expect(waiveDemand(db, { demandId: demand.id, reason: "  ", audit: ctx(ORG, f.admin.user.id, "admin") })).rejects.toThrow(WaiveReasonRequiredError);
  });

  it("refuses without demand.waive", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(ORG, f.project.id, f.admin.user.id);
    const confirmed = await confirmedBookingWithPlan(f, plan.id);
    const demand = await db.demand.findFirstOrThrow({ where: { bookingId: confirmed.id, sequence: 1 } });
    await expect(
      waiveDemand(db, { demandId: demand.id, reason: "test", audit: ctx(ORG, f.seller.user.id, "seller") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("getDemandsForBooking", () => {
  it("returns demands ordered by sequence", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(ORG, f.project.id, f.admin.user.id);
    const confirmed = await confirmedBookingWithPlan(f, plan.id);
    const demands = await getDemandsForBooking(db, { bookingId: confirmed.id, orgId: ORG, actorId: f.admin.user.id });
    expect(demands.map((d) => d.sequence)).toEqual([1, 2, 3]);
  });

  it("refuses without booking.read", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(ORG, f.project.id, f.admin.user.id);
    const confirmed = await confirmedBookingWithPlan(f, plan.id);
    await expect(
      getDemandsForBooking(db, { bookingId: confirmed.id, orgId: ORG, actorId: f.seller.user.id }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("tenancy: cross-org demand access is refused", () => {
  it("refuses raising a demand belonging to another org", async () => {
    const f = await seedFixture(ORG);
    const other = await seedFixture(OTHER_ORG);
    const otherPlan = await createPaymentPlan(db, {
      code: "STD", name: "Standard", projectId: other.project.id,
      milestones: [{ sequence: 1, label: "All", pctOfAgreementValue: "100" }],
      audit: ctx(OTHER_ORG, other.admin.user.id, "admin"),
    });
    await acquireHold(db, { orgId: OTHER_ORG, unitId: other.unit.id, associateId: other.seller.associate!.id, audit: ctx(OTHER_ORG, other.seller.user.id, "seller") });
    const draft = await createDraftBooking(db, {
      unitId: other.unit.id, priceListId: other.priceList.id, customerId: other.customer.id, paymentPlanId: otherPlan.id,
      audit: ctx(OTHER_ORG, other.seller.user.id, "seller"),
    });
    const confirmed = await confirmBooking(db, { bookingId: draft.id, audit: ctx(OTHER_ORG, other.admin.user.id, "admin") });
    const demand = await db.demand.findFirstOrThrow({ where: { bookingId: confirmed.id } });

    await expect(raiseDemand(db, { demandId: demand.id, audit: ctx(ORG, f.admin.user.id, "admin") })).rejects.toThrow(ForbiddenError);
  });
});

describe("audit: demand generation and mutations each write a row", () => {
  it("raise and waive each write one UPDATE audit row", async () => {
    const f = await seedFixture();
    const plan = await seedPlan(ORG, f.project.id, f.admin.user.id);
    const confirmed = await confirmedBookingWithPlan(f, plan.id);
    const [d1, d2] = await db.demand.findMany({ where: { bookingId: confirmed.id }, orderBy: { sequence: "asc" } });

    await raiseDemand(db, { demandId: d1!.id, audit: ctx(ORG, f.admin.user.id, "admin") });
    const raiseAudit = await db.auditLog.findFirstOrThrow({ where: { entity: "Demand", entityId: d1!.id, action: "UPDATE" } });
    expect((raiseAudit.after as { status?: string }).status).toBe("RAISED");

    await waiveDemand(db, { demandId: d2!.id, reason: "test", audit: ctx(ORG, f.admin.user.id, "admin") });
    const waiveAudit = await db.auditLog.findFirstOrThrow({ where: { entity: "Demand", entityId: d2!.id, action: "UPDATE" } });
    expect((waiveAudit.after as { status?: string }).status).toBe("WAIVED");
  });
});
