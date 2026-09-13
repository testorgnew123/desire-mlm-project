// Notifications -- Phase 2 Slice 7. Runs against LOCAL Docker Postgres --
// audience resolution (role codes, ASSOCIATE, UPLINE_L1), the QUEUED-only
// posture, and the wiring into collections-sweep.ts's ladder are exactly
// what is under test. Nothing here sends an EMAIL/WHATSAPP/SMS notification
// anywhere -- see notifications.ts's own header comment.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import {
  DuplicateNotificationRuleCodeError,
  NotificationRuleNotFoundError,
  createNotificationRule,
  evaluateNotificationRules,
  listNotificationRules,
  listNotifications,
  updateNotificationRule,
} from "../src/notifications";
import { runCollectionsSweep } from "../src/collections-sweep";
import { acquireHold } from "../src/holds";
import { confirmBooking, createDraftBooking } from "../src/bookings";
import { createPaymentPlan, raiseDemand } from "../src/payment-plans";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_notifications";
const DAY_MS = 24 * 60 * 60_000;

async function reset() {
  for (const orgId of [ORG]) {
    await db.notification.deleteMany({ where: { orgId } });
    await db.notificationRule.deleteMany({ where: { orgId } });
    await db.collectionAlert.deleteMany({ where: { orgId } });
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

async function renameRole(orgId: string, fromCode: string, toCode: string) {
  const role = await db.role.findFirstOrThrow({ where: { orgId, code: fromCode } });
  await db.role.update({ where: { id: role.id }, data: { code: toCode } });
}

function ctx(orgId: string, userId: string | null, label: string): AuditContext {
  return { orgId, actorId: userId, actorLabel: label };
}

async function seedFixture() {
  await db.organization.create({ data: { id: ORG, name: "Notifications Test Org", legalName: "Notifications Test Org Pvt Ltd" } });

  const superAdmin = await makeUser(ORG, "superadmin", ["rbac.manage", "project.write"]);
  await renameRole(ORG, "ROLE_superadmin", "SUPER_ADMIN");

  // Two users sharing the SAME FINANCE_ADMIN role -- @@unique([orgId, code])
  // on Role means a second "FINANCE_ADMIN"-coded role in one org is
  // impossible, so financeAdmin2 is assigned the first user's role rather
  // than getting a second role renamed to the same code.
  const financeAdmin1 = await makeUser(ORG, "finance1", []);
  await renameRole(ORG, "ROLE_finance1", "FINANCE_ADMIN");
  const financeRole = await db.role.findFirstOrThrow({ where: { orgId: ORG, code: "FINANCE_ADMIN" } });
  const financeAdmin2User = await db.user.create({ data: { orgId: ORG, email: `finance2-${ORG}@test.local`, name: "finance2", passwordHash: "unused" } });
  await db.userRole.create({ data: { userId: financeAdmin2User.id, roleId: financeRole.id, projectId: null } });
  const financeAdmin2 = { user: financeAdmin2User };

  const upline = await makeUser(ORG, "upline", [], { associate: true });
  const seller = await makeUser(ORG, "seller", [], { associate: true });
  await db.associateHierarchy.create({ data: { associateId: upline.associate!.id, parentId: null, path: "/", depth: 0, validFrom: new Date("2024-01-01") } });
  await db.associateHierarchy.create({
    data: { associateId: seller.associate!.id, parentId: upline.associate!.id, path: `/${upline.associate!.id}/`, depth: 1, validFrom: new Date("2024-01-01") },
  });
  const orphan = await makeUser(ORG, "orphan", [], { associate: true }); // no upline
  await db.associateHierarchy.create({ data: { associateId: orphan.associate!.id, parentId: null, path: "/", depth: 0, validFrom: new Date("2024-01-01") } });

  return { superAdmin, financeAdmin1, financeAdmin2, upline, seller, orphan };
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("createNotificationRule", () => {
  it("creates a rule", async () => {
    const f = await seedFixture();
    const rule = await createNotificationRule(db, {
      code: "DEMAND_OVERDUE_1", name: "Overdue reminder", channels: ["IN_APP"], audience: ["ASSOCIATE"],
      templateKey: "demand_overdue", audit: ctx(ORG, f.superAdmin.user.id, "superadmin"),
    });
    expect(rule.code).toBe("DEMAND_OVERDUE_1");
    expect(rule.enabled).toBe(true);
  });

  it("rejects a duplicate code", async () => {
    const f = await seedFixture();
    await createNotificationRule(db, {
      code: "DEMAND_OVERDUE_1", name: "x", channels: ["IN_APP"], audience: ["ASSOCIATE"],
      templateKey: "t", audit: ctx(ORG, f.superAdmin.user.id, "superadmin"),
    });
    await expect(
      createNotificationRule(db, {
        code: "DEMAND_OVERDUE_1", name: "y", channels: ["IN_APP"], audience: ["ASSOCIATE"],
        templateKey: "t", audit: ctx(ORG, f.superAdmin.user.id, "superadmin"),
      }),
    ).rejects.toThrow(DuplicateNotificationRuleCodeError);
  });

  it("refuses without rbac.manage", async () => {
    const f = await seedFixture();
    await expect(
      createNotificationRule(db, {
        code: "X", name: "x", channels: ["IN_APP"], audience: ["ASSOCIATE"],
        templateKey: "t", audit: ctx(ORG, f.financeAdmin1.user.id, "finance1"),
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("evaluateNotificationRules: audience resolution", () => {
  it("is a no-op when no rule matches the code", async () => {
    const notifications = await evaluateNotificationRules(db, {
      orgId: ORG, code: "NO_SUCH_RULE", title: "x", body: "x",
    });
    expect(notifications).toEqual([]);
  });

  it("is a no-op when the matching rule is disabled", async () => {
    const f = await seedFixture();
    const rule = await createNotificationRule(db, {
      code: "DISABLED_RULE", name: "x", channels: ["IN_APP"], audience: ["ASSOCIATE"],
      templateKey: "t", audit: ctx(ORG, f.superAdmin.user.id, "superadmin"),
    });
    await db.notificationRule.update({ where: { id: rule.id }, data: { enabled: false } });

    const notifications = await evaluateNotificationRules(db, {
      orgId: ORG, code: "DISABLED_RULE", associateId: f.seller.associate!.id, title: "x", body: "x",
    });
    expect(notifications).toEqual([]);
  });

  it("resolves ASSOCIATE to the event's own associate", async () => {
    const f = await seedFixture();
    await createNotificationRule(db, {
      code: "R1", name: "x", channels: ["IN_APP"], audience: ["ASSOCIATE"],
      templateKey: "t", audit: ctx(ORG, f.superAdmin.user.id, "superadmin"),
    });

    const notifications = await evaluateNotificationRules(db, {
      orgId: ORG, code: "R1", associateId: f.seller.associate!.id, title: "Hi", body: "Body", actionUrl: "/x", entity: "Demand", entityId: "d1",
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.userId).toBe(f.seller.user.id);
    expect(notifications[0]!.channel).toBe("IN_APP");
    expect(notifications[0]!.status).toBe("QUEUED");
    expect(notifications[0]!.ruleCode).toBe("R1");
    expect(notifications[0]!.actionUrl).toBe("/x");
  });

  it("resolves UPLINE_L1 to the immediate parent associate", async () => {
    const f = await seedFixture();
    await createNotificationRule(db, {
      code: "R2", name: "x", channels: ["IN_APP"], audience: ["UPLINE_L1"],
      templateKey: "t", audit: ctx(ORG, f.superAdmin.user.id, "superadmin"),
    });

    const notifications = await evaluateNotificationRules(db, { orgId: ORG, code: "R2", associateId: f.seller.associate!.id, title: "x", body: "x" });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.userId).toBe(f.upline.user.id);
  });

  it("produces nothing for UPLINE_L1 when the associate has no parent", async () => {
    const f = await seedFixture();
    await createNotificationRule(db, {
      code: "R3", name: "x", channels: ["IN_APP"], audience: ["UPLINE_L1"],
      templateKey: "t", audit: ctx(ORG, f.superAdmin.user.id, "superadmin"),
    });

    const notifications = await evaluateNotificationRules(db, { orgId: ORG, code: "R3", associateId: f.orphan.associate!.id, title: "x", body: "x" });
    expect(notifications).toEqual([]);
  });

  it("resolves a role code to every user holding that role in the org", async () => {
    const f = await seedFixture();
    await createNotificationRule(db, {
      code: "R4", name: "x", channels: ["IN_APP"], audience: ["FINANCE_ADMIN"],
      templateKey: "t", audit: ctx(ORG, f.superAdmin.user.id, "superadmin"),
    });

    const notifications = await evaluateNotificationRules(db, { orgId: ORG, code: "R4", title: "x", body: "x" });
    expect(notifications.map((n) => n.userId).sort()).toEqual([f.financeAdmin1.user.id, f.financeAdmin2.user.id].sort());
  });

  it("creates one Notification per (user, channel) for a multi-channel rule", async () => {
    const f = await seedFixture();
    await createNotificationRule(db, {
      code: "R5", name: "x", channels: ["IN_APP", "EMAIL"], audience: ["ASSOCIATE"],
      templateKey: "t", audit: ctx(ORG, f.superAdmin.user.id, "superadmin"),
    });

    const notifications = await evaluateNotificationRules(db, { orgId: ORG, code: "R5", associateId: f.seller.associate!.id, title: "x", body: "x" });
    expect(notifications).toHaveLength(2);
    expect(notifications.map((n) => n.channel).sort()).toEqual(["EMAIL", "IN_APP"]);
    // Every channel still just QUEUED -- nothing sends EMAIL anywhere yet.
    expect(notifications.every((n) => n.status === "QUEUED")).toBe(true);
  });

  it("does not duplicate a user reachable via two audience entries", async () => {
    const f = await seedFixture();
    // ASSOCIATE and UPLINE_L1 both resolve to real, DIFFERENT users here,
    // but a role code overlapping with ASSOCIATE would double the row
    // without the Set-based dedup -- assert the seller only appears once
    // even though ASSOCIATE is listed twice.
    await createNotificationRule(db, {
      code: "R6", name: "x", channels: ["IN_APP"], audience: ["ASSOCIATE", "ASSOCIATE"],
      templateKey: "t", audit: ctx(ORG, f.superAdmin.user.id, "superadmin"),
    });

    const notifications = await evaluateNotificationRules(db, { orgId: ORG, code: "R6", associateId: f.seller.associate!.id, title: "x", body: "x" });
    expect(notifications).toHaveLength(1);
  });
});

describe("listNotifications: own only", () => {
  it("returns only the given user's notifications, newest first", async () => {
    const f = await seedFixture();
    await createNotificationRule(db, {
      code: "R7", name: "x", channels: ["IN_APP"], audience: ["ASSOCIATE"],
      templateKey: "t", audit: ctx(ORG, f.superAdmin.user.id, "superadmin"),
    });
    await evaluateNotificationRules(db, { orgId: ORG, code: "R7", associateId: f.seller.associate!.id, title: "First", body: "x" });
    await evaluateNotificationRules(db, { orgId: ORG, code: "R7", associateId: f.seller.associate!.id, title: "Second", body: "x" });

    const own = await listNotifications(db, { userId: f.seller.user.id });
    expect(own.map((n) => n.title)).toEqual(["Second", "First"]);

    const uplineOwn = await listNotifications(db, { userId: f.upline.user.id });
    expect(uplineOwn).toEqual([]);
  });
});

describe("wiring: the collections sweep queues real notifications when a rule is configured", () => {
  it("fires a Notification for DEMAND_OVERDUE_1 when that rule is enabled", async () => {
    const f = await seedFixture();
    await createNotificationRule(db, {
      code: "DEMAND_OVERDUE_1", name: "Overdue", channels: ["IN_APP"], audience: ["ASSOCIATE"],
      templateKey: "t", audit: ctx(ORG, f.superAdmin.user.id, "superadmin"),
    });

    const project = await db.project.create({
      data: {
        orgId: ORG, code: "SKY", name: "Skyline", city: "Pune", state: "Maharashtra",
        reraRegNo: "P-TEST-0001", reraValidTill: new Date("2030-01-01"),
        holdTtlMinutes: 60, holdExtensionMinutes: 30, maxHoldExtensions: 1,
      },
    });
    const unitType = await db.unitType.create({
      data: { orgId: ORG, projectId: project.id, code: "2BHK", name: "2BHK", carpetArea: "650.00", builtUpArea: "780.00", saleableArea: "975.00" },
    });
    const unit = await db.unit.create({ data: { orgId: ORG, projectId: project.id, unitTypeId: unitType.id, unitNumber: "A-1", floor: 1 } });
    await db.chargeHead.create({
      data: { orgId: ORG, code: "BSP", name: "Basic Sale Price", category: "BASE_PRICE", isTaxable: true, gstRatePct: "5.00", countsTowardCommission: true, isRefundable: false, displayOrder: 1 },
    });
    const priceList = await db.priceList.create({
      data: {
        orgId: ORG, projectId: project.id, version: 1, name: "v1", status: "ACTIVE",
        validFrom: new Date("2020-01-01"), preparedById: "u_test",
        items: { create: [{ unitTypeId: unitType.id, baseRatePerSqft: "5000.00", plcCharges: {}, otherCharges: [] }] },
      },
    });
    const customer = await db.customer.create({ data: { orgId: ORG, name: "Buyer", phone: "9999999999" } });
    const plan = await createPaymentPlan(db, {
      code: "STD", name: "Standard", projectId: project.id,
      milestones: [{ sequence: 1, label: "All", pctOfAgreementValue: "100" }],
      audit: ctx(ORG, f.superAdmin.user.id, "superadmin"),
    });

    await db.rolePermission.create({
      data: {
        roleId: (await db.role.findFirstOrThrow({ where: { orgId: ORG, code: "ROLE_seller" } })).id,
        permissionId: (await db.permission.upsert({ where: { code: "booking.create" }, update: {}, create: { code: "booking.create", resource: "booking", action: "create" } })).id,
      },
    });
    await db.rolePermission.create({
      data: {
        roleId: (await db.role.findFirstOrThrow({ where: { orgId: ORG, code: "ROLE_seller" } })).id,
        permissionId: (await db.permission.upsert({ where: { code: "hold.create" }, update: {}, create: { code: "hold.create", resource: "hold", action: "create" } })).id,
      },
    });
    await db.rolePermission.create({
      data: {
        roleId: (await db.role.findFirstOrThrow({ where: { orgId: ORG, code: "SUPER_ADMIN" } })).id,
        permissionId: (await db.permission.upsert({ where: { code: "booking.confirm" }, update: {}, create: { code: "booking.confirm", resource: "booking", action: "confirm" } })).id,
      },
    });
    await db.rolePermission.create({
      data: {
        roleId: (await db.role.findFirstOrThrow({ where: { orgId: ORG, code: "SUPER_ADMIN" } })).id,
        permissionId: (await db.permission.upsert({ where: { code: "demand.raise" }, update: {}, create: { code: "demand.raise", resource: "demand", action: "raise" } })).id,
      },
    });

    await acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: f.seller.associate!.id, audit: ctx(ORG, f.seller.user.id, "seller") });
    const draft = await createDraftBooking(db, {
      unitId: unit.id, priceListId: priceList.id, customerId: customer.id, paymentPlanId: plan.id,
      audit: ctx(ORG, f.seller.user.id, "seller"),
    });
    const confirmed = await confirmBooking(db, { bookingId: draft.id, audit: ctx(ORG, f.superAdmin.user.id, "superadmin") });
    const [demand] = await db.demand.findMany({ where: { bookingId: confirmed.id } });
    await raiseDemand(db, { demandId: demand!.id, audit: ctx(ORG, f.superAdmin.user.id, "superadmin") });

    const overdue = new Date(demand!.dueDate.getTime() + 1 * DAY_MS);
    await runCollectionsSweep(db, { now: overdue });

    const notifications = await listNotifications(db, { userId: f.seller.user.id });
    const overdueNotification = notifications.find((n) => n.ruleCode === "DEMAND_OVERDUE_1");
    expect(overdueNotification).toBeDefined();
    expect(overdueNotification!.entity).toBe("Demand");
    expect(overdueNotification!.entityId).toBe(demand!.id);
  });
});

describe("listNotificationRules / updateNotificationRule (Phase 3.5 Slice 15 -- Admin > Notification rules)", () => {
  it("lists rules for the org and toggles enabled, with an audit row", async () => {
    const f = await seedFixture();
    const rule = await createNotificationRule(db, {
      code: "TOGGLE_TEST", name: "Toggle test", channels: ["IN_APP"], audience: ["ASSOCIATE"], templateKey: "toggle_test",
      audit: ctx(ORG, f.superAdmin.user.id, "superadmin"),
    });
    expect(rule.enabled).toBe(true);

    const rules = await listNotificationRules(db, { orgId: ORG, actorId: f.superAdmin.user.id });
    expect(rules.map((r) => r.id)).toContain(rule.id);

    const disabled = await updateNotificationRule(db, { ruleId: rule.id, enabled: false, audit: ctx(ORG, f.superAdmin.user.id, "superadmin") });
    expect(disabled.enabled).toBe(false);

    const auditRow = await db.auditLog.findFirstOrThrow({ where: { entity: "NotificationRule", entityId: rule.id, action: "UPDATE" } });
    expect((auditRow.before as { enabled: boolean }).enabled).toBe(true);
    expect((auditRow.after as { enabled: boolean }).enabled).toBe(false);
  });

  it("throws for a rule that does not exist", async () => {
    const f = await seedFixture();
    await expect(
      updateNotificationRule(db, { ruleId: "nope", enabled: false, audit: ctx(ORG, f.superAdmin.user.id, "superadmin") }),
    ).rejects.toThrow(NotificationRuleNotFoundError);
  });

  it("refuses without rbac.manage", async () => {
    await seedFixture();
    const noPerms = await makeUser(ORG, "rulenoperms", []);
    await expect(listNotificationRules(db, { orgId: ORG, actorId: noPerms.user.id })).rejects.toThrow(ForbiddenError);
  });
});
