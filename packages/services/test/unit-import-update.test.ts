// "Update plots that already exist": the CSV import read as changes to plots that
// are already in a block. Local Postgres: the row lock, the all-or-nothing
// rollback and the audit rows are what is under test, so a mock would prove
// nothing. The pure rules for one row are in unit-import.test.ts.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import { PlotsOnlyError } from "../src/plots-only";
import {
  UnitImportRejectedError,
  UnitImportTargetError,
  importUnits,
  type ImportUnitsParams,
  type RawUnitRow,
} from "../src/unit-import";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_importupdate";

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

async function makeUser(label: string, codes: string[]) {
  const user = await db.user.create({
    data: { orgId: ORG, email: `${label}-${ORG}@test.local`, name: label, passwordHash: "unused" },
  });
  const role = await db.role.create({ data: { orgId: ORG, code: `ROLE_${label}`, name: label } });
  for (const code of codes) {
    const [resource, action] = code.split(".");
    const permission = await db.permission.upsert({
      where: { code },
      update: {},
      create: { code, resource: resource!, action: action! },
    });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  }
  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });
  return user;
}

/** Block A with three 200 sq yd plots, block B with one, a second plot type, an
 *  admin who may write projects and someone who may not. */
async function seed() {
  await db.organization.create({ data: { id: ORG, name: "Import Update Org", legalName: "Import Update Org Pvt Ltd" } });
  const project = await db.project.create({ data: { orgId: ORG, code: "IMU", name: "Import update", holdTtlMinutes: 60 } });
  const blockA = await db.tower.create({ data: { orgId: ORG, projectId: project.id, code: "A", name: "Block A", kind: "BLOCK" } });
  const blockB = await db.tower.create({ data: { orgId: ORG, projectId: project.id, code: "B", name: "Block B", kind: "BLOCK" } });
  const type200 = await db.unitType.create({
    data: { orgId: ORG, projectId: project.id, code: "PLOT-200", name: "200 sq yd", areaBasis: "SQYD", saleableArea: "200.00" },
  });
  const type300 = await db.unitType.create({
    data: { orgId: ORG, projectId: project.id, code: "PLOT-300", name: "300 sq yd", areaBasis: "SQYD", saleableArea: "300.00" },
  });
  const plot = (towerId: string, unitNumber: string) =>
    db.unit.create({ data: { orgId: ORG, projectId: project.id, towerId, unitTypeId: type200.id, unitNumber } });
  const a01 = await plot(blockA.id, "A-01");
  const a02 = await plot(blockA.id, "A-02");
  const a03 = await plot(blockA.id, "A-03");
  const b01 = await plot(blockB.id, "B-01");
  const admin = await makeUser("admin", ["project.write"]);
  const nobody = await makeUser("nobody", []);
  return { project, blockA, blockB, type200, type300, plots: { a01, a02, a03, b01 }, admin, nobody };
}
type Fixture = Awaited<ReturnType<typeof seed>>;

const ctx = (user: { id: string } | null): AuditContext => ({ orgId: ORG, actorId: user?.id ?? null, actorLabel: "t" });

/** The import as the screen runs it: update mode, into block A, as the admin. */
const run = (f: Fixture, rows: RawUnitRow[], over: Partial<ImportUnitsParams> = {}) =>
  importUnits(db, {
    orgId: ORG,
    projectId: f.project.id,
    towerId: f.blockA.id,
    updateExisting: true,
    rows,
    audit: ctx(f.admin),
    ...over,
  });

const unitsOf = async (f: Fixture) =>
  new Map((await db.unit.findMany({ where: { projectId: f.project.id } })).map((unit) => [unit.unitNumber, unit]));

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("importing with updateExisting", () => {
  it("changes size, type, facing and tags, bumps updatedAt, and writes an audit row per plot plus one for the file", async () => {
    const f = await seed();
    const before = await unitsOf(f);
    await new Promise((resolve) => setTimeout(resolve, 20)); // so a moved updatedAt is visible

    const report = await run(f, [
      { unitNumber: "A-01", saleableAreaOverride: "210" },
      { unitNumber: "A-02", unitTypeCode: "PLOT-300", facing: "NE", plcTags: ["CORNER"] },
      { unitNumber: "A-03" }, // names a plot and changes nothing
    ]);

    expect(report).toMatchObject({ imported: 0, updated: 2, unchanged: 1, skipped: 0, errors: [] });
    const after = await unitsOf(f);
    expect(after.get("A-01")?.saleableAreaOverride?.toString()).toBe("210");
    expect(after.get("A-01")?.unitTypeId).toBe(f.type200.id);
    expect(after.get("A-02")).toMatchObject({ unitTypeId: f.type300.id, facing: "NE", plcTags: ["CORNER"] });
    // The delta poll keys on updatedAt: changed plots move, the others do not.
    expect(after.get("A-01")!.updatedAt.getTime()).toBeGreaterThan(before.get("A-01")!.updatedAt.getTime());
    expect(after.get("A-02")!.updatedAt.getTime()).toBeGreaterThan(before.get("A-02")!.updatedAt.getTime());
    expect(after.get("A-03")!.updatedAt.getTime()).toBe(before.get("A-03")!.updatedAt.getTime());
    expect(after.get("B-01")!.updatedAt.getTime()).toBe(before.get("B-01")!.updatedAt.getTime());
    expect(after.size).toBe(before.size);

    const rows = await db.auditLog.findMany({ where: { orgId: ORG, entity: "Unit", action: "UPDATE" } });
    expect(rows).toHaveLength(2);
    const forPlot = (id: string) => rows.find((row) => row.entityId === id)!;
    const a01 = forPlot(f.plots.a01.id);
    expect(a01.before).toEqual({ saleableAreaOverride: null });
    expect(a01.after).toEqual({ saleableAreaOverride: "210" });
    expect(a01.reason).toBe("unit import (update)");
    const a02 = forPlot(f.plots.a02.id);
    expect(a02.before).toEqual({ unitTypeId: f.type200.id, facing: null, plcTags: [] });
    expect(a02.after).toEqual({ unitTypeId: f.type300.id, facing: "NE", plcTags: ["CORNER"] });

    const batch = await db.auditLog.findFirstOrThrow({ where: { orgId: ORG, entity: "UnitImport", action: "UPDATE" } });
    expect(batch.after).toMatchObject({ updateExisting: true, rowsSubmitted: 3, updated: 2, unchanged: 1 });
  });

  it("changes the size of a blocked plot", async () => {
    const f = await seed();
    await db.unit.update({ where: { id: f.plots.a01.id }, data: { status: "BLOCKED" } });

    const report = await run(f, [{ unitNumber: "A-01", saleableAreaOverride: "210" }]);

    expect(report.updated).toBe(1);
    expect((await unitsOf(f)).get("A-01")?.saleableAreaOverride?.toString()).toBe("210");
  });

  it("is idempotent: the same file a second time changes nothing and writes nothing", async () => {
    const f = await seed();
    const rows = [{ unitNumber: "A-01", saleableAreaOverride: "210", facing: "N" }];
    await run(f, rows);
    const auditAfterFirst = await db.auditLog.count({ where: { orgId: ORG } });

    const again = await run(f, rows);

    expect(again).toMatchObject({ updated: 0, unchanged: 1, skipped: 0, errors: [] });
    expect(await db.auditLog.count({ where: { orgId: ORG } })).toBe(auditAfterFirst);
  });

  it("rejects the whole file when a row has a problem, and never creates a plot for an unknown number", async () => {
    const f = await seed();
    const total = await db.unit.count({ where: { projectId: f.project.id } });

    const rejected = await run(f, [
      { unitNumber: "A-01", saleableAreaOverride: "210" },
      { unitNumber: "A-99", saleableAreaOverride: "210" },
    ]).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(UnitImportRejectedError);
    const errors = (rejected as UnitImportRejectedError).report.errors;
    expect(errors.map((error) => [error.rowNumber, error.field])).toEqual([[2, "unitNumber"]]);
    expect(errors[0]?.message).toMatch(/does not exist/);
    expect(await db.unit.count({ where: { projectId: f.project.id } })).toBe(total);
    expect((await unitsOf(f)).get("A-01")?.saleableAreaOverride).toBeNull();
    expect(await db.auditLog.count({ where: { orgId: ORG, action: "UPDATE" } })).toBe(0);
  });

  it("refuses a plot that is in another block than the one the file targets", async () => {
    const f = await seed();

    const rejected = await run(f, [{ unitNumber: "B-01", saleableAreaOverride: "210" }]).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(UnitImportRejectedError);
    expect((rejected as UnitImportRejectedError).report.errors[0]?.message).toMatch(/not in the block/);
    expect((await unitsOf(f)).get("B-01")?.saleableAreaOverride).toBeNull();
  });

  it("refuses to change the price of a held plot, naming it, and with SKIP_INVALID still does the others", async () => {
    const f = await seed();
    await db.unit.update({ where: { id: f.plots.a02.id }, data: { status: "HELD" } });
    const rows = [
      { unitNumber: "A-01", saleableAreaOverride: "210" },
      { unitNumber: "A-02", saleableAreaOverride: "210" },
    ];

    const rejected = await run(f, rows).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(UnitImportRejectedError);
    expect((rejected as UnitImportRejectedError).report.errors[0]?.message).toMatch(/Plot A-02 is held.*Block it first/);
    expect((await unitsOf(f)).get("A-01")?.saleableAreaOverride).toBeNull();

    const partial = await run(f, rows, { mode: "SKIP_INVALID" });
    expect(partial).toMatchObject({ updated: 1, skipped: 1 });
    expect(partial.errors).toHaveLength(1);
    const after = await unitsOf(f);
    expect(after.get("A-01")?.saleableAreaOverride?.toString()).toBe("210");
    expect(after.get("A-02")?.saleableAreaOverride).toBeNull();
  });

  it("still lets a held plot's facing change", async () => {
    const f = await seed();
    await db.unit.update({ where: { id: f.plots.a02.id }, data: { status: "HELD" } });

    const report = await run(f, [{ unitNumber: "A-02", facing: "S" }]);

    expect(report.updated).toBe(1);
    expect((await unitsOf(f)).get("A-02")?.facing).toBe("S");
  });

  it("is for someone who may write projects: others and a system actor are refused, and nothing changes", async () => {
    const f = await seed();
    const rows = [{ unitNumber: "A-01", saleableAreaOverride: "210" }];

    await expect(run(f, rows, { audit: ctx(f.nobody) })).rejects.toThrow(ForbiddenError);
    await expect(run(f, rows, { audit: ctx(null) })).rejects.toThrow(ForbiddenError);

    expect((await unitsOf(f)).get("A-01")?.saleableAreaOverride).toBeNull();
  });

  it("needs the block whose plots it changes", async () => {
    const f = await seed();

    await expect(run(f, [{ unitNumber: "A-01", saleableAreaOverride: "210" }], { towerId: undefined })).rejects.toThrow(
      UnitImportTargetError,
    );
  });

  it("keeps the plots-only rule: a flat type in the file is refused", async () => {
    const f = await seed();
    await db.unitType.create({
      data: { orgId: ORG, projectId: f.project.id, code: "FLAT", name: "Flat", areaBasis: "SQFT", carpetArea: "650", builtUpArea: "780", saleableArea: "975" },
    });

    await expect(run(f, [{ unitNumber: "A-01", unitTypeCode: "FLAT" }])).rejects.toThrow(PlotsOnlyError);
  });

  it("is off unless asked for: without it an existing plot number is still a duplicate", async () => {
    const f = await seed();

    const rejected = await run(f, [{ unitNumber: "A-01", unitTypeCode: "PLOT-200", saleableAreaOverride: "210" }], {
      updateExisting: false,
    }).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(UnitImportRejectedError);
    expect((rejected as UnitImportRejectedError).report.errors[0]?.message).toMatch(/already exists/);
    expect((await unitsOf(f)).get("A-01")?.saleableAreaOverride).toBeNull();
  });
});
