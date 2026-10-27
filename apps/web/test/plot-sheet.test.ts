// Which buttons the plot sheet shows. A plot's sheet used to lose Book the moment
// its own hold was confirmed; these pin each case.
import { describe, expect, it } from "vitest";
import type { UnitStatus } from "@desire/db";
import { plotSheetActions } from "../app/(pwa)/inventory/[projectId]/plot-sheet";

const base = { isMine: false, holderUnknown: false, viewerIsAssociate: true };
const sheet = (status: UnitStatus, over: Partial<typeof base> = {}) => plotSheetActions({ status, ...base, ...over });

describe("plotSheetActions", () => {
  it("offers an associate both Hold and Book on a free plot", () => {
    expect(sheet("AVAILABLE")).toEqual({ canHold: true, canBook: true, canRelease: false, note: null });
  });

  it("offers Book and Release on the associate's own hold, and no second Hold", () => {
    expect(sheet("HELD", { isMine: true })).toEqual({ canHold: false, canBook: true, canRelease: true, note: null });
  });

  it("offers nothing on someone else's hold", () => {
    expect(sheet("HELD")).toEqual({ canHold: false, canBook: false, canRelease: false, note: null });
  });

  it("offers nothing while the holder is unknown (a delta poll just said HELD), even if the snapshot said mine", () => {
    expect(sheet("HELD", { isMine: true, holderUnknown: true })).toMatchObject({ canBook: false, canRelease: false, canHold: false });
  });

  it("offers nothing on a plot that is booked, sold or in any later state", () => {
    for (const status of ["BOOKED", "AGREEMENT_SIGNED", "REGISTERED", "POSSESSION"] as const) {
      expect(sheet(status, { isMine: true })).toEqual({ canHold: false, canBook: false, canRelease: false, note: null });
    }
  });

  it("says a blocked plot is not for sale, to everyone", () => {
    for (const viewerIsAssociate of [true, false]) {
      expect(sheet("BLOCKED", { viewerIsAssociate })).toEqual({
        canHold: false,
        canBook: false,
        canRelease: false,
        note: "Not available for sale.",
      });
    }
  });

  it("offers a person with no associate profile no buttons, and says why on a free plot", () => {
    expect(sheet("AVAILABLE", { viewerIsAssociate: false })).toEqual({
      canHold: false,
      canBook: false,
      canRelease: false,
      note: "Only associates can hold or book plots.",
    });
    expect(sheet("HELD", { viewerIsAssociate: false, isMine: true }).canRelease).toBe(false);
  });
});
