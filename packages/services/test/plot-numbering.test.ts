// How a new block's plots are numbered. Pure -- no database. The project page
// imports the same function to preview the numbering as the count is typed, so
// what these pin down is exactly what a user is shown and then gets.
import { describe, expect, it } from "vitest";
import {
  MAX_PLOTS_PER_BLOCK,
  PlotCountError,
  describePlotRows,
  plotAssignments,
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

describe("plotAssignments", () => {
  it("numbers rows in order, carrying on from one to the next", () => {
    expect(
      plotAssignments("A", [
        { count: 2, type: "P200" },
        { count: 1, type: "P300" },
      ]),
    ).toEqual([
      { unitNumber: "A-1", type: "P200" },
      { unitNumber: "A-2", type: "P200" },
      { unitNumber: "A-3", type: "P300" },
    ]);
  });

  it("pads to the width of the TOTAL, so the whole block sorts the way it reads", () => {
    const out = plotAssignments("A", [
      { count: 5, type: "x" },
      { count: 5, type: "y" },
    ]);
    expect(out[0]!.unitNumber).toBe("A-01");
    expect(out[9]!.unitNumber).toBe("A-10");
    const numbers = out.map((o) => o.unitNumber);
    expect([...numbers].sort()).toEqual(numbers);
  });

  it("a single row is exactly what plotNumbers makes", () => {
    expect(plotAssignments("B", [{ count: 40, type: "x" }]).map((o) => o.unitNumber)).toEqual(
      plotNumbers("B", 40),
    );
  });

  it("lets the same type repeat", () => {
    const out = plotAssignments("A", [
      { count: 1, type: "x" },
      { count: 1, type: "y" },
      { count: 1, type: "x" },
    ]);
    expect(out.map((o) => o.type)).toEqual(["x", "y", "x"]);
  });

  it("refuses a total over the maximum, though each row is small", () => {
    expect(() =>
      plotAssignments("A", [
        { count: MAX_PLOTS_PER_BLOCK, type: "x" },
        { count: 1, type: "y" },
      ]),
    ).toThrow(PlotCountError);
  });

  it.each([[0], [-1], [1.5], [Number.NaN]])("refuses a row of %s plots", (count) => {
    expect(() => plotAssignments("A", [{ count, type: "x" }])).toThrow(PlotCountError);
  });

  it("refuses no rows and a blank code", () => {
    expect(() => plotAssignments("A", [])).toThrow(PlotCountError);
    expect(() => plotAssignments(" ", [{ count: 1, type: "x" }])).toThrow(PlotCountError);
  });
});

describe("describePlotRows", () => {
  it("gives first and last number per row and the total", () => {
    expect(
      describePlotRows("A", [
        { count: 10, type: "x" },
        { count: 5, type: "y" },
      ]),
    ).toEqual({
      total: 15,
      rows: [
        { type: "x", count: 10, first: "A-01", last: "A-10" },
        { type: "y", count: 5, first: "A-11", last: "A-15" },
      ],
    });
  });

  it("is null, not a throw, while the inputs are not valid", () => {
    expect(describePlotRows("A", [])).toBeNull();
    expect(describePlotRows("", [{ count: 3, type: "x" }])).toBeNull();
    expect(describePlotRows("A", [{ count: 0, type: "x" }])).toBeNull();
  });
});
