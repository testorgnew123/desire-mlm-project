// A plotted block and its plots, created together. Runs against LOCAL Docker
// Postgres: what is under test is a transaction -- "either the block and every
// plot exist, or nothing does" -- and unique-number and permission checks that
// all live in the database or behind it. A mock would prove nothing.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import { DuplicateCodeError } from "../src/projects";
import { createBlockWithPlots } from "../src/blocks";
import { MAX_PLOTS_PER_BLOCK, PlotCountError } from "../src/plot-numbering";
import { UnitImportRejectedError, importUnits } from "../src/unit-import";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_blocks";

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
  // Permission is global seed config, not test data -- upserted, never deleted
  // (projects.test.ts explains the cross-file race that deleting it caused).
}

/** An org-wide user, optionally holding project.write. */
async function makeUser(label: string, holdsWrite: boolean) {
  const user = await db.user.create({
    data: { orgId: ORG, email: `${label}-${ORG}@test.local`, name: label, passwordHash: "unused" },
  });
  const role = await db.role.create({ data: { orgId: ORG, code: `ROLE_${label}`, name: label } });
  if (holdsWrite) {
    const perm = await db.permission.upsert({
      where: { code: "project.write" },
      update: {},
      create: { code: "project.write", resource: "project", action: "write" },
    });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  }
  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });
  return user;
}

/** A project, a 200 sq yd plot type, and a user who may write. `rera: false`
 *  gives the project no registration -- the state a freshly created project is
 *  in. RERA is optional, so it must make no difference. */
async function seed({ rera = true }: { rera?: boolean } = {}) {
  await db.organization.create({
    data: { id: ORG, name: "Blocks Test Org", legalName: "Blocks Test Org Pvt Ltd" },
  });
  const project = await db.project.create({
    data: {
      orgId: ORG,
      code: "BLK",
      name: "Block Project",
      city: "Jaipur",
      state: "Rajasthan",
      ...(rera ? { reraRegNo: "P-BLK-1", reraValidTill: new Date("2030-01-01") } : {}),
    },
  });
  const plotType = await db.unitType.create({
    data: {
      orgId: ORG,
      projectId: project.id,
      code: "PLOT-200",
      name: "200 sq yd plot",
      areaBasis: "SQYD",
      saleableArea: "200.00",
    },
  });
  const writer = await makeUser("writer", true);
  return { project, plotType, writer };
}

function ctx(user: { id: string }): AuditContext {
  return { orgId: ORG, actorId: user.id, actorLabel: "writer" };
}

const padded = (n: number, width: number) => String(n).padStart(width, "0");

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("createBlockWithPlots", () => {
  it("creates the block and every plot together", async () => {
    const { project, writer } = await seed();

    const result = await createBlockWithPlots(db, {
      projectId: project.id,
      code: "A",
      name: "Block A",
      plotCount: 12,
      plotUnitTypeCode: "PLOT-200",
      audit: ctx(writer),
    });

    expect(result.plotsCreated).toBe(12);
    expect(result.tower).toMatchObject({ code: "A", name: "Block A", kind: "BLOCK", totalFloors: null });

    const units = await db.unit.findMany({
      where: { projectId: project.id },
      orderBy: { unitNumber: "asc" },
    });
    expect(units.map((u) => u.unitNumber)).toEqual(
      Array.from({ length: 12 }, (_, i) => `A-${padded(i + 1, 2)}`),
    );
    expect(units.every((u) => u.towerId === result.tower.id)).toBe(true);
    // A plot has no floor. Storing 0 would put every plot in a phantom
    // ground-floor row on the inventory board.
    expect(units.every((u) => u.floor === null)).toBe(true);
    expect(units.every((u) => u.status === "AVAILABLE")).toBe(true);
    expect(units.every((u) => u.plcTags.length === 0)).toBe(true);

    // One genesis history row per plot, as createUnit and importUnits write.
    expect(await db.unitStatusHistory.count({ where: { unit: { projectId: project.id } } })).toBe(12);
  });

  it("writes one audit row for the block and ONE for the batch of plots, not twelve", async () => {
    const { project, writer } = await seed();
    await createBlockWithPlots(db, {
      projectId: project.id,
      code: "A",
      name: "Block A",
      plotCount: 12,
      plotUnitTypeCode: "PLOT-200",
      audit: ctx(writer),
    });

    expect(await db.auditLog.count({ where: { orgId: ORG, entity: "Tower", action: "CREATE" } })).toBe(1);
    expect(await db.auditLog.count({ where: { orgId: ORG, entity: "UnitImport", action: "CREATE" } })).toBe(1);
  });

  it.each([
    ["omitted", undefined],
    ["zero", 0],
  ])("creates an empty block when the plot count is %s -- and needs no RERA for that", async (_label, plotCount) => {
    const { project, writer } = await seed({ rera: false });

    const result = await createBlockWithPlots(db, {
      projectId: project.id,
      code: "A",
      name: "Block A",
      plotCount,
      audit: ctx(writer),
    });

    expect(result.plotsCreated).toBe(0);
    expect(result.tower.kind).toBe("BLOCK");
    expect(await db.unit.count({ where: { projectId: project.id } })).toBe(0);
  });

  // RERA registration is not required, so a project that has none -- the normal
  // state of a project that was just created -- gets its block and plots like any
  // other, and so does one whose registration has lapsed.
  it.each([
    ["has no RERA registration", { rera: false }],
    ["has an expired RERA registration", { rera: true }],
  ])("creates the block and its plots when the project %s", async (_label, { rera }) => {
    const { project, writer } = await seed({ rera });
    if (rera) {
      await db.project.update({ where: { id: project.id }, data: { reraValidTill: new Date("2020-01-01") } });
    }

    const result = await createBlockWithPlots(db, {
      projectId: project.id,
      code: "A",
      name: "Block A",
      plotCount: 5,
      plotUnitTypeCode: "PLOT-200",
      audit: ctx(writer),
    });

    expect(result.plotsCreated).toBe(5);
    expect(await db.tower.count({ where: { projectId: project.id } })).toBe(1);
    expect(await db.unit.count({ where: { projectId: project.id } })).toBe(5);
  });

  it("leaves no block behind when one of the plot numbers is already taken", async () => {
    const { project, plotType, writer } = await seed();
    // Five plots are numbered A-1 ... A-5 (padding follows the width of the
    // count), so A-2 is the number this block is about to claim.
    await db.unit.create({
      data: { orgId: ORG, projectId: project.id, unitTypeId: plotType.id, unitNumber: "A-2" },
    });

    await expect(
      createBlockWithPlots(db, {
        projectId: project.id,
        code: "A",
        name: "Block A",
        plotCount: 5,
        plotUnitTypeCode: "PLOT-200",
        audit: ctx(writer),
      }),
    ).rejects.toThrow(UnitImportRejectedError);

    expect(await db.tower.count({ where: { projectId: project.id } })).toBe(0);
    expect(await db.unit.count({ where: { projectId: project.id } })).toBe(1); // only the one already there
  });

  it("leaves no block behind when the plot type is not one of the project's", async () => {
    const { project, writer } = await seed();

    await expect(
      createBlockWithPlots(db, {
        projectId: project.id,
        code: "A",
        name: "Block A",
        plotCount: 5,
        plotUnitTypeCode: "NOT-A-TYPE",
        audit: ctx(writer),
      }),
    ).rejects.toThrow(UnitImportRejectedError);

    expect(await db.tower.count({ where: { projectId: project.id } })).toBe(0);
  });

  it("refuses a plot count with no plot type, before touching the database", async () => {
    const { project, writer } = await seed();

    await expect(
      createBlockWithPlots(db, {
        projectId: project.id,
        code: "A",
        name: "Block A",
        plotCount: 5,
        audit: ctx(writer),
      }),
    ).rejects.toThrow(PlotCountError);

    expect(await db.tower.count({ where: { projectId: project.id } })).toBe(0);
  });

  it.each([
    ["NaN", Number.NaN],
    ["fractional", 2.5],
    ["negative", -3],
    ["over the maximum", MAX_PLOTS_PER_BLOCK + 1],
  ])("refuses a %s plot count and creates nothing", async (_label, plotCount) => {
    const { project, writer } = await seed();

    await expect(
      createBlockWithPlots(db, {
        projectId: project.id,
        code: "A",
        name: "Block A",
        plotCount,
        plotUnitTypeCode: "PLOT-200",
        audit: ctx(writer),
      }),
    ).rejects.toThrow(PlotCountError);

    expect(await db.tower.count({ where: { projectId: project.id } })).toBe(0);
  });

  describe("several sizes in one block", () => {
    async function addType(projectId: string, code: string, area: string) {
      return db.unitType.create({
        data: { orgId: ORG, projectId, code, name: code, areaBasis: "SQYD", saleableArea: area },
      });
    }

    it("makes each size in order, numbered straight through, with one tower and one import audit row", async () => {
      const { project, writer } = await seed();
      await addType(project.id, "PLOT-300", "300.00");
      await addType(project.id, "PLOT-150", "150.00");

      const result = await createBlockWithPlots(db, {
        projectId: project.id,
        code: "A",
        name: "Block A",
        plotGroups: [
          { count: 4, unitTypeCode: "PLOT-200" },
          { count: 3, unitTypeCode: "PLOT-300" },
          { count: 2, unitTypeCode: "PLOT-150" },
        ],
        audit: ctx(writer),
      });

      expect(result.plotsCreated).toBe(9);
      expect(result.byUnitType).toEqual({ "PLOT-200": 4, "PLOT-300": 3, "PLOT-150": 2 });

      const units = await db.unit.findMany({
        where: { projectId: project.id },
        orderBy: { unitNumber: "asc" },
        select: { unitNumber: true, unitType: { select: { code: true } } },
      });
      expect(units.map((u) => [u.unitNumber, u.unitType.code])).toEqual([
        ["A-1", "PLOT-200"],
        ["A-2", "PLOT-200"],
        ["A-3", "PLOT-200"],
        ["A-4", "PLOT-200"],
        ["A-5", "PLOT-300"],
        ["A-6", "PLOT-300"],
        ["A-7", "PLOT-300"],
        ["A-8", "PLOT-150"],
        ["A-9", "PLOT-150"],
      ]);

      expect(await db.tower.count({ where: { projectId: project.id } })).toBe(1);
      expect(await db.unitStatusHistory.count({ where: { unit: { projectId: project.id } } })).toBe(9);
      const imports = await db.auditLog.findMany({ where: { orgId: ORG, entity: "UnitImport" } });
      expect(imports).toHaveLength(1);
      expect(imports[0]!.after).toMatchObject({
        imported: 9,
        byUnitType: { "PLOT-200": 4, "PLOT-300": 3, "PLOT-150": 2 },
      });
    });

    it("the order of the groups decides who gets the first numbers", async () => {
      const { project, writer } = await seed();
      await addType(project.id, "PLOT-300", "300.00");

      await createBlockWithPlots(db, {
        projectId: project.id,
        code: "A",
        name: "Block A",
        plotGroups: [
          { count: 1, unitTypeCode: "PLOT-300" },
          { count: 1, unitTypeCode: "PLOT-200" },
        ],
        audit: ctx(writer),
      });

      const first = await db.unit.findFirstOrThrow({
        where: { projectId: project.id, unitNumber: "A-1" },
        select: { unitType: { select: { code: true } } },
      });
      expect(first.unitType.code).toBe("PLOT-300");
    });

    it("one group is the same as the single count and type", async () => {
      const { project, writer } = await seed();
      const viaGroups = await createBlockWithPlots(db, {
        projectId: project.id,
        code: "A",
        name: "Block A",
        plotGroups: [{ count: 12, unitTypeCode: "PLOT-200" }],
        audit: ctx(writer),
      });
      const viaCount = await createBlockWithPlots(db, {
        projectId: project.id,
        code: "B",
        name: "Block B",
        plotCount: 12,
        plotUnitTypeCode: "PLOT-200",
        audit: ctx(writer),
      });
      const numbers = async (towerId: string) =>
        (await db.unit.findMany({ where: { towerId }, orderBy: { unitNumber: "asc" } })).map((u) =>
          u.unitNumber.replace(/^[AB]/, ""),
        );
      expect(await numbers(viaGroups.tower.id)).toEqual(await numbers(viaCount.tower.id));
      expect(viaCount.byUnitType).toEqual({ "PLOT-200": 12 });
    });

    it("refuses the single count and groups together", async () => {
      const { project, writer } = await seed();
      await expect(
        createBlockWithPlots(db, {
          projectId: project.id,
          code: "A",
          name: "Block A",
          plotCount: 3,
          plotUnitTypeCode: "PLOT-200",
          plotGroups: [{ count: 2, unitTypeCode: "PLOT-200" }],
          audit: ctx(writer),
        }),
      ).rejects.toThrow(PlotCountError);
      expect(await db.tower.count({ where: { projectId: project.id } })).toBe(0);
    });

    it("counts the total against the maximum, not each group", async () => {
      const { project, writer } = await seed();
      await expect(
        createBlockWithPlots(db, {
          projectId: project.id,
          code: "A",
          name: "Block A",
          plotGroups: [
            { count: MAX_PLOTS_PER_BLOCK, unitTypeCode: "PLOT-200" },
            { count: 1, unitTypeCode: "PLOT-200" },
          ],
          audit: ctx(writer),
        }),
      ).rejects.toThrow(PlotCountError);
      expect(await db.tower.count({ where: { projectId: project.id } })).toBe(0);
    });

    it("rolls everything back when one size is not a type of this project", async () => {
      const { project, writer } = await seed();
      await expect(
        createBlockWithPlots(db, {
          projectId: project.id,
          code: "A",
          name: "Block A",
          plotGroups: [
            { count: 2, unitTypeCode: "PLOT-200" },
            { count: 2, unitTypeCode: "NOPE" },
          ],
          audit: ctx(writer),
        }),
      ).rejects.toThrow(UnitImportRejectedError);
      expect(await db.tower.count({ where: { projectId: project.id } })).toBe(0);
      expect(await db.unit.count({ where: { projectId: project.id } })).toBe(0);
    });

    it("rolls everything back when one size is a flat type", async () => {
      const { project, writer } = await seed();
      await db.unitType.create({
        data: {
          orgId: ORG,
          projectId: project.id,
          code: "2BHK",
          name: "2 BHK",
          areaBasis: "SQFT",
          bedrooms: 2,
          carpetArea: "800.00",
          builtUpArea: "900.00",
          saleableArea: "1000.00",
        },
      });
      await expect(
        createBlockWithPlots(db, {
          projectId: project.id,
          code: "A",
          name: "Block A",
          plotGroups: [
            { count: 2, unitTypeCode: "PLOT-200" },
            { count: 2, unitTypeCode: "2BHK" },
          ],
          audit: ctx(writer),
        }),
      ).rejects.toThrow();
      expect(await db.tower.count({ where: { projectId: project.id } })).toBe(0);
    });
  });

  it("reports a repeated block code as a duplicate code, not as a plot problem", async () => {
    const { project, writer } = await seed();
    await createBlockWithPlots(db, {
      projectId: project.id,
      code: "A",
      name: "Block A",
      audit: ctx(writer),
    });

    await expect(
      createBlockWithPlots(db, {
        projectId: project.id,
        code: "A",
        name: "Block A again",
        plotCount: 5,
        plotUnitTypeCode: "PLOT-200",
        audit: ctx(writer),
      }),
    ).rejects.toThrow(DuplicateCodeError);

    expect(await db.unit.count({ where: { projectId: project.id } })).toBe(0);
  });

  it("refuses a user without project.write, and creates nothing", async () => {
    const { project } = await seed();
    const reader = await makeUser("reader", false);

    await expect(
      createBlockWithPlots(db, {
        projectId: project.id,
        code: "A",
        name: "Block A",
        plotCount: 5,
        plotUnitTypeCode: "PLOT-200",
        audit: ctx(reader),
      }),
    ).rejects.toThrow(ForbiddenError);

    expect(await db.tower.count({ where: { projectId: project.id } })).toBe(0);
  });

  it("refuses a system actor", async () => {
    const { project } = await seed();

    await expect(
      createBlockWithPlots(db, {
        projectId: project.id,
        code: "A",
        name: "Block A",
        audit: { orgId: ORG, actorId: null, actorLabel: "job" },
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

// importUnits' transaction body was split out so a block and its plots can
// share a transaction. Its own database half had no test before that -- only
// the pure validator did -- so these guard the split itself.
describe("importUnits, after the split into importUnitsInTx", () => {
  it("imports valid rows with history, tags, and ONE audit row for the batch", async () => {
    const { project, writer } = await seed();

    const report = await importUnits(db, {
      orgId: ORG,
      projectId: project.id,
      rows: [
        { unitNumber: "P-1", unitTypeCode: "PLOT-200", plcTags: ["CORNER"] },
        { unitNumber: "P-2", unitTypeCode: "PLOT-200", plcTags: [] },
      ],
      audit: ctx(writer),
    });

    expect(report).toMatchObject({ imported: 2, skipped: 0, errors: [] });
    const corner = await db.unit.findFirstOrThrow({ where: { projectId: project.id, unitNumber: "P-1" } });
    expect(corner.plcTags).toEqual(["CORNER"]);
    expect(await db.unitStatusHistory.count({ where: { unit: { projectId: project.id } } })).toBe(2);
    expect(await db.auditLog.count({ where: { orgId: ORG, entity: "UnitImport" } })).toBe(1);
  });

  it("rejects the whole batch when any row is bad, and writes nothing", async () => {
    const { project, writer } = await seed();

    await expect(
      importUnits(db, {
        orgId: ORG,
        projectId: project.id,
        rows: [
          { unitNumber: "P-1", unitTypeCode: "PLOT-200", plcTags: [] },
          { unitNumber: "P-2", unitTypeCode: "NOT-A-TYPE", plcTags: [] },
        ],
        audit: ctx(writer),
      }),
    ).rejects.toThrow(UnitImportRejectedError);

    expect(await db.unit.count({ where: { projectId: project.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { orgId: ORG, entity: "UnitImport" } })).toBe(0);
  });
});
