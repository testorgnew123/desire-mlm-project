import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as importUnits } from "../app/api/v1/projects/[projectId]/units/import/route";
import { body, db, params, request, resetWorld, seedWorld, type World } from "./support";

let w: World;
beforeEach(async () => {
  await resetWorld();
  w = await seedWorld();
});
afterAll(async () => {
  await resetWorld();
  await db.$disconnect();
});

const HEADER = "unitNumber,unitTypeCode,floor,facing,plcTags,carpetAreaOverride,saleableAreaOverride";

function upload(
  token: string | null,
  csv: string | null,
  towerId: string | null = w.block.id,
  updateExisting = false,
) {
  const form = new FormData();
  if (csv !== null) form.set("file", new File([csv], "plots.csv", { type: "text/csv" }));
  if (towerId) form.set("towerId", towerId);
  // A tick-box posts "on" when ticked and nothing at all when not.
  if (updateExisting) form.set("updateExisting", "on");
  return importUnits(
    request(`/api/v1/projects/${w.project.id}/units/import`, { method: "POST", token, body: form }),
    params({ projectId: w.project.id }),
  );
}

const plotsNow = () => db.unit.count({ where: { projectId: w.project.id } });

describe("POST /api/v1/projects/[projectId]/units/import", () => {
  it("answers 401 without a session", async () => {
    expect((await upload(null, `${HEADER}\nB-01,PLOT-200,,,,,\n`)).status).toBe(401);
  });

  it("answers 403 to an associate, who cannot create plots", async () => {
    const response = await upload(w.seller.token, `${HEADER}\nB-01,PLOT-200,,,,,\n`);
    expect(response.status).toBe(403);
    expect(await plotsNow()).toBe(3);
  });

  it("answers 400 when no file is attached, and when the file has no data row", async () => {
    expect((await upload(w.admin.token, null)).status).toBe(400);
    expect((await upload(w.admin.token, `${HEADER}\n`)).status).toBe(400);
  });

  it.each([["an admin", () => w.admin], ["a super admin", () => w.superAdmin]])("lets %s load plots into a block", async (_who, who) => {
    const response = await upload(who().token, `${HEADER}\nB-01,PLOT-200,,N,,,\nB-02,PLOT-200,,S,,,\n`);

    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ imported: 2, skipped: 0 });
    expect(await plotsNow()).toBe(5);
    const created = await db.unit.findMany({ where: { unitNumber: { in: ["B-01", "B-02"] } }, select: { towerId: true, floor: true } });
    expect(created.every((u) => u.towerId === w.block.id && u.floor === null)).toBe(true);
  });

  it("reads a file as a spreadsheet exports it: a BOM, quoted commas, Windows line ends, notes and a trailing blank line", async () => {
    const csv =
      `﻿${HEADER}\r\n` +
      `# a note, with a comma, that is ignored\r\n` +
      `"B-10",PLOT-200,,N,CORNER|PARK_FACING,,\r\n` +
      `"B-11",PLOT-200,,,,,\r\n` +
      `\r\n`;
    const response = await upload(w.admin.token, csv);

    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ imported: 2, ignoredComments: 1 });
    const corner = await db.unit.findFirstOrThrow({ where: { unitNumber: "B-10" } });
    expect(corner.plcTags.sort()).toEqual(["CORNER", "PARK_FACING"]);
  });

  it("answers 400 with a plain message when an Excel workbook is uploaded instead of a CSV", async () => {
    const form = new FormData();
    // The first bytes of any .xlsx: a ZIP local-file header.
    form.set("file", new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])], "plots.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    form.set("towerId", w.block.id);
    const response = await importUnits(
      request(`/api/v1/projects/${w.project.id}/units/import`, { method: "POST", token: w.admin.token, body: form }),
      params({ projectId: w.project.id }),
    );

    expect(response.status).toBe(400);
    expect(String((await body(response)).detail)).toMatch(/Excel workbook/);
    expect(await plotsNow()).toBe(3);
  });

  it("answers 422 with every bad row at once, and writes none of them", async () => {
    const csv = `${HEADER}\nB-01,PLOT-200,,,,,\nA-01,PLOT-200,,,,,\nB-03,NO-SUCH-TYPE,,,,,\n`;
    const response = await upload(w.admin.token, csv);

    expect(response.status).toBe(422);
    const json = (await body(response)) as { report: { errors: { rowNumber: number }[] } };
    expect(json.report.errors.map((e) => e.rowNumber).sort()).toEqual([2, 3]);
    expect(await plotsNow()).toBe(3);
  });

  it("answers 422 for a flat type, now that only plots can be created", async () => {
    await db.unitType.create({
      data: { orgId: w.project.orgId, projectId: w.project.id, code: "FLAT", name: "Flat", areaBasis: "SQFT", carpetArea: "650", builtUpArea: "780", saleableArea: "975" },
    });
    const response = await upload(w.admin.token, `${HEADER}\nB-01,FLAT,,,,,\n`);
    expect(response.status).toBe(422);
    expect(String((await body(response)).detail)).toMatch(/plot/i);
    expect(await plotsNow()).toBe(3);
  });

  it("answers 422 for a tower, now that only blocks can receive plots", async () => {
    const tower = await db.tower.create({
      data: { orgId: w.project.orgId, projectId: w.project.id, code: "TWR", name: "Tower", kind: "TOWER", totalFloors: 5 },
    });
    const response = await upload(w.admin.token, `${HEADER}\nT-101,PLOT-200,1,,,,\n`, tower.id);
    expect(response.status).toBe(422);
    expect(await plotsNow()).toBe(3);
  });

  it("loads plots into a project with no RERA registration, which is not required", async () => {
    await db.project.update({ where: { id: w.project.id }, data: { reraRegNo: null, reraValidTill: null } });
    const response = await upload(w.admin.token, `${HEADER}\nB-01,PLOT-200,,,,,\n`);
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ imported: 1, skipped: 0 });
    expect(await plotsNow()).toBe(4);
  });

  it("answers 422 for a block that belongs to another project", async () => {
    const response = await upload(w.admin.token, `${HEADER}\nB-01,PLOT-200,,,,,\n`, "no-such-block");
    expect(response.status).toBe(422);
  });
});

describe("POST /api/v1/projects/[projectId]/units/import with 'Update plots that already exist' ticked", () => {
  const plotNamed = (unitNumber: string) =>
    db.unit.findFirstOrThrow({ where: { projectId: w.project.id, unitNumber } });

  it("changes the plots the file names, leaves blank cells alone, and creates nothing", async () => {
    const csv = `${HEADER}\nA-01,,,S,CORNER,,210\nA-02,,,,,,\n`;
    const response = await upload(w.admin.token, csv, w.block.id, true);

    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ imported: 0, updated: 1, unchanged: 1, skipped: 0 });
    expect(await plotsNow()).toBe(3);
    const changed = await plotNamed("A-01");
    expect(changed).toMatchObject({ facing: "S", plcTags: ["CORNER"] });
    expect(changed.saleableAreaOverride?.toString()).toBe("210");
    expect((await plotNamed("A-02")).saleableAreaOverride).toBeNull();
  });

  it("answers 422 with the whole report and changes nothing when a row names a plot that does not exist", async () => {
    const csv = `${HEADER}\nA-01,,,,,,210\nZ-99,,,,,,210\n`;
    const response = await upload(w.admin.token, csv, w.block.id, true);

    expect(response.status).toBe(422);
    const json = (await body(response)) as { report: { errors: { rowNumber: number; message: string }[] } };
    expect(json.report.errors.map((e) => e.rowNumber)).toEqual([2]);
    expect(json.report.errors[0]?.message).toMatch(/does not exist/);
    expect(await plotsNow()).toBe(3);
    expect((await plotNamed("A-01")).saleableAreaOverride).toBeNull();
  });

  it("answers 422 when the size of a held plot would change", async () => {
    await db.unit.update({ where: { id: w.plots[1]!.id }, data: { status: "HELD" } });
    const response = await upload(w.admin.token, `${HEADER}\nA-02,,,,,,210\n`, w.block.id, true);

    expect(response.status).toBe(422);
    const json = (await body(response)) as { report: { errors: { message: string }[] } };
    expect(json.report.errors[0]?.message).toMatch(/Plot A-02 is held/);
    expect((await plotNamed("A-02")).saleableAreaOverride).toBeNull();
  });

  it("answers 403 to an associate, and 401 without a session", async () => {
    const csv = `${HEADER}\nA-01,,,,,,210\n`;

    expect((await upload(w.seller.token, csv, w.block.id, true)).status).toBe(403);
    expect((await upload(null, csv, w.block.id, true)).status).toBe(401);
    expect((await plotNamed("A-01")).saleableAreaOverride).toBeNull();
  });

  it("is off unless the box is ticked: the same file is refused as duplicates", async () => {
    const response = await upload(w.admin.token, `${HEADER}\nA-01,PLOT-200,,,,,210\n`);

    expect(response.status).toBe(422);
    expect(await plotsNow()).toBe(3);
    expect((await plotNamed("A-01")).saleableAreaOverride).toBeNull();
  });
});
