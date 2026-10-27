// The role sync adds what the permission matrix has and a database lacks, and
// nothing else. Needs the migrated local Postgres (never the hosted one). The
// "old world" is the production state the 2026-10-25 cut left behind: eight
// hand-seeded roles, no ADMIN, no `user.manage`.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PERMISSION_CODES, PERMISSION_MATRIX, ROLE_CODES, getPrismaClient, permissionsForRole } from "../src/index";
import { applyRoleSync, assertMatrixIsSane, planRoleSync, planRoleSyncForOrgs } from "../src/sync-roles";

const prisma = getPrismaClient();
const ORG = "org_test_syncroles";
const OTHER_ORG = "org_test_syncroles_other";

const OLD_ROLES = [
  "SUPER_ADMIN",
  "FINANCE_ADMIN",
  "PROJECT_MANAGER",
  "SALES_HEAD",
  "SALES_ADMIN",
  "TEAM_LEAD",
  "ASSOCIATE",
  "AUDITOR",
] as const;

async function reset(): Promise<void> {
  for (const orgId of [ORG, OTHER_ORG]) {
    await prisma.user.deleteMany({ where: { orgId } });
    await prisma.role.deleteMany({ where: { orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
  }
}

async function makeOrg(id: string): Promise<void> {
  await prisma.organization.create({
    data: { id, name: "Sync Test", legalName: "Sync Test", timezone: "Asia/Kolkata", currency: "INR" },
  });
}

/** An org as production looks today: eight roles, no ADMIN, no `user.manage`. */
async function seedOldWorld(): Promise<void> {
  await makeOrg(ORG);
  // Permission rows are global; the old world is the one where this one does not exist yet.
  await prisma.permission.deleteMany({ where: { code: "user.manage" } });
  await prisma.permission.createMany({
    data: PERMISSION_CODES.filter((code) => code !== "user.manage").map((code) => {
      const [resource, action] = code.split(".");
      return { code, resource: resource ?? code, action: action ?? "" };
    }),
    skipDuplicates: true,
  });

  const grantsFor: Record<string, string[]> = {
    SALES_HEAD: ["lead.read", "booking.confirm"],
    ASSOCIATE: ["commission.read", "booking.create"],
    SUPER_ADMIN: PERMISSION_CODES.filter((code) => code !== "user.manage"),
  };
  for (const code of OLD_ROLES) {
    const role = await prisma.role.create({ data: { orgId: ORG, code, name: code } });
    const permissions = await prisma.permission.findMany({ where: { code: { in: grantsFor[code] ?? [] } } });
    await prisma.rolePermission.createMany({
      data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
    });
  }

  const roleId = async (code: string) =>
    (await prisma.role.findUniqueOrThrow({ where: { orgId_code: { orgId: ORG, code } } })).id;
  for (const [email, role] of [["owner", "SUPER_ADMIN"], ["head", "SALES_HEAD"], ["seller", "ASSOCIATE"]] as const) {
    const user = await prisma.user.create({
      data: { orgId: ORG, email: `${email}@sync.test`, name: email, passwordHash: "x", status: "ACTIVE" },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: await roleId(role), projectId: null } });
  }
}

const grantsOf = async (orgId: string, code: string): Promise<string[]> =>
  (
    await prisma.rolePermission.findMany({
      where: { role: { orgId, code } },
      select: { permission: { select: { code: true } } },
    })
  )
    .map((grant) => grant.permission.code)
    .sort();

const rolesNow = async (orgId: string) =>
  (await prisma.role.findMany({ where: { orgId }, select: { code: true } })).map((role) => role.code).sort();

const grantCount = (orgId: string) => prisma.rolePermission.count({ where: { role: { orgId } } });

describe("planRoleSync", () => {
  beforeEach(reset);
  afterAll(async () => {
    await reset();
    await prisma.$disconnect();
  });

  it("reads only: planning changes nothing", async () => {
    await seedOldWorld();
    const before = { roles: await rolesNow(ORG), grants: await grantCount(ORG), permissions: await prisma.permission.count() };
    await planRoleSync(prisma, ORG);
    expect({ roles: await rolesNow(ORG), grants: await grantCount(ORG), permissions: await prisma.permission.count() }).toEqual(before);
  });

  it("finds ADMIN and user.manage missing, and exactly the grants each active role lacks", async () => {
    await seedOldWorld();
    const plan = await planRoleSync(prisma, ORG);

    expect(plan.rolesToCreate).toEqual(["ADMIN"]);
    expect(plan.permissionsToCreate).toEqual(["user.manage"]);

    const added = (role: string) => plan.grantsToAdd.filter((grant) => grant.role === role).map((grant) => grant.permission).sort();
    expect(added("ADMIN")).toEqual([...permissionsForRole("ADMIN")].sort());
    expect(added("SUPER_ADMIN")).toEqual(["user.manage"]);
    expect(added("ASSOCIATE")).not.toContain("booking.create");
    expect(added("ASSOCIATE")).toContain("hold.create");
  });

  it("reports a grant an active role holds beyond the matrix, and does not plan to remove it", async () => {
    await seedOldWorld();
    const plan = await planRoleSync(prisma, ORG);
    expect(plan.extraGrants).toContainEqual({ role: "ASSOCIATE", permission: "commission.read" });
  });

  it("plans one entry per organisation, or one for the organisation named, and refuses an unknown one", async () => {
    await makeOrg(ORG);
    await makeOrg(OTHER_ORG);
    const all = await planRoleSyncForOrgs(prisma);
    expect(all.map((plan) => plan.orgId)).toEqual(expect.arrayContaining([ORG, OTHER_ORG]));
    expect((await planRoleSyncForOrgs(prisma, ORG)).map((plan) => plan.orgId)).toEqual([ORG]);
    await expect(planRoleSyncForOrgs(prisma, "org_does_not_exist")).rejects.toThrow(/not found/);
  });
});

describe("applyRoleSync", () => {
  beforeEach(reset);

  it("gives the old world an ADMIN role and the matrix grants on every active role", async () => {
    await seedOldWorld();
    await applyRoleSync(prisma, await planRoleSync(prisma, ORG));

    expect(await prisma.permission.count({ where: { code: "user.manage" } })).toBe(1);
    expect(await rolesNow(ORG)).toEqual(expect.arrayContaining(["ADMIN", "ASSOCIATE", "SUPER_ADMIN"]));
    for (const code of ROLE_CODES) {
      expect(await grantsOf(ORG, code)).toEqual(expect.arrayContaining([...permissionsForRole(code)]));
    }
    const admin = await prisma.role.findUniqueOrThrow({ where: { orgId_code: { orgId: ORG, code: "ADMIN" } } });
    expect(admin).toMatchObject({ name: "Admin", isSystem: true });
  });

  it("adds only: a grant beyond the matrix, the old roles and every user's role stay", async () => {
    await seedOldWorld();
    const before = {
      roles: await rolesNow(ORG),
      salesHead: await grantsOf(ORG, "SALES_HEAD"),
      userRoles: await prisma.userRole.count({ where: { role: { orgId: ORG } } }),
    };
    await applyRoleSync(prisma, await planRoleSync(prisma, ORG));

    expect(await grantsOf(ORG, "ASSOCIATE")).toContain("commission.read");
    expect(await grantsOf(ORG, "SALES_HEAD")).toEqual(before.salesHead);
    expect(await prisma.userRole.count({ where: { role: { orgId: ORG } } })).toBe(before.userRoles);
    expect(await rolesNow(ORG)).toEqual([...before.roles, "ADMIN"].sort());
  });

  it("changes nothing the second time, and two overlapping runs end clean", async () => {
    await seedOldWorld();
    const plan = await planRoleSync(prisma, ORG);
    await Promise.all([applyRoleSync(prisma, plan), applyRoleSync(prisma, plan)]);
    const settled = { roles: await rolesNow(ORG), grants: await grantCount(ORG) };

    const again = await planRoleSync(prisma, ORG);
    expect(again).toMatchObject({ permissionsToCreate: [], rolesToCreate: [], grantsToAdd: [] });
    await applyRoleSync(prisma, again);
    expect({ roles: await rolesNow(ORG), grants: await grantCount(ORG) }).toEqual(settled);
  });

  it("leaves another organisation alone", async () => {
    await seedOldWorld();
    await makeOrg(OTHER_ORG);
    await applyRoleSync(prisma, await planRoleSync(prisma, ORG));
    expect(await rolesNow(OTHER_ORG)).toEqual([]);
  });

  it("gives a brand-new organisation all three roles holding exactly the matrix", async () => {
    await makeOrg(ORG);
    await applyRoleSync(prisma, await planRoleSync(prisma, ORG));
    expect(await rolesNow(ORG)).toEqual([...ROLE_CODES].sort());
    for (const code of ROLE_CODES) expect(await grantsOf(ORG, code)).toEqual([...permissionsForRole(code)].sort());
  });
});

describe("assertMatrixIsSane", () => {
  beforeEach(reset);

  it("passes for the real matrix", () => {
    expect(() => assertMatrixIsSane()).not.toThrow();
  });

  it("refuses to sync when SUPER_ADMIN would lose a permission, and plans nothing", async () => {
    await makeOrg(ORG);
    const original = PERMISSION_MATRIX["booking.read"];
    PERMISSION_MATRIX["booking.read"] = original.filter((role) => role !== "SUPER_ADMIN");
    try {
      await expect(planRoleSync(prisma, ORG)).rejects.toThrow(/SUPER_ADMIN would not hold booking\.read/);
      expect(await rolesNow(ORG)).toEqual([]);
    } finally {
      PERMISSION_MATRIX["booking.read"] = original;
      await reset();
    }
  });
});
