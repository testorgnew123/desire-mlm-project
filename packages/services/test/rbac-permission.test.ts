// hasPermission / assertPermission against a real seeded Role/Permission
// chain -- the pure isInScope/resolveAccessibleAssociateIds logic has its
// own thorough unit tests in rbac.test.ts; this covers the DB-backed half.
import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError, assertPermission, hasPermission } from "../src/rbac";

const db = getPrismaClient();
const TEST_ORG_ID = "org_test_rbac";

async function setupOrgWideRole() {
  await db.organization.upsert({
    where: { id: TEST_ORG_ID },
    update: {},
    create: { id: TEST_ORG_ID, name: "RBAC Test Org", legalName: "RBAC Test Org Pvt Ltd" },
  });

  const permission = await db.permission.upsert({
    where: { code: "test.action" },
    update: {},
    create: { code: "test.action", resource: "test", action: "action" },
  });

  const role = await db.role.create({
    data: { orgId: TEST_ORG_ID, code: `TEST_ROLE_${Date.now()}`, name: "Test Role" },
  });

  await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });

  const user = await db.user.create({
    data: {
      orgId: TEST_ORG_ID,
      email: `rbac-test-${Date.now()}@example.test`,
      name: "RBAC Test User",
      passwordHash: "unused-in-this-test",
    },
  });

  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });

  return { user, role, permission };
}

describe("hasPermission / assertPermission", () => {
  afterAll(async () => {
    await db.userRole.deleteMany({ where: { role: { orgId: TEST_ORG_ID } } });
    await db.rolePermission.deleteMany({ where: { role: { orgId: TEST_ORG_ID } } });
    await db.role.deleteMany({ where: { orgId: TEST_ORG_ID } });
    await db.user.deleteMany({ where: { orgId: TEST_ORG_ID } });
    await db.organization.deleteMany({ where: { id: TEST_ORG_ID } });
    // Permission is a GLOBAL table, not scoped by orgId -- deleting only
    // TEST_ORG_ID's rows above leaves this behind forever across runs. Found
    // by actually counting seeded permissions after a test run and getting
    // 33 instead of the expected 32 -- see PROGRESS.md decision log.
    await db.permission.deleteMany({ where: { code: "test.action" } });
    await db.$disconnect();
  });

  it("grants a permission the user's role actually holds", async () => {
    const { user } = await setupOrgWideRole();
    expect(await hasPermission(db, user.id, "test.action")).toBe(true);
  });

  it("denies a permission the user's role does not hold", async () => {
    const { user } = await setupOrgWideRole();
    expect(await hasPermission(db, user.id, "some.other.permission")).toBe(false);
  });

  it("denies a permission for a user with no roles at all", async () => {
    const org = await db.organization.upsert({
      where: { id: TEST_ORG_ID },
      update: {},
      create: { id: TEST_ORG_ID, name: "RBAC Test Org", legalName: "RBAC Test Org Pvt Ltd" },
    });
    const bareUser = await db.user.create({
      data: {
        orgId: org.id,
        email: `rbac-bare-${Date.now()}@example.test`,
        name: "No Roles",
        passwordHash: "unused",
      },
    });
    expect(await hasPermission(db, bareUser.id, "test.action")).toBe(false);
  });

  it("assertPermission throws ForbiddenError, not a generic error, on denial", async () => {
    const { user } = await setupOrgWideRole();
    await expect(assertPermission(db, user.id, "nonexistent.permission")).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("assertPermission resolves silently when the permission is held", async () => {
    const { user } = await setupOrgWideRole();
    await expect(assertPermission(db, user.id, "test.action")).resolves.toBeUndefined();
  });

  it("an org-wide role grant (projectId null) is honoured when checking against a specific project", async () => {
    const { user } = await setupOrgWideRole();
    expect(await hasPermission(db, user.id, "test.action", { projectId: "some_project" })).toBe(
      true,
    );
  });
});

describe("getAccessibleAssociateIds (DB-backed wrapper)", () => {
  afterAll(async () => {
    await db.associateHierarchy.deleteMany({ where: { associate: { orgId: TEST_ORG_ID } } });
    await db.associate.deleteMany({ where: { orgId: TEST_ORG_ID } });
    await db.user.deleteMany({ where: { orgId: TEST_ORG_ID, email: { contains: "scope-test" } } });
    await db.organization.deleteMany({ where: { id: TEST_ORG_ID } });
  });

  it("OWN mode returns the actor without querying the database", async () => {
    const { getAccessibleAssociateIds } = await import("../src/rbac");
    const ids = await getAccessibleAssociateIds(db, "associate_never_queried", "OWN");
    expect(ids).toEqual(["associate_never_queried"]);
  });

  it("OWN_AND_DOWNLINE queries real AssociateHierarchy rows and scopes correctly", async () => {
    const { getAccessibleAssociateIds } = await import("../src/rbac");

    await db.organization.upsert({
      where: { id: TEST_ORG_ID },
      update: {},
      create: { id: TEST_ORG_ID, name: "RBAC Test Org", legalName: "RBAC Test Org Pvt Ltd" },
    });

    const suffix = Date.now();
    async function makeAssociate(code: string) {
      const user = await db.user.create({
        data: {
          orgId: TEST_ORG_ID,
          email: `scope-test-${code}-${suffix}@example.test`,
          name: code,
          passwordHash: "unused",
        },
      });
      return db.associate.create({
        data: {
          orgId: TEST_ORG_ID,
          userId: user.id,
          code: `${code}-${suffix}`,
          engagementType: "EMPLOYEE",
          joinDate: new Date(),
        },
      });
    }

    const manager = await makeAssociate("MGR");
    const report = await makeAssociate("REP");
    const stranger = await makeAssociate("OTHER");

    await db.associateHierarchy.create({
      data: { associateId: manager.id, parentId: null, path: "/", depth: 0, validFrom: new Date("2020-01-01") },
    });
    await db.associateHierarchy.create({
      data: {
        associateId: report.id,
        parentId: manager.id,
        path: `/${manager.id}/`,
        depth: 1,
        validFrom: new Date("2020-01-01"),
      },
    });
    await db.associateHierarchy.create({
      data: { associateId: stranger.id, parentId: null, path: "/", depth: 0, validFrom: new Date("2020-01-01") },
    });

    const scoped = await getAccessibleAssociateIds(db, manager.id, "OWN_AND_DOWNLINE");

    expect(scoped).toEqual(expect.arrayContaining([manager.id, report.id]));
    expect(scoped).not.toContain(stranger.id);
  });
});
