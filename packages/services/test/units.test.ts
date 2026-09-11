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
  getUnitDeltas,
  transitionUnitStatus,
  unblockUnit,
} from "../src/units";
import { acquireHold } from "../src/holds";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_units";

const audit: AuditContext = { orgId: ORG, actorId: null, actorLabel: "test" };

async function reset() {
  await db.auditLog.deleteMany({ where: { orgId: ORG } });
  await db.unitStatusHistory.deleteMany({ where: { unit: { orgId: ORG } } });
  await db.unitHold.deleteMany({ where: { orgId: ORG } });
  await db.unit.deleteMany({ where: { orgId: ORG } });
  await db.priceListItem.deleteMany({ where: { priceList: { orgId: ORG } } });
  await db.priceList.deleteMany({ where: { orgId: ORG } });
  await db.unitType.deleteMany({ where: { orgId: ORG } });
  await db.tower.deleteMany({ where: { orgId: ORG } });
  await db.associateGrade.deleteMany({ where: { associate: { orgId: ORG } } });
  await db.associate.deleteMany({ where: { orgId: ORG } });
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

  return { project, unit, unitType, associate };
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
    await expect(blockUnit(db, { unitId: unit.id, reason: "", audit })).rejects.toThrow(
      UnitBlockError,
    );
    await expect(blockUnit(db, { unitId: unit.id, reason: "   ", audit })).rejects.toThrow(
      UnitBlockError,
    );
  });

  it("blocks an AVAILABLE unit, recording who and why", async () => {
    const { unit } = await seedFixture();

    await blockUnit(db, { unitId: unit.id, reason: "legal hold", audit });

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
    await blockUnit(db, { unitId: unit.id, reason: "first", audit });
    await expect(
      blockUnit(db, { unitId: unit.id, reason: "second", audit }),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it("releases a live hold in the same transaction as the block, so a blocked unit never points at a live hold", async () => {
    const { unit, associate } = await seedFixture();
    const held = await acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: associate.id, audit });

    await blockUnit(db, { unitId: unit.id, reason: "compliance freeze", audit });

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
    await expect(unblockUnit(db, { unitId: unit.id, audit })).rejects.toThrow(UnitBlockError);
  });

  it("restores an AVAILABLE unit to AVAILABLE", async () => {
    const { unit } = await seedFixture();
    await blockUnit(db, { unitId: unit.id, reason: "test", audit });

    const result = await unblockUnit(db, { unitId: unit.id, reason: "resolved", audit });

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
    await blockUnit(db, { unitId: unit.id, reason: "review", audit });

    const result = await unblockUnit(db, { unitId: unit.id, audit });

    expect(result.restoredTo).toBe("BOOKED");
    const after = await db.unit.findUniqueOrThrow({ where: { id: unit.id } });
    expect(after.status).toBe("BOOKED");
  });

  it("the special case: a unit blocked while HELD returns to AVAILABLE, not HELD, because the hold was already released", async () => {
    const { unit, associate } = await seedFixture();
    await acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: associate.id, audit });
    await blockUnit(db, { unitId: unit.id, reason: "freeze", audit });

    const result = await unblockUnit(db, { unitId: unit.id, audit });

    // Structurally HELD -> BLOCKED -> HELD would be legal, but it would point
    // at the hold row blockUnit already released -- unblockUnit deliberately
    // returns AVAILABLE instead, per its own doc comment.
    expect(result.restoredTo).toBe("AVAILABLE");
    const after = await db.unit.findUniqueOrThrow({ where: { id: unit.id } });
    expect(after.status).toBe("AVAILABLE");
  });

  it("defaults the history reason to 'unblocked' when none is given", async () => {
    const { unit } = await seedFixture();
    await blockUnit(db, { unitId: unit.id, reason: "test", audit });
    await unblockUnit(db, { unitId: unit.id, audit });

    const history = await db.unitStatusHistory.findFirst({
      where: { unitId: unit.id, fromStatus: "BLOCKED" },
    });
    expect(history?.reason).toBe("unblocked");
  });

  it("throws when the unit has no recorded prior status (data corruption, not a real path)", async () => {
    const { unit } = await seedFixture();
    await blockUnit(db, { unitId: unit.id, reason: "test", audit });
    // Simulate a corrupted history table: delete the row that names what the
    // unit was before it was blocked.
    await db.unitStatusHistory.deleteMany({ where: { unitId: unit.id, toStatus: "BLOCKED" } });

    await expect(unblockUnit(db, { unitId: unit.id, audit })).rejects.toThrow(UnitBlockError);
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
