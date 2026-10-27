import { describe, expect, it } from "vitest";
import { parsePlotGroups } from "@/lib/plot-groups";

describe("parsePlotGroups", () => {
  it("pairs counts with types in order", () => {
    expect(parsePlotGroups(["10", "5"], ["t200", "t300"])).toEqual([
      { count: 10, unitTypeId: "t200" },
      { count: 5, unitTypeId: "t300" },
    ]);
  });

  it("gives none for a form left blank", () => {
    expect(parsePlotGroups([""], [""])).toEqual([]);
    expect(parsePlotGroups([], [])).toEqual([]);
  });

  it("skips a wholly blank row between filled ones", () => {
    expect(parsePlotGroups(["4", "", "6"], ["a", "", "b"])).toEqual([
      { count: 4, unitTypeId: "a" },
      { count: 6, unitTypeId: "b" },
    ]);
  });

  it("names the row when the count is missing", () => {
    expect(() => parsePlotGroups(["4", ""], ["a", "b"])).toThrow(/Size 2: enter how many/);
  });

  it("names the row when the type is missing", () => {
    expect(() => parsePlotGroups(["4", "3"], ["a", ""])).toThrow(/Size 2: choose a plot type/);
  });

  it.each(["0", "-2", "2.5", "abc"])("refuses the count %s", (count) => {
    expect(() => parsePlotGroups([count], ["a"])).toThrow(/Size 1: .*whole number/);
  });

  it("allows the same type twice", () => {
    expect(parsePlotGroups(["3", "2"], ["a", "a"])).toHaveLength(2);
  });
});
