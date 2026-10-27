// Which buttons a plot's detail sheet offers the person looking at it. Decided
// here, apart from the sheet, so the rule can be tested and the phone grid and the
// book page cannot disagree about it. "Taken since this list loaded" is the case
// the grid used to get wrong: right after you tapped Hold, the delta poll marked
// your own plot as held by someone unknown and the sheet hid Book.
import type { UnitStatus } from "@desire/db";

export interface PlotSheetInput {
  /** The status as displayed (lazy expiry already applied). */
  status: UnitStatus;
  /** The live hold on the plot is this viewer's, as the page snapshot knew it. */
  isMine: boolean;
  /** The status came from a delta poll, which carries no holder identity. */
  holderUnknown: boolean;
  /** The viewer has an associate profile (only associates hold and book). */
  viewerIsAssociate: boolean;
}

export interface PlotSheetActions {
  canHold: boolean;
  canBook: boolean;
  canRelease: boolean;
  note: string | null;
}

const NONE: PlotSheetActions = { canHold: false, canBook: false, canRelease: false, note: null };

export function plotSheetActions({ status, isMine, holderUnknown, viewerIsAssociate }: PlotSheetInput): PlotSheetActions {
  if (status === "BLOCKED") return { ...NONE, note: "Not available for sale." };
  if (!viewerIsAssociate) {
    return status === "AVAILABLE" ? { ...NONE, note: "Only associates can hold or book plots." } : NONE;
  }
  if (status === "AVAILABLE") return { canHold: true, canBook: true, canRelease: false, note: null };
  if (status === "HELD" && isMine && !holderUnknown) return { canHold: false, canBook: true, canRelease: true, note: null };
  return NONE;
}
