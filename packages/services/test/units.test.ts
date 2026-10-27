// Unit state transitions, blocking/unblocking, and the board's delta read.
// Runs against LOCAL Docker Postgres -- transactions, row locks, and history
// reconstruction are exactly what is under test, so a mock would prove nothing.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { InvalidTransitionError } from "../src/unit-transitions";
import {
  UnitBlockError,
  blockUnit,
  getStockStatement,
  getUnitDeltas,
  listActiveHolds,
  listBlockedUnits,
  transitionUnitStatus,
  unblockUnit,
} from "../src/units";
import { acquireHold } from "../src/holds";
import { ForbiddenError } from "../src/rbac";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_units";

const audit: AuditContext = { orgId: ORG, actorId: null, actorLabel: "test" };

/** An admin who holds unit.block; set by seedFixture. Blocking is permissioned,
 *  so these calls go through a real user rather than the system actor. */
let adminAudit: AuditContext;

/** A user holding `unit.block` org-wide (the Admin role has it). */
async function makeUser(label: string, permissions: string[]) {
  const user = await db.user.create({
    data: { orgId: ORG, email: `${label}@test.local`, name: label, passwordHash: "unused" },
  });
  const role = await db.role.create({ data: { orgId: ORG, code: `ROLE_${label}`, name: label } });
  for (const code of permissions) {
    const [resource, action] = code.split(".") as [string, string];
    const perm = await db.permission.upsert({
      where: { code },
      update: {},
      create: { code, resource, action },
    });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  }
  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });
  return user;
}

async function reset() {
  await db.auditLog.deleteMany({ where: { orgId: ORG } });
  await db.booking.deleteMany({ where: { orgId: ORG } });
  await db.customer.deleteMany({ where: { orgId: ORG } });
  await db.unitStatusHistory.deleteMany({ where: { unit: { orgId: ORG } } });
  await db.unitHold.deleteMany({ where: { orgId: ORG } });
  await db.unit.deleteMany({ where: { orgId: ORG } });
  await db.priceListItem.deleteMany({ where: { priceList: { orgId: ORG } } });
  await db.priceList.deleteMany({ where: { orgId: ORG } });
  await db.unitType.deleteMany({ where: { orgId: ORG } });
  await db.tower.deleteMany({ where: { orgId: ORG } });
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

/** One holdable unit, with an active price list and a fresh grade/associate so
 *  acquireHold can be exercised where a test needs a real hold to exist. */
async function seedFixture() {
  await db.organization.create({
    data: { id: ORG, name: "Units Test Org", legalName: "Units Test Org Pvt Ltd" },
  });
  const grade = await db.grade.create({
    data: { orgId: ORG, code: "GT", name: "Test Grade", rank: 1, holdQuota: 5 },
  });
  const project = await db.project.create({
    data: {
      orgId: ORG,
      code: "TESTPROJ",
      name: "Test Project",
      city: "Pune",
      state: "Maharashtra",
      reraRegNo: "P-TEST-0001",
      reraValidTill: new Date("2030-01-01"),
      holdTtlMinutes: 60,
      holdExtensionMinutes: 30,
      maxHoldExtensions: 1,
    },
  });
  await db.priceList.create({
    data: {
      orgId: ORG,
      projectId: project.id,
      version: 1,
      name: "v1",
      status: "ACTIVE",
      validFrom: new Date("2020-01-01"),
      preparedById: "u_test",
    },
  });
  const unitType = await db.unitType.create({
    data: {
      orgId: ORG,
      projectId: project.id,
      code: "2BHK",
      name: "2BHK",
      carpetArea: "650.00",
      builtUpArea: "780.00",
      saleableArea: "975.00",
    },
  });
  const unit = await db.unit.create({
    data: {
      orgId: ORG,
      projectId: project.id,
      unitTypeId: unitType.id,
      unitNumber: "A-1",
      floor: 1,
    },
  });

  const user = await db.user.create({
    data: { orgId: ORG, email: "holder@test.local", name: "Holder", passwordHash: "unused" },
  });
  const associate = await db.associate.create({
    data: {
      orgId: ORG,
      userId: user.id,
      code: "A-0001",
      engagementType: "EMPLOYEE",
      joinDate: new Date("2024-01-01"),
    },
  });
  await db.associateGrade.create({
    data: { associateId: associate.id, gradeId: grade.id, validFrom: new Date("2024-01-01") },
  });

  const admin = await makeUser("admin", ["unit.block"]);
  adminAudit = { orgId: ORG, actorId: admin.id, actorLabel: admin.name };

  return { project, unit, unitType, associate, admin };
}

beforeEach(reset);

afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("transitionUnitStatus", () => {
  it("applies a legal transition, writing a UnitStatusHistory row and an audit row", async () => {
    const { unit } = await seedFixture();

    await transitionUnitStatus(db, { unitId: unit.id, to: "HELD", reason: "manual test", audit });

    const after = await db.unit.findUniqueOrThrow({ where: { id: unit.id } });
    expect(after.status).toBe("HELD");

    const history = await db.unitStatusHistory.findFirst({
      where: { unitId: unit.id, toStatus: "HELD" },
    });
    expect(history?.fromStatus).toBe("AVAILABLE");
    expect(history?.reason).toBe("manual test");

    const auditRow = await db.auditLog.findFirst({
      where: { entity: "Unit", entityId: unit.id, action: "UPDATE" },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.before).toEqual({ status: "AVAILABLE" });
    expect(auditRow?.after).toEqual({ status: "HELD" });
  });

  it("refuses an illegal transition and writes nothing", async () => {
    const { unit } = await seedFixture();

    // AVAILABLE -> BOOKED skips HELD; not a legal structural transition.
    await expect(
      transitionUnitStatus(db, { unitId: unit.id, to: "BOOKED", audit }),
    ).rejects.toThrow(InvalidTransitionError);

    const after = await db.unit.findUniqueOrThrow({ where: { id: unit.id } });
    expect(after.status).toBe("AVAILABLE");
    const history = await db.unitStatusHistory.findMany({ where: { unitId: unit.id } });
    expect(history).toHaveLength(0);
  });

  it("throws when the unit does not exist", async () => {
    await seedFixture();
    await expect(
      transitionUnitStatus(db, { unitId: "does-not-exist", to: "HELD", audit }),
    ).rejects.toThrow();
  });
});

describe("blockUnit", () => {
  it("requires a non-empty reason", async () => {
    const { unit } = await seedFixture();
    await expect(blockUnit(db, { unitId: unit.id, reason: "", audit: adminAudit })).rejects.toThrow(
      UnitBlockError,
    );
    await expect(blockUnit(db, { unitId: unit.id, reason: "   ", audit: adminAudit })).rejects.toThrow(
      UnitBlockError,
    );
  });

  it("blocks an AVAILABLE unit, recording who and why", async () => {
    const { unit } = await seedFixture();

    await blockUnit(db, { unitId: unit.id, reason: "legal hold", audit: adminAudit });

    const after = await db.unit.findUniqueOrThrow({ where: { id: unit.id } });
    expect(after.status).toBe("BLOCKED");
    expect(after.blockReason).toBe("legal hold");
    expect(after.blockedAt).not.toBeNull();

    const history = await db.unitStatusHistory.findFirst({
      where: { unitId: unit.id, toStatus: "BLOCKED" },
    });
    expect(history?.fromStatus).toBe("AVAILABLE");
    expect(history?.reason).toBe("legal hold");
  });

  it("refuses to block a unit already BLOCKED", async () => {
    const { unit } = await seedFixture();
    await blockUnit(db, { unitId: unit.id, reason: "first", audit: adminAudit });
    await expect(
      blockUnit(db, { unitId: unit.id, reason: "second", audit: adminAudit }),
    ).rejects.toThrow(/already blocked/);
  });

  it("releases a live hold in the same transaction as the block, so a blocked unit never points at a live hold", async () => {
    const { unit, associate } = await seedFixture();
    const held = await acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: associate.id, audit });

    await blockUnit(db, { unitId: unit.id, reason: "compliance freeze", audit: adminAudit });

    const after = await db.unit.findUniqueOrThrow({ where: { id: unit.id } });
    expect(after.status).toBe("BLOCKED");
    expect(after.currentHoldId).toBeNull();

    const hold = await db.unitHold.findUniqueOrThrow({ where: { id: held.holdId } });
    expect(hold.releasedAt).not.toBeNull();
    expect(hold.releaseReason).toBe("UNIT_BLOCKED");
  });
});

describe("unblockUnit", () => {
  it("refuses to unblock a unit that is not BLOCKED", async () => {
    const { unit } = await seedFixture();
    await expect(unblockUnit(db, { unitId: unit.id, audit: adminAudit })).rejects.toThrow(UnitBlockError);
  });

  it("restores an AVAILABLE unit to AVAILABLE", async () => {
    const { unit } = await seedFixture();
    await blockUnit(db, { unitId: unit.id, reason: "test", audit: adminAudit });

    const result = await unblockUnit(db, { unitId: unit.id, reason: "resolved", audit: adminAudit });

    expect(result.restoredTo).toBe("AVAILABLE");
    const after = await db.unit.findUniqueOrThrow({ where: { id: unit.id } });
    expect(after.status).toBe("AVAILABLE");
    expect(after.blockReason).toBeNull();
    expect(after.blockedById).toBeNull();
    expect(after.blockedAt).toBeNull();

    const history = await db.unitStatusHistory.findFirst({
      where: { unitId: unit.id, toStatus: "AVAILABLE", fromStatus: "BLOCKED" },
    });
    expect(history?.reason).toBe("resolved");
  });

  it("restores a BOOKED unit to BOOKED, not to AVAILABLE", async () => {
    const { unit, associate } = await seedFixture();
    await acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: associate.id, audit });
    await transitionUnitStatus(db, { unitId: unit.id, to: "BOOKED", audit });
    // blockUnit no longer takes a sold plot, but one blocked before that rule
    // may exist: lay down the state it left (BLOCKED, history from BOOKED).
    await db.unit.update({ where: { id: unit.id }, data: { status: "BLOCKED", blockReason: "review" } });
    await db.unitStatusHistory.create({
      data: { unitId: unit.id, fromStatus: "BOOKED", toStatus: "BLOCKED", reason: "review", actorLabel: "legacy" },
    });

    const result = await unblockUnit(db, { unitId: unit.id, audit: adminAudit });

    expect(result.restoredTo).toBe("BOOKED");
    const after = await db.unit.findUniqueOrThrow({ where: { id: unit.id } });
    expect(after.status).toBe("BOOKED");
  });

  it("the special case: a unit blocked while HELD returns to AVAILABLE, not HELD, because the hold was already released", async () => {
    const { unit, associate } = await seedFixture();
    await acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: associate.id, audit });
    await blockUnit(db, { unitId: unit.id, reason: "freeze", audit: adminAudit });

    const result = await unblockUnit(db, { unitId: unit.id, audit: adminAudit });

    // Structurally HELD -> BLOCKED -> HELD would be legal, but it would point
    // at the hold row blockUnit already released -- unblockUnit deliberately
    // returns AVAILABLE instead, per its own doc comment.
    expect(result.restoredTo).toBe("AVAILABLE");
    const after = await db.unit.findUniqueOrThrow({ where: { id: unit.id } });
    expect(after.status).toBe("AVAILABLE");
  });

  it("defaults the history reason to 'unblocked' when none is given", async () => {
    const { unit } = await seedFixture();
    await blockUnit(db, { unitId: unit.id, reason: "test", audit: adminAudit });
    await unblockUnit(db, { unitId: unit.id, audit: adminAudit });

    const history = await db.unitStatusHistory.findFirst({
      where: { unitId: unit.id, fromStatus: "BLOCKED" },
    });
    expect(history?.reason).toBe("unblocked");
  });

  it("throws when the unit has no recorded prior status (data corruption, not a real path)", async () => {
    const { unit } = await seedFixture();
    await blockUnit(db, { unitId: unit.id, reason: "test", audit: adminAudit });
    // Simulate a corrupted history table: delete the row that names what the
    // unit was before it was blocked.
    await db.unitStatusHistory.deleteMany({ where: { unitId: unit.id, toStatus: "BLOCKED" } });

    await expect(unblockUnit(db, { unitId: unit.id, audit: adminAudit })).rejects.toThrow(UnitBlockError);
  });
});

describe("blocking is permissioned and only for plots still on sale", () => {
  async function bookingOn(unitId: string, projectId: string, associateId: string, status: "DRAFT" | "CONFIRMED" | "CANCELLED") {
    const customer = await db.customer.create({ data: { orgId: ORG, name: "Buyer", phone: "9999900000" } });
    const priceList = await db.priceList.findFirstOrThrow({ where: { projectId } });
    return db.booking.create({
      data: {
        orgId: ORG,
        projectId,
        unitId,
        customerId: customer.id,
        bookingNumber: `BK-${Math.random().toString(36).slice(2, 8)}`,
        bookingDate: new Date(),
        status,
        sellingAssociateId: associateId,
        priceListId: priceList.id,
        baseAmount: "1000.00",
        agreementValue: "1000.00",
        commissionableValue: "1000.00",
        saleableAreaAtBooking: "975.00",
      },
    });
  }

  it("refuses a user without unit.block, and changes nothing", async () => {
    const { unit } = await seedFixture();
    const associateUser = await makeUser("plain", ["unit.read"]);

    await expect(
      blockUnit(db, {
        unitId: unit.id,
        reason: "nope",
        audit: { orgId: ORG, actorId: associateUser.id, actorLabel: "plain" },
      }),
    ).rejects.toThrow(ForbiddenError);

    expect((await db.unit.findUniqueOrThrow({ where: { id: unit.id } })).status).toBe("AVAILABLE");
    await blockUnit(db, { unitId: unit.id, reason: "ok", audit: adminAudit });
    await expect(
      unblockUnit(db, { unitId: unit.id, audit: { orgId: ORG, actorId: associateUser.id, actorLabel: "plain" } }),
    ).rejects.toThrow(ForbiddenError);
    expect((await db.unit.findUniqueOrThrow({ where: { id: unit.id } })).status).toBe("BLOCKED");
  });

  it("refuses the system actor", async () => {
    const { unit } = await seedFixture();
    await expect(blockUnit(db, { unitId: unit.id, reason: "x", audit })).rejects.toThrow(ForbiddenError);
    await expect(unblockUnit(db, { unitId: unit.id, audit })).rejects.toThrow(ForbiddenError);
  });

  it("refuses an admin of another organisation", async () => {
    const { unit } = await seedFixture();
    await expect(
      blockUnit(db, { unitId: unit.id, reason: "x", audit: { ...adminAudit, orgId: "org_somewhere_else" } }),
    ).rejects.toThrow(/not found/i);
    expect((await db.unit.findUniqueOrThrow({ where: { id: unit.id } })).status).toBe("AVAILABLE");
  });

  it("refuses an admin whose role is for a different project", async () => {
    const { unit } = await seedFixture();
    const other = await db.project.create({
      data: { orgId: ORG, code: "OTHERP", name: "Other", city: "Pune", state: "Maharashtra" },
    });
    const scoped = await makeUser("scoped", []);
    const role = await db.role.create({ data: { orgId: ORG, code: "ROLE_scoped_block", name: "scoped" } });
    const perm = await db.permission.upsert({
      where: { code: "unit.block" },
      update: {},
      create: { code: "unit.block", resource: "unit", action: "block" },
    });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    await db.userRole.create({ data: { userId: scoped.id, roleId: role.id, projectId: other.id } });

    await expect(
      blockUnit(db, { unitId: unit.id, reason: "x", audit: { orgId: ORG, actorId: scoped.id, actorLabel: "s" } }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("trims the reason, and refuses one over 500 characters", async () => {
    const { unit } = await seedFixture();
    await expect(
      blockUnit(db, { unitId: unit.id, reason: "x".repeat(501), audit: adminAudit }),
    ).rejects.toThrow(UnitBlockError);
    await blockUnit(db, { unitId: unit.id, reason: "  title dispute  ", audit: adminAudit });
    expect((await db.unit.findUniqueOrThrow({ where: { id: unit.id } })).blockReason).toBe("title dispute");
  });

  it.each(["BOOKED", "AGREEMENT_SIGNED", "REGISTERED", "POSSESSION"] as const)("refuses a %s plot: cancel the booking first", async (status) => {
    const { unit } = await seedFixture();
    await db.unit.update({ where: { id: unit.id }, data: { status } });
    await expect(blockUnit(db, { unitId: unit.id, reason: "x", audit: adminAudit })).rejects.toThrow(
      /Cancel the booking first/,
    );
    expect((await db.unit.findUniqueOrThrow({ where: { id: unit.id } })).status).toBe(status);
  });

  it("refuses a held plot with a draft booking waiting on it", async () => {
    const { unit, project, associate } = await seedFixture();
    await acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: associate.id, audit });
    const booking = await bookingOn(unit.id, project.id, associate.id, "DRAFT");

    await expect(blockUnit(db, { unitId: unit.id, reason: "x", audit: adminAudit })).rejects.toThrow(
      new RegExp(booking.bookingNumber),
    );
    expect((await db.unit.findUniqueOrThrow({ where: { id: unit.id } })).status).toBe("HELD");
  });

  it("takes a held plot whose only booking was cancelled", async () => {
    const { unit, project, associate } = await seedFixture();
    await acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: associate.id, audit });
    await bookingOn(unit.id, project.id, associate.id, "CANCELLED");

    await blockUnit(db, { unitId: unit.id, reason: "x", audit: adminAudit });
    expect((await db.unit.findUniqueOrThrow({ where: { id: unit.id } })).status).toBe("BLOCKED");
  });

  it("a blocked plot cannot be held", async () => {
    const { unit, associate } = await seedFixture();
    await blockUnit(db, { unitId: unit.id, reason: "x", audit: adminAudit });
    await expect(
      acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: associate.id, audit }),
    ).rejects.toThrow();
    expect(await db.unitHold.count({ where: { unitId: unit.id } })).toBe(0);
  });

  it("writes an audit row naming the admin and the reason", async () => {
    const { unit, admin } = await seedFixture();
    await blockUnit(db, { unitId: unit.id, reason: "survey pending", audit: adminAudit });
    const row = await db.auditLog.findFirstOrThrow({
      where: { entity: "Unit", entityId: unit.id, action: "UPDATE" },
    });
    expect(row.actorId).toBe(admin.id);
    expect(row.reason).toBe("survey pending");
  });

  it("two admins unblocking at once write one history row, and one of them is told it is not blocked", async () => {
    const { unit } = await seedFixture();
    await blockUnit(db, { unitId: unit.id, reason: "x", audit: adminAudit });

    const results = await Promise.allSettled([
      unblockUnit(db, { unitId: unit.id, audit: adminAudit }),
      unblockUnit(db, { unitId: unit.id, audit: adminAudit }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.unitStatusHistory.count({ where: { unitId: unit.id, fromStatus: "BLOCKED" } })).toBe(1);
  });
});

describe("getUnitDeltas", () => {
  it("returns every unit on the first call (no since)", async () => {
    const { project, unit } = await seedFixture();
    const { units, serverTime } = await getUnitDeltas(db, { projectId: project.id });

    expect(units).toHaveLength(1);
    expect(units[0]?.id).toBe(unit.id);
    expect(units[0]?.status).toBe("AVAILABLE");
    expect(units[0]?.currentHoldExpiresAt).toBeNull();
    expect(serverTime).toBeInstanceOf(Date);
  });

  it("only returns units changed since the given timestamp", async () => {
    const { project, unit, associate } = await seedFixture();
    const { serverTime: firstPoll } = await getUnitDeltas(db, { projectId: project.id });

    // Nothing has changed yet.
    const noChange = await getUnitDeltas(db, { projectId: project.id, since: firstPoll });
    expect(noChange.units).toHaveLength(0);

    // acquireHold, not transitionUnitStatus directly: a HELD status only reads
    // back as HELD when a live hold row backs it (effectiveUnitStatus).
    await acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: associate.id, audit });

    const changed = await getUnitDeltas(db, { projectId: project.id, since: firstPoll });
    expect(changed.units).toHaveLength(1);
    expect(changed.units[0]?.status).toBe("HELD");
  });

  it("reports HELD with the hold's expiresAt when a hold is live", async () => {
    const { project, unit, associate } = await seedFixture();
    const held = await acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: associate.id, audit });

    const { units } = await getUnitDeltas(db, { projectId: project.id });

    expect(units[0]?.status).toBe("HELD");
    expect(units[0]?.currentHoldExpiresAt?.toISOString()).toBe(held.expiresAt.toISOString());
  });

  it("reports the EFFECTIVE status: a hold past its expiresAt reads as AVAILABLE even before the sweep runs", async () => {
    const { project, unit, associate } = await seedFixture();
    const held = await acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: associate.id, audit });

    // Read as though "now" is just after the hold's expiry -- the unit row and
    // the hold row still say HELD; only the effective-status computation
    // should treat it as free.
    const { units } = await getUnitDeltas(db, {
      projectId: project.id,
      now: new Date(held.expiresAt.getTime() + 1),
    });

    expect(units[0]?.status).toBe("AVAILABLE");
    expect(units[0]?.currentHoldExpiresAt).toBeNull();
  });

  it("scopes to the given project only", async () => {
    const { project, unit } = await seedFixture();
    const otherProject = await db.project.create({
      data: {
        orgId: ORG,
        code: "OTHERPROJ",
        name: "Other Project",
        city: "Pune",
        state: "Maharashtra",
      },
    });

    const { units } = await getUnitDeltas(db, { projectId: otherProject.id });
    expect(units).toHaveLength(0);

    const own = await getUnitDeltas(db, { projectId: project.id });
    expect(own.units.map((u) => u.id)).toEqual([unit.id]);
  });
});

describe("listActiveHolds", () => {
  it("returns a live hold with the unit and associate it belongs to", async () => {
    const { project, unit, associate } = await seedFixture();
    const held = await acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: associate.id, audit });

    const rows = await listActiveHolds(db, { orgId: ORG });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      holdId: held.holdId,
      unitId: unit.id,
      projectId: project.id,
      associateId: associate.id,
      associateCode: associate.code,
    });
  });

  it("excludes a released hold", async () => {
    const { unit, associate } = await seedFixture();
    const held = await acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: associate.id, audit });
    await db.unitHold.update({ where: { id: held.holdId }, data: { releasedAt: new Date() } });

    const rows = await listActiveHolds(db, { orgId: ORG });
    expect(rows).toHaveLength(0);
  });

  it("excludes an expired hold even though releasedAt is still null (lazy expiry)", async () => {
    const { unit, associate } = await seedFixture();
    const held = await acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: associate.id, audit });

    const rows = await listActiveHolds(db, { orgId: ORG, now: new Date(held.expiresAt.getTime() + 1) });
    expect(rows).toHaveLength(0);
  });

  it("scopes to the given project only", async () => {
    const { unit, associate } = await seedFixture();
    await acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: associate.id, audit });
    const otherProject = await db.project.create({
      data: { orgId: ORG, code: "OTHERPROJ", name: "Other Project", city: "Pune", state: "Maharashtra" },
    });

    const rows = await listActiveHolds(db, { orgId: ORG, projectId: otherProject.id });
    expect(rows).toHaveLength(0);
  });
});

describe("listBlockedUnits", () => {
  it("returns a blocked unit with its reason and who blocked it", async () => {
    const { unit } = await seedFixture();
    const blocker = await makeUser("Blocker Admin", ["unit.block"]);
    await blockUnit(db, {
      unitId: unit.id,
      reason: "compliance freeze",
      audit: { ...audit, actorId: blocker.id, actorLabel: blocker.name },
    });

    const rows = await listBlockedUnits(db, { orgId: ORG });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      unitId: unit.id,
      blockReason: "compliance freeze",
      blockedByLabel: "Blocker Admin",
    });
  });

  it("excludes units that are not BLOCKED", async () => {
    await seedFixture();
    const rows = await listBlockedUnits(db, { orgId: ORG });
    expect(rows).toHaveLength(0);
  });
});

describe("getStockStatement", () => {
  it("groups units by tower, unit type and status", async () => {
    const { project, unitType } = await seedFixture();
    const tower = await db.tower.create({
      data: { orgId: ORG, projectId: project.id, code: "A", name: "Tower A", totalFloors: 10 },
    });
    await db.unit.createMany({
      data: [
        { orgId: ORG, projectId: project.id, towerId: tower.id, unitTypeId: unitType.id, unitNumber: "A-2", floor: 2 },
        { orgId: ORG, projectId: project.id, towerId: tower.id, unitTypeId: unitType.id, unitNumber: "A-3", floor: 3 },
      ],
    });

    const rows = await getStockStatement(db, { orgId: ORG, projectId: project.id });

    // The fixture's own unit has no tower (towerId null); the two new ones do.
    const towered = rows.find((row) => row.towerName === "Tower A");
    expect(towered).toMatchObject({ unitTypeName: "2BHK", status: "AVAILABLE", count: 2 });

    const untowered = rows.find((row) => row.towerName === null);
    expect(untowered).toMatchObject({ unitTypeName: "2BHK", status: "AVAILABLE", count: 1 });
  });

  it("scopes to the given project only", async () => {
    const { project, unitType } = await seedFixture();
    const otherProject = await db.project.create({
      data: { orgId: ORG, code: "OTHERPROJ", name: "Other Project", city: "Pune", state: "Maharashtra" },
    });
    await db.unit.create({
      data: { orgId: ORG, projectId: otherProject.id, unitTypeId: unitType.id, unitNumber: "B-1", floor: 1 },
    });

    const rows = await getStockStatement(db, { orgId: ORG, projectId: project.id });
    expect(rows).toHaveLength(1);
  });

  it("groups by EFFECTIVE status, not the raw column -- a hold past its expiresAt counts as AVAILABLE even before the sweep runs", async () => {
    const { project, unit, associate } = await seedFixture();
    const held = await acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: associate.id, audit });

    const rows = await getStockStatement(db, {
      orgId: ORG,
      projectId: project.id,
      now: new Date(held.expiresAt.getTime() + 1),
    });

    expect(rows).toEqual([{ towerName: null, unitTypeName: "2BHK", status: "AVAILABLE", count: 1 }]);
  });
});
