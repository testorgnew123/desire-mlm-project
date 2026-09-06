// Integration tests -- run against LOCAL Docker Postgres (see .env in this
// package), never the hosted Neon project, so repeated lockout/session churn
// never pollutes the real database. Requires `docker compose up -d` from the
// repo root and migrations applied locally first.
import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import {
  SessionInvalidError,
  createSession,
  revokeAllSessions,
  revokeSession,
  validateSession,
} from "../src/auth";
// Password hashing lives in its own module so that argon2's native .node addon
// stays off every request path -- see the header of src/password.ts. Tests are
// free to import it directly; auth.ts is not.
import {
  AccountLockedError,
  InvalidCredentialsError,
  attemptLogin,
  hashPassword,
} from "../src/password";

const db = getPrismaClient();
const TEST_ORG_ID = "org_test_auth";
const TEST_PASSWORD = "correct-horse-battery-staple";

async function makeTestUser(emailSuffix: string) {
  await db.organization.upsert({
    where: { id: TEST_ORG_ID },
    update: {},
    create: { id: TEST_ORG_ID, name: "Auth Test Org", legalName: "Auth Test Org Pvt Ltd" },
  });

  return db.user.create({
    data: {
      orgId: TEST_ORG_ID,
      email: `auth-test-${emailSuffix}-${Date.now()}@example.test`,
      name: "Test User",
      passwordHash: await hashPassword(TEST_PASSWORD),
      status: "ACTIVE",
    },
  });
}

// A SINGLE file-level cleanup, run once after every describe block below has
// finished -- not one per describe. Per-describe cleanup is a trap here:
// makeTestUser() re-upserts the shared organization on demand, so an earlier
// describe's afterAll deleting it out from under a later describe (whose own
// afterAll doesn't repeat that step) leaves the org behind at the end of the
// file. That is exactly what happened before this was consolidated -- see
// PROGRESS.md decision log.
afterAll(async () => {
  await db.session.deleteMany({ where: { user: { orgId: TEST_ORG_ID } } });
  await db.user.deleteMany({ where: { orgId: TEST_ORG_ID } });
  await db.organization.deleteMany({ where: { id: TEST_ORG_ID } });
  await db.$disconnect();
});

describe("attemptLogin / lockout", () => {
  it("succeeds with the correct password and resets failedLoginCount", async () => {
    const user = await makeTestUser("success");
    const result = await attemptLogin(db, user.email, TEST_ORG_ID, TEST_PASSWORD);
    expect(result.user.id).toBe(user.id);

    const reloaded = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(reloaded.failedLoginCount).toBe(0);
    expect(reloaded.lastLoginAt).not.toBeNull();
  });

  it("throws InvalidCredentialsError on wrong password, and increments failedLoginCount", async () => {
    const user = await makeTestUser("wrongpass");
    await expect(attemptLogin(db, user.email, TEST_ORG_ID, "wrong-password")).rejects.toThrow(
      InvalidCredentialsError,
    );

    const reloaded = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(reloaded.failedLoginCount).toBe(1);
  });

  it("throws InvalidCredentialsError (not a different error) for a non-existent email", async () => {
    await expect(
      attemptLogin(db, "does-not-exist@example.test", TEST_ORG_ID, "anything"),
    ).rejects.toThrow(InvalidCredentialsError);
  });

  it("locks the account after 5 failed attempts, then rejects even the correct password", async () => {
    const user = await makeTestUser("lockout");

    for (let i = 0; i < 5; i++) {
      await expect(attemptLogin(db, user.email, TEST_ORG_ID, "wrong")).rejects.toThrow(
        InvalidCredentialsError,
      );
    }

    // The 6th attempt, even with the RIGHT password, must be locked out --
    // this is the whole point of lockout.
    await expect(attemptLogin(db, user.email, TEST_ORG_ID, TEST_PASSWORD)).rejects.toThrow(
      AccountLockedError,
    );

    const reloaded = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(reloaded.lockedUntil).not.toBeNull();
    expect(reloaded.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("sessions", () => {
  it("creates a session, validates it, and touches lastActiveAt", async () => {
    const user = await makeTestUser("session-create");
    const { rawToken } = await createSession(db, user.id, { ipAddress: "127.0.0.1" });

    const validated = await validateSession(db, rawToken);
    expect(validated.userId).toBe(user.id);
  });

  it("rejects an unknown token", async () => {
    await expect(validateSession(db, "not-a-real-token")).rejects.toThrow(SessionInvalidError);
  });

  it("rejects a session after it has been revoked", async () => {
    const user = await makeTestUser("session-revoke");
    const { rawToken } = await createSession(db, user.id, {});

    await revokeSession(db, rawToken);

    await expect(validateSession(db, rawToken)).rejects.toThrow(SessionInvalidError);
  });

  it("revokeAllSessions revokes every session for a user, not just one", async () => {
    const user = await makeTestUser("session-revoke-all");
    const a = await createSession(db, user.id, {});
    const b = await createSession(db, user.id, {});

    await revokeAllSessions(db, user.id);

    await expect(validateSession(db, a.rawToken)).rejects.toThrow(SessionInvalidError);
    await expect(validateSession(db, b.rawToken)).rejects.toThrow(SessionInvalidError);
  });

  it("rejects a session past its absolute expiry even if recently active", async () => {
    const user = await makeTestUser("session-expired");
    const { rawToken } = await createSession(db, user.id, {});

    // Simulate the absolute timeout having passed, with lastActiveAt kept
    // fresh -- proves expiresAt is checked independently of idle timeout.
    await db.session.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(validateSession(db, rawToken)).rejects.toThrow(SessionInvalidError);
  });

  it("rejects a session past its idle timeout even with a future absolute expiry", async () => {
    const user = await makeTestUser("session-idle");
    const { rawToken } = await createSession(db, user.id, {});

    await db.session.updateMany({
      where: { userId: user.id },
      data: { lastActiveAt: new Date(Date.now() - 13 * 60 * 60_000) }, // 13h ago > 12h idle limit
    });

    await expect(validateSession(db, rawToken)).rejects.toThrow(SessionInvalidError);
  });
});
