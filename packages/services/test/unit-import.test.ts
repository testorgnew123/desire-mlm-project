// Bulk import validation. Pure function, so tested exhaustively without a
// database. The contract that matters: EVERY problem in the file is reported
// in one pass, so a user fixes their spreadsheet once instead of discovering
// the next error on each re-upload.
import { describe, expect, it } from "vitest";
import { Prisma } from "@desire/db";
import {
  validateUnitImportRows,
  validateUnitUpdateRows,
  type ExistingUnitForUpdate,
  type RawUnitRow,
  type UnitImportContext,
  type UnitUpdateContext,
} from "../src/unit-import";

const D = (v: string | number) => new Prisma.Decimal(v);

const CONTEXT: UnitImportContext = {
  existingUnitNumbers: ["A-101"],
  unitTypeAreas: [
    ["2BHK", { carpetArea: D(650), builtUpArea: D(780), saleableArea: D(975) }],
    ["3BHK", { carpetArea: D(900), builtUpArea: D(1080), saleableArea: D(1350) }],
  ],
  towerTotalFloors: 10,
};

const goodRow = (over: Partial<RawUnitRow> = {}): RawUnitRow => ({
  unitNumber: "B-201",
  unitTypeCode: "2BHK",
  floor: 2,
  ...over,
});

/** Errors for a given 1-based row, by field. */
const fieldsFor = (errors: { rowNumber: number; field: string }[], rowNumber: number) =>
  errors.filter((e) => e.rowNumber === rowNumber).map((e) => e.field).sort();

describe("happy path", () => {
  it("accepts well-formed rows and parses them", () => {
    const { valid, errors } = validateUnitImportRows(
      [goodRow(), goodRow({ unitNumber: "B-202", floor: 3, facing: "NE" })],
      CONTEXT,
    );
    expect(errors).toEqual([]);
    expect(valid).toHaveLength(2);
    expect(valid[0]?.unitNumber).toBe("B-201");
    expect(valid[1]?.facing).toBe("NE");
  });

  it("row numbers are 1-based over data rows, so they match the user's spreadsheet", () => {
    const { errors } = validateUnitImportRows(
      [goodRow(), goodRow({ unitNumber: "" })],
      CONTEXT,
    );
    // The bad row is the SECOND data row -> rowNumber 2, not 1 and not 0.
    expect(errors.every((e) => e.rowNumber === 2)).toBe(true);
  });
});

describe("reports EVERY problem, not just the first", () => {
  it("a row with three bad fields yields three errors", () => {
    const { valid, errors } = validateUnitImportRows(
      [{ unitNumber: "", unitTypeCode: "NOPE", floor: "3.5" }],
      CONTEXT,
    );
    expect(valid).toHaveLength(0);
    expect(fieldsFor(errors, 1)).toEqual(["floor", "unitNumber", "unitTypeCode"]);
  });

  it("problems in different rows are all reported in one pass", () => {
    const { errors } = validateUnitImportRows(
      [goodRow({ unitNumber: "" }), goodRow({ unitNumber: "B-9", unitTypeCode: "NOPE" })],
      CONTEXT,
    );
    expect(new Set(errors.map((e) => e.rowNumber))).toEqual(new Set([1, 2]));
  });
});

describe("unit numbers", () => {
  it("rejects a number already present in the project", () => {
    const { errors } = validateUnitImportRows([goodRow({ unitNumber: "A-101" })], CONTEXT);
    expect(errors.some((e) => e.field === "unitNumber")).toBe(true);
  });

  it("rejects duplicates WITHIN the batch, naming the row that claimed it first", () => {
    const { valid, errors } = validateUnitImportRows(
      [goodRow({ unitNumber: "C-1" }), goodRow({ unitNumber: "C-1", floor: 4 })],
      CONTEXT,
    );
    // The first occurrence is fine; the second is the duplicate.
    expect(valid).toHaveLength(1);
    const dup = errors.find((e) => e.field === "unitNumber");
    expect(dup?.rowNumber).toBe(2);
    expect(dup?.message).toMatch(/1/); // points back at the first row
  });

  it("rejects blank and whitespace-only unit numbers", () => {
    const { errors } = validateUnitImportRows(
      [goodRow({ unitNumber: "   " }), goodRow({ unitNumber: undefined })],
      CONTEXT,
    );
    expect(errors.filter((e) => e.field === "unitNumber")).toHaveLength(2);
  });
});

describe("floors", () => {
  it("rejects a non-integer floor with a message naming the actual value", () => {
    const { errors } = validateUnitImportRows([goodRow({ floor: "3.5" })], CONTEXT);
    const err = errors.find((e) => e.field === "floor");
    expect(err).toBeDefined();
    expect(String(err?.message)).toMatch(/3\.5/);
  });

  it("rejects a floor above the tower's totalFloors", () => {
    const { errors } = validateUnitImportRows([goodRow({ floor: 11 })], CONTEXT);
    expect(errors.some((e) => e.field === "floor")).toBe(true);
  });

  it("accepts the top floor exactly (boundary, not off-by-one)", () => {
    const { errors } = validateUnitImportRows([goodRow({ floor: 10 })], CONTEXT);
    expect(errors).toEqual([]);
  });

  it("skips the ceiling check when no tower is given", () => {
    const { errors } = validateUnitImportRows([goodRow({ floor: 99 })], {
      ...CONTEXT,
      towerTotalFloors: undefined,
    });
    expect(errors).toEqual([]);
  });
});

describe("unit type", () => {
  it("rejects an unknown code and hints at the valid ones", () => {
    const { errors } = validateUnitImportRows([goodRow({ unitTypeCode: "5BHK" })], CONTEXT);
    const err = errors.find((e) => e.field === "unitTypeCode");
    expect(err).toBeDefined();
    expect(String(err?.message)).toMatch(/2BHK|3BHK/);
  });
});

describe("facing", () => {
  it("accepts the eight compass values", () => {
    for (const f of ["N", "S", "E", "W", "NE", "NW", "SE", "SW"]) {
      const { errors } = validateUnitImportRows(
        [goodRow({ unitNumber: `F-${f}`, facing: f })],
        CONTEXT,
      );
      expect(errors, `facing ${f} should be valid`).toEqual([]);
    }
  });

  it("rejects anything else", () => {
    const { errors } = validateUnitImportRows([goodRow({ facing: "NORTH" })], CONTEXT);
    expect(errors.some((e) => e.field === "facing")).toBe(true);
  });

  it("treats facing as optional", () => {
    const { errors } = validateUnitImportRows([goodRow({ facing: undefined })], CONTEXT);
    expect(errors).toEqual([]);
  });
});

describe("area overrides -- the expensive confusion", () => {
  it("rejects carpet >= saleable (docs/19-GLOSSARY.md: carpet is always the smaller)", () => {
    const { errors } = validateUnitImportRows(
      [goodRow({ carpetAreaOverride: "1000", saleableAreaOverride: "900" })],
      CONTEXT,
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts a sane override pair", () => {
    const { errors } = validateUnitImportRows(
      [goodRow({ carpetAreaOverride: "700", saleableAreaOverride: "1050" })],
      CONTEXT,
    );
    expect(errors).toEqual([]);
  });

  it("rejects a negative area", () => {
    const { errors } = validateUnitImportRows(
      [goodRow({ carpetAreaOverride: "-650" })],
      CONTEXT,
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects an absurd area rather than letting Postgres abort the whole insert", () => {
    // Decimal(10,2) overflows past 8 integer digits. A price landing in an
    // area column is the realistic cause -- the user needs a row-and-field
    // message, not a failed batch.
    const { errors } = validateUnitImportRows(
      [goodRow({ saleableAreaOverride: "5000000000" })],
      CONTEXT,
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("purity", () => {
  it("does not mutate the caller's rows or context", () => {
    const rows = [goodRow()];
    const snapshot = JSON.parse(JSON.stringify(rows));
    const existing = ["A-101"];
    validateUnitImportRows(rows, { ...CONTEXT, existingUnitNumbers: existing });
    expect(JSON.parse(JSON.stringify(rows))).toEqual(snapshot);
    expect(existing).toEqual(["A-101"]); // batch numbers not appended to the caller's array
  });

  it("same input twice gives the same result", () => {
    const rows = [goodRow(), goodRow({ unitNumber: "" })];
    const a = validateUnitImportRows(rows, CONTEXT);
    const b = validateUnitImportRows(rows, CONTEXT);
    expect(JSON.stringify(b.errors)).toBe(JSON.stringify(a.errors));
  });
});

// ── Plotted blocks ─────────────────────────────────────────────────────
//
// A plot has no floor. The rule mirrors createUnit's assertUnitFloor exactly:
// TOWER demands a floor, BLOCK forbids one, no target group leaves it
// optional. The last of those is the one with teeth -- an earlier cut of this
// change kept `floor === undefined` in validateRow's final guard, so every
// plot was dropped with NO error at all: valid empty, errors empty, nothing
// imported and nothing said. Silent data loss is the worst failure an
// importer can have, so it is asserted directly.
describe("plotted blocks", () => {
  const BLOCK_CONTEXT: UnitImportContext = {
    existingUnitNumbers: [],
    unitTypeAreas: [["PLOT", { carpetArea: D(900), builtUpArea: D(950), saleableArea: D(1000) }]],
    targetGroupKind: "BLOCK",
  };
  const plotRow = (over: Partial<RawUnitRow> = {}): RawUnitRow => ({
    unitNumber: "B1-001",
    unitTypeCode: "PLOT",
    ...over,
  });

  it("accepts a plot with no floor, and actually returns it", () => {
    const { valid, errors } = validateUnitImportRows(
      [plotRow(), plotRow({ unitNumber: "B1-002" })],
      BLOCK_CONTEXT,
    );
    expect(errors).toEqual([]);
    // The regression: this was 0 while errors was also empty.
    expect(valid).toHaveLength(2);
    expect(valid[0]?.floor).toBeUndefined();
  });

  it("rejects a plot that carries a floor", () => {
    const { valid, errors } = validateUnitImportRows([plotRow({ floor: 3 })], BLOCK_CONTEXT);
    expect(valid).toHaveLength(0);
    expect(fieldsFor(errors, 1)).toEqual(["floor"]);
    expect(errors[0]?.message).toContain("must be empty for a plot in a block");
  });

  it("demands a floor when the batch targets a tower", () => {
    const { valid, errors } = validateUnitImportRows([plotRow()], {
      ...BLOCK_CONTEXT,
      targetGroupKind: "TOWER",
      towerTotalFloors: 10,
    });
    expect(valid).toHaveLength(0);
    expect(errors[0]?.message).toContain("required for a unit in a tower");
  });

  it("leaves floor optional when the batch targets no group", () => {
    const { valid, errors } = validateUnitImportRows([plotRow()], {
      ...BLOCK_CONTEXT,
      targetGroupKind: undefined,
    });
    expect(errors).toEqual([]);
    expect(valid).toHaveLength(1);
  });
});

// "Update plots that already exist": the same file read as changes to plots that
// are already there. Pure, like the rest of this file: the plots, their status
// and their sizes are passed in.
describe("updating plots that already exist", () => {
  const BLOCK = "block-a";
  const plot = (unitNumber: string, over: Partial<ExistingUnitForUpdate> = {}): [string, ExistingUnitForUpdate] => [
    unitNumber,
    {
      id: `id-${unitNumber}`,
      towerId: BLOCK,
      status: "AVAILABLE",
      unitTypeCode: "PLOT-200",
      facing: null,
      plcTags: [],
      saleableAreaOverride: null,
      ...over,
    },
  ];
  const contextFor = (...units: Array<[string, ExistingUnitForUpdate]>): UnitUpdateContext => ({
    existingUnits: units,
    targetTowerId: BLOCK,
    unitTypeAreas: [
      ["PLOT-200", { carpetArea: null, builtUpArea: null, saleableArea: D(200) }],
      ["PLOT-300", { carpetArea: null, builtUpArea: null, saleableArea: D(300) }],
    ],
  });

  it("changes only what the row says: a blank cell, or an empty tag list, keeps the plot as it is", () => {
    const { changes, unchanged, errors } = validateUnitUpdateRows(
      // The route hands plcTags over as [] for a blank cell.
      [{ unitNumber: "A-01", unitTypeCode: "", floor: "", facing: "", plcTags: [], saleableAreaOverride: "210" }],
      contextFor(plot("A-01", { facing: "N", plcTags: ["CORNER"] })),
    );
    expect(errors).toEqual([]);
    expect(unchanged).toBe(0);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ rowNumber: 1, unitId: "id-A-01", unitNumber: "A-01" });
    expect(changes[0]?.patch).toEqual({ saleableAreaOverride: D(210) });
  });

  it("changes type, size, facing and tags together, normalising what it is given", () => {
    const { changes, errors } = validateUnitUpdateRows(
      [{ unitNumber: "A-01", unitTypeCode: "PLOT-300", facing: "ne", plcTags: ["corner", "park facing"], saleableAreaOverride: "250.555" }],
      contextFor(plot("A-01")),
    );
    expect(errors).toEqual([]);
    expect(changes[0]?.patch).toEqual({
      unitTypeCode: "PLOT-300",
      facing: "NE",
      plcTags: ["CORNER", "PARK_FACING"],
      saleableAreaOverride: D("250.56"),
    });
  });

  it("counts a row that already matches as unchanged, not as an error", () => {
    const { changes, unchanged, errors } = validateUnitUpdateRows(
      [
        { unitNumber: "A-01", saleableAreaOverride: "200" }, // the type's own size
        { unitNumber: "A-02", saleableAreaOverride: "210.00" }, // its own override already
        { unitNumber: "A-03", facing: "n", plcTags: ["CORNER"], unitTypeCode: "PLOT-200" },
        { unitNumber: "A-04" }, // names a plot and says nothing
      ],
      contextFor(
        plot("A-01"),
        plot("A-02", { saleableAreaOverride: D("210") }),
        plot("A-03", { facing: "N", plcTags: ["CORNER"] }),
        plot("A-04"),
      ),
    );
    expect(errors).toEqual([]);
    expect(changes).toEqual([]);
    expect(unchanged).toBe(4);
  });

  it("changes the size of a blocked plot, but refuses to change size, type or tags of a held or sold one", () => {
    const { changes, errors } = validateUnitUpdateRows(
      [
        { unitNumber: "A-01", saleableAreaOverride: "210" },
        { unitNumber: "A-02", saleableAreaOverride: "210" },
        { unitNumber: "A-03", plcTags: ["CORNER"] },
        { unitNumber: "A-04", unitTypeCode: "PLOT-300" },
      ],
      contextFor(
        plot("A-01", { status: "BLOCKED" }),
        plot("A-02", { status: "HELD" }),
        plot("A-03", { status: "BOOKED" }),
        plot("A-04", { status: "HELD" }),
      ),
    );
    expect(changes.map((change) => change.unitNumber)).toEqual(["A-01"]);
    expect(errors.map((error) => [error.rowNumber, error.field])).toEqual([
      [2, "unitNumber"],
      [3, "unitNumber"],
      [4, "unitNumber"],
    ]);
    expect(errors[0]?.message).toMatch(/Plot A-02 is held.*Block it first/);
    expect(errors[1]?.message).toMatch(/Plot A-03 is sold.*Cancel its booking/);
  });

  it("still changes the facing of a held plot, and accepts a held plot the file leaves as it is", () => {
    const { changes, unchanged, errors } = validateUnitUpdateRows(
      [
        { unitNumber: "A-01", facing: "S" },
        { unitNumber: "A-02", saleableAreaOverride: "200" },
      ],
      contextFor(plot("A-01", { status: "HELD" }), plot("A-02", { status: "HELD" })),
    );
    expect(errors).toEqual([]);
    expect(changes[0]?.patch).toEqual({ facing: "S" });
    expect(unchanged).toBe(1);
  });

  it("never creates: an unknown plot, a plot in another block and a repeated plot are errors", () => {
    const { changes, errors } = validateUnitUpdateRows(
      [
        { unitNumber: "Z-99", saleableAreaOverride: "210" },
        { unitNumber: "B-01", saleableAreaOverride: "210" },
        { unitNumber: "A-01", saleableAreaOverride: "210" },
        { unitNumber: "A-01", saleableAreaOverride: "220" },
        { unitNumber: "", saleableAreaOverride: "210" },
      ],
      contextFor(plot("A-01"), plot("B-01", { towerId: "block-b" })),
    );
    expect(changes.map((change) => change.unitNumber)).toEqual(["A-01"]);
    expect(errors.map((error) => [error.rowNumber, error.field])).toEqual([
      [1, "unitNumber"],
      [2, "unitNumber"],
      [4, "unitNumber"],
      [5, "unitNumber"],
    ]);
    expect(errors[0]?.message).toMatch(/does not exist.*never creates/);
    expect(errors[1]?.message).toMatch(/not in the block/);
    expect(errors[2]?.message).toMatch(/more than once.*first on row 3/);
  });

  it("reports every bad cell of a row in one pass, and changes nothing for that row", () => {
    const { changes, unchanged, errors } = validateUnitUpdateRows(
      [
        {
          unitNumber: "A-01",
          unitTypeCode: "NOPE",
          floor: "2",
          facing: "UP",
          plcTags: ["corner", "bad tag!"],
          carpetAreaOverride: "100",
          saleableAreaOverride: "abc",
        },
      ],
      contextFor(plot("A-01")),
    );
    expect(changes).toEqual([]);
    expect(unchanged).toBe(0);
    expect(fieldsFor(errors, 1)).toEqual([
      "carpetAreaOverride",
      "facing",
      "floor",
      "plcTags",
      "saleableAreaOverride",
      "unitTypeCode",
    ]);
  });

  it("refuses a size of zero, below zero or beyond the column", () => {
    const { errors } = validateUnitUpdateRows(
      [
        { unitNumber: "A-01", saleableAreaOverride: "0" },
        { unitNumber: "A-02", saleableAreaOverride: "-5" },
        { unitNumber: "A-03", saleableAreaOverride: "100000000" },
      ],
      contextFor(plot("A-01"), plot("A-02"), plot("A-03")),
    );
    expect(errors.map((error) => error.field)).toEqual(["saleableAreaOverride", "saleableAreaOverride", "saleableAreaOverride"]);
  });
});
