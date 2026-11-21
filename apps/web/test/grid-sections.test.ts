// How the phone grid arranges plots. The arrangement moved out of the component so
// that only the block on screen is sorted; these pin that it orders exactly as the
// old in-component version did (a copy of it is the oracle below).
import { describe, expect, it } from "vitest";
import { floorsOf, groupByTower } from "../app/(pwa)/inventory/[projectId]/grid-sections";

interface Plot {
  id: string;
  unitNumber: string;
  floor: number | null;
  towerCode: string | null;
  towerKind: "TOWER" | "BLOCK" | null;
}

/** The arrangement as InventoryGrid computed it before: every block, every plot, with
 *  localeCompare. */
function oldTowerSections(merged: Plot[]) {
  const byTower = new Map<string, { towerCode: string | null; towerKind: Plot["towerKind"]; units: Plot[] }>();
  for (const unit of merged) {
    const key = unit.towerCode ?? "";
    let section = byTower.get(key);
    if (!section) {
      section = { towerCode: unit.towerCode, towerKind: unit.towerKind, units: [] };
      byTower.set(key, section);
    }
    section.units.push(unit);
  }
  return [...byTower.values()]
    .sort((a, b) => (a.towerCode ?? "").localeCompare(b.towerCode ?? ""))
    .map((section) => {
      const byFloor = new Map<number, Plot[]>();
      const floorless: Plot[] = [];
      for (const unit of section.units) {
        if (unit.floor === null) {
          floorless.push(unit);
          continue;
        }
        const row = byFloor.get(unit.floor);
        if (row) row.push(unit);
        else byFloor.set(unit.floor, [unit]);
      }
      const floors: Array<{ floor: number | null; units: Plot[] }> = [...byFloor.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([floor, units]) => ({
          floor: floor as number | null,
          units: [...units].sort((a, b) => a.unitNumber.localeCompare(b.unitNumber)),
        }));
      if (floorless.length > 0) {
        floors.push({ floor: null, units: [...floorless].sort((a, b) => a.unitNumber.localeCompare(b.unitNumber)) });
      }
      return { towerCode: section.towerCode, towerKind: section.towerKind, floors };
    });
}

// A deterministic shuffle, so a failure reproduces.
function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const NUMBERS = ["B01-1", "B01-10", "B01-2", "b01-3", "B01-003", "B01-100", "A-7", "a-7", "Z9", "10", "9", "É-1", "E-1"];

function sampleUnits(): Plot[] {
  const units: Plot[] = [];
  let id = 0;
  for (const [towerCode, towerKind] of [
    ["B01", "BLOCK"],
    ["B10", "BLOCK"],
    ["B02", "BLOCK"],
    ["T1", "TOWER"],
    [null, null],
  ] as const) {
    for (const unitNumber of NUMBERS) {
      // Blocks hold plots (no floor); the tower and the loose plots get floors, some missing.
      const floor = towerKind === "BLOCK" ? null : towerKind === "TOWER" ? (id % 4) - 1 : id % 3 === 0 ? null : 2;
      units.push({ id: `u${id++}`, unitNumber, floor, towerCode, towerKind });
    }
  }
  return units;
}

describe("groupByTower + floorsOf", () => {
  it.each([1, 7, 42])("arranges every block exactly as the old in-component version did (shuffle %i)", (seed) => {
    const units = shuffled(sampleUnits(), seed);
    const expected = oldTowerSections(units);
    const actual = groupByTower(units).map((group) => ({
      towerCode: group.towerCode,
      towerKind: group.towerKind,
      floors: floorsOf(group.units),
    }));
    expect(actual).toEqual(expected);
  });

  it("keys the group of plots outside any block as '_' and the others by block code", () => {
    const groups = groupByTower(sampleUnits());
    expect(groups.map((g) => g.key)).toEqual(["_", "B01", "B02", "B10", "T1"]);
  });

  it("does nothing for no plots", () => {
    expect(groupByTower([])).toEqual([]);
    expect(floorsOf([])).toEqual([]);
  });

  it("puts floors highest first and the floorless row last", () => {
    const rows = floorsOf([
      { floor: 1, unitNumber: "a" },
      { floor: null, unitNumber: "p" },
      { floor: 3, unitNumber: "b" },
      { floor: 2, unitNumber: "c" },
    ]);
    expect(rows.map((row) => row.floor)).toEqual([3, 2, 1, null]);
  });

  it("does not change the order of the list it is given", () => {
    const units = shuffled(sampleUnits(), 3);
    const before = units.map((unit) => unit.id);
    groupByTower(units);
    floorsOf(units);
    expect(units.map((unit) => unit.id)).toEqual(before);
  });
});
