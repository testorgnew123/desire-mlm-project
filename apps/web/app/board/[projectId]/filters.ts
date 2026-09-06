import type { UnitStatus } from "@desire/db";
import type { BoardUnit } from "./types";

/** Sentinel for "no restriction" in a <select> value, which must be a string. */
export const ANY = "ANY";
/** Facing is nullable on Unit, so "not recorded" is a real, selectable bucket. */
export const UNSPECIFIED = "UNSPECIFIED";

/** The filter rail of docs/08-SCREENS.md, minus budget and PLC tags.
 *
 *  Budget needs the ACTIVE price list and a cost-sheet computation
 *  (docs/06-INVENTORY-SPEC.md section 5) that this screen does not load and no
 *  endpoint exposes yet; a filter that silently matched nothing would be worse
 *  than its absence. PLC tags are shown in the unit drawer but not filtered on.
 *  Both are additive once the pricing read exists. */
export interface BoardFilters {
  /** ANY, or a UnitType id. */
  unitTypeId: string;
  /** ANY, UNSPECIFIED, or a facing value. */
  facing: string;
  floorMin: number | null;
  floorMax: number | null;
  /** Empty means every status, which is not the same as "none selected". */
  statuses: UnitStatus[];
}

export const EMPTY_FILTERS: BoardFilters = {
  unitTypeId: ANY,
  facing: ANY,
  floorMin: null,
  floorMax: null,
  statuses: [],
};

/** Everything except status. Status is applied separately so the status chips
 *  can show facet counts -- "how many would this chip show me" rather than
 *  "how many are currently selected". */
export function matchesAttributeFilters(unit: BoardUnit, filters: BoardFilters): boolean {
  if (filters.unitTypeId !== ANY && unit.unitTypeId !== filters.unitTypeId) return false;

  if (filters.facing === UNSPECIFIED) {
    if (unit.facing !== null) return false;
  } else if (filters.facing !== ANY && unit.facing !== filters.facing) {
    return false;
  }

  if (filters.floorMin !== null && unit.floor < filters.floorMin) return false;
  if (filters.floorMax !== null && unit.floor > filters.floorMax) return false;

  return true;
}

/** Drives the count on the collapsed "Filters" toggle, so an associate who
 *  scrolled past the rail still knows the grid is filtered. */
export function countActiveFilters(filters: BoardFilters): number {
  let count = 0;
  if (filters.unitTypeId !== ANY) count += 1;
  if (filters.facing !== ANY) count += 1;
  if (filters.floorMin !== null) count += 1;
  if (filters.floorMax !== null) count += 1;
  if (filters.statuses.length > 0) count += 1;
  return count;
}
