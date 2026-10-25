// SCOPE.plotsOnly: while it is on, nothing can be newly created as a tower, a
// flat or a square-foot unit type -- through any of the services, so a form that
// forgot to say so, or an API caller that never used a form, is still refused.
// Legacy apartment rows are put in with Prisma directly, the way existing data
// got there. Runs against LOCAL Postgres.
import "dotenv/config";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCOPE, getPrismaClient } from "@desire/db";
import { createBlockWithPlots } from "../src/blocks";
import { PlotsOnlyError } from "../src/plots-only";
import { createTower, createUnit, createUnitType } from "../src/projects";
import { importUnits } from "../src/unit-import";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_plotsonly";

async function reset() {
  await db.auditLog.deleteMany({ where: { orgId: ORG } });
  await db.unitStatusHistory.deleteMany({ where: { unit: { orgId: ORG } } });
  await db.unit.deleteMany({ where: { orgId: ORG } });
  await db.unitType.deleteMany({ where: { orgId: ORG } });
  await db.tower.deleteMany({ where: { orgId: ORG } });
  await db.userRole.deleteMany({ where: { role: { orgId: ORG } } });
  await db.rolePermission.deleteMany({ where: { role: { orgId: ORG } } });
  await db.role.deleteMany({ where: { orgId: ORG } });
  await db.user.deleteMany({ where: { orgId: ORG } });
  await db.project.deleteMany({ where: { orgId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/** A project with live RERA, a writer, and the legacy shapes alongside the new:
 *  a block, a tower, a plot type and a flat type. */
async function seed() {
  await db.organization.create({ data: { id: ORG, name: "Plots Only Org", legalName: "Plots Only Org Pvt Ltd" } });
  const project = await db.project.create({
    data: { orgId: ORG, code: "PO", name: "Plots Only", reraRegNo: "P-PO-1", reraValidTill: new Date("2030-01-01") },
  });
  const user = await db.user.create({
    data: { orgId: ORG, email: `writer-${ORG}@test.local`, name: "writer", passwordHash: "unused" },
  });
  const role = await db.role.create({ data: { orgId: ORG, code: "ROLE_writer", name: "writer" } });
  const permission = await db.permission.upsert({
    where: { code: "project.write" },
    update: {},
    create: { code: "project.write", resource: "project", action: "write" },
  });
  await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });

  const block = await db.tower.create({
    data: { orgId: ORG, projectId: project.id, code: "BLK", name: "Block", kind: "BLOCK" },
  });
  const tower = await db.tower.create({
    data: { orgId: ORG, projectId: project.id, code: "TWR", name: "Tower", kind: "TOWER", totalFloors: 10 },
  });
  const plotType = await db.unitType.create({
    data: { orgId: ORG, projectId: project.id, code: "PLOT", name: "Plot", areaBasis: "SQYD", saleableArea: "200.00" },
  });
  const flatType = await db.unitType.create({
    data: {
      orgId: ORG,
      projectId: project.id,
      code: "FLAT",
      name: "Flat",
      areaBasis: "SQFT",
      carpetArea: "650.00",
      builtUpArea: "780.00",
      saleableArea: "975.00",
    },
  });
  return { project, user, block, tower, plotType, flatType };
}

const ctx = (user: { id: string }): AuditContext => ({ orgId: ORG, actorId: user.id, actorLabel: "writer" });

beforeEach(async () => {
  SCOPE.plotsOnly = true;
  await reset();
});
afterEach(() => {
  SCOPE.plotsOnly = true;
});
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("plots only (the default)", () => {
  it("is on", () => {
    expect(SCOPE.plotsOnly).toBe(true);
  });

  describe("groups", () => {
    it.each([["TOWER", "TOWER" as const], ["not said, which the service would read as a tower", undefined]])(
      "refuses a group that is %s",
      async (_label, kind) => {
        const f = await seed();
        await expect(
          createTower(db, { projectId: f.project.id, code: "NEW", name: "New", kind, totalFloors: 12, audit: ctx(f.user) }),
        ).rejects.toThrow(PlotsOnlyError);
        expect(await db.tower.count({ where: { projectId: f.project.id, code: "NEW" } })).toBe(0);
      },
    );

    it("creates a block", async () => {
      const f = await seed();
      const block = await createTower(db, { projectId: f.project.id, code: "NEW", name: "New", kind: "BLOCK", audit: ctx(f.user) });
      expect(block.kind).toBe("BLOCK");
    });
  });

  describe("unit types", () => {
    it.each([["SQFT", "SQFT" as const], ["not said, which the service would read as square feet", undefined]])(
      "refuses a type priced in %s",
      async (_label, areaBasis) => {
        const f = await seed();
        await expect(
          createUnitType(db, {
            projectId: f.project.id,
            code: "NEWFLAT",
            name: "New flat",
            areaBasis,
            carpetArea: "500.00",
            builtUpArea: "600.00",
            saleableArea: "700.00",
            audit: ctx(f.user),
          }),
        ).rejects.toThrow(PlotsOnlyError);
        expect(await db.unitType.count({ where: { projectId: f.project.id, code: "NEWFLAT" } })).toBe(0);
      },
    );

    it("creates a plot type", async () => {
      const f = await seed();
      const type = await createUnitType(db, {
        projectId: f.project.id,
        code: "PLOT-300",
        name: "Plot 300",
        areaBasis: "SQYD",
        saleableArea: "300.00",
        audit: ctx(f.user),
      });
      expect(type.areaBasis).toBe("SQYD");
    });
  });

  describe("units", () => {
    it("refuses a unit of a flat type even in a block, and a unit inside a tower even of a plot type", async () => {
      const f = await seed();
      await expect(
        createUnit(db, { projectId: f.project.id, towerId: f.block.id, unitTypeId: f.flatType.id, unitNumber: "X-1", audit: ctx(f.user) }),
      ).rejects.toThrow(PlotsOnlyError);
      await expect(
        createUnit(db, { projectId: f.project.id, towerId: f.tower.id, unitTypeId: f.plotType.id, unitNumber: "X-2", floor: 1, audit: ctx(f.user) }),
      ).rejects.toThrow(PlotsOnlyError);
      expect(await db.unit.count({ where: { projectId: f.project.id } })).toBe(0);
    });

    it("creates a plot in a block", async () => {
      const f = await seed();
      const plot = await createUnit(db, {
        projectId: f.project.id,
        towerId: f.block.id,
        unitTypeId: f.plotType.id,
        unitNumber: "BLK-01",
        audit: ctx(f.user),
      });
      expect(plot).toMatchObject({ unitNumber: "BLK-01", towerId: f.block.id, floor: null });
    });
  });

  describe("the importer", () => {
    it("refuses to load units into a tower", async () => {
      const f = await seed();
      await expect(
        importUnits(db, {
          orgId: ORG,
          projectId: f.project.id,
          towerId: f.tower.id,
          rows: [{ unitNumber: "T-101", unitTypeCode: "PLOT", floor: 1 }],
          audit: ctx(f.user),
        }),
      ).rejects.toThrow(PlotsOnlyError);
      expect(await db.unit.count({ where: { projectId: f.project.id } })).toBe(0);
    });

    it("refuses rows that use a flat type, and writes none of them", async () => {
      const f = await seed();
      await expect(
        importUnits(db, {
          orgId: ORG,
          projectId: f.project.id,
          towerId: f.block.id,
          rows: [
            { unitNumber: "BLK-01", unitTypeCode: "PLOT" },
            { unitNumber: "BLK-02", unitTypeCode: "FLAT" },
          ],
          audit: ctx(f.user),
        }),
      ).rejects.toThrow(PlotsOnlyError);
      expect(await db.unit.count({ where: { projectId: f.project.id } })).toBe(0);
    });

    it("loads plots into a block", async () => {
      const f = await seed();
      const result = await importUnits(db, {
        orgId: ORG,
        projectId: f.project.id,
        towerId: f.block.id,
        rows: [
          { unitNumber: "BLK-01", unitTypeCode: "PLOT" },
          { unitNumber: "BLK-02", unitTypeCode: "PLOT" },
        ],
        audit: ctx(f.user),
      });
      expect(result.imported).toBe(2);
    });
  });

  describe("a block with plots", () => {
    it("refuses a flat type for the plots and leaves no block behind", async () => {
      const f = await seed();
      await expect(
        createBlockWithPlots(db, {
          projectId: f.project.id,
          code: "NEWBLK",
          name: "New block",
          plotCount: 5,
          plotUnitTypeCode: "FLAT",
          audit: ctx(f.user),
        }),
      ).rejects.toThrow(PlotsOnlyError);
      expect(await db.tower.count({ where: { projectId: f.project.id, code: "NEWBLK" } })).toBe(0);
      expect(await db.unit.count({ where: { projectId: f.project.id } })).toBe(0);
    });
  });
});

describe("switched off (SCOPE.plotsOnly = false)", () => {
  it("creates a tower, a flat type and a flat again -- the rules are paused, not removed", async () => {
    SCOPE.plotsOnly = false;
    const f = await seed();

    const tower = await createTower(db, { projectId: f.project.id, code: "T2", name: "T2", totalFloors: 8, audit: ctx(f.user) });
    const flat = await createUnitType(db, {
      projectId: f.project.id,
      code: "FLAT2",
      name: "Flat 2",
      carpetArea: "500.00",
      builtUpArea: "600.00",
      saleableArea: "700.00",
      audit: ctx(f.user),
    });
    const unit = await createUnit(db, {
      projectId: f.project.id,
      towerId: tower.id,
      unitTypeId: flat.id,
      unitNumber: "T2-101",
      floor: 1,
      audit: ctx(f.user),
    });

    expect(tower.kind).toBe("TOWER");
    expect(flat.areaBasis).toBe("SQFT");
    expect(unit.floor).toBe(1);
  });
});
