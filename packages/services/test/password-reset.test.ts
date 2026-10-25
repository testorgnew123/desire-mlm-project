// Forgot-password links and the forced change at first sign-in. LOCAL Postgres.
// sendEmail is replaced by a recorder, so the reset link a test needs is read
// from the "sent" message exactly as a person would read it from their inbox.
import "dotenv/config";
import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrismaClient } from "@desire/db";
import { createSession } from "../src/auth";
import { hashPassword, verifyPassword } from "../src/password";
import type * as EmailModule from "../src/email";
import {
  InvalidResetTokenError,
  PasswordChangeNotRequiredError,
  RESET_REQUEST_COOLDOWN_SECONDS,
  RESET_TOKEN_TTL_MINUTES,
  WeakPasswordError,
  completeForcedPasswordChange,
  isResetTokenUsable,
  requestPasswordReset,
  resetPasswordWithToken,
} from "../src/password-reset";

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
const ORG = "org_test_pwreset";
const OLD_PASSWORD = "the-old-password-1";
const NEW_PASSWORD = "a-brand-new-password-9";

async function reset() {
  await db.auditLog.deleteMany({ where: { orgId: ORG } });
  await db.user.deleteMany({ where: { orgId: ORG } }); // sessions and tokens cascade
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function makeUser(overrides: Record<string, unknown> = {}) {
  await db.organization.upsert({
    where: { id: ORG },
    update: {},
    create: { id: ORG, name: "Reset Test Org", legalName: "Reset Test Org Pvt Ltd" },
  });
  return db.user.create({
    data: {
      orgId: ORG,
      email: "asha@test.local",
      name: "Asha",
      passwordHash: await hashPassword(OLD_PASSWORD),
      status: "ACTIVE",
      ...overrides,
    },
  });
}

/** The token a person would copy out of the emailed link. */
function tokenFromLastMail(): string {
  const text = mail.sent[mail.sent.length - 1]?.text ?? "";
  const match = /\/login\/reset\?token=([\w-]+)/.exec(text);
  if (!match?.[1]) throw new Error(`no reset link in: ${text}`);
  return match[1];
}

beforeEach(async () => {
  mail.sent.length = 0;
  mail.failWith = null;
  process.env.APP_BASE_URL = "https://app.test";
  await reset();
});
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("requestPasswordReset", () => {
  it("emails a link, stores only the hash of its token, and expires it after 30 minutes", async () => {
    const user = await makeUser();
    const before = Date.now();

    expect(await requestPasswordReset(db, { orgId: ORG, email: "asha@test.local" })).toBe("SENT");

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: "asha@test.local", subject: "Reset your Desire password" });
    expect(mail.sent[0]!.text).toContain("https://app.test/login/reset?token=");
    expect(mail.sent[0]!.text).toContain("expires in 30 minutes");

    const token = tokenFromLastMail();
    const row = await db.passwordResetToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(row.tokenHash).not.toContain(token);
    expect(row.usedAt).toBeNull();
    const lifetime = row.expiresAt.getTime() - before;
    expect(lifetime).toBeGreaterThan((RESET_TOKEN_TTL_MINUTES - 1) * 60_000);
    expect(lifetime).toBeLessThanOrEqual(RESET_TOKEN_TTL_MINUTES * 60_000 + 5_000);
  });

  it("matches the email whatever its case or padding", async () => {
    await makeUser();
    expect(await requestPasswordReset(db, { orgId: ORG, email: "  ASHA@Test.Local " })).toBe("SENT");
  });

  it("does nothing, and sends nothing, for an address nobody has", async () => {
    await makeUser();
    expect(await requestPasswordReset(db, { orgId: ORG, email: "nobody@test.local" })).toBe("NO_SUCH_USER");
    expect(mail.sent).toEqual([]);
    expect(await db.passwordResetToken.count()).toBe(0);
  });

  it.each(["SUSPENDED", "DISABLED"])("does nothing for a %s account", async (status) => {
    await makeUser({ status });
    expect(await requestPasswordReset(db, { orgId: ORG, email: "asha@test.local" })).toBe("NOT_ALLOWED");
    expect(mail.sent).toEqual([]);
  });

  it("creates no token when the app's address is not configured (a link could not be built)", async () => {
    await makeUser();
    delete process.env.APP_BASE_URL;
    expect(await requestPasswordReset(db, { orgId: ORG, email: "asha@test.local" })).toBe("NOT_CONFIGURED");
    expect(await db.passwordResetToken.count()).toBe(0);
  });

  it("allows one request a minute per account", async () => {
    await makeUser();
    expect(await requestPasswordReset(db, { orgId: ORG, email: "asha@test.local" })).toBe("SENT");
    expect(await requestPasswordReset(db, { orgId: ORG, email: "asha@test.local" })).toBe("THROTTLED");
    expect(mail.sent).toHaveLength(1);
  });

  it("voids the earlier link when a new one is issued after the cool-down", async () => {
    const user = await makeUser();
    await requestPasswordReset(db, { orgId: ORG, email: "asha@test.local" });
    const first = tokenFromLastMail();
    await db.passwordResetToken.updateMany({
      where: { userId: user.id },
      data: { createdAt: new Date(Date.now() - (RESET_REQUEST_COOLDOWN_SECONDS + 5) * 1000) },
    });

    expect(await requestPasswordReset(db, { orgId: ORG, email: "asha@test.local" })).toBe("SENT");
    const second = tokenFromLastMail();

    expect(second).not.toBe(first);
    expect(await isResetTokenUsable(db, first)).toBe(false);
    expect(await isResetTokenUsable(db, second)).toBe(true);
  });

  it("reports a mail failure but keeps the link issued", async () => {
    await makeUser();
    mail.failWith = new Error("smtp down");
    expect(await requestPasswordReset(db, { orgId: ORG, email: "asha@test.local" })).toBe("SEND_FAILED");
    expect(await db.passwordResetToken.count()).toBe(1);
  });
});

describe("resetPasswordWithToken", () => {
  async function issue(overrides: Record<string, unknown> = {}) {
    const user = await makeUser(overrides);
    await requestPasswordReset(db, { orgId: ORG, email: "asha@test.local" });
    return { user, token: tokenFromLastMail() };
  }

  it("sets the new password and lets the old one go", async () => {
    const { user, token } = await issue();
    await resetPasswordWithToken(db, { token, newPassword: NEW_PASSWORD });

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(after.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(after.passwordHash, OLD_PASSWORD)).toBe(false);
  });

  it("clears a lockout and a pending forced change, and activates an invited account", async () => {
    const { user, token } = await issue({
      status: "INVITED",
      mustChangePassword: true,
      failedLoginCount: 5,
      lockedUntil: new Date(Date.now() + 600_000),
    });
    await resetPasswordWithToken(db, { token, newPassword: NEW_PASSWORD });

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after).toMatchObject({ status: "ACTIVE", mustChangePassword: false, failedLoginCount: 0, lockedUntil: null });
  });

  it("revokes every session of that user", async () => {
    const { user, token } = await issue();
    await createSession(db, user.id, {});
    await createSession(db, user.id, {});
    await resetPasswordWithToken(db, { token, newPassword: NEW_PASSWORD });

    const sessions = await db.session.findMany({ where: { userId: user.id } });
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
  });

  it("works once: the same link cannot be used twice", async () => {
    const { token } = await issue();
    await resetPasswordWithToken(db, { token, newPassword: NEW_PASSWORD });
    await expect(resetPasswordWithToken(db, { token, newPassword: "another-password-77" })).rejects.toThrow(InvalidResetTokenError);
  });

  it("lets only one of two simultaneous submissions win", async () => {
    const { user, token } = await issue();
    const results = await Promise.allSettled([
      resetPasswordWithToken(db, { token, newPassword: "first-password-1234" }),
      resetPasswordWithToken(db, { token, newPassword: "second-password-1234" }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(InvalidResetTokenError);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    const winner = results[0]!.status === "fulfilled" ? "first-password-1234" : "second-password-1234";
    expect(await verifyPassword(after.passwordHash, winner)).toBe(true);
  });

  it("refuses an expired link", async () => {
    const { token } = await issue();
    await db.passwordResetToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await isResetTokenUsable(db, token)).toBe(false);
    await expect(resetPasswordWithToken(db, { token, newPassword: NEW_PASSWORD })).rejects.toThrow(InvalidResetTokenError);
  });

  it("refuses a made-up token", async () => {
    await makeUser();
    expect(await isResetTokenUsable(db, "made-up")).toBe(false);
    await expect(resetPasswordWithToken(db, { token: "made-up", newPassword: NEW_PASSWORD })).rejects.toThrow(InvalidResetTokenError);
  });

  it("refuses an account suspended after the link was issued", async () => {
    const { user, token } = await issue();
    await db.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } });
    await expect(resetPasswordWithToken(db, { token, newPassword: NEW_PASSWORD })).rejects.toThrow(InvalidResetTokenError);
  });

  it("rejects a weak password without spending the link", async () => {
    const { token } = await issue();
    await expect(resetPasswordWithToken(db, { token, newPassword: "short" })).rejects.toThrow(WeakPasswordError);
    expect(await isResetTokenUsable(db, token)).toBe(true);
    await expect(resetPasswordWithToken(db, { token, newPassword: "x".repeat(129) })).rejects.toThrow(WeakPasswordError);
  });

  it("writes an audit row that never contains the password or the token", async () => {
    const { user, token } = await issue();
    await resetPasswordWithToken(db, { token, newPassword: NEW_PASSWORD });

    const rows = await db.auditLog.findMany({ where: { orgId: ORG, entity: "User", entityId: user.id } });
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain(NEW_PASSWORD);
    expect(text).not.toContain(token);
    expect(rows[0]!.actorId).toBe(user.id);
  });

  it("voids every other unused link of the same user", async () => {
    const { user, token } = await issue();
    await db.passwordResetToken.create({
      data: { userId: user.id, tokenHash: `other-${Date.now()}`, expiresAt: new Date(Date.now() + 600_000) },
    });
    await resetPasswordWithToken(db, { token, newPassword: NEW_PASSWORD });
    expect((await db.passwordResetToken.findMany({ where: { userId: user.id } })).every((t) => t.usedAt !== null)).toBe(true);
  });
});

describe("completeForcedPasswordChange", () => {
  it("replaces the temporary password, clears the flag and activates the account", async () => {
    const user = await makeUser({ status: "INVITED", mustChangePassword: true });
    await completeForcedPasswordChange(db, { userId: user.id, newPassword: NEW_PASSWORD });

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after).toMatchObject({ mustChangePassword: false, status: "ACTIVE" });
    expect(await verifyPassword(after.passwordHash, NEW_PASSWORD)).toBe(true);
  });

  it("refuses an account that is not waiting for a change", async () => {
    const user = await makeUser({ mustChangePassword: false });
    await expect(completeForcedPasswordChange(db, { userId: user.id, newPassword: NEW_PASSWORD })).rejects.toThrow(PasswordChangeNotRequiredError);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(after.passwordHash, OLD_PASSWORD)).toBe(true);
  });

  it("refuses an unknown user", async () => {
    await expect(completeForcedPasswordChange(db, { userId: "nope", newPassword: NEW_PASSWORD })).rejects.toThrow(PasswordChangeNotRequiredError);
  });

  it("refuses to keep the temporary password as the new one", async () => {
    const user = await makeUser({ mustChangePassword: true });
    await expect(completeForcedPasswordChange(db, { userId: user.id, newPassword: OLD_PASSWORD })).rejects.toThrow(/different from the temporary/);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).mustChangePassword).toBe(true);
  });

  it("rejects a weak password", async () => {
    const user = await makeUser({ mustChangePassword: true });
    await expect(completeForcedPasswordChange(db, { userId: user.id, newPassword: "short" })).rejects.toThrow(WeakPasswordError);
  });

  it("works once: a second call finds nothing to change", async () => {
    const user = await makeUser({ mustChangePassword: true });
    await completeForcedPasswordChange(db, { userId: user.id, newPassword: NEW_PASSWORD });
    await expect(completeForcedPasswordChange(db, { userId: user.id, newPassword: "yet-another-pass-1" })).rejects.toThrow(PasswordChangeNotRequiredError);
  });

  it("writes an audit row without the password", async () => {
    const user = await makeUser({ mustChangePassword: true });
    await completeForcedPasswordChange(db, { userId: user.id, newPassword: NEW_PASSWORD });
    const rows = await db.auditLog.findMany({ where: { orgId: ORG, entityId: user.id } });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(NEW_PASSWORD);
  });
});
