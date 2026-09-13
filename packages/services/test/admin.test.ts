// User/Role admin CRUD -- Phase 3.5 Slice 15. Runs against LOCAL Docker
// Postgres -- the duplicate-email guard, the close-and-replace role
// assignment, and the rbac.manage gate are exactly what is under test.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import { verifyPassword } from "../src/password";
import {
  DuplicateEmailError,
  RoleNotFoundError,
  UserNotFoundError,
  createUser,
  listUsers,
  updateUserRoles,
} from "../src/admin";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_admin";
const OTHER_ORG = "org_test_admin_other";

async function reset() {
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.auditLog.deleteMany({ where: { orgId } });
    await db.userRole.deleteMany({ where: { role: { orgId } } });
    await db.rolePermission.deleteMany({ where: { role: { orgId } } });
    await db.role.deleteMany({ where: { orgId } });
    await db.user.deleteMany({ where: { orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
  }
}

async function makeUser(orgId: string, label: string, codes: string[]) {
  const user = await db.user.create({ data: { orgId, email: `${label}-${orgId}@test.local`, name: label, passwordHash: "unused" } });
  const role = await db.role.create({ data: { orgId, code: `ROLE_${label}`, name: label } });
  for (const code of codes) {
    const [resource, action] = code.split(".");
    const perm = await db.permission.upsert({ where: { code }, update: {}, create: { code, resource: resource!, action: action! } });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  }
  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });
  return user;
}

/** The real ROLE_CODES this codebase seeds -- createUser/updateUserRoles
 *  assign an EXISTING role row, they don't create one, so the fixture
 *  seeds the two roles these tests actually assign users to. */
async function seedFixture(orgId: string = ORG) {
  await db.organization.create({ data: { id: orgId, name: "Admin Test Org", legalName: "Admin Test Org Pvt Ltd" } });
  await db.role.create({ data: { orgId, code: "ASSOCIATE", name: "Associate" } });
  await db.role.create({ data: { orgId, code: "TEAM_LEAD", name: "Team Lead" } });
  const admin = await makeUser(orgId, "admin", ["rbac.manage"]);
  const noPerms = await makeUser(orgId, "noperms", []);
  return { admin, noPerms };
}

function ctx(orgId: string, userId: string | null, label: string): AuditContext {
  return { orgId, actorId: userId, actorLabel: label };
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("createUser", () => {
  it("creates an INVITED user with one role and a real, verifiable temporary password", async () => {
    const f = await seedFixture();

    const result = await createUser(db, {
      email: "newhire@test.local", name: "New Hire", roleCode: "ASSOCIATE",
      audit: ctx(ORG, f.admin.id, "admin"),
    });

    const user = await db.user.findUniqueOrThrow({ where: { id: result.userId } });
    expect(user.status).toBe("INVITED");
    expect(await verifyPassword(user.passwordHash, result.temporaryPassword)).toBe(true);

    const roles = await db.userRole.findMany({ where: { userId: user.id }, include: { role: true } });
    expect(roles.map((r) => r.role.code)).toEqual(["ASSOCIATE"]);
  });

  it("rejects a duplicate email within the same org", async () => {
    const f = await seedFixture();
    await createUser(db, { email: "dup@test.local", name: "First", roleCode: "ASSOCIATE", audit: ctx(ORG, f.admin.id, "admin") });
    await expect(
      createUser(db, { email: "dup@test.local", name: "Second", roleCode: "ASSOCIATE", audit: ctx(ORG, f.admin.id, "admin") }),
    ).rejects.toThrow(DuplicateEmailError);
  });

  it("throws for a role code not configured in this org", async () => {
    const f = await seedFixture();
    await expect(
      createUser(db, { email: "x@test.local", name: "X", roleCode: "SUPER_ADMIN", audit: ctx(ORG, f.admin.id, "admin") }),
    ).rejects.toThrow(RoleNotFoundError);
  });

  it("refuses without rbac.manage", async () => {
    const f = await seedFixture();
    await expect(
      createUser(db, { email: "x@test.local", name: "X", roleCode: "ASSOCIATE", audit: ctx(ORG, f.noPerms.id, "noperms") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("updateUserRoles: close-and-replace, never additive", () => {
  it("replaces the user's single role with a new one", async () => {
    const f = await seedFixture();
    const created = await createUser(db, { email: "promo@test.local", name: "Promo", roleCode: "ASSOCIATE", audit: ctx(ORG, f.admin.id, "admin") });

    await updateUserRoles(db, { userId: created.userId, roleCode: "TEAM_LEAD", audit: ctx(ORG, f.admin.id, "admin") });

    const roles = await db.userRole.findMany({ where: { userId: created.userId }, include: { role: true } });
    expect(roles.map((r) => r.role.code)).toEqual(["TEAM_LEAD"]);
  });

  it("writes a before/after audit row naming both role sets", async () => {
    const f = await seedFixture();
    const created = await createUser(db, { email: "audited@test.local", name: "Audited", roleCode: "ASSOCIATE", audit: ctx(ORG, f.admin.id, "admin") });

    await updateUserRoles(db, { userId: created.userId, roleCode: "TEAM_LEAD", audit: ctx(ORG, f.admin.id, "admin") });

    const row = await db.auditLog.findFirstOrThrow({ where: { entity: "User", entityId: created.userId, action: "UPDATE" } });
    expect((row.before as { roleCodes: string[] }).roleCodes).toEqual(["ASSOCIATE"]);
    expect((row.after as { roleCodes: string[] }).roleCodes).toEqual(["TEAM_LEAD"]);
  });

  it("throws for a user that does not exist", async () => {
    const f = await seedFixture();
    await expect(
      updateUserRoles(db, { userId: "nope", roleCode: "TEAM_LEAD", audit: ctx(ORG, f.admin.id, "admin") }),
    ).rejects.toThrow(UserNotFoundError);
  });

  it("refuses a user belonging to another organisation", async () => {
    const f = await seedFixture(ORG);
    const other = await seedFixture(OTHER_ORG);
    const created = await createUser(db, { email: "cross@test.local", name: "Cross", roleCode: "ASSOCIATE", audit: ctx(OTHER_ORG, other.admin.id, "admin") });

    await expect(
      updateUserRoles(db, { userId: created.userId, roleCode: "TEAM_LEAD", audit: ctx(ORG, f.admin.id, "admin") }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses without rbac.manage", async () => {
    const f = await seedFixture();
    const created = await createUser(db, { email: "guarded@test.local", name: "Guarded", roleCode: "ASSOCIATE", audit: ctx(ORG, f.admin.id, "admin") });
    await expect(
      updateUserRoles(db, { userId: created.userId, roleCode: "TEAM_LEAD", audit: ctx(ORG, f.noPerms.id, "noperms") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("listUsers", () => {
  it("returns every user in the org with their role codes", async () => {
    const f = await seedFixture();
    await createUser(db, { email: "one@test.local", name: "One", roleCode: "ASSOCIATE", audit: ctx(ORG, f.admin.id, "admin") });

    const users = await listUsers(db, { orgId: ORG, actorId: f.admin.id });
    const created = users.find((u) => u.email === "one@test.local");
    expect(created?.roleCodes).toEqual(["ASSOCIATE"]);
    expect(created?.status).toBe("INVITED");
  });

  it("refuses without rbac.manage", async () => {
    const f = await seedFixture();
    await expect(listUsers(db, { orgId: ORG, actorId: f.noPerms.id })).rejects.toThrow(ForbiddenError);
  });
});
