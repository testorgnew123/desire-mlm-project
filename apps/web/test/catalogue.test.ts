// The catalogue is a compact encoding that must not lose anything: whatever the
// pages used to hand the screens, expandCatalogue(buildCatalogue(...)) has to hand
// them again, field for field. `reference` below is that old per-unit mapping,
// copied from the two pages it replaced.
import { describe, expect, it } from "vitest";
import { Prisma } from "@desire/db";
import { effectiveUnitStatus } from "@desire/services/holds";
import { formatArea } from "@/lib/money";
import { expandCatalogue } from "@/app/board/[projectId]/catalogue";
import {
  buildCatalogue,
  type CatalogueHold,
  type CatalogueRow,
} from "@/app/board/[projectId]/build-catalogue";
import type { BoardTower } from "@/app/board/[projectId]/types";

const NOW = new Date("2026-10-25T10:00:00.000Z");
const LATER = new Date("2026-10-26T10:00:00.000Z");
const EARLIER = new Date("2026-10-24T10:00:00.000Z");

const TOWERS: BoardTower[] = [
  { id: "tw_a", code: "A", name: "Block A", kind: "BLOCK" },
  { id: "tw_b", code: "B", name: "Block B", kind: "BLOCK" },
  { id: "tw_t", code: "T1", name: "Tower 1", kind: "TOWER" },
];

const PLOT_TYPE: CatalogueRow["unitType"] = {
  id: "ut_plot",
  code: "SQYD-200",
  name: "200 sq yd plot",
  bedrooms: null,
  areaBasis: "SQYD",
  carpetArea: null,
  builtUpArea: null,
  saleableArea: new Prisma.Decimal("200"),
};
const FLAT_TYPE: CatalogueRow["unitType"] = {
  id: "ut_2bhk",
  code: "2BHK",
  name: "2 BHK",
  bedrooms: 2,
  areaBasis: "SQFT",
  carpetArea: new Prisma.Decimal("850.5"),
  builtUpArea: "1000",
  saleableArea: new Prisma.Decimal("1200"),
};

function row(overrides: Partial<CatalogueRow> & Pick<CatalogueRow, "id">): CatalogueRow {
  return {
    unitNumber: overrides.id.toUpperCase(),
    floor: null,
    towerId: "tw_a",
    facing: null,
    plcTags: [],
    status: "AVAILABLE",
    blockReason: null,
    currentHoldId: null,
    updatedAt: new Date("2026-10-20T08:30:00.000Z"),
    carpetAreaOverride: null,
    saleableAreaOverride: null,
    unitType: PLOT_TYPE,
    ...overrides,
  };
}

function hold(overrides: Partial<CatalogueHold> = {}): CatalogueHold {
  return {
    expiresAt: LATER,
    releasedAt: null,
    associate: { code: "A-0007", userId: "u_seller", user: { name: "Ravi Kumar" } },
    ...overrides,
  };
}

const HOLDS = new Map<string, CatalogueHold>([
  ["h_live_mine", hold()],
  ["h_live_other", hold({ associate: { code: "A-0042", userId: "u_other", user: { name: "Meera Shah" } } })],
  ["h_expired", hold({ expiresAt: EARLIER })],
  ["h_released", hold({ releasedAt: EARLIER })],
]);

const ROWS: CatalogueRow[] = [
  row({ id: "plain" }),
  row({
    id: "measured",
    towerId: "tw_b",
    facing: "East",
    plcTags: ["Corner", "Park facing"],
    saleableAreaOverride: new Prisma.Decimal("187.25"),
  }),
  row({
    id: "flat",
    towerId: "tw_t",
    floor: 3,
    unitType: FLAT_TYPE,
    carpetAreaOverride: new Prisma.Decimal("860"),
    saleableAreaOverride: "1210",
  }),
  row({ id: "flat_plain", towerId: "tw_t", floor: 0, unitType: FLAT_TYPE }),
  row({ id: "held_mine", status: "HELD", currentHoldId: "h_live_mine" }),
  row({ id: "held_other", status: "HELD", currentHoldId: "h_live_other" }),
  // A hold nobody swept yet reads as free, and carries no holder.
  row({ id: "held_expired", status: "HELD", currentHoldId: "h_expired" }),
  row({ id: "held_missing", status: "HELD", currentHoldId: "h_gone" }),
  // A booked unit keeps its last hold pointer; that hold is not a live one.
  row({ id: "booked", status: "BOOKED", currentHoldId: "h_released" }),
  row({ id: "blocked", status: "BLOCKED", blockReason: "Litigation" }),
  row({ id: "no_block", towerId: null }),
  row({ id: "empty_strings", facing: "", blockReason: "" }),
];

/** What the two pages built per unit before the catalogue existed. */
function reference(unit: CatalogueRow, viewerUserId?: string) {
  const current = unit.currentHoldId ? (HOLDS.get(unit.currentHoldId) ?? null) : null;
  const status = effectiveUnitStatus({ status: unit.status }, current, NOW);
  const liveHold = status === "HELD" ? current : null;
  const tower = TOWERS.find((candidate) => candidate.id === unit.towerId);
  return {
    id: unit.id,
    unitNumber: unit.unitNumber,
    floor: unit.floor,
    towerId: unit.towerId,
    towerCode: tower?.code ?? null,
    towerKind: tower?.kind ?? null,
    facing: unit.facing,
    plcTags: unit.plcTags,
    unitTypeId: unit.unitType.id,
    unitTypeCode: unit.unitType.code,
    unitTypeName: unit.unitType.name,
    bedrooms: unit.unitType.bedrooms,
    carpetArea: formatArea(unit.carpetAreaOverride ?? unit.unitType.carpetArea, "carpet", unit.unitType.areaBasis),
    builtUpArea: formatArea(unit.unitType.builtUpArea, "builtUp", unit.unitType.areaBasis),
    saleableArea: formatArea(
      unit.saleableAreaOverride ?? unit.unitType.saleableArea,
      "saleable",
      unit.unitType.areaBasis,
    )!,
    blockReason: unit.blockReason,
    status,
    currentHoldExpiresAt: liveHold ? liveHold.expiresAt.toISOString() : null,
    heldByName: liveHold ? liveHold.associate.user.name : null,
    heldByCode: liveHold ? liveHold.associate.code : null,
    isMine: !!(liveHold && viewerUserId !== undefined && liveHold.associate.userId === viewerUserId),
    updatedAt: unit.updatedAt.toISOString(),
  };
}

const build = (rows: CatalogueRow[], viewerUserId?: string) =>
  buildCatalogue({ rows, holds: HOLDS, towers: TOWERS, now: NOW, viewerUserId });

describe("catalogue", () => {
  it("gives back exactly what the pages used to build, field for field", () => {
    const { units } = expandCatalogue(build(ROWS, "u_seller"));
    expect(units).toEqual(ROWS.map((unit) => reference(unit, "u_seller")));
  });

  it("marks no hold as the viewer's when no viewer is named", () => {
    const { units } = expandCatalogue(build(ROWS));
    expect(units).toEqual(ROWS.map((unit) => reference(unit)));
    expect(units.some((unit) => unit.isMine)).toBe(false);
  });

  it("survives the trip through JSON, which is how it reaches the browser", () => {
    const sent = JSON.parse(JSON.stringify(build(ROWS, "u_seller")));
    expect(expandCatalogue(sent).units).toEqual(ROWS.map((unit) => reference(unit, "u_seller")));
  });

  it("only the viewer's own live hold is theirs", () => {
    const { units } = expandCatalogue(build(ROWS, "u_seller"));
    const mine = units.filter((unit) => unit.isMine).map((unit) => unit.id);
    expect(mine).toEqual(["held_mine"]);
  });

  it("sends each unit type once, however many units share it", () => {
    const catalogue = build(ROWS);
    expect(catalogue.types.map((type) => type.id)).toEqual(["ut_plot", "ut_2bhk"]);
    expect(catalogue.units.filter((unit) => catalogue.types[unit.type]!.id === "ut_plot").length).toBeGreaterThan(5);
  });

  it("leaves out what is empty or shared, so a plain unit is a handful of fields", () => {
    const entry = build(ROWS).units.find((unit) => unit.id === "plain")!;
    expect(Object.keys(entry).sort()).toEqual(["id", "status", "tower", "type", "unitNumber", "updatedAt"]);
  });

  it("carries a unit's own measured area and nothing for one that has none", () => {
    const catalogue = build(ROWS);
    const measured = catalogue.units.find((unit) => unit.id === "measured")!;
    const plain = catalogue.units.find((unit) => unit.id === "plain")!;
    expect(measured.saleableArea).toBe("187.25 sq yd (saleable)");
    expect(plain.saleableArea).toBeUndefined();
    expect(catalogue.types[0]!.saleableArea).toBe("200.00 sq yd (saleable)");
  });

  it("treats a unit pointing at a block that is not in the list as outside any block", () => {
    const { units } = expandCatalogue(build([row({ id: "stray", towerId: "tw_deleted" })]));
    expect(units[0]).toMatchObject({ towerId: null, towerCode: null, towerKind: null });
  });

  it("is a fraction of the size of the per-unit payload at plot scale", () => {
    const rows: CatalogueRow[] = Array.from({ length: 2000 }, (_, index) =>
      row({
        // Real ids are 25-character cuids; short ones would flatter the result.
        id: `cm${String(index).padStart(23, "0")}`,
        unitNumber: `${"AB"[index % 2]}-${String(index).padStart(4, "0")}`,
        towerId: TOWERS[index % 2]!.id,
        facing: index % 3 === 0 ? "East" : null,
        plcTags: index % 10 === 0 ? ["Corner"] : [],
        saleableAreaOverride: new Prisma.Decimal(150 + (index % 40)),
        status: index % 25 === 0 ? "HELD" : "AVAILABLE",
        currentHoldId: index % 25 === 0 ? "h_live_other" : null,
      }),
    );
    const perUnit = JSON.stringify(rows.map((unit) => reference(unit))).length;
    const compact = JSON.stringify(build(rows)).length;
    expect(compact).toBeLessThan(perUnit * 0.5);
  });
});
