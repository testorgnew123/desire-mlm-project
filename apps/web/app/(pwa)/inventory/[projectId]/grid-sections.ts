// How the phone grid arranges plots: into blocks, then floors, then plot number.
//
// Pure functions, split from InventoryGrid so the ordering is pinned by a test and so
// the grid can arrange only the block on screen. It used to group and sort every plot
// of every block (thousands of locale comparisons on a slow phone) for each snapshot
// and each live change, to draw one block.
import type { GroupKind } from "@/lib/groups";

/** Created once: calling `localeCompare` builds a collator per comparison. Orders
 *  exactly as `a.localeCompare(b)` does. */
const collator = new Intl.Collator();
const compare = (a: string, b: string): number => collator.compare(a, b);

/** The key of the group of plots that sit outside any block. */
const NO_BLOCK_KEY = "_";

export interface TowerGroup<U> {
  /** The block code, or "_" for plots outside any block. */
  key: string;
  towerCode: string | null;
  towerKind: GroupKind | null;
  units: U[];
}

/** Plots grouped by block, blocks in code order. One pass; nothing inside a block is sorted. */
export function groupByTower<U extends { towerCode: string | null; towerKind: GroupKind | null }>(
  units: readonly U[],
): TowerGroup<U>[] {
  const byTower = new Map<string, TowerGroup<U>>();
  for (const unit of units) {
    const mapKey = unit.towerCode ?? "";
    let group = byTower.get(mapKey);
    if (!group) {
      group = { key: unit.towerCode ?? NO_BLOCK_KEY, towerCode: unit.towerCode, towerKind: unit.towerKind, units: [] };
      byTower.set(mapKey, group);
    }
    group.units.push(unit);
  }
  return [...byTower.values()].sort((a, b) => compare(a.towerCode ?? "", b.towerCode ?? ""));
}

export interface FloorRow<U> {
  /** Null for plots, which have no floor. */
  floor: number | null;
  units: U[];
}

/** One block's plots as floor rows: highest floor first (the building-elevation reading
 *  order), plots without a floor together in one last row, plot numbers in locale order. */
export function floorsOf<U extends { floor: number | null; unitNumber: string }>(units: readonly U[]): FloorRow<U>[] {
  const byFloor = new Map<number, U[]>();
  const floorless: U[] = [];
  for (const unit of units) {
    if (unit.floor === null) {
      floorless.push(unit);
      continue;
    }
    const row = byFloor.get(unit.floor);
    if (row) row.push(unit);
    else byFloor.set(unit.floor, [unit]);
  }
  const byNumber = (a: U, b: U) => compare(a.unitNumber, b.unitNumber);
  const floors: FloorRow<U>[] = [...byFloor.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([floor, row]) => ({ floor, units: [...row].sort(byNumber) }));
  if (floorless.length > 0) floors.push({ floor: null, units: [...floorless].sort(byNumber) });
  return floors;
}
