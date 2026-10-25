// narrow-roles plans and applies the move from the old eight roles to the three
// active ones. Needs the migrated local Postgres (never the hosted one).
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PERMISSION_CODES, getPrismaClient, permissionsForRole } from "../src/index";
import { applyNarrowing, planNarrowing } from "../src/narrow-roles";

const prisma = getPrismaClient();
const ORG = "org_test_narrow";
const PROJECT = "project_test_narrow";

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
  await prisma.auditLog.deleteMany({ where: { orgId: ORG } });
  await prisma.user.deleteMany({ where: { orgId: ORG } });
  await prisma.role.deleteMany({ where: { orgId: ORG } });
  await prisma.project.deleteMany({ where: { orgId: ORG } });
}

/** An org as it looks before the cut: eight roles, no ADMIN, no user.manage. */
async function seedOldWorld(): Promise<Record<string, string>> {
  await prisma.organization.upsert({
    where: { id: ORG },
    update: {},
    create: { id: ORG, name: "Narrow Test", legalName: "Narrow Test", timezone: "Asia/Kolkata", currency: "INR" },
  });
  // Permission rows are global, so an earlier run's apply may have created this
  // one; the old world is the one where it does not exist yet.
  await prisma.permission.deleteMany({ where: { code: "user.manage" } });
  await prisma.permission.createMany({
    data: PERMISSION_CODES.filter((code) => code !== "user.manage").map((code) => {
      const [resource, action] = code.split(".");
      return { code, resource: resource ?? code, action: action ?? "" };
    }),
    skipDuplicates: true,
  });
  await prisma.project.create({ data: { id: PROJECT, orgId: ORG, code: "NARROW", name: "Narrow" } });

  const grantsFor: Record<string, string[]> = {
    SALES_HEAD: ["lead.read", "booking.confirm"],
    ASSOCIATE: ["commission.read", "booking.create"],
    SUPER_ADMIN: [...PERMISSION_CODES].filter((c) => c !== "user.manage"),
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
  const users: Record<string, string> = {};
  const addUser = async (key: string, roles: { code: string; projectId?: string }[]) => {
    const user = await prisma.user.create({
      data: { orgId: ORG, email: `${key}@narrow.test`, name: key, passwordHash: "x", status: "ACTIVE" },
    });
    for (const role of roles) {
      await prisma.userRole.create({
        data: { userId: user.id, roleId: await roleId(role.code), projectId: role.projectId ?? null },
      });
    }
    users[key] = user.id;
  };

  await addUser("owner", [{ code: "SUPER_ADMIN" }]);
  await addUser("lead", [{ code: "TEAM_LEAD" }]);
  await addUser("head", [{ code: "SALES_HEAD" }]);
  await addUser("pm", [{ code: "PROJECT_MANAGER", projectId: PROJECT }]);
  await addUser("both", [{ code: "TEAM_LEAD" }, { code: "ASSOCIATE" }]);
  await addUser("seller", [{ code: "ASSOCIATE" }]);
  await addUser("auditor", [{ code: "AUDITOR" }]);
  return users;
}

const rolesNow = async () =>
  (await prisma.role.findMany({ where: { orgId: ORG }, select: { code: true } })).map((r) => r.code).sort();

const roleCodesOf = async (userId: string) =>
  (await prisma.userRole.findMany({ where: { userId }, select: { projectId: true, role: { select: { code: true } } } }))
    .map((ur) => `${ur.role.code}${ur.projectId ? `@${ur.projectId}` : ""}`)
    .sort();

describe("planNarrowing", () => {
  beforeEach(reset);
  afterAll(async () => {
    await reset();
    await prisma.$disconnect();
  });

  it("reads only: planning changes nothing", async () => {
    await seedOldWorld();
    const before = await rolesNow();
    await planNarrowing(prisma, ORG);
    expect(await rolesNow()).toEqual(before);
  });

  it("finds the ADMIN role and the user.manage permission missing", async () => {
    await seedOldWorld();
    const plan = await planNarrowing(prisma, ORG);
    expect(plan.rolesToCreate).toEqual(["ADMIN"]);
    expect(plan.permissionsToCreate).toEqual(["user.manage"]);
  });

  it("maps each removed role to its replacement, keeping a project scope", async () => {
    await seedOldWorld();
    const plan = await planNarrowing(prisma, ORG);
    const move = (email: string) =>
      plan.reRole.filter((m) => m.userEmail === `${email}@narrow.test`).map((m) => `${m.fromRole}->${m.toRole}${m.projectId ? `@${m.projectId}` : ""}`);
    expect(move("lead")).toEqual(["TEAM_LEAD->ASSOCIATE"]);
    expect(move("head")).toEqual(["SALES_HEAD->ADMIN"]);
    expect(move("pm")).toEqual([`PROJECT_MANAGER->ADMIN@${PROJECT}`]);
  });

  it("leaves an AUDITOR alone and keeps that role, but deletes every other removed role once its users have moved", async () => {
    await seedOldWorld();
    const plan = await planNarrowing(prisma, ORG);
    expect(plan.needsDecision).toEqual([{ userEmail: "auditor@narrow.test", role: "AUDITOR" }]);
    expect(plan.rolesKept).toEqual([{ role: "AUDITOR", holders: 1 }]);
    expect(plan.rolesToDelete.sort()).toEqual([
      "FINANCE_ADMIN",
      "PROJECT_MANAGER",
      "SALES_ADMIN",
      "SALES_HEAD",
      "TEAM_LEAD",
    ]);
  });
});

describe("applyNarrowing", () => {
  beforeEach(reset);

  it("ends with the three roles plus a kept AUDITOR, and each role holds exactly the matrix", async () => {
    await seedOldWorld();
    await applyNarrowing(prisma, await planNarrowing(prisma, ORG));

    expect(await rolesNow()).toEqual(["ADMIN", "ASSOCIATE", "AUDITOR", "SUPER_ADMIN"]);
    for (const code of ["SUPER_ADMIN", "ADMIN", "ASSOCIATE"] as const) {
      const grants = await prisma.rolePermission.findMany({
        where: { role: { orgId: ORG, code } },
        select: { permission: { select: { code: true } } },
      });
      expect(grants.map((g) => g.permission.code).sort(), code).toEqual([...permissionsForRole(code)].sort());
    }
  });

  it("re-roles users, keeps project scope, collapses duplicates and leaves the auditor", async () => {
    const users = await seedOldWorld();
    await applyNarrowing(prisma, await planNarrowing(prisma, ORG));

    expect(await roleCodesOf(users.lead!)).toEqual(["ASSOCIATE"]);
    expect(await roleCodesOf(users.head!)).toEqual(["ADMIN"]);
    expect(await roleCodesOf(users.pm!)).toEqual([`ADMIN@${PROJECT}`]);
    expect(await roleCodesOf(users.both!)).toEqual(["ASSOCIATE"]);
    expect(await roleCodesOf(users.seller!)).toEqual(["ASSOCIATE"]);
    expect(await roleCodesOf(users.owner!)).toEqual(["SUPER_ADMIN"]);
    expect(await roleCodesOf(users.auditor!)).toEqual(["AUDITOR"]);
  });

  it("revokes the sessions of a re-roled user and writes an audit row for the change", async () => {
    const users = await seedOldWorld();
    await prisma.session.create({
      data: { userId: users.head!, tokenHash: `narrow-${Date.now()}`, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    await applyNarrowing(prisma, await planNarrowing(prisma, ORG));

    const sessions = await prisma.session.findMany({ where: { userId: users.head! } });
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
    const audit = await prisma.auditLog.findFirst({ where: { orgId: ORG, entityId: users.head! } });
    expect(audit?.before).toEqual({ roleCode: "SALES_HEAD" });
    expect(audit?.after).toEqual({ roleCode: "ADMIN" });
  });

  it("is idempotent: a second plan has nothing left to do except the undecided auditor", async () => {
    await seedOldWorld();
    await applyNarrowing(prisma, await planNarrowing(prisma, ORG));
    const again = await planNarrowing(prisma, ORG);

    expect(again.rolesToCreate).toEqual([]);
    expect(again.permissionsToCreate).toEqual([]);
    expect(again.grantsToAdd).toEqual([]);
    expect(again.grantsToRemove).toEqual([]);
    expect(again.reRole).toEqual([]);
    expect(again.rolesToDelete).toEqual([]);
    expect(again.needsDecision).toHaveLength(1);
  });
});
