// Bulk unit import. An inventory board is only as good as what was loaded into
// it (docs/06-INVENTORY-SPEC.md section 6), and inventory arrives as a
// developer's spreadsheet -- inconsistent, half-typed, and occasionally the
// wrong column order.
//
// Two halves, deliberately separated:
//   1. validateUnitImportRows -- pure. No database, no file I/O. Everything it
//      needs about the project (existing unit numbers, unit types and their
//      areas, tower height) is passed in, so the whole rule set is testable
//      against every malformed-row case without Postgres.
//   2. importUnits -- the thin DB half: read that context, validate, insert.
//
// Parsing is NOT here. Services do no file I/O; the route layer turns the
// uploaded CSV/XLSX into plain objects and hands them over, the same division
// docs/07-API.md draws for every other endpoint -- handlers validate shape,
// services hold the rules.
import { Prisma, SCOPE } from "@desire/db";
import type { UnitGroupKind, UnitStatus } from "@desire/db";
import type { PrismaClient } from "@desire/db";
import { writeAuditLog, type AuditContext } from "./audit";
import { normalizePlcTag } from "./plc-tags";
import { PlotsOnlyError, assertPlotsOnlyGroup } from "./plots-only";
import { assertPermission, ForbiddenError } from "./rbac";
import {
  PRICE_EDITABLE_STATUSES,
  auditDiff,
  priceLockedMessage,
  resolveUnitAreas,
  type UnitTypeAreas,
} from "./projects";

// ── Errors ─────────────────────────────────────────────────────────────

/** ALL_OR_NOTHING refused the batch. Carries the full report so the route
 *  layer can render every problem at once -- an importer that surfaces one
 *  error per upload attempt makes a 400-row file take 400 uploads. */
export class UnitImportRejectedError extends Error {
  constructor(public readonly report: UnitImportReport) {
    super(
      `Unit import rejected under ALL_OR_NOTHING: ${report.errors.length} problem(s) ` +
        `across ${report.skipped} row(s). Nothing was imported.`,
    );
    this.name = "UnitImportRejectedError";
  }
}

/** The project or tower the batch targets does not exist, or does not belong
 *  where the caller says it does. */
export class UnitImportTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitImportTargetError";
  }
}

export class UnitImportConflictError extends Error {
  constructor(public readonly projectId: string) {
    super(
      `A concurrent import claimed one of these unit numbers in project ${projectId}. ` +
        `Nothing was imported; re-run the import to see which rows now clash.`,
    );
    this.name = "UnitImportConflictError";
  }
}

// ── Row shapes ─────────────────────────────────────────────────────────

/** One data row exactly as a CSV/XLSX parser produces it: keys are the
 *  spreadsheet's column names, every cell is unknown until validated. */
export type RawUnitRow = Record<string, unknown>;

/** Unit.facing is a plain String? in the schema, so this union exists only
 *  here, at the import boundary, to stop "North" and "north-east" entering the
 *  column alongside "N" and making the board's facing filter useless. */
export const UNIT_FACINGS = ["N", "S", "E", "W", "NE", "NW", "SE", "SW"] as const;
export type UnitFacing = (typeof UNIT_FACINGS)[number];

export interface ParsedUnitRow {
  /** 1-based index into the source file's DATA rows -- see RowError. */
  rowNumber: number;
  unitNumber: string;
  unitTypeCode: string;
  /** Undefined for a plot in a BLOCK, which has no floor. */
  floor?: number;
  facing?: UnitFacing;
  plcTags: string[];
  carpetAreaOverride?: Prisma.Decimal;
  saleableAreaOverride?: Prisma.Decimal;
}

/** One problem with one field of one row. A row with three bad fields produces
 *  three of these, not one summary -- the user fixes their spreadsheet in a
 *  single pass rather than discovering the next problem on re-upload. */
export interface RowError {
  /** 1-based over the source file's DATA rows: rows[0] is row 1. The parser
   *  has already dropped the header, so a file with a header line shows this
   *  row at spreadsheet line rowNumber + 1. */
  rowNumber: number;
  field: string;
  /** The offending cell, as it arrived. */
  value: unknown;
  message: string;
}

export interface UnitImportContext {
  /** Unit numbers already in the project. Compared exactly (after trimming),
   *  matching the @@unique([projectId, unitNumber]) index this predicts. */
  existingUnitNumbers: Iterable<string>;
  /** UnitType.code -> that type's areas, one entry per unit type defined for
   *  this project. One map rather than a code list plus a parallel area list:
   *  the keys ARE the set of valid unitTypeCode values, so the two cannot
   *  disagree. The areas are what a row's overrides are checked against -- see
   *  the area block in validateRow. */
  unitTypeAreas: Iterable<[string, UnitTypeAreas]>;
  /** Tower.totalFloors, when the batch targets one tower. Omitted means no
   *  floor ceiling can be checked. */
  towerTotalFloors?: number;
  /** The kind of group this batch targets, when it targets one. TOWER demands
   *  a floor on every row; BLOCK forbids one, because a plot has none.
   *  Omitted means the batch targets no group, where floor stays optional --
   *  that case predates blocks and is not retro-invalidated. */
  targetGroupKind?: UnitGroupKind;
}

export interface UnitImportValidation {
  valid: ParsedUnitRow[];
  errors: RowError[];
}

/** A plot already in the project, as the "update existing plots" import sees it. */
export interface ExistingUnitForUpdate {
  id: string;
  towerId: string | null;
  status: UnitStatus;
  unitTypeCode: string;
  facing: string | null;
  plcTags: readonly string[];
  saleableAreaOverride: Prisma.Decimal | null;
}

export interface UnitUpdateContext {
  /** The project's plots by plot number: at least every one the file names. */
  existingUnits: Iterable<[string, ExistingUnitForUpdate]>;
  /** The block the file targets. A plot in any other block is refused. */
  targetTowerId: string;
  /** As for UnitImportContext: the keys are the valid unitTypeCode values. */
  unitTypeAreas: Iterable<[string, UnitTypeAreas]>;
}

/** One plot the file changes. `patch` has only the fields that differ. */
export interface ParsedUnitUpdate {
  rowNumber: number;
  unitId: string;
  unitNumber: string;
  patch: {
    unitTypeCode?: string;
    facing?: UnitFacing;
    plcTags?: string[];
    saleableAreaOverride?: Prisma.Decimal;
  };
}

export interface UnitUpdateValidation {
  changes: ParsedUnitUpdate[];
  /** Rows naming a plot that is already exactly as the file says. */
  unchanged: number;
  errors: RowError[];
}

// ── Validation (pure) ──────────────────────────────────────────────────

const FACING_SET: ReadonlySet<string> = new Set<string>(UNIT_FACINGS);

// decimal.js rounding mode 4 is ROUND_HALF_UP. Prisma's bundled Decimal typings
// expose the mode as a numeric union and do not re-export decimal.js's named
// ROUND_HALF_UP constant, so the mode is named here rather than reached for
// through Prisma.Decimal (which would not typecheck).
const ROUND_HALF_UP = 4;

// Unit.carpetAreaOverride / saleableAreaOverride are Decimal(10, 2): eight
// integer digits. A misaligned column (a price landing in an area cell) would
// otherwise reach Postgres and abort the whole insert with a numeric overflow
// instead of a row-and-field message the user can act on.
const MAX_AREA = new Prisma.Decimal("99999999.99");

interface ResolvedContext {
  existingUnitNumbers: ReadonlySet<string>;
  unitTypeAreas: ReadonlyMap<string, UnitTypeAreas>;
  unitTypeHint: string;
  towerTotalFloors: number | undefined;
  targetGroupKind: UnitGroupKind | undefined;
}

/** Validates every row and reports every problem found. Rows with no problems
 *  come back in `valid`, ready to insert; a row with any problem is never
 *  partially accepted. Pure: same rows plus same context, same result. */
export function validateUnitImportRows(
  rows: readonly RawUnitRow[],
  context: UnitImportContext,
): UnitImportValidation {
  const unitTypeAreas = new Map(context.unitTypeAreas);
  const resolved: ResolvedContext = {
    existingUnitNumbers: new Set(context.existingUnitNumbers),
    unitTypeAreas,
    unitTypeHint: describeCodes(unitTypeAreas.keys()),
    towerTotalFloors: context.towerTotalFloors,
    targetGroupKind: context.targetGroupKind,
  };

  // unitNumber -> the first row that claimed it, so the duplicate message can
  // point at the other half of the pair.
  const firstSeenAt = new Map<string, number>();

  const valid: ParsedUnitRow[] = [];
  const errors: RowError[] = [];

  rows.forEach((row, index) => {
    const result = validateRow(row, index + 1, resolved, firstSeenAt);
    if (result.parsed) valid.push(result.parsed);
    errors.push(...result.errors);
  });

  return { valid, errors };
}

function validateRow(
  row: RawUnitRow,
  rowNumber: number,
  ctx: ResolvedContext,
  firstSeenAt: Map<string, number>,
): { parsed: ParsedUnitRow | null; errors: RowError[] } {
  const problems: RowError[] = [];
  const fail = (field: string, value: unknown, message: string): void => {
    problems.push({ rowNumber, field, value, message });
  };

  // ── unitNumber. At most one problem is reported per field: once a cell is
  //    empty there is nothing useful to say about its uniqueness.
  const unitNumber = readCellString(row.unitNumber);
  if (unitNumber === undefined) {
    fail(
      "unitNumber",
      row.unitNumber,
      isAbsent(row.unitNumber)
        ? "unitNumber is required"
        : `unitNumber must be text, got ${display(row.unitNumber)}`,
    );
  } else if (ctx.existingUnitNumbers.has(unitNumber)) {
    fail(
      "unitNumber",
      row.unitNumber,
      `unit '${unitNumber}' already exists in this project`,
    );
  } else {
    const firstRow = firstSeenAt.get(unitNumber);
    if (firstRow === undefined) {
      firstSeenAt.set(unitNumber, rowNumber);
    } else {
      fail(
        "unitNumber",
        row.unitNumber,
        `unit '${unitNumber}' appears more than once in this batch (first on row ${firstRow})`,
      );
    }
  }

  // ── unitTypeCode
  const unitTypeCode = readCellString(row.unitTypeCode);
  if (unitTypeCode === undefined) {
    fail(
      "unitTypeCode",
      row.unitTypeCode,
      isAbsent(row.unitTypeCode)
        ? "unitTypeCode is required"
        : `unitTypeCode must be text, got ${display(row.unitTypeCode)}`,
    );
  } else if (!ctx.unitTypeAreas.has(unitTypeCode)) {
    fail(
      "unitTypeCode",
      row.unitTypeCode,
      `unitTypeCode '${unitTypeCode}' is not a unit type of this project (${ctx.unitTypeHint})`,
    );
  }

  // ── floor
  //
  // Three cases, matching createUnit's assertUnitFloor: a TOWER demands a
  // floor, a BLOCK forbids one (a plot has none, and storing 0 would put every
  // plot in a phantom ground-floor row on the board), and a batch targeting no
  // group at all keeps the old optional behaviour.
  const floor = readInteger(row.floor);
  if (ctx.targetGroupKind === "BLOCK") {
    if (!isAbsent(row.floor)) {
      fail("floor", row.floor, "floor must be empty for a plot in a block");
    }
  } else if (floor === undefined) {
    if (ctx.targetGroupKind === "TOWER" || !isAbsent(row.floor)) {
      fail(
        "floor",
        row.floor,
        isAbsent(row.floor)
          ? "floor is required for a unit in a tower"
          : `floor must be an integer, got ${display(row.floor)}`,
      );
    }
  } else if (ctx.towerTotalFloors !== undefined) {
    // Ground is floor 0, so the tower spans 0..totalFloors. Basement levels are
    // not expressible this way; the schema models floor as a bare Int with no
    // convention recorded (docs/06-INVENTORY-SPEC.md does not pin one either),
    // so a project with basement inventory needs that decision made first.
    if (floor < 0 || floor > ctx.towerTotalFloors) {
      fail(
        "floor",
        row.floor,
        `floor must be between 0 and ${ctx.towerTotalFloors} for this tower, got ${floor}`,
      );
    }
  }

  // ── facing (optional)
  const facing = readFacing(row.facing, fail);

  // ── plcTags (optional). Priced per tag by PriceListItem.plcCharges, so a
  //    stray blank tag silently costs the customer nothing and the developer a
  //    reconciliation (docs/06-INVENTORY-SPEC.md section 5).
  const plcTags = readPlcTags(row.plcTags, fail) ?? [];

  // ── Area overrides (optional). Null means inherit from the UnitType.
  const carpet = readAreaCell("carpetAreaOverride", row.carpetAreaOverride);
  if (carpet && !carpet.ok) {
    fail("carpetAreaOverride", row.carpetAreaOverride, carpet.message);
  }
  const saleable = readAreaCell("saleableAreaOverride", row.saleableAreaOverride);
  if (saleable && !saleable.ok) {
    fail("saleableAreaOverride", row.saleableAreaOverride, saleable.message);
  }

  // carpet < built-up <= saleable, on the EFFECTIVE areas: an override where
  // one is given, the UnitType's own figure where it is not. Carpet is net
  // usable area, built-up adds internal walls and balcony, saleable adds a
  // share of the common areas (docs/19-GLOSSARY.md), and pricing is quoted per
  // saleable sqft, so an inverted pair misprices the unit by ~35% -- a hard
  // rejection, not a warning.
  //
  // Checking the overrides only against each other would let through exactly
  // what projects.ts::createUnit rejects with
  // assertAreaHierarchy(resolveUnitAreas(...)): a lone carpetAreaOverride above
  // the type's saleableArea, or a lone saleableAreaOverride below its
  // carpetArea. The bulk path must not accept geometry the single-unit path
  // refuses, so the same resolver is called here on areas passed in as data.
  //
  // Positivity is not re-checked: readAreaCell already rejects a non-positive
  // override, and the UnitType's own areas went through assertAreaHierarchy
  // when the type was created.
  const typeAreas = unitTypeCode === undefined ? undefined : ctx.unitTypeAreas.get(unitTypeCode);
  if (typeAreas) {
    const effective = resolveUnitAreas(
      {
        carpetAreaOverride: carpet?.ok ? carpet.value : null,
        saleableAreaOverride: saleable?.ok ? saleable.value : null,
      },
      typeAreas,
    );
    const inherited = `unit type '${unitTypeCode}' supplies any area not overridden`;
    // A plot type has neither carpet nor built-up, so there is no hierarchy to
    // check -- only the positive-saleable rule, which assertAreaHierarchy
    // already owns. Skipping here rather than treating null as zero, which
    // would report a nonsense "0.00 must be less than 0.00".
    if (effective.carpetArea === null || effective.builtUpArea === null) {
      // nothing to compare
    } else if (!effective.carpetArea.lessThan(effective.builtUpArea)) {
      fail(
        "carpetAreaOverride",
        row.carpetAreaOverride,
        `carpet area (${effective.carpetArea.toFixed(2)}) must be less than built-up area ` +
          `(${effective.builtUpArea.toFixed(2)}) -- ${inherited}`,
      );
    } else if (effective.builtUpArea !== null && effective.builtUpArea.greaterThan(effective.saleableArea)) {
      fail(
        "saleableAreaOverride",
        row.saleableAreaOverride,
        `saleable area (${effective.saleableArea.toFixed(2)}) must be at least built-up area ` +
          `(${effective.builtUpArea.toFixed(2)}) -- ${inherited}`,
      );
    }
  }

  // The undefined checks below are already implied by problems.length === 0;
  // they are spelled out because the compiler cannot see that.
  //
  // floor is NOT in this list: undefined is a legitimate value for a plot in
  // a block, and the floor block above has already failed the row if the
  // group actually required one. Including it here dropped every plot
  // silently -- valid empty, errors empty, nothing imported and nothing said.
  if (problems.length > 0 || unitNumber === undefined || unitTypeCode === undefined) {
    return { parsed: null, errors: problems };
  }

  return {
    parsed: {
      rowNumber,
      unitNumber,
      unitTypeCode,
      floor,
      facing,
      plcTags,
      carpetAreaOverride: carpet?.ok ? carpet.value : undefined,
      saleableAreaOverride: saleable?.ok ? saleable.value : undefined,
    },
    errors: [],
  };
}

// ── Update validation (pure) ───────────────────────────────────────────

/** The same file, read as changes to plots that already exist ("Update plots that
 *  already exist") instead of new plots. Only the plot number is required; a blank
 *  cell leaves that value as it is. Plot type, size (saleableAreaOverride), facing
 *  and plcTags can change. The plot number is the key and the block is the target,
 *  so neither can. A row that changes nothing is counted, not refused.
 *
 *  A plot's type, size and tags are its price, so a row that changes any of them
 *  on a plot that is held or sold is refused (PRICE_EDITABLE_STATUSES); facing
 *  changes on any plot. Every problem is reported, and a row with any problem
 *  changes nothing. A plot has one area, so the carpet < built-up <= saleable rule
 *  that createUnit applies to flats does not come into it: only a positive size. */
export function validateUnitUpdateRows(
  rows: readonly RawUnitRow[],
  context: UnitUpdateContext,
): UnitUpdateValidation {
  const existingUnits = new Map(context.existingUnits);
  const unitTypeAreas = new Map(context.unitTypeAreas);
  const unitTypeHint = describeCodes(unitTypeAreas.keys());
  // unitNumber -> the first row that named it, so the duplicate message can
  // point at the other half of the pair.
  const firstSeenAt = new Map<string, number>();

  const changes: ParsedUnitUpdate[] = [];
  const errors: RowError[] = [];
  let unchanged = 0;

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const problems: RowError[] = [];
    const fail: Fail = (field, value, message) => {
      problems.push({ rowNumber, field, value, message });
    };

    // ── unitNumber: the plot this row is about
    const unitNumber = readCellString(row.unitNumber);
    let current: ExistingUnitForUpdate | undefined;
    if (unitNumber === undefined) {
      fail(
        "unitNumber",
        row.unitNumber,
        isAbsent(row.unitNumber)
          ? "unitNumber is required"
          : `unitNumber must be text, got ${display(row.unitNumber)}`,
      );
    } else {
      const firstRow = firstSeenAt.get(unitNumber);
      if (firstRow !== undefined) {
        fail(
          "unitNumber",
          row.unitNumber,
          `unit '${unitNumber}' appears more than once in this batch (first on row ${firstRow})`,
        );
      } else {
        firstSeenAt.set(unitNumber, rowNumber);
        current = existingUnits.get(unitNumber);
        if (!current) {
          fail(
            "unitNumber",
            row.unitNumber,
            `plot '${unitNumber}' does not exist in this project (updating never creates plots)`,
          );
        } else if (current.towerId !== context.targetTowerId) {
          fail("unitNumber", row.unitNumber, `plot '${unitNumber}' is not in the block this file targets`);
        }
      }
    }

    // ── unitTypeCode (optional: blank keeps the plot's type)
    let newTypeCode: string | undefined;
    if (!isAbsent(row.unitTypeCode)) {
      const code = readCellString(row.unitTypeCode);
      if (code === undefined) {
        fail("unitTypeCode", row.unitTypeCode, `unitTypeCode must be text, got ${display(row.unitTypeCode)}`);
      } else if (!unitTypeAreas.has(code)) {
        fail(
          "unitTypeCode",
          row.unitTypeCode,
          `unitTypeCode '${code}' is not a unit type of this project (${unitTypeHint})`,
        );
      } else {
        newTypeCode = code;
      }
    }

    // A plot in a block has no floor, and no carpet area for a file to set.
    if (!isAbsent(row.floor)) {
      fail("floor", row.floor, "floor must be empty for a plot in a block");
    }
    if (!isAbsent(row.carpetAreaOverride)) {
      fail("carpetAreaOverride", row.carpetAreaOverride, "a plot has no carpet area; leave carpetAreaOverride empty");
    }

    const facing = readFacing(row.facing, fail);
    const plcTags = readPlcTags(row.plcTags, fail);
    const sizeCell = readAreaCell("saleableAreaOverride", row.saleableAreaOverride);
    if (sizeCell && !sizeCell.ok) {
      fail("saleableAreaOverride", row.saleableAreaOverride, sizeCell.message);
    }
    const newSize = sizeCell?.ok ? sizeCell.value : undefined;

    if (problems.length === 0 && current !== undefined && unitNumber !== undefined) {
      // The size the plot has now: its own override, else its type's.
      const nowSize = current.saleableAreaOverride ?? unitTypeAreas.get(current.unitTypeCode)?.saleableArea;
      const typeChanged = newTypeCode !== undefined && newTypeCode !== current.unitTypeCode;
      const sizeChanged = newSize !== undefined && (nowSize === undefined || !newSize.equals(nowSize));
      const tagsChanged = plcTags !== undefined && !sameTags(plcTags, current.plcTags);
      const facingChanged = facing !== undefined && facing !== current.facing;

      if ((typeChanged || sizeChanged || tagsChanged) && !PRICE_EDITABLE_STATUSES.includes(current.status)) {
        fail("unitNumber", row.unitNumber, priceLockedMessage(unitNumber, current.status));
      } else if (typeChanged || sizeChanged || tagsChanged || facingChanged) {
        const patch: ParsedUnitUpdate["patch"] = {};
        if (typeChanged && newTypeCode !== undefined) patch.unitTypeCode = newTypeCode;
        if (sizeChanged && newSize !== undefined) patch.saleableAreaOverride = newSize;
        if (facingChanged && facing !== undefined) patch.facing = facing;
        if (tagsChanged && plcTags !== undefined) patch.plcTags = plcTags;
        changes.push({ rowNumber, unitId: current.id, unitNumber, patch });
      } else {
        unchanged += 1;
      }
    }
    errors.push(...problems);
  });

  return { changes, unchanged, errors };
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((tag) => right.has(tag));
}

// ── Cell readers ───────────────────────────────────────────────────────
//
// A CSV parser hands back "" for an empty cell, an XLSX parser hands back
// undefined or null. All three mean "the user left it blank".

function isAbsent(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value.trim() === "";
}

/** Trimmed non-empty text, or undefined. Numbers are accepted because a
 *  spreadsheet turns a unit number like 101 into a number cell. */
function readCellString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readInteger(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

type AreaCell = { ok: true; value: Prisma.Decimal } | { ok: false; message: string };

/** Returns undefined when the cell is blank (the override is optional and null
 *  means "inherit from the UnitType"). Areas are Decimal, never float. */
function readAreaCell(field: string, raw: unknown): AreaCell | undefined {
  if (isAbsent(raw)) return undefined;
  if (typeof raw !== "string" && typeof raw !== "number") {
    return { ok: false, message: `${field} must be a number, got ${display(raw)}` };
  }

  let parsed: Prisma.Decimal;
  try {
    parsed = new Prisma.Decimal(typeof raw === "string" ? raw.trim() : raw);
  } catch {
    return { ok: false, message: `${field} must be a number, got ${display(raw)}` };
  }
  if (!parsed.isFinite()) {
    return {
      ok: false,
      message: `${field} must be a finite number, got ${display(raw)}`,
    };
  }

  // Round here rather than letting Postgres truncate the third decimal on
  // insert, so what the report validated is exactly what gets stored. Half-up
  // at 2dp, the one rounding rule in this codebase.
  const rounded = parsed.toDecimalPlaces(2, ROUND_HALF_UP);
  if (rounded.lessThanOrEqualTo(0)) {
    return {
      ok: false,
      message: `${field} must be greater than zero, got ${display(raw)}`,
    };
  }
  if (rounded.greaterThan(MAX_AREA)) {
    return {
      ok: false,
      message:
        `${field} must be at most ${MAX_AREA.toFixed(2)} sqft ` +
        `(the column is Decimal(10,2)), got ${display(raw)}`,
    };
  }
  return { ok: true, value: rounded };
}

function display(value: unknown): string {
  if (value === undefined || value === null) return "nothing";
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? `a ${typeof value}`;
  } catch {
    return `a ${typeof value}`;
  }
}

function describeCodes(codes: Iterable<string>): string {
  const sorted = [...codes].sort();
  if (sorted.length === 0) return "this project has no unit types defined";
  const shown = sorted.slice(0, 10).join(", ");
  if (sorted.length > 10) return `known: ${shown}, +${sorted.length - 10} more`;
  return `known: ${shown}`;
}

/** Records one problem with one field of the row being read. */
type Fail = (field: string, value: unknown, message: string) => void;

/** The facing cell. Undefined when it is blank, or wrong (a wrong one is reported). */
function readFacing(raw: unknown, fail: Fail): UnitFacing | undefined {
  if (isAbsent(raw)) return undefined;
  const normalised = readCellString(raw)?.toUpperCase();
  if (normalised === undefined || !FACING_SET.has(normalised)) {
    fail("facing", raw, `facing must be one of ${UNIT_FACINGS.join(", ")}, got ${display(raw)}`);
    return undefined;
  }
  return normalised as UnitFacing;
}

/** The plcTags cell, which the parser has already split into an array. Undefined
 *  when it is blank (an empty array is blank) or not an array (reported); otherwise
 *  the tags, normalised and de-duplicated, with any bad tag reported and left out. */
function readPlcTags(raw: unknown, fail: Fail): string[] | undefined {
  if (isAbsent(raw) || (Array.isArray(raw) && raw.length === 0)) return undefined;
  if (!Array.isArray(raw)) {
    // The parser splits a delimited cell; this layer never sees "A|B".
    fail("plcTags", raw, `plcTags must be an array of strings, got ${display(raw)}`);
    return undefined;
  }
  const tags: string[] = [];
  raw.forEach((tag: unknown, tagIndex: number) => {
    if (typeof tag !== "string" || tag.trim() === "") {
      fail("plcTags", tag, `plcTags[${tagIndex}] must be a non-empty string, got ${display(tag)}`);
    } else {
      try {
        tags.push(normalizePlcTag(tag));
      } catch (error) {
        fail("plcTags", tag, `plcTags[${tagIndex}]: ${(error as Error).message}`);
      }
    }
  });
  return [...new Set(tags)];
}

// ── Import (database) ──────────────────────────────────────────────────

export type UnitImportMode = "ALL_OR_NOTHING" | "SKIP_INVALID";

export interface ImportUnitsParams {
  orgId: string;
  projectId: string;
  /** Optional: units may sit directly under a project (Unit.towerId is
   *  nullable). When given, every row in the batch lands in this tower and its
   *  totalFloors bounds the floor check. */
  towerId?: string;
  rows: readonly RawUnitRow[];
  audit: AuditContext;
  /** Defaults to ALL_OR_NOTHING -- see importUnits. */
  mode?: UnitImportMode;
  /** Read the rows as changes to plots that already exist in `towerId` (a block,
   *  required) instead of as new plots. Never creates a plot. See
   *  validateUnitUpdateRows for what a row may change. */
  updateExisting?: boolean;
}

export interface UnitImportReport {
  imported: number;
  skipped: number;
  errors: RowError[];
  /** `updateExisting` only: plots changed, and plots already as the file says.
   *  `imported` is 0 then, and `skipped` counts the rows with a problem. */
  updated?: number;
  unchanged?: number;
}

/** Imports a batch of units in one transaction.
 *
 *  ALL_OR_NOTHING is the default deliberately. A half-imported inventory is
 *  worse than a rejected one: nobody can tell which half landed, so the fix is
 *  to diff 900 spreadsheet rows against the database by hand before daring to
 *  re-run. A rejected batch leaves the project exactly as it was, and the
 *  report says precisely what to fix. SKIP_INVALID exists for the deliberate
 *  "load what you can, chase the stragglers later" case and must be asked for.
 *
 *  Existing unit numbers are read inside the same transaction as the insert,
 *  so the uniqueness check cannot be invalidated by a commit that lands
 *  between the two.
 *
 *  Gated on the same permission as creating one unit by hand
 *  (projects.ts::createUnit): loading 900 units must not be an easier act than
 *  loading one. docs/07-API.md puts authorization in the service layer, never
 *  in the handler. */
export async function importUnits(
  db: PrismaClient,
  params: ImportUnitsParams,
): Promise<UnitImportReport> {
  // AuditContext.actorId is null for job actors (the hold-expiry sweep), and a
  // job holds no roles to check against, so a null actor here is an
  // authorization failure rather than a missing argument -- the same rule
  // requireActor applies to every master-data mutation in projects.ts.
  const actorId = params.audit.actorId;
  if (!actorId) {
    throw new ForbiddenError("Unit import requires a user actor, not a system actor.");
  }

  try {
    return await db.$transaction(
      (tx) => importUnitsInTx(tx, params, actorId),
      // Prisma's 5s default is tight for a few thousand rows. 10s and no more:
      // that is the platform's synchronous ceiling
      // (docs/adr/0005-netlify-native-jobs-no-redis.md), so a longer budget
      // would only mean the function dies before the transaction does. A file
      // bigger than one 10s transaction has to run as a background job rather
      // than be split into batches -- splitting would give up the atomicity
      // that is the whole point of ALL_OR_NOTHING.
      { timeout: 10_000 },
    );
  } catch (err) {
    // P2002 on units = @@unique([projectId, unitNumber]) fired, i.e. a
    // concurrent import claimed one of these numbers between the read above and
    // this insert. The transaction rolled back, so nothing landed.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new UnitImportConflictError(params.projectId);
    }
    throw err;
  }
}

/** importUnits' transaction body, for a caller that already holds one.
 *  createBlockWithPlots (blocks.ts) creates a block and its plots in one
 *  transaction, and an interactive transaction cannot be nested. The caller owns
 *  the actor check, the transaction (and its timeout) and the P2002 mapping. */
export async function importUnitsInTx(
  tx: Prisma.TransactionClient,
  params: ImportUnitsParams,
  actorId: string,
): Promise<UnitImportReport> {
  const mode = params.mode ?? "ALL_OR_NOTHING";
  const submitted = params.rows.length;

  const project = await tx.project.findUnique({
    where: { id: params.projectId },
    select: { orgId: true },
  });
  // Org mismatch is treated as "not found": a caller from another org
  // must not learn that this project id exists.
  if (!project || project.orgId !== params.orgId) {
    throw new UnitImportTargetError(
      `Project ${params.projectId} was not found in this organisation.`,
    );
  }
  await assertPermission(tx, actorId, "project.write", { projectId: params.projectId });

  let towerTotalFloors: number | undefined;
  let targetGroupKind: UnitGroupKind | undefined;
  if (params.towerId) {
    const tower = await tx.tower.findUnique({
      where: { id: params.towerId },
      select: { projectId: true, totalFloors: true, kind: true },
    });
    if (!tower || tower.projectId !== params.projectId) {
      throw new UnitImportTargetError(
        `Tower ${params.towerId} does not belong to project ${params.projectId}.`,
      );
    }
    assertPlotsOnlyGroup(tower.kind);
    // Null for a BLOCK, which has no floors to bound against.
    towerTotalFloors = tower.totalFloors ?? undefined;
    targetGroupKind = tower.kind;
  }

  const unitTypes = await tx.unitType.findMany({
    where: { projectId: params.projectId },
    select: {
      id: true,
      code: true,
      areaBasis: true,
      carpetArea: true,
      builtUpArea: true,
      saleableArea: true,
    },
  });
  if (SCOPE.plotsOnly) {
    const notPlots = new Set(unitTypes.filter((type) => type.areaBasis !== "SQYD").map((type) => type.code));
    const flat = params.rows.find((row) => typeof row.unitTypeCode === "string" && notPlots.has(row.unitTypeCode));
    if (flat) {
      throw new PlotsOnlyError(
        `Unit type "${String(flat.unitTypeCode)}" is a flat type; plots need a plot type (square yards).`,
      );
    }
  }
  const unitTypeIdByCode = new Map(unitTypes.map((type) => [type.code, type.id]));
  const unitTypeAreas: [string, UnitTypeAreas][] = unitTypes.map((type) => [
    type.code,
    {
      carpetArea: type.carpetArea,
      builtUpArea: type.builtUpArea,
      saleableArea: type.saleableArea,
    },
  ]);

  if (params.updateExisting) {
    return updateExistingPlotsInTx(tx, params, { mode, targetGroupKind, unitTypeIdByCode, unitTypeAreas });
  }

  // Read only on this path: updating reads just the plots the file names.
  const existingUnits = await tx.unit.findMany({
    where: { projectId: params.projectId },
    select: { unitNumber: true },
  });
  const { valid, errors } = validateUnitImportRows(params.rows, {
    existingUnitNumbers: existingUnits.map((unit) => unit.unitNumber),
    unitTypeAreas,
    towerTotalFloors,
    targetGroupKind,
  });

  if (errors.length > 0 && mode === "ALL_OR_NOTHING") {
    // Thrown before anything is written, so the rollback has nothing to
    // undo. No audit row either: the project is unchanged, and a log that
    // records non-changes stops being a record of changes.
    throw new UnitImportRejectedError({ imported: 0, skipped: submitted, errors });
  }

  // Nothing valid to insert (SKIP_INVALID over a wholly bad file) leaves
  // the project untouched, so there is no mutation to audit -- the caller
  // gets the report instead.
  if (valid.length > 0) {
    const data = valid.map((row) => toCreateInput(row, params, unitTypeIdByCode));
    // createManyAndReturn rather than createMany: the genesis history rows
    // below need the generated ids, and re-reading the units by unit
    // number would be a second round trip for something the INSERT can
    // return (Postgres INSERT ... RETURNING).
    const created = await tx.unit.createManyAndReturn({ data, select: { id: true } });

    // Genesis history row per unit, exactly as createUnit writes for a
    // single unit. UnitStatusHistory.fromStatus is nullable precisely for
    // this, and unblockUnit in units.ts reads history to find a unit's
    // prior status -- an imported unit with no history at all has a hole
    // in that trail.
    const genesis: Prisma.UnitStatusHistoryCreateManyInput[] = created.map((unit) => ({
      unitId: unit.id,
      fromStatus: null,
      toStatus: "AVAILABLE",
      reason: "unit imported",
      actorId,
      actorLabel: params.audit.actorLabel,
    }));
    await tx.unitStatusHistory.createMany({ data: genesis });

    const byUnitType: Record<string, number> = {};
    for (const row of valid) byUnitType[row.unitTypeCode] = (byUnitType[row.unitTypeCode] ?? 0) + 1;

    // ONE audit row for the batch. Per-unit rows would bury the signal: a
    // 900-unit import is one administrative act, and "who loaded this
    // inventory, when, and how much of it was rejected" is the question
    // the log has to answer. AuditAction has no IMPORT member (the schema
    // is authoritative) and the entity is the batch rather than any one
    // unit, so this is a CREATE recorded against the project it filled.
    await writeAuditLog(tx, params.audit, {
      action: "CREATE",
      entity: "UnitImport",
      entityId: params.projectId,
      after: {
        projectId: params.projectId,
        towerId: params.towerId ?? null,
        mode,
        rowsSubmitted: submitted,
        imported: valid.length,
        skipped: submitted - valid.length,
        errorCount: errors.length,
        byUnitType,
      },
    });
  }

  return { imported: valid.length, skipped: submitted - valid.length, errors };
}

function toCreateInput(
  row: ParsedUnitRow,
  params: Pick<ImportUnitsParams, "orgId" | "projectId" | "towerId">,
  unitTypeIdByCode: ReadonlyMap<string, string>,
): Prisma.UnitCreateManyInput {
  const unitTypeId = unitTypeIdByCode.get(row.unitTypeCode);
  if (unitTypeId === undefined) {
    // Unreachable: validation accepted the code against this same map's keys.
    throw new UnitImportTargetError(
      `Unit type '${row.unitTypeCode}' on row ${row.rowNumber} could not be resolved to an id.`,
    );
  }

  return {
    orgId: params.orgId,
    projectId: params.projectId,
    towerId: params.towerId ?? null,
    unitTypeId,
    unitNumber: row.unitNumber,
    floor: row.floor ?? null,
    facing: row.facing ?? null,
    plcTags: row.plcTags,
    carpetAreaOverride: row.carpetAreaOverride ?? null,
    saleableAreaOverride: row.saleableAreaOverride ?? null,
    // status defaults to AVAILABLE; imported units enter the pool unheld.
  };
}

/** importUnitsInTx for `updateExisting`: the rows change plots already in the
 *  target block. It never creates a plot -- plots cannot be deleted from the UI, so
 *  a mistyped number must not leave one behind.
 *
 *  The plots the file names are locked in id order (the order setUnitPlcTag uses,
 *  so two admins cannot deadlock) and read AFTER the lock, so a hold or booking
 *  that lands while the file is being judged cannot change a plot already judged
 *  free. Then one UPDATE and one audit row per changed plot: two statements each,
 *  not the dozen updateUnit spends, so a block's worth stays inside the 10 s
 *  transaction. The audit row per plot carries before and after, as updateUnit's
 *  does, plus one batch row for the file. */
async function updateExistingPlotsInTx(
  tx: Prisma.TransactionClient,
  params: ImportUnitsParams,
  context: {
    mode: UnitImportMode;
    targetGroupKind: UnitGroupKind | undefined;
    unitTypeIdByCode: ReadonlyMap<string, string>;
    unitTypeAreas: Iterable<[string, UnitTypeAreas]>;
  },
): Promise<UnitImportReport> {
  const submitted = params.rows.length;
  const towerId = params.towerId;
  if (!towerId || context.targetGroupKind !== "BLOCK") {
    throw new UnitImportTargetError("Updating existing plots needs the block whose plots the file changes.");
  }

  const numbers = [
    ...new Set(
      params.rows.flatMap((row) => {
        const unitNumber = readCellString(row.unitNumber);
        return unitNumber === undefined ? [] : [unitNumber];
      }),
    ),
  ];
  const named =
    numbers.length === 0
      ? []
      : await tx.unit.findMany({
          where: { projectId: params.projectId, unitNumber: { in: numbers } },
          select: { id: true },
        });
  const ids = named.map((unit) => unit.id);
  if (ids.length > 0) {
    await tx.$queryRaw`SELECT "id" FROM "units" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
  }
  const units =
    ids.length === 0
      ? []
      : await tx.unit.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            unitNumber: true,
            towerId: true,
            unitTypeId: true,
            status: true,
            facing: true,
            plcTags: true,
            saleableAreaOverride: true,
            unitType: { select: { code: true } },
          },
        });
  const unitById = new Map(units.map((unit) => [unit.id, unit]));

  const { changes, unchanged, errors } = validateUnitUpdateRows(params.rows, {
    existingUnits: units.map((unit): [string, ExistingUnitForUpdate] => [
      unit.unitNumber,
      {
        id: unit.id,
        towerId: unit.towerId,
        status: unit.status,
        unitTypeCode: unit.unitType.code,
        facing: unit.facing,
        plcTags: unit.plcTags,
        saleableAreaOverride: unit.saleableAreaOverride,
      },
    ]),
    targetTowerId: towerId,
    unitTypeAreas: context.unitTypeAreas,
  });

  if (errors.length > 0 && context.mode === "ALL_OR_NOTHING") {
    // Thrown before anything is written, as for a create: nothing changed, so no
    // audit row either.
    throw new UnitImportRejectedError({ imported: 0, skipped: submitted, errors });
  }

  for (const change of changes) {
    const data: Prisma.UnitUncheckedUpdateInput = {};
    if (change.patch.unitTypeCode !== undefined) {
      const unitTypeId = context.unitTypeIdByCode.get(change.patch.unitTypeCode);
      if (unitTypeId === undefined) {
        // Unreachable: validation accepted the code against this same map's keys.
        throw new UnitImportTargetError(
          `Unit type '${change.patch.unitTypeCode}' on row ${change.rowNumber} could not be resolved to an id.`,
        );
      }
      data.unitTypeId = unitTypeId;
    }
    if (change.patch.facing !== undefined) data.facing = change.patch.facing;
    if (change.patch.plcTags !== undefined) data.plcTags = change.patch.plcTags;
    if (change.patch.saleableAreaOverride !== undefined) {
      data.saleableAreaOverride = change.patch.saleableAreaOverride;
    }
    // Prisma sets updatedAt, which the board's delta poll keys on.
    await tx.unit.update({ where: { id: change.unitId }, data });
    // The same before/after shape updateUnit writes, so the trail reads alike
    // whichever way a plot was changed.
    const { before, after } = auditDiff(unitById.get(change.unitId) ?? {}, data);
    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "Unit",
      entityId: change.unitId,
      before,
      after,
      reason: "unit import (update)",
    });
  }

  const skipped = submitted - changes.length - unchanged;
  if (changes.length > 0) {
    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "UnitImport",
      entityId: params.projectId,
      after: {
        projectId: params.projectId,
        towerId,
        mode: context.mode,
        updateExisting: true,
        rowsSubmitted: submitted,
        updated: changes.length,
        unchanged,
        skipped,
        errorCount: errors.length,
      },
    });
  }

  return { imported: 0, updated: changes.length, unchanged, skipped, errors };
}
