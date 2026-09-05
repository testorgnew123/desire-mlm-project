import { describe, expect, it } from "vitest";
import { computeRelease, resolveMilestoneCumulativePct } from "../src/release";
import { D } from "./helpers";
import type { ReleaseScheduleSlab } from "../src/types";

describe("computeRelease", () => {
  it("releases the full amount when cumulative pct is 100 and nothing released yet", () => {
    const delta = computeRelease({
      entryGrossAmount: D("15000"),
      entryAlreadyReleased: D("0"),
      cumulativeReleasePct: D("100"),
    });
    expect(delta.toString()).toBe("15000");
  });

  it("releases only the pro-rata share for a partial cumulative pct", () => {
    const delta = computeRelease({
      entryGrossAmount: D("15000"),
      entryAlreadyReleased: D("0"),
      cumulativeReleasePct: D("30"),
    });
    expect(delta.toString()).toBe("4500");
  });

  it("is idempotent: calling again with the same cumulative pct releases nothing further", () => {
    const first = computeRelease({
      entryGrossAmount: D("15000"),
      entryAlreadyReleased: D("0"),
      cumulativeReleasePct: D("30"),
    });
    const second = computeRelease({
      entryGrossAmount: D("15000"),
      entryAlreadyReleased: first,
      cumulativeReleasePct: D("30"),
    });
    expect(second.toString()).toBe("0");
  });

  it("never returns a negative delta if cumulative pct somehow decreases", () => {
    const delta = computeRelease({
      entryGrossAmount: D("15000"),
      entryAlreadyReleased: D("6000"), // already released more than 30% would target
      cumulativeReleasePct: D("30"),
    });
    expect(delta.toString()).toBe("0");
  });
});

describe("resolveMilestoneCumulativePct", () => {
  const slabs: ReleaseScheduleSlab[] = [
    { sequence: 1, triggerType: "BOOKING_CONFIRMED", triggerRef: "booking", releasePct: D(40) },
    { sequence: 2, triggerType: "REGISTRATION", triggerRef: "registration", releasePct: D(80) },
    { sequence: 3, triggerType: "POSSESSION", triggerRef: "possession", releasePct: D(100) },
  ];

  it("returns 0 when no trigger has fired", () => {
    expect(resolveMilestoneCumulativePct(slabs, new Set()).toString()).toBe("0");
  });

  it("returns the highest releasePct among fired triggers", () => {
    const fired = new Set(["booking", "registration"]);
    expect(resolveMilestoneCumulativePct(slabs, fired).toString()).toBe("80");
  });

  it("returns 100 once every slab has fired", () => {
    const fired = new Set(["booking", "registration", "possession"]);
    expect(resolveMilestoneCumulativePct(slabs, fired).toString()).toBe("100");
  });

  it("falls back to triggerType as the key when triggerRef is null", () => {
    const slabsWithNullRef: ReleaseScheduleSlab[] = [
      { sequence: 1, triggerType: "BOOKING_CONFIRMED", triggerRef: null, releasePct: D(100) },
    ];
    const fired = new Set(["BOOKING_CONFIRMED"]);
    expect(resolveMilestoneCumulativePct(slabsWithNullRef, fired).toString()).toBe("100");
  });
});
