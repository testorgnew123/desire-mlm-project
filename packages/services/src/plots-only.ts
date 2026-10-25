// The guard behind SCOPE.plotsOnly (@desire/db): while it is on, nothing can be
// newly created as a tower, a flat or a square-foot unit type. It lives in the
// services, not in the forms, because the forms are only one way in -- the unit
// import route and any API caller go through the same functions.
//
// Existing apartment data is untouched and still readable; only creation is
// refused. With plotsOnly false every function here does nothing.
import { SCOPE } from "@desire/db";
import type { AreaBasis, UnitGroupKind } from "@desire/db";

export class PlotsOnlyError extends Error {
  constructor(what: string) {
    super(`This product currently handles plotted developments only. ${what}`);
    this.name = "PlotsOnlyError";
  }
}

/** A unit group must be a BLOCK. Anything else -- including "not said", which the
 *  services would otherwise read as a TOWER -- is refused. */
export function assertPlotsOnlyGroup(kind: UnitGroupKind | null | undefined): void {
  if (SCOPE.plotsOnly && kind !== "BLOCK") {
    throw new PlotsOnlyError("Create a block of plots, not a tower.");
  }
}

/** A unit type must be priced per square yard. Square feet means a flat. */
export function assertPlotsOnlyBasis(basis: AreaBasis | null | undefined): void {
  if (SCOPE.plotsOnly && basis !== "SQYD") {
    throw new PlotsOnlyError("Create a plot type (square yards), not a flat type.");
  }
}
