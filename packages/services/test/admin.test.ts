// User/Role admin -- three roles (SUPER_ADMIN, ADMIN, ASSOCIATE). Runs against
// LOCAL Docker Postgres. Under test: the role allowlist, the privilege ceiling
// (ADMIN manages associates only), the self-change and last-super-admin guards,
// session revocation on a role change, the associate profile every new
// associate needs before they can hold or book anything, and the company-email
// rule (ALLOWED_EMAIL_DOMAINS) that applies to every role but Super Admin.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyRoleSync, getPrismaClient, planRoleSync } from "@desire/db";
import { ForbiddenError, getSessionPermissions } from "../src/rbac";
import { AccountDisabledError, createSession } from "../src/auth";
import { attemptLogin, verifyPassword } from "../src/password";
import { EmailConfigError } from "../src/email";
import type * as EmailModule from "../src/email";
import {
  DuplicateEmailError,
  InvalidRoleError,
  InvalidUserInputError,
  LastSuperAdminError,
  NoDefaultGradeError,
  RoleNotFoundError,
  SelfDeleteError,
  SelfDisableError,
  SelfRoleChangeError,
  UserInUseError,
  UserNotFoundError,
  createUser,
  deleteUser,
  getUser,
  listUsers,
  resetUserPassword,
  setUserDisabled,
  updateUser,
  updateUserRoles,
} from "../src/admin";
import { ensureAdminAssociateProfiles } from "../src/associate-profile";
import { EmailDomainNotAllowedError, EmailDomainsNotConfiguredError } from "../src/allowed-domains";
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
    await db.lead.deleteMany({ where: { orgId } });
    await db.savedReportView.deleteMany({ where: { orgId } });
    await db.associateHierarchy.deleteMany({ where: { associate: { orgId } } });
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
  // Every Admin and Associate made below is on @test.local; the tests of the rule
  // itself change this per test.
  process.env.ALLOWED_EMAIL_DOMAINS = "test.local";
  await reset();
});
afterAll(async () => {
  delete process.env.ALLOWED_EMAIL_DOMAINS;
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

  // Production's roles were hand-seeded before Admin existed (PROGRESS.md, Phase 0),
  // so the Admin screen offered a role the database did not have: "Role "ADMIN" is
  // not configured for this organisation". The role sync that runs on every deploy
  // is the cure, and the person it creates must really be able to confirm bookings.
  it("cannot hand out Admin in an organisation seeded before the cut, until the role sync has run", async () => {
    const f = await seedFixture();
    await db.role.deleteMany({ where: { orgId: ORG, code: "ADMIN" } });
    const asOwner = ctx(ORG, f.owner.id, "owner");

    await expect(createUser(db, { email: "a1@test.local", name: "A1", roleCode: "ADMIN", audit: asOwner })).rejects.toThrow(
      RoleNotFoundError,
    );
    const associate = await createUser(db, { email: "seller@test.local", name: "Seller", roleCode: "ASSOCIATE", audit: asOwner });
    await expect(
      updateUserRoles(db, { userId: associate.userId, roleCode: "ADMIN", audit: asOwner }),
    ).rejects.toThrow(RoleNotFoundError);

    await applyRoleSync(db, await planRoleSync(db, ORG));

    const created = await createUser(db, { email: "a2@test.local", name: "A2", roleCode: "ADMIN", audit: asOwner });
    expect(await rolesOf(created.userId)).toEqual(["ADMIN"]);
    const granted = await getSessionPermissions(db, created.userId);
    for (const code of ["booking.read", "booking.confirm", "booking.cancel", "user.manage"]) expect(granted.has(code)).toBe(true);
    expect(granted.has("rbac.manage")).toBe(false);
    // An admin holds and books plots too (they are given an associate profile).
    for (const code of ["hold.create", "booking.create"]) expect(granted.has(code)).toBe(true);

    await updateUserRoles(db, { userId: associate.userId, roleCode: "ADMIN", audit: asOwner });
    expect(await rolesOf(associate.userId)).toEqual(["ADMIN"]);
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

    it.each(["ADMIN", "SUPER_ADMIN"] as const)("lets a SUPER_ADMIN create a %s, who also gets an associate profile to hold and book with", async (roleCode) => {
      const f = await seedFixture();
      const result = await createUser(db, { email: "boss@test.local", name: "Boss", roleCode, audit: ctx(ORG, f.owner.id, "owner") });
      expect(await rolesOf(result.userId)).toEqual([roleCode]);
      // Reported as no associate code (it is not mailed to an admin), though the profile exists.
      expect(result.associateCode).toBeNull();
      expect(await db.associate.count({ where: { userId: result.userId } })).toBe(1);
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

describe("admins hold and book plots, so they get an associate profile", () => {
  const profileOf = (userId: string) => db.associate.findUnique({ where: { userId } });

  it.each(["ADMIN", "SUPER_ADMIN"] as const)("creating a %s user gives them a profile under the lowest grade", async (roleCode) => {
    const f = await seedFixture();
    const created = await createUser(db, { email: `x-${roleCode}@test.local`, name: "X", roleCode, audit: ctx(ORG, f.owner.id, "owner") });

    const associate = await profileOf(created.userId);
    expect(associate).toMatchObject({ code: "A-0001", status: "ACTIVE" });
    const grade = await db.associateGrade.findFirstOrThrow({ where: { associateId: associate!.id }, include: { grade: true } });
    expect(grade.grade.code).toBe("G1");
  });

  it("still creates an admin when no grade is configured, just without a profile", async () => {
    const f = await seedFixture(ORG, { grade: false });
    const created = await createUser(db, { email: "adm@test.local", name: "Adm", roleCode: "ADMIN", audit: ctx(ORG, f.owner.id, "owner") });

    expect(await rolesOf(created.userId)).toEqual(["ADMIN"]);
    expect(await profileOf(created.userId)).toBeNull();
  });

  it("changing a user to admin gives them a profile, and keeps the one they already had", async () => {
    const f = await seedFixture();
    const seller = await createUser(db, { email: "seller@test.local", name: "Seller", roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });
    const before = await profileOf(seller.userId);

    await updateUserRoles(db, { userId: seller.userId, roleCode: "ADMIN", audit: ctx(ORG, f.owner.id, "owner") });

    expect((await profileOf(seller.userId))?.id).toBe(before!.id);
    expect(await db.associate.count({ where: { orgId: ORG } })).toBe(1);
  });

  describe("ensureAdminAssociateProfiles (the deploy-time backfill)", () => {
    it("lists who would get a profile on a dry run and writes nothing", async () => {
      const f = await seedFixture();

      const outcomes = await ensureAdminAssociateProfiles(db, { apply: false, orgId: ORG });

      expect(outcomes.map((o) => [o.email, o.result])).toEqual([
        [f.admin.email, "would create"],
        [f.owner.email, "would create"],
      ]);
      expect(await db.associate.count({ where: { orgId: ORG } })).toBe(0);
    });

    it("gives every admin and super admin a profile once, and nobody else", async () => {
      const f = await seedFixture();
      await ensureAdminAssociateProfiles(db, { apply: true, orgId: ORG });

      const owner = await profileOf(f.owner.id);
      const admin = await profileOf(f.admin.id);
      expect([owner?.code, admin?.code].sort()).toEqual(["A-0001", "A-0002"]);
      expect(await profileOf(f.noPerms.id)).toBeNull();

      const again = await ensureAdminAssociateProfiles(db, { apply: true, orgId: ORG });
      expect(again).toEqual([]);
      expect(await db.associate.count({ where: { orgId: ORG } })).toBe(2);
      const audit = await db.auditLog.findFirst({ where: { orgId: ORG, entity: "Associate", entityId: owner!.id } });
      expect(audit?.actorId).toBeNull();
    });

    it("does not touch a plain associate, and skips with a message when there is no grade", async () => {
      const f = await seedFixture(ORG, { grade: false });

      const outcomes = await ensureAdminAssociateProfiles(db, { apply: true, orgId: ORG });

      expect(outcomes.map((o) => o.result)).toEqual(["skipped (no grade)", "skipped (no grade)"]);
      expect(await db.associate.count({ where: { orgId: ORG } })).toBe(0);
      void f;
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
    const adminProfile = await db.associate.findUniqueOrThrow({ where: { userId: created.userId } });

    await updateUserRoles(db, { userId: created.userId, roleCode: "ASSOCIATE", audit: ctx(ORG, f.owner.id, "owner") });

    // The profile the admin already had is the one they keep, not a second one.
    expect((await db.associate.findUniqueOrThrow({ where: { userId: created.userId } })).id).toBe(adminProfile.id);
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

// The client holds Super Admin and may use any address. Everyone else needs a
// company one, and the list is server configuration the client cannot edit.
describe("createUser: company email domains", () => {
  it.each(["ADMIN", "ASSOCIATE"] as const)("refuses a %s on a non-company address and leaves no trace", async (roleCode) => {
    const f = await seedFixture();
    // The owner may create either role, so the address is the only thing in the way.
    await expect(
      createUser(db, { email: "boss@gmail.com", name: "Boss", roleCode, audit: ctx(ORG, f.owner.id, "owner") }),
    ).rejects.toThrow('"gmail.com" is not allowed; use an address at: test.local.');

    expect(await db.user.count({ where: { orgId: ORG, email: "boss@gmail.com" } })).toBe(0);
    expect(await db.auditLog.count({ where: { orgId: ORG, entity: "User", action: "CREATE" } })).toBe(0);
    expect(await db.associate.count({ where: { orgId: ORG } })).toBe(0);
    expect(mail.sent).toEqual([]);
  });

  it("refuses an Associate on a non-company address when an Admin is the one creating it", async () => {
    const f = await seedFixture();
    await expect(
      createUser(db, { email: "seller@gmail.com", name: "Seller", roleCode: "ASSOCIATE", audit: ctx(ORG, f.admin.id, "admin") }),
    ).rejects.toThrow(EmailDomainNotAllowedError);
  });

  it("lets a Super Admin be created on any address, as the client's own account", async () => {
    const f = await seedFixture();
    const result = await createUser(db, {
      email: "Client@Gmail.com", name: "Client", roleCode: "SUPER_ADMIN", audit: ctx(ORG, f.owner.id, "owner"),
    });

    expect(result.email).toBe("client@gmail.com");
    expect(await rolesOf(result.userId)).toEqual(["SUPER_ADMIN"]);
    expect(mail.sent.map((m) => m.to)).toEqual(["client@gmail.com"]);
  });

  it("takes any listed domain, and not a subdomain of one", async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = "test.local, example.org";
    const f = await seedFixture();
    const audit = ctx(ORG, f.owner.id, "owner");

    await createUser(db, { email: "a@example.org", name: "A", roleCode: "ASSOCIATE", audit });
    await createUser(db, { email: "b@test.local", name: "B", roleCode: "ASSOCIATE", audit });
    await expect(
      createUser(db, { email: "c@mail.example.org", name: "C", roleCode: "ASSOCIATE", audit }),
    ).rejects.toThrow(EmailDomainNotAllowedError);
  });

  const UNUSABLE: [label: string, value: string | undefined][] = [
    ["unset", undefined],
    ["empty", ""],
    ["malformed", "*.test.local"],
  ];
  it.each(UNUSABLE)("refuses Admin and Associate accounts when the setting is %s, but not a Super Admin", async (_label, value) => {
    if (value === undefined) delete process.env.ALLOWED_EMAIL_DOMAINS;
    else process.env.ALLOWED_EMAIL_DOMAINS = value;
    const f = await seedFixture();
    const audit = ctx(ORG, f.owner.id, "owner");

    for (const roleCode of ["ADMIN", "ASSOCIATE"] as const) {
      await expect(createUser(db, { email: "a@test.local", name: "A", roleCode, audit })).rejects.toThrow(
        EmailDomainsNotConfiguredError,
      );
    }
    expect(await db.user.count({ where: { orgId: ORG, email: "a@test.local" } })).toBe(0);

    await expect(
      createUser(db, { email: "boss@test.local", name: "Boss", roleCode: "SUPER_ADMIN", audit }),
    ).resolves.toMatchObject({ email: "boss@test.local" });
  });

  it("reports a missing permission before the address", async () => {
    const f = await seedFixture();
    await expect(
      createUser(db, { email: "x@gmail.com", name: "X", roleCode: "ASSOCIATE", audit: ctx(ORG, f.noPerms.id, "noperms") }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      createUser(db, { email: "x@gmail.com", name: "X", roleCode: "ADMIN", audit: ctx(ORG, f.admin.id, "admin") }),
    ).rejects.toThrow("Only a Super Admin");
  });
});

// Moving an account to another role does not change its address, so only the one
// move that would be a way round the rule is checked: Super Admin to anything else.
describe("updateUserRoles: company email domains", () => {
  async function clientOnGmail(f: Awaited<ReturnType<typeof seedFixture>>) {
    return createUser(db, {
      email: "client@gmail.com", name: "Client", roleCode: "SUPER_ADMIN", audit: ctx(ORG, f.owner.id, "owner"),
    });
  }

  it.each(["ADMIN", "ASSOCIATE"] as const)("refuses to turn a Super Admin on a non-company address into a %s", async (roleCode) => {
    const f = await seedFixture();
    const client = await clientOnGmail(f);
    await createSession(db, client.userId, {});

    await expect(
      updateUserRoles(db, { userId: client.userId, roleCode, audit: ctx(ORG, f.owner.id, "owner") }),
    ).rejects.toThrow(EmailDomainNotAllowedError);

    expect(await rolesOf(client.userId)).toEqual(["SUPER_ADMIN"]);
    expect((await db.session.findMany({ where: { userId: client.userId } })).every((s) => s.revokedAt === null)).toBe(true);
    expect(await db.auditLog.count({ where: { orgId: ORG, entity: "User", entityId: client.userId, action: "UPDATE" } })).toBe(0);
  });

  it.each(["ADMIN", "ASSOCIATE"] as const)("lets a Super Admin on a company address become a %s", async (roleCode) => {
    const f = await seedFixture();
    const second = await createUser(db, {
      email: "second@test.local", name: "Second", roleCode: "SUPER_ADMIN", audit: ctx(ORG, f.owner.id, "owner"),
    });

    await updateUserRoles(db, { userId: second.userId, roleCode, audit: ctx(ORG, f.owner.id, "owner") });

    expect(await rolesOf(second.userId)).toEqual([roleCode]);
  });

  it("refuses the move while the setting is unusable, even for a company address", async () => {
    const f = await seedFixture();
    const second = await createUser(db, {
      email: "second@test.local", name: "Second", roleCode: "SUPER_ADMIN", audit: ctx(ORG, f.owner.id, "owner"),
    });
    delete process.env.ALLOWED_EMAIL_DOMAINS;

    await expect(
      updateUserRoles(db, { userId: second.userId, roleCode: "ADMIN", audit: ctx(ORG, f.owner.id, "owner") }),
    ).rejects.toThrow(EmailDomainsNotConfiguredError);
    expect(await rolesOf(second.userId)).toEqual(["SUPER_ADMIN"]);
  });

  it("does not check moves between Admin and Associate, or a move up to Super Admin", async () => {
    const f = await seedFixture();
    // An account that pre-dates the rule can sit on any address.
    const old = await db.user.create({ data: { orgId: ORG, email: "old@gmail.com", name: "Old", passwordHash: "x", status: "ACTIVE" } });
    const associate = await db.role.findUniqueOrThrow({ where: { orgId_code: { orgId: ORG, code: "ASSOCIATE" } } });
    await db.userRole.create({ data: { userId: old.id, roleId: associate.id } });
    const audit = ctx(ORG, f.owner.id, "owner");

    for (const roleCode of ["ADMIN", "ASSOCIATE", "SUPER_ADMIN"] as const) {
      await updateUserRoles(db, { userId: old.id, roleCode, audit });
      expect(await rolesOf(old.id)).toEqual([roleCode]);
    }
  });

  it("does nothing when a Super Admin on a non-company address is re-submitted as Super Admin", async () => {
    const f = await seedFixture();
    const client = await clientOnGmail(f);

    await expect(
      updateUserRoles(db, { userId: client.userId, roleCode: "SUPER_ADMIN", audit: ctx(ORG, f.owner.id, "owner") }),
    ).resolves.toBeUndefined();
    expect(await rolesOf(client.userId)).toEqual(["SUPER_ADMIN"]);
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

// ── Edit, disable and delete ───────────────────────────────────────────────

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

const asOwner = (f: Fixture) => ctx(ORG, f.owner.id, "owner");
const asAdmin = (f: Fixture) => ctx(ORG, f.admin.id, "admin");

/** An account made through the screen's own path: INVITED, never signed in, with
 *  its associate profile. */
const makeUser = (f: Fixture, email: string, roleCode: "SUPER_ADMIN" | "ADMIN" | "ASSOCIATE" = "ASSOCIATE", name = "Person") =>
  createUser(db, { email, name, roleCode, audit: asOwner(f) });

/** Someone holding rbac.manage through a role that is not SUPER_ADMIN, so the actor is
 *  never the account being touched and it is the guard on the last Super Admin that
 *  stops the change. */
async function opsActor() {
  const role = await db.role.create({ data: { orgId: ORG, code: "OPS", name: "Ops" } });
  const permission = await db.permission.findUniqueOrThrow({ where: { code: "rbac.manage" } });
  await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  const ops = await db.user.create({ data: { orgId: ORG, email: "ops@test.local", name: "Ops", passwordHash: "x" } });
  await db.userRole.create({ data: { userId: ops.id, roleId: role.id } });
  return ops;
}

const auditRows = (userId: string, action: "UPDATE" | "DELETE") =>
  db.auditLog.findMany({ where: { entity: "User", entityId: userId, action } });

describe("updateUser", () => {
  it("changes the name and the address, stores the address lower-case and audits before and after", async () => {
    const f = await seedFixture();
    const person = await makeUser(f, "old.address@test.local", "ASSOCIATE", "Old Name");

    const result = await updateUser(db, {
      userId: person.userId, name: "  New Name ", email: " New.Address@Test.Local ", audit: asOwner(f),
    });

    expect(result).toEqual({ userId: person.userId, name: "New Name", email: "new.address@test.local", changed: true, emailChanged: true });
    expect(await db.user.findUniqueOrThrow({ where: { id: person.userId } })).toMatchObject({
      name: "New Name",
      email: "new.address@test.local",
    });
    const [row] = await auditRows(person.userId, "UPDATE");
    expect(row?.before).toEqual({ name: "Old Name", email: "old.address@test.local" });
    expect(row?.after).toEqual({ name: "New Name", email: "new.address@test.local" });
  });

  it("does not sign the person out or touch their password", async () => {
    const f = await seedFixture();
    const person = await makeUser(f, "p@test.local");
    await createSession(db, person.userId, {});
    const before = await db.user.findUniqueOrThrow({ where: { id: person.userId } });

    await updateUser(db, { userId: person.userId, name: "Renamed", email: "q@test.local", audit: asOwner(f) });

    expect((await db.session.findMany({ where: { userId: person.userId } })).every((s) => s.revokedAt === null)).toBe(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: person.userId } })).passwordHash).toBe(before.passwordHash);
  });

  it("lets the name be corrected on an account whose address pre-dates the company list", async () => {
    const f = await seedFixture();
    // Made before the rule, on any address. The address is left alone, so it is not checked.
    const old = await db.user.create({ data: { orgId: ORG, email: "old@gmail.com", name: "Typo Nme", passwordHash: "x", status: "ACTIVE" } });
    const associate = await db.role.findUniqueOrThrow({ where: { orgId_code: { orgId: ORG, code: "ASSOCIATE" } } });
    await db.userRole.create({ data: { userId: old.id, roleId: associate.id } });

    const result = await updateUser(db, { userId: old.id, name: "Typo Name", email: "OLD@gmail.com", audit: asOwner(f) });

    expect(result).toMatchObject({ changed: true, emailChanged: false, email: "old@gmail.com" });
    expect((await db.user.findUniqueOrThrow({ where: { id: old.id } })).name).toBe("Typo Name");
  });

  it.each(["ADMIN", "ASSOCIATE"] as const)("refuses a new address off the company list on a %s, and leaves the account alone", async (roleCode) => {
    const f = await seedFixture();
    const person = await makeUser(f, "p@test.local", roleCode);

    await expect(
      updateUser(db, { userId: person.userId, name: "Changed", email: "p@gmail.com", audit: asOwner(f) }),
    ).rejects.toThrow('"gmail.com" is not allowed; use an address at: test.local.');

    expect(await db.user.findUniqueOrThrow({ where: { id: person.userId } })).toMatchObject({ name: "Person", email: "p@test.local" });
    expect(await auditRows(person.userId, "UPDATE")).toEqual([]);
  });

  it("lets a Super Admin's address be anything", async () => {
    const f = await seedFixture();
    const boss = await makeUser(f, "boss@test.local", "SUPER_ADMIN");

    await updateUser(db, { userId: boss.userId, name: "Boss", email: "boss@gmail.com", audit: asOwner(f) });

    expect((await db.user.findUniqueOrThrow({ where: { id: boss.userId } })).email).toBe("boss@gmail.com");
  });

  it("checks the address only when it changes: an unusable setting does not stop a name edit", async () => {
    const f = await seedFixture();
    const person = await makeUser(f, "p@test.local");
    delete process.env.ALLOWED_EMAIL_DOMAINS;

    await expect(
      updateUser(db, { userId: person.userId, name: "Renamed", email: "p@test.local", audit: asOwner(f) }),
    ).resolves.toMatchObject({ changed: true, emailChanged: false });
    await expect(
      updateUser(db, { userId: person.userId, name: "Renamed", email: "q@test.local", audit: asOwner(f) }),
    ).rejects.toThrow(EmailDomainsNotConfiguredError);
  });

  it("refuses an address another account already has, whatever its case", async () => {
    const f = await seedFixture();
    await makeUser(f, "one@test.local");
    const two = await makeUser(f, "two@test.local");

    await expect(
      updateUser(db, { userId: two.userId, name: "Person", email: "ONE@test.local", audit: asOwner(f) }),
    ).rejects.toThrow(DuplicateEmailError);
    expect((await db.user.findUniqueOrThrow({ where: { id: two.userId } })).email).toBe("two@test.local");
  });

  it("rejects an empty name and a malformed address", async () => {
    const f = await seedFixture();
    const person = await makeUser(f, "p@test.local");
    await expect(
      updateUser(db, { userId: person.userId, name: "   ", email: "p@test.local", audit: asOwner(f) }),
    ).rejects.toThrow(InvalidUserInputError);
    await expect(
      updateUser(db, { userId: person.userId, name: "Person", email: "not-an-email", audit: asOwner(f) }),
    ).rejects.toThrow(InvalidUserInputError);
  });

  it("does nothing, and writes no audit row, when nothing changed", async () => {
    const f = await seedFixture();
    const person = await makeUser(f, "p@test.local");

    const result = await updateUser(db, { userId: person.userId, name: " Person ", email: "P@test.local", audit: asOwner(f) });

    expect(result).toMatchObject({ changed: false, emailChanged: false });
    expect(await auditRows(person.userId, "UPDATE")).toEqual([]);
  });

  describe("the privilege ceiling", () => {
    it("lets an ADMIN edit an associate", async () => {
      const f = await seedFixture();
      const person = await makeUser(f, "p@test.local");
      await updateUser(db, { userId: person.userId, name: "By Admin", email: "p2@test.local", audit: asAdmin(f) });
      expect(await db.user.findUniqueOrThrow({ where: { id: person.userId } })).toMatchObject({ name: "By Admin", email: "p2@test.local" });
    });

    it("stops an ADMIN editing an admin or a super admin", async () => {
      const f = await seedFixture();
      const boss = await makeUser(f, "boss@test.local", "ADMIN");
      for (const userId of [boss.userId, f.owner.id]) {
        await expect(
          updateUser(db, { userId, name: "Changed", email: "changed@test.local", audit: asAdmin(f) }),
        ).rejects.toThrow("Only a Super Admin");
      }
    });

    it("refuses a user without user-management permission, a system actor, another org's user and an unknown user", async () => {
      const f = await seedFixture();
      const other = await seedFixture(OTHER_ORG);
      const person = await makeUser(f, "p@test.local");
      const foreign = await createUser(db, {
        email: "foreign@test.local", name: "Foreign", roleCode: "ASSOCIATE", audit: ctx(OTHER_ORG, other.owner.id, "owner"),
      });
      const edit = (userId: string, audit: AuditContext) => updateUser(db, { userId, name: "Changed", email: "changed@test.local", audit });

      await expect(edit(person.userId, ctx(ORG, f.noPerms.id, "noperms"))).rejects.toThrow(ForbiddenError);
      await expect(edit(person.userId, ctx(ORG, null, "system"))).rejects.toThrow(ForbiddenError);
      await expect(edit(foreign.userId, asOwner(f))).rejects.toThrow(ForbiddenError);
      await expect(edit("nope", asOwner(f))).rejects.toThrow(UserNotFoundError);
    });
  });
});

describe("setUserDisabled", () => {
  it("disables an account: status DISABLED, every session of theirs ended, the change audited", async () => {
    const f = await seedFixture();
    const person = await makeUser(f, "p@test.local");
    await createSession(db, person.userId, {});
    await createSession(db, person.userId, {});
    await createSession(db, f.admin.id, {});

    const result = await setUserDisabled(db, { userId: person.userId, disabled: true, audit: asOwner(f) });

    expect(result).toMatchObject({ userId: person.userId, status: "DISABLED", changed: true });
    expect((await db.user.findUniqueOrThrow({ where: { id: person.userId } })).status).toBe("DISABLED");
    const theirs = await db.session.findMany({ where: { userId: person.userId } });
    expect(theirs).toHaveLength(2);
    expect(theirs.every((s) => s.revokedAt !== null)).toBe(true);
    expect((await db.session.findMany({ where: { userId: f.admin.id } })).every((s) => s.revokedAt === null)).toBe(true);
    const [row] = await auditRows(person.userId, "UPDATE");
    expect(row?.before).toEqual({ status: "INVITED" });
    expect(row?.after).toEqual({ status: "DISABLED" });
  });

  it("keeps everything else about the account, its associate profile included", async () => {
    const f = await seedFixture();
    const person = await makeUser(f, "p@test.local");
    const before = await db.associate.findUniqueOrThrow({ where: { userId: person.userId } });

    await setUserDisabled(db, { userId: person.userId, disabled: true, audit: asOwner(f) });

    expect(await rolesOf(person.userId)).toEqual(["ASSOCIATE"]);
    expect((await db.associate.findUniqueOrThrow({ where: { userId: person.userId } })).id).toBe(before.id);
  });

  it("stops the account signing in, and lets it sign in again once enabled", async () => {
    const f = await seedFixture();
    const person = await makeUser(f, "p@test.local");

    await setUserDisabled(db, { userId: person.userId, disabled: true, audit: asOwner(f) });
    await expect(attemptLogin(db, "p@test.local", ORG, person.temporaryPassword)).rejects.toThrow(AccountDisabledError);

    await setUserDisabled(db, { userId: person.userId, disabled: false, audit: asOwner(f) });
    await expect(attemptLogin(db, "p@test.local", ORG, person.temporaryPassword)).resolves.toMatchObject({ user: { id: person.userId } });
  });

  it("enables an account back to INVITED while it has a temporary password, ACTIVE once it has its own", async () => {
    const f = await seedFixture();
    const person = await makeUser(f, "p@test.local");

    await setUserDisabled(db, { userId: person.userId, disabled: true, audit: asOwner(f) });
    const invited = await setUserDisabled(db, { userId: person.userId, disabled: false, audit: asOwner(f) });
    expect(invited).toMatchObject({ status: "INVITED", changed: true });

    await db.user.update({ where: { id: person.userId }, data: { status: "ACTIVE", mustChangePassword: false } });
    await setUserDisabled(db, { userId: person.userId, disabled: true, audit: asOwner(f) });
    const active = await setUserDisabled(db, { userId: person.userId, disabled: false, audit: asOwner(f) });
    expect(active).toMatchObject({ status: "ACTIVE", changed: true });
  });

  it("treats a SUSPENDED account as switched off too, and enabling it brings it back", async () => {
    const f = await seedFixture();
    const person = await makeUser(f, "p@test.local");
    await db.user.update({ where: { id: person.userId }, data: { status: "SUSPENDED" } });

    expect(await setUserDisabled(db, { userId: person.userId, disabled: true, audit: asOwner(f) })).toMatchObject({ status: "SUSPENDED", changed: false });
    expect(await setUserDisabled(db, { userId: person.userId, disabled: false, audit: asOwner(f) })).toMatchObject({ status: "INVITED", changed: true });
  });

  it("does nothing, and writes no audit row, when the account is already in the state asked for", async () => {
    const f = await seedFixture();
    const person = await makeUser(f, "p@test.local");

    expect(await setUserDisabled(db, { userId: person.userId, disabled: false, audit: asOwner(f) })).toMatchObject({ changed: false });
    await setUserDisabled(db, { userId: person.userId, disabled: true, audit: asOwner(f) });
    expect(await setUserDisabled(db, { userId: person.userId, disabled: true, audit: asOwner(f) })).toMatchObject({ status: "DISABLED", changed: false });

    expect(await auditRows(person.userId, "UPDATE")).toHaveLength(1);
  });

  it("stops anyone disabling themselves", async () => {
    const f = await seedFixture();
    await makeUser(f, "second@test.local", "SUPER_ADMIN");
    await expect(setUserDisabled(db, { userId: f.owner.id, disabled: true, audit: asOwner(f) })).rejects.toThrow(SelfDisableError);
  });

  it("keeps the last Super Admin who can sign in: a disabled one does not count as another", async () => {
    const f = await seedFixture();
    const ops = await opsActor();
    const second = await makeUser(f, "second@test.local", "SUPER_ADMIN");
    const byOps = ctx(ORG, ops.id, "ops");

    // Two can sign in: either may go.
    await setUserDisabled(db, { userId: second.userId, disabled: true, audit: byOps });
    // One is left, and it cannot be switched off, or demoted, or deleted.
    await expect(setUserDisabled(db, { userId: f.owner.id, disabled: true, audit: byOps })).rejects.toThrow(LastSuperAdminError);
    await expect(updateUserRoles(db, { userId: f.owner.id, roleCode: "ADMIN", audit: byOps })).rejects.toThrow(LastSuperAdminError);
    await expect(deleteUser(db, { userId: f.owner.id, audit: byOps })).rejects.toThrow(LastSuperAdminError);
    expect((await db.user.findUniqueOrThrow({ where: { id: f.owner.id } })).status).toBe("ACTIVE");
  });

  describe("the privilege ceiling", () => {
    it("lets an ADMIN disable and enable an associate", async () => {
      const f = await seedFixture();
      const person = await makeUser(f, "p@test.local");
      await setUserDisabled(db, { userId: person.userId, disabled: true, audit: asAdmin(f) });
      expect((await db.user.findUniqueOrThrow({ where: { id: person.userId } })).status).toBe("DISABLED");
      await setUserDisabled(db, { userId: person.userId, disabled: false, audit: asAdmin(f) });
      expect((await db.user.findUniqueOrThrow({ where: { id: person.userId } })).status).toBe("INVITED");
    });

    it("stops an ADMIN disabling an admin or a super admin", async () => {
      const f = await seedFixture();
      const boss = await makeUser(f, "boss@test.local", "ADMIN");
      for (const userId of [boss.userId, f.owner.id]) {
        await expect(setUserDisabled(db, { userId, disabled: true, audit: asAdmin(f) })).rejects.toThrow("Only a Super Admin");
      }
    });

    it("refuses a user without user-management permission, a system actor, another org's user and an unknown user", async () => {
      const f = await seedFixture();
      const other = await seedFixture(OTHER_ORG);
      const person = await makeUser(f, "p@test.local");
      const foreign = await createUser(db, {
        email: "foreign@test.local", name: "Foreign", roleCode: "ASSOCIATE", audit: ctx(OTHER_ORG, other.owner.id, "owner"),
      });
      const disable = (userId: string, audit: AuditContext) => setUserDisabled(db, { userId, disabled: true, audit });

      await expect(disable(person.userId, ctx(ORG, f.noPerms.id, "noperms"))).rejects.toThrow(ForbiddenError);
      await expect(disable(person.userId, ctx(ORG, null, "system"))).rejects.toThrow(ForbiddenError);
      await expect(disable(foreign.userId, asOwner(f))).rejects.toThrow(ForbiddenError);
      await expect(disable("nope", asOwner(f))).rejects.toThrow(UserNotFoundError);
    });
  });
});

describe("deleteUser", () => {
  it.each(["ASSOCIATE", "ADMIN"] as const)("deletes a %s who never signed in, with their profile, and keeps the audit trail", async (roleCode) => {
    const f = await seedFixture();
    const person = await makeUser(f, "p@test.local", roleCode, "Typo Person");

    const result = await deleteUser(db, { userId: person.userId, audit: asOwner(f) });

    expect(result).toEqual({ userId: person.userId, email: "p@test.local" });
    expect(await db.user.count({ where: { id: person.userId } })).toBe(0);
    expect(await db.userRole.count({ where: { userId: person.userId } })).toBe(0);
    expect(await db.associate.count({ where: { userId: person.userId } })).toBe(0);
    const [row] = await auditRows(person.userId, "DELETE");
    expect(row?.before).toMatchObject({ email: "p@test.local", name: "Typo Person", roleCodes: [roleCode] });
    // The address is free again.
    await expect(makeUser(f, "p@test.local")).resolves.toMatchObject({ email: "p@test.local" });
  });

  it("refuses an account that has signed in, and deletes nothing", async () => {
    const f = await seedFixture();
    const person = await makeUser(f, "p@test.local");
    await db.user.update({ where: { id: person.userId }, data: { lastLoginAt: new Date() } });

    await expect(deleteUser(db, { userId: person.userId, audit: asOwner(f) })).rejects.toThrow(
      "p@test.local has signed in before, so it cannot be deleted. Disable it instead.",
    );
    expect(await db.user.count({ where: { id: person.userId } })).toBe(1);
    expect(await auditRows(person.userId, "DELETE")).toEqual([]);
  });

  it("refuses an account with activity on its associate profile, and rolls everything back", async () => {
    const f = await seedFixture();
    const person = await makeUser(f, "p@test.local");
    const associate = await db.associate.findUniqueOrThrow({ where: { userId: person.userId } });
    await db.lead.create({
      data: { orgId: ORG, name: "Buyer", phone: "+919876543210", phoneHash: "hash", source: "WALK_IN", assignedAssociateId: associate.id },
    });

    await expect(deleteUser(db, { userId: person.userId, audit: asOwner(f) })).rejects.toThrow(UserInUseError);

    // The grade row and the profile were deleted first inside the transaction: they are back.
    expect(await db.user.count({ where: { id: person.userId } })).toBe(1);
    expect(await db.associate.count({ where: { userId: person.userId } })).toBe(1);
    expect(await db.associateGrade.count({ where: { associateId: associate.id } })).toBe(1);
    expect(await auditRows(person.userId, "DELETE")).toEqual([]);
  });

  it("refuses an account that has associates placed under it, instead of quietly detaching them", async () => {
    const f = await seedFixture();
    const person = await makeUser(f, "p@test.local");
    const child = await makeUser(f, "child@test.local");
    const parentProfile = await db.associate.findUniqueOrThrow({ where: { userId: person.userId } });
    const childProfile = await db.associate.findUniqueOrThrow({ where: { userId: child.userId } });
    await db.associateHierarchy.create({
      data: { associateId: childProfile.id, parentId: parentProfile.id, path: `/${parentProfile.id}/`, depth: 1, validFrom: new Date() },
    });

    await expect(deleteUser(db, { userId: person.userId, audit: asOwner(f) })).rejects.toThrow(UserInUseError);

    expect((await db.associateHierarchy.findFirstOrThrow({ where: { associateId: childProfile.id } })).parentId).toBe(parentProfile.id);
    expect(await db.user.count({ where: { id: person.userId } })).toBe(1);
  });

  it("knows every relation that detaches or cascades instead of refusing", async () => {
    // deleteUser leaves it to the database to refuse a delete when something points at the
    // account, except where the schema says otherwise. This lists those exceptions. A new one
    // fails here, so deleteUser gets changed to look at it before it can detach something quietly.
    const schema = readFileSync(join(__dirname, "../../db/prisma/schema.prisma"), "utf8");
    const exceptions: string[] = [];
    let model = "";
    for (const line of schema.split(/\r?\n/)) {
      const declared = /^model\s+(\w+)/.exec(line);
      if (declared) {
        model = declared[1]!;
        continue;
      }
      const relation = /^\s*(\w+)\s+(Associate|User)(\?)?\s+@relation\(/.exec(line);
      if (!relation) continue;
      const action = /onDelete:\s*(\w+)/.exec(line)?.[1] ?? (relation[3] ? "SetNull" : "Restrict");
      if (action !== "Restrict" && action !== "NoAction") exceptions.push(`${model}.${relation[1]} -> ${relation[2]} (${action})`);
    }

    expect(exceptions.sort()).toEqual([
      "AssociateHierarchy.parent -> Associate (SetNull)",
      "Lead.associate -> Associate (SetNull)",
      "LeadActivity.associate -> Associate (SetNull)",
      "PasswordResetToken.user -> User (Cascade)",
      "Session.user -> User (Cascade)",
      "UserRole.user -> User (Cascade)",
    ]);
  });

  it("refuses an account that owns a saved report view", async () => {
    const f = await seedFixture();
    const person = await makeUser(f, "p@test.local");
    await db.savedReportView.create({ data: { orgId: ORG, userId: person.userId, reportKey: "sales", name: "Mine" } });

    await expect(deleteUser(db, { userId: person.userId, audit: asOwner(f) })).rejects.toThrow(UserInUseError);

    expect(await db.user.count({ where: { id: person.userId } })).toBe(1);
    expect(await db.associate.count({ where: { userId: person.userId } })).toBe(1);
  });

  it("refuses an account whose associate profile has a grade history", async () => {
    const f = await seedFixture();
    const person = await makeUser(f, "p@test.local");
    const associate = await db.associate.findUniqueOrThrow({ where: { userId: person.userId } });
    const senior = await db.grade.findFirstOrThrow({ where: { orgId: ORG, code: "G2" } });
    await db.associateGrade.create({ data: { associateId: associate.id, gradeId: senior.id, validFrom: new Date() } });

    await expect(deleteUser(db, { userId: person.userId, audit: asOwner(f) })).rejects.toThrow("has a grade history");
    expect(await db.associateGrade.count({ where: { associateId: associate.id } })).toBe(2);
  });

  it("stops anyone deleting themselves", async () => {
    const f = await seedFixture();
    await makeUser(f, "second@test.local", "SUPER_ADMIN");
    await expect(deleteUser(db, { userId: f.owner.id, audit: asOwner(f) })).rejects.toThrow(SelfDeleteError);
  });

  describe("the privilege ceiling", () => {
    it("lets an ADMIN delete an associate", async () => {
      const f = await seedFixture();
      const person = await makeUser(f, "p@test.local");
      await deleteUser(db, { userId: person.userId, audit: asAdmin(f) });
      expect(await db.user.count({ where: { id: person.userId } })).toBe(0);
    });

    it("stops an ADMIN deleting an admin or a super admin", async () => {
      const f = await seedFixture();
      const boss = await makeUser(f, "boss@test.local", "ADMIN");
      for (const userId of [boss.userId, f.owner.id]) {
        await expect(deleteUser(db, { userId, audit: asAdmin(f) })).rejects.toThrow("Only a Super Admin");
        expect(await db.user.count({ where: { id: userId } })).toBe(1);
      }
    });

    it("refuses a user without user-management permission, a system actor, another org's user and an unknown user", async () => {
      const f = await seedFixture();
      const other = await seedFixture(OTHER_ORG);
      const person = await makeUser(f, "p@test.local");
      const foreign = await createUser(db, {
        email: "foreign@test.local", name: "Foreign", roleCode: "ASSOCIATE", audit: ctx(OTHER_ORG, other.owner.id, "owner"),
      });

      await expect(deleteUser(db, { userId: person.userId, audit: ctx(ORG, f.noPerms.id, "noperms") })).rejects.toThrow(ForbiddenError);
      await expect(deleteUser(db, { userId: person.userId, audit: ctx(ORG, null, "system") })).rejects.toThrow(ForbiddenError);
      await expect(deleteUser(db, { userId: foreign.userId, audit: asOwner(f) })).rejects.toThrow(ForbiddenError);
      await expect(deleteUser(db, { userId: "nope", audit: asOwner(f) })).rejects.toThrow(UserNotFoundError);
      expect(await db.user.count({ where: { id: { in: [person.userId, foreign.userId] } } })).toBe(2);
    });
  });
});

describe("listUsers: search", () => {
  async function people() {
    const f = await seedFixture();
    await makeUser(f, "ana.rao@test.local", "ASSOCIATE", "Ana Rao");
    await makeUser(f, "bob@test.local", "ASSOCIATE", "Bob Stone");
    await makeUser(f, "a_b@test.local", "ASSOCIATE", "Underscore");
    await makeUser(f, "axb@test.local", "ASSOCIATE", "Letter X");
    return f;
  }
  const found = async (f: Fixture, search: string, actorId = f.owner.id) =>
    (await listUsers(db, { orgId: ORG, actorId, search })).map((u) => u.email);

  it("finds an account by part of its name or of its email, whatever the case", async () => {
    const f = await people();
    expect(await found(f, "RAO")).toEqual(["ana.rao@test.local"]);
    expect(await found(f, "  stone ")).toEqual(["bob@test.local"]);
    expect(await found(f, "ANA.R")).toEqual(["ana.rao@test.local"]);
    expect(await found(f, "bob@test")).toEqual(["bob@test.local"]);
  });

  it("takes % and _ as the characters they are, not as wildcards", async () => {
    const f = await people();
    expect(await found(f, "a_b")).toEqual(["a_b@test.local"]);
    expect(await found(f, "%")).toEqual([]);
  });

  it("lists everyone for an empty or blank search", async () => {
    const f = await people();
    const everyone = (await listUsers(db, { orgId: ORG, actorId: f.owner.id })).map((u) => u.email);
    expect(await found(f, "")).toEqual(everyone);
    expect(await found(f, "   ")).toEqual(everyone);
  });

  it("cuts a very long search instead of failing on it", async () => {
    const f = await people();
    expect(await found(f, "x".repeat(500))).toEqual([]);
    // Cut to 100 characters: the first 100 match nobody, the rest never reaches the database.
    expect(await found(f, `bob@test.local${"z".repeat(500)}`)).toEqual([]);
  });

  it("never lets an ADMIN's search reach an admin or a super admin", async () => {
    const f = await people();
    expect(await found(f, "owner", f.admin.id)).toEqual([]);
    expect(await found(f, "admin", f.admin.id)).toEqual([]);
    expect(await found(f, "bob", f.admin.id)).toEqual(["bob@test.local"]);
  });
});

describe("getUser", () => {
  it("returns the account with its detail", async () => {
    const f = await seedFixture();
    const person = await makeUser(f, "p@test.local", "ASSOCIATE", "Pat Person");

    const user = await getUser(db, { orgId: ORG, actorId: f.owner.id, userId: person.userId });

    expect(user).toMatchObject({
      id: person.userId,
      email: "p@test.local",
      name: "Pat Person",
      status: "INVITED",
      roleCodes: ["ASSOCIATE"],
      lastLoginAt: null,
      mustChangePassword: true,
      associateCode: "A-0001",
    });
    expect(Number.isNaN(Date.parse(user!.createdAt))).toBe(false);
  });

  it("shows an ADMIN an associate but not an admin, a super admin, another org's account or a stranger", async () => {
    const f = await seedFixture();
    const other = await seedFixture(OTHER_ORG);
    const person = await makeUser(f, "p@test.local");
    const boss = await makeUser(f, "boss@test.local", "ADMIN");
    const foreign = await createUser(db, {
      email: "foreign@test.local", name: "Foreign", roleCode: "ASSOCIATE", audit: ctx(OTHER_ORG, other.owner.id, "owner"),
    });
    const as = (userId: string) => getUser(db, { orgId: ORG, actorId: f.admin.id, userId });

    expect(await as(person.userId)).toMatchObject({ email: "p@test.local" });
    expect(await as(boss.userId)).toBeNull();
    expect(await as(f.owner.id)).toBeNull();
    expect(await as(foreign.userId)).toBeNull();
    expect(await as("nope")).toBeNull();
  });

  it("refuses a user who holds no user-management permission", async () => {
    const f = await seedFixture();
    await expect(getUser(db, { orgId: ORG, actorId: f.noPerms.id, userId: f.owner.id })).rejects.toThrow(ForbiddenError);
  });
});
