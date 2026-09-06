// Bulk import validation. Pure function, so tested exhaustively without a
// database. The contract that matters: EVERY problem in the file is reported
// in one pass, so a user fixes their spreadsheet once instead of discovering
// the next error on each re-upload.
import { describe, expect, it } from "vitest";
import { Prisma } from "@desire/db";
import {
  validateUnitImportRows,
  type RawUnitRow,
  type UnitImportContext,
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
