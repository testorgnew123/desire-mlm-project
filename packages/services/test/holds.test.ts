// GATE (docs/06-INVENTORY-SPEC.md section 2, PROGRESS.md Phase 1): two users
// must not be able to hold the same unit. Runs against LOCAL Docker Postgres
// (see .env in this package) -- never a mock. Row locks, partial unique
// indexes and transaction isolation are precisely the things being tested;
// a mock cannot reproduce any of them.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import {
  HoldExtensionLimitError,
  HoldGuardError,
  HoldQuotaExceededError,
  UnitNotAvailableError,
  acquireHold,
  effectiveUnitStatus,
  expireStaleHolds,
  extendHold,
  isHoldLive,
  releaseHold,
} from "../src/holds";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_holds";

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

/** Builds a complete, holdable fixture: org, project with valid RERA, active
 *  price list, one unit, and `associateCount` associates each with a grade
 *  granting `holdQuota` holds. */
async function seedFixture(opts: { associateCount: number; holdQuota?: number; units?: number }) {
  const quota = opts.holdQuota ?? 5;
  const unitCount = opts.units ?? 1;

  await db.organization.create({
    data: { id: ORG, name: "Holds Test Org", legalName: "Holds Test Org Pvt Ltd" },
  });
  const grade = await db.grade.create({
    data: { orgId: ORG, code: "GT", name: "Test Grade", rank: 1, holdQuota: quota },
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

  const units = [];
  for (let i = 1; i <= unitCount; i++) {
    units.push(
      await db.unit.create({
        data: {
          orgId: ORG,
          projectId: project.id,
          unitTypeId: unitType.id,
          unitNumber: `A-${i}`,
          floor: 1,
        },
      }),
    );
  }

  const associates = [];
  for (let i = 0; i < opts.associateCount; i++) {
    const user = await db.user.create({
      data: {
        orgId: ORG,
        email: `holder-${i}@test.local`,
        name: `Holder ${i}`,
        passwordHash: "unused",
      },
    });
    const associate = await db.associate.create({
      data: {
        orgId: ORG,
        userId: user.id,
        code: `A-${String(i).padStart(4, "0")}`,
        engagementType: "EMPLOYEE",
        joinDate: new Date("2024-01-01"),
      },
    });
    await db.associateGrade.create({
      data: { associateId: associate.id, gradeId: grade.id, validFrom: new Date("2024-01-01") },
    });
    associates.push(associate);
  }

  return { project, units, associates };
}

beforeEach(reset);

afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("GATE: 50 concurrent hold attempts on one unit", () => {
  it("exactly one succeeds; the other 49 lose cleanly and are told who won", async () => {
    const { units, associates } = await seedFixture({ associateCount: 50 });
    const unit = units[0]!;

    const results = await Promise.allSettled(
      associates.map((a) =>
        acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: a.id, audit }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(49);

    // Every loss must be the clean, named error -- not a deadlock, timeout,
    // constraint dump, or generic 500.
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason;
      expect(reason, `unexpected error: ${reason?.stack ?? reason}`).toBeInstanceOf(
        UnitNotAvailableError,
      );
      expect((reason as UnitNotAvailableError).heldBy?.code).toMatch(/^A-\d{4}$/);
    }

    // And the database agrees: exactly one live hold row.
    const liveHolds = await db.unitHold.count({ where: { unitId: unit.id, releasedAt: null } });
    expect(liveHolds).toBe(1);

    const fresh = await db.unit.findUniqueOrThrow({ where: { id: unit.id } });
    expect(fresh.status).toBe("HELD");
    expect(fresh.currentHoldId).not.toBeNull();
  });

  it("50 concurrent attempts across 50 DIFFERENT units all succeed -- the lock is per-unit, not global", async () => {
    const { units, associates } = await seedFixture({ associateCount: 50, units: 50 });

    const results = await Promise.allSettled(
      units.map((u, i) =>
        acquireHold(db, { orgId: ORG, unitId: u.id, associateId: associates[i]!.id, audit }),
      ),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(50);
  });
});

describe("acquire guards", () => {
  it("rejects when the associate is already at their hold quota", async () => {
    const { units, associates } = await seedFixture({ associateCount: 1, holdQuota: 2, units: 3 });
    const a = associates[0]!;

    await acquireHold(db, { orgId: ORG, unitId: units[0]!.id, associateId: a.id, audit });
    await acquireHold(db, { orgId: ORG, unitId: units[1]!.id, associateId: a.id, audit });

    await expect(
      acquireHold(db, { orgId: ORG, unitId: units[2]!.id, associateId: a.id, audit }),
    ).rejects.toThrow(HoldQuotaExceededError);
  });

  it("rejects when the project has no active price list", async () => {
    const { project, units, associates } = await seedFixture({ associateCount: 1 });
    await db.priceList.updateMany({ where: { projectId: project.id }, data: { status: "ARCHIVED" } });

    await expect(
      acquireHold(db, { orgId: ORG, unitId: units[0]!.id, associateId: associates[0]!.id, audit }),
    ).rejects.toThrow(HoldGuardError);
  });

  it("rejects when the project's RERA registration has expired", async () => {
    const { project, units, associates } = await seedFixture({ associateCount: 1 });
    await db.project.update({
      where: { id: project.id },
      data: { reraValidTill: new Date("2020-01-01") },
    });

    await expect(
      acquireHold(db, { orgId: ORG, unitId: units[0]!.id, associateId: associates[0]!.id, audit }),
    ).rejects.toThrow(HoldGuardError);
  });

  it("writes a UnitStatusHistory row and an audit row on success", async () => {
    const { units, associates } = await seedFixture({ associateCount: 1 });
    await acquireHold(db, { orgId: ORG, unitId: units[0]!.id, associateId: associates[0]!.id, audit });

    const history = await db.unitStatusHistory.findMany({ where: { unitId: units[0]!.id } });
    expect(history).toHaveLength(1);
    expect(history[0]?.toStatus).toBe("HELD");

    const auditRows = await db.auditLog.findMany({ where: { orgId: ORG, entity: "UnitHold" } });
    expect(auditRows).toHaveLength(1);
  });
});

describe("lazy expiry", () => {
  it("isHoldLive is false once past expiresAt, even with releasedAt still null", () => {
    const past = { expiresAt: new Date(Date.now() - 1000), releasedAt: null };
    expect(isHoldLive(past)).toBe(false);
  });

  it("effectiveUnitStatus reads a HELD unit with an expired hold as AVAILABLE", () => {
    const status = effectiveUnitStatus(
      { status: "HELD" },
      { expiresAt: new Date(Date.now() - 1000), releasedAt: null },
    );
    expect(status).toBe("AVAILABLE");
  });

  it("a unit whose hold expired can be re-held immediately, before any sweep runs", async () => {
    const { units, associates } = await seedFixture({ associateCount: 2 });
    const unit = units[0]!;

    const first = await acquireHold(db, {
      orgId: ORG,
      unitId: unit.id,
      associateId: associates[0]!.id,
      audit,
    });
    // Expire it in the past without touching releasedAt -- exactly the state
    // between real expiry and the sweep noticing.
    await db.unitHold.update({
      where: { id: first.holdId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const second = await acquireHold(db, {
      orgId: ORG,
      unitId: unit.id,
      associateId: associates[1]!.id,
      audit,
    });
    expect(second.holdId).not.toBe(first.holdId);

    // The stale hold was materialised as released, not left dangling.
    const stale = await db.unitHold.findUniqueOrThrow({ where: { id: first.holdId } });
    expect(stale.releasedAt).not.toBeNull();
    expect(stale.releaseReason).toBe("EXPIRED");
  });
});

describe("release and extend", () => {
  it("releasing frees the unit for someone else", async () => {
    const { units, associates } = await seedFixture({ associateCount: 2 });
    const unit = units[0]!;

    const held = await acquireHold(db, {
      orgId: ORG,
      unitId: unit.id,
      associateId: associates[0]!.id,
      audit,
    });
    await releaseHold(db, { holdId: held.holdId, reason: "RELEASED_BY_ASSOCIATE", audit });

    const after = await db.unit.findUniqueOrThrow({ where: { id: unit.id } });
    expect(after.status).toBe("AVAILABLE");
    expect(after.currentHoldId).toBeNull();

    await expect(
      acquireHold(db, { orgId: ORG, unitId: unit.id, associateId: associates[1]!.id, audit }),
    ).resolves.toBeTruthy();
  });

  it("admin force-release requires a reason note", async () => {
    const { units, associates } = await seedFixture({ associateCount: 1 });
    const held = await acquireHold(db, {
      orgId: ORG,
      unitId: units[0]!.id,
      associateId: associates[0]!.id,
      audit,
    });

    await expect(
      releaseHold(db, { holdId: held.holdId, reason: "RELEASED_BY_ADMIN", audit }),
    ).rejects.toThrow(HoldGuardError);
  });

  it("extends once, then refuses beyond maxHoldExtensions", async () => {
    const { units, associates } = await seedFixture({ associateCount: 1 });
    const held = await acquireHold(db, {
      orgId: ORG,
      unitId: units[0]!.id,
      associateId: associates[0]!.id,
      audit,
    });

    const extended = await extendHold(db, { holdId: held.holdId, audit });
    expect(extended.expiresAt.getTime()).toBeGreaterThan(held.expiresAt.getTime());

    await expect(extendHold(db, { holdId: held.holdId, audit })).rejects.toThrow(
      HoldExtensionLimitError,
    );
  });
});

describe("expiry sweep", () => {
  it("releases expired holds, frees the units, and is idempotent on a second run", async () => {
    const { units, associates } = await seedFixture({ associateCount: 2, units: 2 });

    const a = await acquireHold(db, {
      orgId: ORG,
      unitId: units[0]!.id,
      associateId: associates[0]!.id,
      audit,
    });
    await acquireHold(db, {
      orgId: ORG,
      unitId: units[1]!.id,
      associateId: associates[1]!.id,
      audit,
    });

    // Expire only the first.
    await db.unitHold.update({
      where: { id: a.holdId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const first = await expireStaleHolds(db);
    expect(first.released).toHaveLength(1);
    expect(first.released[0]?.holdId).toBe(a.holdId);

    const freed = await db.unit.findUniqueOrThrow({ where: { id: units[0]!.id } });
    expect(freed.status).toBe("AVAILABLE");
    expect(freed.currentHoldId).toBeNull();

    // The still-live hold is untouched.
    const untouched = await db.unit.findUniqueOrThrow({ where: { id: units[1]!.id } });
    expect(untouched.status).toBe("HELD");

    // Idempotent: nothing left to do.
    const second = await expireStaleHolds(db);
    expect(second.released).toHaveLength(0);
  });

  // Regression. Found by running the real cron against the real deploy with a
  // hand-planted expired hold: the sweep released the hold row and wrote a
  // HELD -> AVAILABLE history row, while the unit itself stayed HELD. The unit
  // was then unsellable forever -- its hold was released, so no later sweep
  // would ever consider it again -- and the append-only history asserted a
  // transition that never happened.
  it("frees a unit whose currentHoldId does not point at its own expiring hold, and never writes history for a move that did not happen", async () => {
    const { units, associates } = await seedFixture({ associateCount: 1, units: 1 });
    const unitId = units[0]!.id;

    const held = await acquireHold(db, {
      orgId: ORG,
      unitId,
      associateId: associates[0]!.id,
      audit,
    });

    // Break the pointer, exactly as the planted hold did, and expire the hold.
    await db.unit.update({ where: { id: unitId }, data: { currentHoldId: null } });
    await db.unitHold.update({
      where: { id: held.holdId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const historyBefore = await db.unitStatusHistory.count({ where: { unitId } });

    const { released } = await expireStaleHolds(db);

    // The unit is recovered rather than stranded...
    const unit = await db.unit.findUniqueOrThrow({ where: { id: unitId } });
    expect(unit.status).toBe("AVAILABLE");
    expect(unit.currentHoldId).toBeNull();

    // ...and because it genuinely moved, it is reported and recorded exactly once.
    expect(released).toHaveLength(1);
    expect(released[0]?.holdId).toBe(held.holdId);
    const written = await db.unitStatusHistory.findMany({
      where: { unitId, actorLabel: "system:hold-expiry-sweep" },
    });
    expect(written).toHaveLength(1);
    expect(await db.unitStatusHistory.count({ where: { unitId } })).toBe(historyBefore + 1);
  });

  // The other half of the same guard: when the unit has legitimately moved past
  // HELD, the sweep must release the stale hold row WITHOUT touching the unit
  // and WITHOUT claiming a transition. Forcing a sold unit back to AVAILABLE
  // because a stale hold expired would destroy a sale.
  it("never resurrects a BOOKED unit, and reports no release when nothing moved", async () => {
    const { units, associates } = await seedFixture({ associateCount: 1, units: 1 });
    const unitId = units[0]!.id;

    const held = await acquireHold(db, {
      orgId: ORG,
      unitId,
      associateId: associates[0]!.id,
      audit,
    });

    // The unit progressed to BOOKED; the hold row was left behind and expires.
    await db.unit.update({
      where: { id: unitId },
      data: { status: "BOOKED", currentHoldId: null },
    });
    await db.unitHold.update({
      where: { id: held.holdId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const { released } = await expireStaleHolds(db);

    const unit = await db.unit.findUniqueOrThrow({ where: { id: unitId } });
    expect(unit.status).toBe("BOOKED");

    // Nothing moved, so nothing is reported and nothing is recorded...
    expect(released).toHaveLength(0);
    expect(
      await db.unitStatusHistory.count({
        where: { unitId, actorLabel: "system:hold-expiry-sweep" },
      }),
    ).toBe(0);

    // ...but the expired hold row is still cleaned up, so it stops being scanned.
    const sweptHold = await db.unitHold.findUniqueOrThrow({ where: { id: held.holdId } });
    expect(sweptHold.releasedAt).not.toBeNull();
    expect(sweptHold.releaseReason).toBe("EXPIRED");
  });
});
