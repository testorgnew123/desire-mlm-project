// How a new block's plots are numbered. Pure -- no database. The project page
// imports the same function to preview the numbering as the count is typed, so
// what these pin down is exactly what a user is shown and then gets.
import { describe, expect, it } from "vitest";
import {
  MAX_PLOTS_PER_BLOCK,
  PlotCountError,
  plotNumbers,
  plotRange,
} from "../src/plot-numbering";

describe("plotNumbers", () => {
  it("numbers from 1, prefixed with the block code", () => {
    expect(plotNumbers("A", 3)).toEqual(["A-1", "A-2", "A-3"]);
  });

  // The reason for padding: unit numbers are compared as text everywhere
  // (board ordering, the CSV duplicate check), and as text "A-10" sorts before
  // "A-2".
  it("pads to the width of the count so the numbers sort the way they read", () => {
    const forty = plotNumbers("A", 40);
    expect(forty[0]).toBe("A-01");
    expect(forty[39]).toBe("A-40");
    expect([...forty].sort()).toEqual(forty);

    const hundredTwenty = plotNumbers("B", 120);
    expect(hundredTwenty[0]).toBe("B-001");
    expect(hundredTwenty[119]).toBe("B-120");
    expect([...hundredTwenty].sort()).toEqual(hundredTwenty);
  });

  it("does not pad a single-digit count", () => {
    expect(plotNumbers("C", 9)).toHaveLength(9);
    expect(plotNumbers("C", 9)[0]).toBe("C-1");
  });

  it("trims the code, so a stray space cannot create 'A -01'", () => {
    expect(plotNumbers("  A ", 12)[0]).toBe("A-01");
  });

  it("allows exactly the maximum and produces unique numbers", () => {
    const max = plotNumbers("A", MAX_PLOTS_PER_BLOCK);
    expect(max).toHaveLength(MAX_PLOTS_PER_BLOCK);
    expect(max[max.length - 1]).toBe("A-500");
    expect(new Set(max).size).toBe(MAX_PLOTS_PER_BLOCK);
  });

  it.each([
    ["zero", 0],
    ["negative", -4],
    ["fractional", 1.5],
    ["NaN, which is what Number('abc') gives a form field", Number.NaN],
    ["one over the maximum", MAX_PLOTS_PER_BLOCK + 1],
  ])("rejects %s", (_label, count) => {
    expect(() => plotNumbers("A", count)).toThrow(PlotCountError);
  });

  it("rejects an empty code, since the numbers would start with a dash", () => {
    expect(() => plotNumbers("   ", 5)).toThrow(PlotCountError);
  });
});

describe("plotRange", () => {
  it("gives the first and last number for the preview line", () => {
    expect(plotRange("A", 40)).toEqual({ first: "A-01", last: "A-40" });
  });

  // The preview runs on every keystroke, including while the field is empty or
  // half typed, so it must report "nothing to show" rather than throw.
  it("returns null instead of throwing while the inputs are incomplete", () => {
    expect(plotRange("A", Number.NaN)).toBeNull();
    expect(plotRange("", 10)).toBeNull();
    expect(plotRange("A", 0)).toBeNull();
    expect(plotRange("A", MAX_PLOTS_PER_BLOCK + 1)).toBeNull();
  });
});
