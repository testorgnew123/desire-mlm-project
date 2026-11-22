import { describe, expect, it } from "vitest";
import { listPlotSizes, parsePlotSize } from "@/lib/plot-size";

describe("parsePlotSize", () => {
  it.each([
    ["210", "210"],
    ["210.5", "210.5"],
    ["210.50", "210.50"],
    ["  180  ", "180"],
    ["0.5", "0.5"],
    ["0210", "210"],
    ["99999999.99", "99999999.99"],
  ])("accepts %j as %j", (typed, expected) => {
    expect(parsePlotSize(typed)).toBe(expected);
  });

  it.each(["", "   ", "0", "0.00", "-5", "abc", "210 sq yd", "2.505", "1,200", "1e3", ".5", "100000000"])(
    "refuses %j with a message that says what to type",
    (typed) => {
      expect(() => parsePlotSize(typed)).toThrow(/square yards as a plain number/);
    },
  );
});

describe("listPlotSizes", () => {
  it("lists a size once, however many plot types and plots carry it", () => {
    expect(listPlotSizes(["200.00", "150.00", "200.00"])).toEqual(["150.00", "200.00"]);
  });

  it("orders by size, not as text", () => {
    expect(listPlotSizes(["1000.00", "200.00", "99.50", "150.00"])).toEqual(["99.50", "150.00", "200.00", "1000.00"]);
  });

  it("is empty when there are no sizes", () => {
    expect(listPlotSizes([])).toEqual([]);
  });

  it("offers only values parsePlotSize takes back unchanged", () => {
    for (const size of listPlotSizes(["99999999.99", "0.50", "210.00"])) {
      expect(parsePlotSize(size)).toBe(size);
    }
  });
});
