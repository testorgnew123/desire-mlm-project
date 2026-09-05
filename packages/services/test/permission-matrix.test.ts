// Spot-checks and structural invariants against docs/09-RBAC-MATRIX.md. Not
// an automated markdown parse -- if this file and the doc ever disagree on a
// cell, that is exactly the kind of drift this test exists to catch when
// someone updates one and forgets the other.
import { describe, expect, it } from "vitest";
import {
  MFA_REQUIRED_ROLES,
  PERMISSION_CODES,
  PERMISSION_MATRIX,
  ROLE_CODES,
  permissionsForRole,
} from "@desire/db";
import { MFA_REQUIRED_ROLE_CODES } from "../src/auth";

describe("structural invariants", () => {
  it("SUPER_ADMIN holds every single permission -- the doc has no exceptions", () => {
    expect(permissionsForRole("SUPER_ADMIN")).toEqual(PERMISSION_CODES);
  });

  it("only SUPER_ADMIN can manage RBAC", () => {
    expect(PERMISSION_MATRIX["rbac.manage"]).toEqual(["SUPER_ADMIN"]);
  });

  it("AUDITOR never holds a write-shaped permission", () => {
    const writeLike = PERMISSION_CODES.filter(
      (code) =>
        !code.endsWith(".read") &&
        code !== "scheme.simulate" && // read-only dry run, not a write
        code !== "report.read",
    );
    for (const code of writeLike) {
      expect(PERMISSION_MATRIX[code], `AUDITOR should not hold ${code}`).not.toContain("AUDITOR");
    }
  });

  it("every permission code appears in exactly one PERMISSION_MATRIX entry", () => {
    expect(Object.keys(PERMISSION_MATRIX).sort()).toEqual([...PERMISSION_CODES].sort());
  });

  it("PROJECT_MANAGER never touches money -- no payout, receipt, or commission permission", () => {
    const moneyPermissions = PERMISSION_CODES.filter(
      (c) => c.startsWith("payout.") || c.startsWith("receipt.") || c === "commission.read",
    );
    for (const code of moneyPermissions) {
      expect(PERMISSION_MATRIX[code]).not.toContain("PROJECT_MANAGER");
    }
  });

  it("every role code has at least one granted permission (nobody is seeded useless)", () => {
    for (const role of ROLE_CODES) {
      expect(permissionsForRole(role).length).toBeGreaterThan(0);
    }
  });
});

describe("spot-checks against specific docs/09-RBAC-MATRIX.md rows", () => {
  it("project.read: every role, no exceptions", () => {
    expect(PERMISSION_MATRIX["project.read"]).toEqual([...ROLE_CODES]);
  });

  it("scheme.prepare: SUPER_ADMIN only -- writing a scheme and running payouts must never be the same person", () => {
    expect(PERMISSION_MATRIX["scheme.prepare"]).toEqual(["SUPER_ADMIN"]);
  });

  it("receipt.verify: SUPER_ADMIN and FINANCE_ADMIN only -- not SALES_ADMIN, who enters receipts", () => {
    expect(PERMISSION_MATRIX["receipt.verify"]).toEqual(["SUPER_ADMIN", "FINANCE_ADMIN"]);
    expect(PERMISSION_MATRIX["receipt.enter"]).not.toEqual(PERMISSION_MATRIX["receipt.verify"]);
  });

  it("booking.cancel: SUPER_ADMIN and SALES_HEAD only", () => {
    expect(PERMISSION_MATRIX["booking.cancel"]).toEqual(["SUPER_ADMIN", "SALES_HEAD"]);
  });

  it("commission.read: reaches down to TEAM_LEAD and ASSOCIATE (own/downline, enforced separately by scope)", () => {
    expect(PERMISSION_MATRIX["commission.read"]).toEqual(
      expect.arrayContaining(["TEAM_LEAD", "ASSOCIATE"]),
    );
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
