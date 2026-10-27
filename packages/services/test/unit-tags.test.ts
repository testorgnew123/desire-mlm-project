// Marking plots as corner (or any PLC tag) and the guards around pricing them.
// Local Postgres: the point is the row lock, the set-based write and that a tag
// the price list does not price is caught before anyone is booked.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import { PlcTagError, normalizePlcTag, normalizePlcTags } from "../src/plc-tags";
import { UnitTagError, getUnpricedPlcTags, setUnitPlcTag } from "../src/unit-tags";
import { PlotTagNotPricedError, bookPlot } from "../src/plot-booking";
import { createUnit, updateUnit } from "../src/projects";
import { importUnits } from "../src/unit-import";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_unittags";

async function reset() {
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

async function makeUser(label: string, codes: string[], withAssociate = false) {
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
  let associate = null;
  if (withAssociate) {
    const grade = await db.grade.upsert({
      where: { orgId_code: { orgId: ORG, code: "GT" } },
      update: {},
      create: { orgId: ORG, code: "GT", name: "Test", rank: 1, holdQuota: 5 },
    });
    associate = await db.associate.create({
      data: { orgId: ORG, userId: user.id, code: `A-${label}`, engagementType: "CHANNEL_PARTNER", joinDate: new Date("2024-01-01") },
    });
    await db.associateGrade.create({
      data: { associateId: associate.id, gradeId: grade.id, validFrom: new Date("2024-01-01") },
    });
  }
  return { user, associate };
}

async function seed(opts: { cornerRate?: boolean } = {}) {
  await db.organization.create({ data: { id: ORG, name: "Tags Org", legalName: "Tags Org Pvt Ltd" } });
  const project = await db.project.create({
    data: { orgId: ORG, code: "TAG", name: "Tags", holdTtlMinutes: 60 },
  });
  const block = await db.tower.create({ data: { orgId: ORG, projectId: project.id, code: "A", name: "Block A", kind: "BLOCK" } });
  const plotType = await db.unitType.create({
    data: { orgId: ORG, projectId: project.id, code: "PLOT-200", name: "200 sq yd", areaBasis: "SQYD", saleableArea: "200.00" },
  });
  const plots = [];
  for (const n of ["A-01", "A-02", "A-03"]) {
    plots.push(await db.unit.create({ data: { orgId: ORG, projectId: project.id, towerId: block.id, unitTypeId: plotType.id, unitNumber: n } }));
  }
  await db.chargeHead.createMany({
    data: [
      { orgId: ORG, code: "BSP", name: "Basic Sale Price", category: "BASE_PRICE", isTaxable: true, gstRatePct: "5.00", countsTowardCommission: true, isRefundable: false, displayOrder: 1 },
      { orgId: ORG, code: "PLC", name: "Preferential location", category: "PLC", isTaxable: true, gstRatePct: "5.00", countsTowardCommission: true, isRefundable: false, displayOrder: 2 },
    ],
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
      items: {
        create: [
          {
            unitTypeId: plotType.id,
            baseRate: "25000.00",
            ...(opts.cornerRate ? { plcCharges: { CORNER: { basis: "PCT_OF_BASE", value: "10" } } } : {}),
          },
        ],
      },
    },
  });
  const admin = await makeUser("admin", ["project.write"]);
  const seller = await makeUser("seller", ["booking.create", "hold.create"], true);
  const reader = await makeUser("reader", ["unit.read"]);
  return { project, block, plotType, plots, admin, seller, reader };
}

const ctx = (user: { id: string }): AuditContext => ({ orgId: ORG, actorId: user.id, actorLabel: "t" });

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("normalizePlcTag", () => {
  it.each([
    ["CORNER", "CORNER"],
    [" corner ", "CORNER"],
    ["park facing", "PARK_FACING"],
    ["park-facing", "PARK_FACING"],
    ["East  Facing", "EAST_FACING"],
  ])("%j -> %s", (raw, expected) => {
    expect(normalizePlcTag(raw)).toBe(expected);
  });

  it.each(["", "   ", "corner!", "a".repeat(31), "कोना"])("refuses %j", (raw) => {
    expect(() => normalizePlcTag(raw)).toThrow(PlcTagError);
  });

  it("writes each tag once", () => {
    expect(normalizePlcTags(["corner", "CORNER", " Corner", "park"])).toEqual(["CORNER", "PARK"]);
  });
});

describe("setUnitPlcTag", () => {
  it("marks plots, bumps updatedAt, and writes one audit row per plot", async () => {
    const { project, plots, admin } = await seed();
    const before = await db.unit.findUniqueOrThrow({ where: { id: plots[0]!.id } });

    const result = await setUnitPlcTag(db, {
      projectId: project.id,
      unitIds: [plots[0]!.id, plots[1]!.id],
      tag: "corner",
      present: true,
      audit: ctx(admin.user),
    });

    expect(result).toEqual({ tag: "CORNER", changed: 2, unchanged: 0 });
    const after = await db.unit.findMany({ where: { projectId: project.id }, orderBy: { unitNumber: "asc" } });
    expect(after.map((u) => u.plcTags)).toEqual([["CORNER"], ["CORNER"], []]);
    expect(after[0]!.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    const rows = await db.auditLog.findMany({ where: { orgId: ORG, entity: "Unit", reason: "marked CORNER" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.before).toEqual({ plcTags: [] });
    expect(rows[0]!.after).toEqual({ plcTags: ["CORNER"] });
  });

  it("is idempotent: marking a marked plot changes nothing and never doubles the tag", async () => {
    const { project, plots, admin } = await seed();
    const params = { projectId: project.id, unitIds: [plots[0]!.id], tag: "CORNER", present: true, audit: ctx(admin.user) };
    await setUnitPlcTag(db, params);
    const again = await setUnitPlcTag(db, params);

    expect(again).toMatchObject({ changed: 0, unchanged: 1 });
    expect((await db.unit.findUniqueOrThrow({ where: { id: plots[0]!.id } })).plcTags).toEqual(["CORNER"]);
    expect(await db.auditLog.count({ where: { orgId: ORG, entity: "Unit", reason: "marked CORNER" } })).toBe(1);
  });

  it("clears the tag and keeps the others", async () => {
    const { project, plots, admin } = await seed();
    await db.unit.update({ where: { id: plots[0]!.id }, data: { plcTags: ["PARK", "CORNER"] } });

    const result = await setUnitPlcTag(db, {
      projectId: project.id,
      unitIds: [plots[0]!.id, plots[1]!.id],
      tag: "CORNER",
      present: false,
      audit: ctx(admin.user),
    });

    expect(result).toMatchObject({ changed: 1, unchanged: 1 });
    expect((await db.unit.findUniqueOrThrow({ where: { id: plots[0]!.id } })).plcTags).toEqual(["PARK"]);
  });

  it("refuses the whole request when any plot is held or sold, naming it, and changes nothing", async () => {
    const { project, plots, admin } = await seed();
    await db.unit.update({ where: { id: plots[1]!.id }, data: { status: "HELD" } });

    await expect(
      setUnitPlcTag(db, {
        projectId: project.id,
        unitIds: plots.map((p) => p.id),
        tag: "CORNER",
        present: true,
        audit: ctx(admin.user),
      }),
    ).rejects.toThrow(/A-02 is held or sold/);

    expect(await db.unit.count({ where: { projectId: project.id, NOT: { plcTags: { isEmpty: true } } } })).toBe(0);
  });

  it("allows a blocked plot (it is not for sale, so no price is moving)", async () => {
    const { project, plots, admin } = await seed();
    await db.unit.update({ where: { id: plots[0]!.id }, data: { status: "BLOCKED" } });
    const result = await setUnitPlcTag(db, {
      projectId: project.id,
      unitIds: [plots[0]!.id],
      tag: "CORNER",
      present: true,
      audit: ctx(admin.user),
    });
    expect(result.changed).toBe(1);
  });

  it("refuses someone without project.write, a system actor, and another organisation", async () => {
    const { project, plots, reader, admin } = await seed();
    const base = { projectId: project.id, unitIds: [plots[0]!.id], tag: "CORNER", present: true };

    await expect(setUnitPlcTag(db, { ...base, audit: ctx(reader.user) })).rejects.toThrow(ForbiddenError);
    await expect(setUnitPlcTag(db, { ...base, audit: { orgId: ORG, actorId: null, actorLabel: "sys" } })).rejects.toThrow(
      ForbiddenError,
    );
    await expect(
      setUnitPlcTag(db, { ...base, audit: { ...ctx(admin.user), orgId: "org_elsewhere" } }),
    ).rejects.toThrow(UnitTagError);
  });

  it("refuses plots of another project, an empty list, too many, and a bad tag", async () => {
    const { project, plots, admin } = await seed();
    const other = await db.project.create({ data: { orgId: ORG, code: "OTH", name: "Other" } });
    const base = { present: true, audit: ctx(admin.user) };

    await expect(
      setUnitPlcTag(db, { ...base, projectId: other.id, unitIds: [plots[0]!.id], tag: "CORNER" }),
    ).rejects.toThrow(/not in this project/);
    await expect(setUnitPlcTag(db, { ...base, projectId: project.id, unitIds: [], tag: "CORNER" })).rejects.toThrow(
      UnitTagError,
    );
    await expect(
      setUnitPlcTag(db, { ...base, projectId: project.id, unitIds: Array.from({ length: 201 }, (_, i) => `x${i}`), tag: "CORNER" }),
    ).rejects.toThrow(/at most 200/);
    await expect(
      setUnitPlcTag(db, { ...base, projectId: project.id, unitIds: [plots[0]!.id], tag: "no good!" }),
    ).rejects.toThrow(PlcTagError);
  });
});

describe("tags are written one way everywhere", () => {
  it("createUnit and updateUnit normalise and de-duplicate", async () => {
    const { project, block, plotType, admin } = await seed();
    const made = await createUnit(db, {
      projectId: project.id,
      towerId: block.id,
      unitTypeId: plotType.id,
      unitNumber: "A-10",
      plcTags: ["corner", "CORNER"],
      audit: ctx(admin.user),
    });
    expect(made.plcTags).toEqual(["CORNER"]);

    const changed = await updateUnit(db, { unitId: made.id, plcTags: ["park facing"], audit: ctx(admin.user) });
    expect(changed.plcTags).toEqual(["PARK_FACING"]);
  });

  it("the importer normalises, and reports a bad tag against its row", async () => {
    const { project, block, admin } = await seed();
    const params = { orgId: ORG, projectId: project.id, towerId: block.id, audit: ctx(admin.user) };

    await importUnits(db, {
      ...params,
      rows: [{ unitNumber: "A-20", unitTypeCode: "PLOT-200", plcTags: ["corner"] }],
    });
    expect((await db.unit.findFirstOrThrow({ where: { unitNumber: "A-20" } })).plcTags).toEqual(["CORNER"]);

    await expect(
      importUnits(db, { ...params, rows: [{ unitNumber: "A-21", unitTypeCode: "PLOT-200", plcTags: ["no good!"] }] }),
    ).rejects.toThrow();
    expect(await db.unit.count({ where: { unitNumber: "A-21" } })).toBe(0);
  });
});

describe("getUnpricedPlcTags", () => {
  it("lists tags in use that the live list does not price, with plot counts", async () => {
    const { project, plots } = await seed();
    await db.unit.update({ where: { id: plots[0]!.id }, data: { plcTags: ["CORNER"] } });
    await db.unit.update({ where: { id: plots[1]!.id }, data: { plcTags: ["CORNER", "PARK"] } });

    expect(await getUnpricedPlcTags(db, { projectId: project.id })).toEqual([
      { tag: "CORNER", plots: 2 },
      { tag: "PARK", plots: 1 },
    ]);
  });

  it("is empty once the list prices the tag, and a per-plot rate is read first", async () => {
    const { project, plots } = await seed({ cornerRate: true });
    await db.unit.update({ where: { id: plots[0]!.id }, data: { plcTags: ["CORNER"] } });
    expect(await getUnpricedPlcTags(db, { projectId: project.id })).toEqual([]);

    // A rate for just this plot, without the corner charge, takes over from the type's.
    const list = await db.priceList.findFirstOrThrow({ where: { projectId: project.id } });
    await db.priceListItem.create({ data: { priceListId: list.id, unitId: plots[0]!.id, baseRate: "30000.00" } });
    expect(await getUnpricedPlcTags(db, { projectId: project.id })).toEqual([{ tag: "CORNER", plots: 1 }]);
  });

  it("is empty when there is no active price list", async () => {
    const { project, plots } = await seed();
    await db.unit.update({ where: { id: plots[0]!.id }, data: { plcTags: ["CORNER"] } });
    await db.priceList.updateMany({ where: { projectId: project.id }, data: { status: "ARCHIVED" } });
    expect(await getUnpricedPlcTags(db, { projectId: project.id })).toEqual([]);
  });
});

describe("booking a corner plot", () => {
  const customer = { name: "Buyer", phone: "9876543210" };

  it("is refused before any hold or customer exists when the list has no corner rate", async () => {
    const { plots, seller } = await seed();
    await db.unit.update({ where: { id: plots[0]!.id }, data: { plcTags: ["CORNER"] } });

    await expect(bookPlot(db, { unitId: plots[0]!.id, customer, audit: ctx(seller.user) })).rejects.toThrow(
      PlotTagNotPricedError,
    );
    await expect(bookPlot(db, { unitId: plots[0]!.id, customer, audit: ctx(seller.user) })).rejects.toThrow(
      /corner.*Ask an admin/,
    );
    expect(await db.unitHold.count({ where: { orgId: ORG } })).toBe(0);
    expect(await db.customer.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("is charged the corner rate once the list has one: 10% of base on top", async () => {
    const { plots, seller } = await seed({ cornerRate: true });
    await db.unit.update({ where: { id: plots[0]!.id }, data: { plcTags: ["CORNER"] } });

    const result = await bookPlot(db, { unitId: plots[0]!.id, customer, audit: ctx(seller.user) });

    const booking = await db.booking.findUniqueOrThrow({ where: { id: result.bookingId } });
    // 200 sq yd x 25,000 = 5,000,000 base; corner 10% = 500,000.
    expect(booking.baseAmount.toString()).toBe("5000000");
    expect(booking.plcAmount.toString()).toBe("500000");
  });

  it("a plot that is not corner is unaffected by the missing rate", async () => {
    const { plots, seller } = await seed();
    const result = await bookPlot(db, { unitId: plots[1]!.id, customer, audit: ctx(seller.user) });
    const booking = await db.booking.findUniqueOrThrow({ where: { id: result.bookingId } });
    expect(booking.plcAmount.toString()).toBe("0");
  });
});
