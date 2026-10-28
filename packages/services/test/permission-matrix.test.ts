// Structural invariants and spot-checks of the cut-down, three-role matrix
// (packages/db/src/permission-matrix.ts). docs/09-RBAC-MATRIX.md still holds the
// full eight-role design; this test pins what is actually granted today.
import { describe, expect, it } from "vitest";
import {
  MFA_REQUIRED_ROLES,
  PERMISSION_CODES,
  PERMISSION_MATRIX,
  ROLE_CODES,
  permissionsForRole,
} from "@desire/db";
import { MFA_REQUIRED_ROLE_CODES } from "../src/auth";

describe("the three roles", () => {
  it("are exactly SUPER_ADMIN, ADMIN and ASSOCIATE", () => {
    expect([...ROLE_CODES]).toEqual(["SUPER_ADMIN", "ADMIN", "ASSOCIATE"]);
  });

  it("each hold at least one permission (nobody is seeded useless)", () => {
    for (const role of ROLE_CODES) {
      expect(permissionsForRole(role).length).toBeGreaterThan(0);
    }
  });
});

describe("structural invariants", () => {
  it("SUPER_ADMIN holds every single permission", () => {
    expect(permissionsForRole("SUPER_ADMIN")).toEqual(PERMISSION_CODES);
  });

  it("every permission code appears in exactly one PERMISSION_MATRIX entry", () => {
    expect(Object.keys(PERMISSION_MATRIX).sort()).toEqual([...PERMISSION_CODES].sort());
  });

  it("only SUPER_ADMIN can manage RBAC", () => {
    expect(PERMISSION_MATRIX["rbac.manage"]).toEqual(["SUPER_ADMIN"]);
  });

  it("user.manage reaches ADMIN, but never ASSOCIATE", () => {
    expect(PERMISSION_MATRIX["user.manage"]).toEqual(["SUPER_ADMIN", "ADMIN"]);
  });

  it("every key for a switched-off feature is SUPER_ADMIN only", () => {
    const off = PERMISSION_CODES.filter(
      (code) =>
        code.startsWith("lead.") ||
        code.startsWith("sitevisit.") ||
        code.startsWith("discount.") ||
        code.startsWith("demand.") ||
        code.startsWith("receipt.") ||
        code.startsWith("associate.") ||
        code.startsWith("grade.") ||
        code.startsWith("scheme.") ||
        code.startsWith("commission.") ||
        code.startsWith("payout.") ||
        code.startsWith("recovery.") ||
        code === "report.read" ||
        code === "audit.read",
    );
    expect(off.length).toBeGreaterThan(10);
    for (const code of off) {
      expect(PERMISSION_MATRIX[code], code).toEqual(["SUPER_ADMIN"]);
    }
  });
});

describe("what each role can do today", () => {
  it("ADMIN runs projects, price lists, confirmations and associate accounts", () => {
    expect(permissionsForRole("ADMIN")).toEqual([
      "project.read",
      "project.write",
      "pricelist.prepare",
      "pricelist.approve",
      "unit.read",
      "unit.block",
      "hold.force_release",
      "booking.read",
      "booking.confirm",
      "booking.cancel",
      "booking.set_price",
      "user.manage",
    ]);
  });

  it("ASSOCIATE browses plots, holds one and drafts a booking -- nothing else", () => {
    expect(permissionsForRole("ASSOCIATE")).toEqual([
      "project.read",
      "unit.read",
      "hold.create",
      "booking.read",
      "booking.create",
    ]);
  });

  it("the seller cannot confirm their own sale: whoever drafts is not who confirms", () => {
    expect(PERMISSION_MATRIX["booking.create"]).not.toContain("ADMIN");
    expect(PERMISSION_MATRIX["booking.confirm"]).not.toContain("ASSOCIATE");
  });

  it("only an associate (with a profile) holds a plot; ADMIN has no associate profile to hold with", () => {
    expect(PERMISSION_MATRIX["hold.create"]).toEqual(["SUPER_ADMIN", "ASSOCIATE"]);
  });

  it("only an admin can set an agreed price on a booking; an associate quotes the list", () => {
    expect(PERMISSION_MATRIX["booking.set_price"]).toEqual(["SUPER_ADMIN", "ADMIN"]);
  });

  it("an associate cannot create or edit a project, plot or price list", () => {
    for (const code of ["project.write", "pricelist.prepare", "pricelist.approve"] as const) {
      expect(PERMISSION_MATRIX[code]).not.toContain("ASSOCIATE");
    }
  });

  it("project.read and unit.read reach every role", () => {
    expect(PERMISSION_MATRIX["project.read"]).toEqual([...ROLE_CODES]);
    expect(PERMISSION_MATRIX["unit.read"]).toEqual([...ROLE_CODES]);
  });
});

describe("MFA requirement consistency", () => {
  it("permission-matrix.ts and auth.ts agree on which roles require MFA", () => {
    expect(new Set(MFA_REQUIRED_ROLES)).toEqual(new Set(MFA_REQUIRED_ROLE_CODES));
  });

  it("every MFA-required role actually exists in ROLE_CODES", () => {
    for (const role of MFA_REQUIRED_ROLES) {
      expect(ROLE_CODES).toContain(role);
    }
  });
});
