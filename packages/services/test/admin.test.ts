// User/Role admin -- three roles (SUPER_ADMIN, ADMIN, ASSOCIATE). Runs against
// LOCAL Docker Postgres. Under test: the role allowlist, the privilege ceiling
// (ADMIN manages associates only), the self-change and last-super-admin guards,
// session revocation on a role change, and the associate profile every new
// associate needs before they can hold or book anything.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import { createSession } from "../src/auth";
import { verifyPassword } from "../src/password";
import { EmailConfigError } from "../src/email";
import type * as EmailModule from "../src/email";
import {
  DuplicateEmailError,
  InvalidRoleError,
  InvalidUserInputError,
  LastSuperAdminError,
  NoDefaultGradeError,
  RoleNotFoundError,
  SelfRoleChangeError,
  UserNotFoundError,
  createUser,
  listUsers,
  resetUserPassword,
  updateUserRoles,
} from "../src/admin";
import type { AuditContext } from "../src/audit";

// No test here may reach a real SMTP server: sendEmail is replaced by a recorder
// that can be told to fail.
const mail = vi.hoisted(() => ({
  sent: [] as { to: string; subject: string; text: string }[],
  failWith: null as Error | null,
}));
vi.mock("../src/email", async (importOriginal) => {
  const original = await importOriginal<typeof EmailModule>();
  return {
    ...original,
    sendEmail: async (params: { to: string; subject: string; text: string }) => {
      if (mail.failWith) throw mail.failWith;
      mail.sent.push(params);
    },
  };
});

const db = getPrismaClient();
const ORG = "org_test_admin";
const OTHER_ORG = "org_test_admin_other";

async function reset() {
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.auditLog.deleteMany({ where: { orgId } });
    await db.associateGrade.deleteMany({ where: { associate: { orgId } } });
    await db.associate.deleteMany({ where: { orgId } });
    await db.grade.deleteMany({ where: { orgId } });
    await db.userRole.deleteMany({ where: { role: { orgId } } });
    await db.rolePermission.deleteMany({ where: { role: { orgId } } });
    await db.role.deleteMany({ where: { orgId } });
    await db.user.deleteMany({ where: { orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
  }
}

const ROLE_GRANTS: [code: string, name: string, permissions: string[]][] = [
  ["SUPER_ADMIN", "Super Admin", ["rbac.manage", "user.manage"]],
  ["ADMIN", "Admin", ["user.manage"]],
  ["ASSOCIATE", "Associate", []],
];

/** The three real roles with the grants admin.ts cares about, a grade for new
 *  associates, an owner (SUPER_ADMIN), an admin (ADMIN), and a user holding no
 *  role at all. */
async function seedFixture(orgId: string = ORG, options: { grade?: boolean } = {}) {
  await db.organization.create({ data: { id: orgId, name: "Admin Test Org", legalName: "Admin Test Org Pvt Ltd" } });

  const roleIds: Record<string, string> = {};
  for (const [code, name, permissions] of ROLE_GRANTS) {
    const role = await db.role.create({ data: { orgId, code, name } });
    roleIds[code] = role.id;
    for (const permissionCode of permissions) {
      const [resource, action] = permissionCode.split(".");
      const permission = await db.permission.upsert({
        where: { code: permissionCode },
        update: {},
        create: { code: permissionCode, resource: resource!, action: action! },
      });
      await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    }
  }

  if (options.grade !== false) {
    await db.grade.create({ data: { orgId, code: "G1", name: "Executive", rank: 1, holdQuota: 3 } });
    await db.grade.create({ data: { orgId, code: "G2", name: "Senior", rank: 2, holdQuota: 5 } });
  }

  const makeActor = async (label: string, roleCode: string | null) => {
    const user = await db.user.create({
      data: { orgId, email: `${label}-${orgId}@test.local`, name: label, passwordHash: "unused", status: "ACTIVE" },
    });
    if (roleCode) {
      await db.userRole.create({ data: { userId: user.id, roleId: roleIds[roleCode]!, projectId: null } });
    }
    return user;
  };

  return {
    owner: await makeActor("owner", "SUPER_ADMIN"),
    admin: await makeActor("admin", "ADMIN"),
    noPerms: await makeActor("noperms", null),
  };
}

function ctx(orgId: string, userId: string | null, label: string): AuditContext {
  return { orgId, actorId: userId, actorLabel: label };
}

const rolesOf = async (userId: string) =>
  (await db.userRole.findMany({ where: { userId }, include: { role: true } })).map((r) => r.role.code);

beforeEach(async () => {
  mail.sent.length = 0;
  mail.failWith = null;
  process.env.APP_BASE_URL = "https://app.test/";
  await reset();
});
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("createUser: the credentials email", () => {
  it("emails the login ID, temporary password, sign-in address and associate code, and makes the person change it", async () => {
    const f = await seedFixture();
    const result = await createUser(db, { email: "New.Hire@test.local", name: "New Hire", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });

    expect(result).toMatchObject({ emailSent: true, emailNote: null, email: "new.hire@test.local" });
    expect(mail.sent).toHaveLength(1);
    const message = mail.sent[0]!;
    expect(message.to).toBe("new.hire@test.local");
    expect(message.subject).toBe("Your Desire account");
    expect(message.text).toContain("Login ID: new.hire@test.local");
    expect(message.text).toContain(`Temporary password: ${result.temporaryPassword}`);
    expect(message.text).toContain("Sign in: https://app.test/login");
    expect(message.text).toContain("Associate code: A-0001");

    const user = await db.user.findUniqueOrThrow({ where: { id: result.userId } });
    expect(user.mustChangePassword).toBe(true);
  });

  it("does not put an associate code in the email of an admin", async () => {
    const f = await seedFixture();
    await createUser(db, { email: "boss@test.local", name: "Boss", roleCode: "ADMIN", audit: ctx(ORG, f.owner.id, "owner") });
    expect(mail.sent[0]!.text).not.toContain("Associate code");
  });

  it("still creates the account when the mail server refuses, and says why", async () => {
    const f = await seedFixture();
    mail.failWith = new Error("550 mailbox unavailable");

    const result = await createUser(db, { email: "x@test.local", name: "X", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });

    expect(result.emailSent).toBe(false);
    expect(result.emailNote).toMatch(/did not accept/);
    expect(await db.user.count({ where: { id: result.userId } })).toBe(1);
    // The admin must be able to hand the password over, so it is still returned.
    expect(result.temporaryPassword.length).toBeGreaterThan(8);
  });

  it("explains that email is not set up when SMTP settings are missing", async () => {
    const f = await seedFixture();
    mail.failWith = new EmailConfigError("SMTP_HOST/SMTP_PORT are not set");

    const result = await createUser(db, { email: "x@test.local", name: "X", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });

    expect(result.emailSent).toBe(false);
    expect(result.emailNote).toMatch(/SMTP settings are missing/);
  });

  it("sends nothing when the account is not created", async () => {
    const f = await seedFixture();
    await createUser(db, { email: "dup@test.local", name: "First", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });
    mail.sent.length = 0;

    await expect(
      createUser(db, { email: "dup@test.local", name: "Second", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") }),
    ).rejects.toThrow(DuplicateEmailError);
    await expect(
      createUser(db, { email: "boss@test.local", name: "Boss", roleCode: "ADMIN", audit: ctx(ORG, f.admin.id, "admin") }),
    ).rejects.toThrow(ForbiddenError);

    expect(mail.sent).toEqual([]);
  });
});

describe("resetUserPassword", () => {
  async function associate(f: Awaited<ReturnType<typeof seedFixture>>) {
    const created = await createUser(db, { email: "seller@test.local", name: "Seller", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });
    mail.sent.length = 0;
    return created;
  }

  it("issues a new temporary password that works, must be changed, and is emailed", async () => {
    const f = await seedFixture();
    const seller = await associate(f);
    await db.user.update({ where: { id: seller.userId }, data: { mustChangePassword: false } });

    const result = await resetUserPassword(db, { userId: seller.userId, audit: ctx(ORG, f.admin.id, "admin") });

    const user = await db.user.findUniqueOrThrow({ where: { id: seller.userId } });
    expect(await verifyPassword(user.passwordHash, result.temporaryPassword)).toBe(true);
    expect(await verifyPassword(user.passwordHash, seller.temporaryPassword)).toBe(false);
    expect(user.mustChangePassword).toBe(true);
    expect(result).toMatchObject({ emailSent: true, userId: seller.userId });
    expect(mail.sent[0]!.subject).toBe("Your Desire password was reset");
    expect(mail.sent[0]!.text).toContain(`Temporary password: ${result.temporaryPassword}`);
  });

  it("ends every session, clears a lockout and voids an unused reset link", async () => {
    const f = await seedFixture();
    const seller = await associate(f);
    await createSession(db, seller.userId, {});
    await db.user.update({ where: { id: seller.userId }, data: { failedLoginCount: 5, lockedUntil: new Date(Date.now() + 600_000) } });
    await db.passwordResetToken.create({
      data: { userId: seller.userId, tokenHash: `reset-${Date.now()}`, expiresAt: new Date(Date.now() + 600_000) },
    });

    await resetUserPassword(db, { userId: seller.userId, audit: ctx(ORG, f.owner.id, "owner") });

    const user = await db.user.findUniqueOrThrow({ where: { id: seller.userId } });
    expect(user).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    expect((await db.session.findMany({ where: { userId: seller.userId } })).every((s) => s.revokedAt !== null)).toBe(true);
    expect((await db.passwordResetToken.findMany({ where: { userId: seller.userId } })).every((t) => t.usedAt !== null)).toBe(true);
  });

  it("writes an audit row that never contains the password", async () => {
    const f = await seedFixture();
    const seller = await associate(f);
    const result = await resetUserPassword(db, { userId: seller.userId, audit: ctx(ORG, f.admin.id, "admin") });

    const rows = await db.auditLog.findMany({ where: { entity: "User", entityId: seller.userId, action: "UPDATE" } });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(result.temporaryPassword);
  });

  it("still resets when the mail server is down, and returns the password for the admin to pass on", async () => {
    const f = await seedFixture();
    const seller = await associate(f);
    mail.failWith = new EmailConfigError("no smtp");

    const result = await resetUserPassword(db, { userId: seller.userId, audit: ctx(ORG, f.admin.id, "admin") });

    expect(result.emailSent).toBe(false);
    const user = await db.user.findUniqueOrThrow({ where: { id: seller.userId } });
    expect(await verifyPassword(user.passwordHash, result.temporaryPassword)).toBe(true);
  });

  it("lets an ADMIN reset an associate but not an admin or a super admin", async () => {
    const f = await seedFixture();
    const boss = await createUser(db, { email: "boss@test.local", name: "Boss", roleCode: "ADMIN", audit: ctx(ORG, f.owner.id, "owner") });
    const before = (await db.user.findUniqueOrThrow({ where: { id: boss.userId } })).passwordHash;

    await expect(resetUserPassword(db, { userId: boss.userId, audit: ctx(ORG, f.admin.id, "admin") })).rejects.toThrow("Only a Super Admin");
    await expect(resetUserPassword(db, { userId: f.owner.id, audit: ctx(ORG, f.admin.id, "admin") })).rejects.toThrow("Only a Super Admin");
    expect((await db.user.findUniqueOrThrow({ where: { id: boss.userId } })).passwordHash).toBe(before);
    expect(mail.sent.filter((m) => m.subject.includes("reset"))).toEqual([]);
  });

  it("lets a SUPER_ADMIN reset an admin", async () => {
    const f = await seedFixture();
    const boss = await createUser(db, { email: "boss@test.local", name: "Boss", roleCode: "ADMIN", audit: ctx(ORG, f.owner.id, "owner") });
    await expect(resetUserPassword(db, { userId: boss.userId, audit: ctx(ORG, f.owner.id, "owner") })).resolves.toMatchObject({ emailSent: true });
  });

  it("refuses a user without user-management permission, another org's user, and an unknown user", async () => {
    const f = await seedFixture();
    const other = await seedFixture(OTHER_ORG);
    const seller = await associate(f);
    const foreign = await createUser(db, { email: "foreign@test.local", name: "Foreign", roleCode: "ASSOCIATE", audit: ctx(OTHER_ORG, other.owner.id, "owner") });

    await expect(resetUserPassword(db, { userId: seller.userId, audit: ctx(ORG, f.noPerms.id, "noperms") })).rejects.toThrow(ForbiddenError);
    await expect(resetUserPassword(db, { userId: foreign.userId, audit: ctx(ORG, f.owner.id, "owner") })).rejects.toThrow(ForbiddenError);
    await expect(resetUserPassword(db, { userId: "nope", audit: ctx(ORG, f.owner.id, "owner") })).rejects.toThrow(UserNotFoundError);
    await expect(resetUserPassword(db, { userId: seller.userId, audit: ctx(ORG, null, "system") })).rejects.toThrow(ForbiddenError);
  });
});

describe("createUser", () => {
  it("creates an INVITED user with one role and a real, verifiable temporary password", async () => {
    const f = await seedFixture();

    const result = await createUser(db, {
      email: "newhire@test.local", name: "New Hire", roleCode: "ASSOCIATE",
      audit: ctx(ORG, f.owner.id, "owner"),
    });

    const user = await db.user.findUniqueOrThrow({ where: { id: result.userId } });
    expect(user.status).toBe("INVITED");
    expect(await verifyPassword(user.passwordHash, result.temporaryPassword)).toBe(true);
    expect(await rolesOf(user.id)).toEqual(["ASSOCIATE"]);
  });

  it("stores the email trimmed and lower-case, because login looks it up that way", async () => {
    const f = await seedFixture();
    const result = await createUser(db, {
      email: "  Mixed.Case@Test.Local ", name: "Mixed", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner"),
    });
    expect(result.email).toBe("mixed.case@test.local");
    expect((await db.user.findUniqueOrThrow({ where: { id: result.userId } })).email).toBe("mixed.case@test.local");
  });

  it("rejects a malformed email and an empty name", async () => {
    const f = await seedFixture();
    const audit = ctx(ORG, f.owner.id, "owner");
    await expect(createUser(db, { email: "not-an-email", name: "X", roleCode: "ASSOCIATE", audit })).rejects.toThrow(InvalidUserInputError);
    await expect(createUser(db, { email: "x@test.local", name: "   ", roleCode: "ASSOCIATE", audit })).rejects.toThrow(InvalidUserInputError);
  });

  it("rejects a duplicate email within the same org, whatever its case", async () => {
    const f = await seedFixture();
    await createUser(db, { email: "dup@test.local", name: "First", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });
    await expect(
      createUser(db, { email: "DUP@test.local", name: "Second", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") }),
    ).rejects.toThrow(DuplicateEmailError);
  });

  it("refuses a role that is not one of the three", async () => {
    const f = await seedFixture();
    await expect(
      createUser(db, { email: "x@test.local", name: "X", roleCode: "TEAM_LEAD" as never, audit: ctx(ORG, f.owner.id, "owner") }),
    ).rejects.toThrow(InvalidRoleError);
  });

  it("throws when the role row is missing from this org", async () => {
    const f = await seedFixture();
    await db.role.deleteMany({ where: { orgId: ORG, code: "ADMIN" } });
    await expect(
      createUser(db, { email: "x@test.local", name: "X", roleCode: "ADMIN", audit: ctx(ORG, f.owner.id, "owner") }),
    ).rejects.toThrow(RoleNotFoundError);
  });

  it("refuses a user who holds no user-management permission", async () => {
    const f = await seedFixture();
    await expect(
      createUser(db, { email: "x@test.local", name: "X", roleCode: "ASSOCIATE", audit: ctx(ORG, f.noPerms.id, "noperms") }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses a system actor", async () => {
    await seedFixture();
    await expect(
      createUser(db, { email: "x@test.local", name: "X", roleCode: "ASSOCIATE", audit: ctx(ORG, null, "system") }),
    ).rejects.toThrow(ForbiddenError);
  });

  describe("the privilege ceiling", () => {
    it("lets an ADMIN create an associate", async () => {
      const f = await seedFixture();
      const result = await createUser(db, { email: "a@test.local", name: "A", roleCode: "ASSOCIATE", audit: ctx(ORG, f.admin.id, "admin") });
      expect(await rolesOf(result.userId)).toEqual(["ASSOCIATE"]);
    });

    it.each(["ADMIN", "SUPER_ADMIN"] as const)("stops an ADMIN creating a %s", async (roleCode) => {
      const f = await seedFixture();
      await expect(
        createUser(db, { email: "boss@test.local", name: "Boss", roleCode, audit: ctx(ORG, f.admin.id, "admin") }),
      ).rejects.toThrow("Only a Super Admin");
      expect(await db.user.count({ where: { orgId: ORG, email: "boss@test.local" } })).toBe(0);
    });

    it.each(["ADMIN", "SUPER_ADMIN"] as const)("lets a SUPER_ADMIN create a %s, with no associate profile", async (roleCode) => {
      const f = await seedFixture();
      const result = await createUser(db, { email: "boss@test.local", name: "Boss", roleCode, audit: ctx(ORG, f.owner.id, "owner") });
      expect(await rolesOf(result.userId)).toEqual([roleCode]);
      expect(result.associateCode).toBeNull();
      expect(await db.associate.count({ where: { userId: result.userId } })).toBe(0);
    });
  });

  describe("the associate profile", () => {
    it("gives a new associate a code, an ACTIVE profile and a current grade with hold quota", async () => {
      const f = await seedFixture();
      const result = await createUser(db, { email: "seller@test.local", name: "Seller", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });

      expect(result.associateCode).toBe("A-0001");
      const associate = await db.associate.findUniqueOrThrow({
        where: { userId: result.userId },
        include: { grades: { include: { grade: true } } },
      });
      expect(associate).toMatchObject({ code: "A-0001", status: "ACTIVE", engagementType: "CHANNEL_PARTNER", orgId: ORG });
      expect(associate.grades).toHaveLength(1);
      expect(associate.grades[0]).toMatchObject({ validTo: null });
      expect(associate.grades[0]!.grade).toMatchObject({ code: "G1", holdQuota: 3 });
    });

    it("numbers the next associate after the highest existing code, ignoring non-sequential ones", async () => {
      const f = await seedFixture();
      const demo = await db.user.create({ data: { orgId: ORG, email: "demo@test.local", name: "Demo", passwordHash: "x" } });
      await db.associate.create({
        data: { orgId: ORG, userId: demo.id, code: "A-DEMO-ASSOCIATE", engagementType: "EMPLOYEE", joinDate: new Date() },
      });
      const first = await createUser(db, { email: "one@test.local", name: "One", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });
      const second = await createUser(db, { email: "two@test.local", name: "Two", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });
      expect([first.associateCode, second.associateCode]).toEqual(["A-0001", "A-0002"]);
    });

    it("writes an audit row for the profile", async () => {
      const f = await seedFixture();
      const result = await createUser(db, { email: "seller@test.local", name: "Seller", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });
      const associate = await db.associate.findUniqueOrThrow({ where: { userId: result.userId } });
      const row = await db.auditLog.findFirst({ where: { entity: "Associate", entityId: associate.id, action: "CREATE" } });
      expect(row).not.toBeNull();
    });

    it("creates nothing at all when no grade is configured", async () => {
      const f = await seedFixture(ORG, { grade: false });
      await expect(
        createUser(db, { email: "seller@test.local", name: "Seller", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") }),
      ).rejects.toThrow(NoDefaultGradeError);
      expect(await db.user.count({ where: { orgId: ORG, email: "seller@test.local" } })).toBe(0);
    });
  });
});

describe("updateUserRoles: close-and-replace, never additive", () => {
  it("replaces the user's single role with a new one", async () => {
    const f = await seedFixture();
    const created = await createUser(db, { email: "promo@test.local", name: "Promo", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });

    await updateUserRoles(db, { userId: created.userId, roleCode: "ADMIN", audit: ctx(ORG, f.owner.id, "owner") });

    expect(await rolesOf(created.userId)).toEqual(["ADMIN"]);
  });

  it("writes a before/after audit row naming both role sets", async () => {
    const f = await seedFixture();
    const created = await createUser(db, { email: "audited@test.local", name: "Audited", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });

    await updateUserRoles(db, { userId: created.userId, roleCode: "ADMIN", audit: ctx(ORG, f.owner.id, "owner") });

    const row = await db.auditLog.findFirstOrThrow({ where: { entity: "User", entityId: created.userId, action: "UPDATE" } });
    expect((row.before as { roleCodes: string[] }).roleCodes).toEqual(["ASSOCIATE"]);
    expect((row.after as { roleCodes: string[] }).roleCodes).toEqual(["ADMIN"]);
  });

  it("revokes every session of the user whose role changed, and only theirs", async () => {
    const f = await seedFixture();
    const created = await createUser(db, { email: "kicked@test.local", name: "Kicked", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });
    await createSession(db, created.userId, {});
    await createSession(db, created.userId, {});
    await createSession(db, f.admin.id, {});

    await updateUserRoles(db, { userId: created.userId, roleCode: "ADMIN", audit: ctx(ORG, f.owner.id, "owner") });

    const mine = await db.session.findMany({ where: { userId: created.userId } });
    expect(mine).toHaveLength(2);
    expect(mine.every((s) => s.revokedAt !== null)).toBe(true);
    const bystander = await db.session.findMany({ where: { userId: f.admin.id } });
    expect(bystander.every((s) => s.revokedAt === null)).toBe(true);
  });

  it("does nothing when the role is unchanged: no revocation, no audit row", async () => {
    const f = await seedFixture();
    const created = await createUser(db, { email: "same@test.local", name: "Same", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });
    await createSession(db, created.userId, {});

    await updateUserRoles(db, { userId: created.userId, roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });

    expect((await db.session.findMany({ where: { userId: created.userId } })).every((s) => s.revokedAt === null)).toBe(true);
    expect(await db.auditLog.count({ where: { entity: "User", entityId: created.userId, action: "UPDATE" } })).toBe(0);
  });

  it("gives an account moved to ASSOCIATE the associate profile it needs", async () => {
    const f = await seedFixture();
    const created = await createUser(db, { email: "demoted@test.local", name: "Demoted", roleCode: "ADMIN", audit: ctx(ORG, f.owner.id, "owner") });
    expect(await db.associate.count({ where: { userId: created.userId } })).toBe(0);

    await updateUserRoles(db, { userId: created.userId, roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });

    expect(await db.associate.count({ where: { userId: created.userId } })).toBe(1);
  });

  it("keeps an existing associate profile (and so their holds and bookings) across a round trip", async () => {
    const f = await seedFixture();
    const created = await createUser(db, { email: "round@test.local", name: "Round", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });
    const before = await db.associate.findUniqueOrThrow({ where: { userId: created.userId } });

    await updateUserRoles(db, { userId: created.userId, roleCode: "ADMIN", audit: ctx(ORG, f.owner.id, "owner") });
    await updateUserRoles(db, { userId: created.userId, roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });

    const after = await db.associate.findMany({ where: { userId: created.userId } });
    expect(after.map((a) => a.id)).toEqual([before.id]);
  });

  it("refuses a role that is not one of the three", async () => {
    const f = await seedFixture();
    const created = await createUser(db, { email: "bad@test.local", name: "Bad", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });
    await expect(
      updateUserRoles(db, { userId: created.userId, roleCode: "FINANCE_ADMIN" as never, audit: ctx(ORG, f.owner.id, "owner") }),
    ).rejects.toThrow(InvalidRoleError);
  });

  it("throws for a user that does not exist", async () => {
    const f = await seedFixture();
    await expect(
      updateUserRoles(db, { userId: "nope", roleCode: "ADMIN", audit: ctx(ORG, f.owner.id, "owner") }),
    ).rejects.toThrow(UserNotFoundError);
  });

  it("refuses a user belonging to another organisation", async () => {
    const f = await seedFixture(ORG);
    const other = await seedFixture(OTHER_ORG);
    const created = await createUser(db, { email: "cross@test.local", name: "Cross", roleCode: "ASSOCIATE", audit: ctx(OTHER_ORG, other.owner.id, "owner") });

    await expect(
      updateUserRoles(db, { userId: created.userId, roleCode: "ADMIN", audit: ctx(ORG, f.owner.id, "owner") }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses a user who holds no user-management permission", async () => {
    const f = await seedFixture();
    const created = await createUser(db, { email: "guarded@test.local", name: "Guarded", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });
    await expect(
      updateUserRoles(db, { userId: created.userId, roleCode: "ADMIN", audit: ctx(ORG, f.noPerms.id, "noperms") }),
    ).rejects.toThrow(ForbiddenError);
  });

  describe("the guards", () => {
    it("stops an ADMIN promoting an associate", async () => {
      const f = await seedFixture();
      const created = await createUser(db, { email: "up@test.local", name: "Up", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });
      await expect(
        updateUserRoles(db, { userId: created.userId, roleCode: "ADMIN", audit: ctx(ORG, f.admin.id, "admin") }),
      ).rejects.toThrow("Only a Super Admin");
      expect(await rolesOf(created.userId)).toEqual(["ASSOCIATE"]);
    });

    it("stops an ADMIN altering another admin or a super admin", async () => {
      const f = await seedFixture();
      const boss = await createUser(db, { email: "boss@test.local", name: "Boss", roleCode: "ADMIN", audit: ctx(ORG, f.owner.id, "owner") });
      await expect(
        updateUserRoles(db, { userId: boss.userId, roleCode: "ASSOCIATE", audit: ctx(ORG, f.admin.id, "admin") }),
      ).rejects.toThrow("Only a Super Admin");
      await expect(
        updateUserRoles(db, { userId: f.owner.id, roleCode: "ASSOCIATE", audit: ctx(ORG, f.admin.id, "admin") }),
      ).rejects.toThrow("Only a Super Admin");
    });

    it("stops anyone changing their own role", async () => {
      const f = await seedFixture();
      await expect(
        updateUserRoles(db, { userId: f.owner.id, roleCode: "ADMIN", audit: ctx(ORG, f.owner.id, "owner") }),
      ).rejects.toThrow(SelfRoleChangeError);
    });

    it("lets a SUPER_ADMIN be demoted while another remains", async () => {
      const f = await seedFixture();
      const second = await createUser(db, { email: "second@test.local", name: "Second", roleCode: "SUPER_ADMIN", audit: ctx(ORG, f.owner.id, "owner") });

      await updateUserRoles(db, { userId: second.userId, roleCode: "ADMIN", audit: ctx(ORG, f.owner.id, "owner") });

      expect(await rolesOf(second.userId)).toEqual(["ADMIN"]);
    });

    it("keeps the last SUPER_ADMIN, even from an actor who holds rbac.manage through some other role", async () => {
      const f = await seedFixture();
      // A role row nobody should create, but rows are data: the guard is for
      // the day one exists.
      const role = await db.role.create({ data: { orgId: ORG, code: "OPS", name: "Ops" } });
      const permission = await db.permission.findUniqueOrThrow({ where: { code: "rbac.manage" } });
      await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
      const ops = await db.user.create({ data: { orgId: ORG, email: "ops@test.local", name: "Ops", passwordHash: "x" } });
      await db.userRole.create({ data: { userId: ops.id, roleId: role.id } });

      await expect(
        updateUserRoles(db, { userId: f.owner.id, roleCode: "ADMIN", audit: ctx(ORG, ops.id, "ops") }),
      ).rejects.toThrow(LastSuperAdminError);
      expect(await rolesOf(f.owner.id)).toEqual(["SUPER_ADMIN"]);
    });
  });
});

describe("listUsers", () => {
  it("shows a SUPER_ADMIN everyone, with role codes", async () => {
    const f = await seedFixture();
    await createUser(db, { email: "one@test.local", name: "One", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });

    const users = await listUsers(db, { orgId: ORG, actorId: f.owner.id });
    const created = users.find((u) => u.email === "one@test.local");
    expect(created?.roleCodes).toEqual(["ASSOCIATE"]);
    expect(created?.status).toBe("INVITED");
    expect(users.map((u) => u.email)).toContain(f.admin.email);
    expect(users.map((u) => u.email)).toContain(f.owner.email);
  });

  it("shows an ADMIN only the associates", async () => {
    const f = await seedFixture();
    await createUser(db, { email: "assoc@test.local", name: "Assoc", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });

    const users = await listUsers(db, { orgId: ORG, actorId: f.admin.id });
    expect(users.map((u) => u.email)).toEqual(["assoc@test.local"]);
  });

  it("pages by email without overlap, so the screen never has to read the whole list", async () => {
    const f = await seedFixture();
    const associate = await db.role.findUniqueOrThrow({ where: { orgId_code: { orgId: ORG, code: "ASSOCIATE" } } });
    for (const n of [1, 2, 3, 4, 5]) {
      const user = await db.user.create({
        data: { orgId: ORG, email: `p${n}@test.local`, name: `P${n}`, passwordHash: "unused" },
      });
      await db.userRole.create({ data: { userId: user.id, roleId: associate.id } });
    }

    const everyone = (await listUsers(db, { orgId: ORG, actorId: f.owner.id })).map((u) => u.email);
    expect(everyone).toHaveLength(8);

    const page = (skip: number) => listUsers(db, { orgId: ORG, actorId: f.owner.id, skip, take: 3 });
    const [first, second, third] = [await page(0), await page(3), await page(6)];
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
    expect(third).toHaveLength(2);
    expect([...first, ...second, ...third].map((u) => u.email)).toEqual(everyone);
    expect(await page(9)).toEqual([]);
  });

  it("never returns the password hash or the MFA secret", async () => {
    const f = await seedFixture();
    const users = await listUsers(db, { orgId: ORG, actorId: f.owner.id });
    for (const user of users) {
      expect(Object.keys(user).sort()).toEqual(["email", "id", "lastLoginAt", "name", "roleCodes", "status"]);
    }
  });

  it("refuses a user who holds no user-management permission", async () => {
    const f = await seedFixture();
    await expect(listUsers(db, { orgId: ORG, actorId: f.noPerms.id })).rejects.toThrow(ForbiddenError);
  });
});
