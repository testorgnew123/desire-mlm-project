import { describe, expect, it } from "vitest";
import { landingPathFor } from "../lib/landing";

describe("landingPathFor", () => {
  it("sends an associate to the plot grid", () => {
    expect(landingPathFor(["ASSOCIATE"])).toBe("/inventory");
  });

  it("sends admins and super admins to the project list", () => {
    expect(landingPathFor(["ADMIN"])).toBe("/projects");
    expect(landingPathFor(["SUPER_ADMIN"])).toBe("/projects");
  });

  it("sends someone holding several roles to the phone shell if any of them is an associate", () => {
    expect(landingPathFor(["ADMIN", "ASSOCIATE"])).toBe("/inventory");
  });

  it("falls back to the project list for no role, or a role that no longer exists", () => {
    expect(landingPathFor([])).toBe("/projects");
    expect(landingPathFor(["TEAM_LEAD"])).toBe("/projects");
  });

  it("accepts any iterable", () => {
    expect(landingPathFor(new Set(["ASSOCIATE"]))).toBe("/inventory");
  });
});
