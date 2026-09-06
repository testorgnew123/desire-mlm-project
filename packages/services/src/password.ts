// Credential verification: password hashing and the login flow.
//
// Split out of auth.ts deliberately. @node-rs/argon2 is a NATIVE .node addon,
// and webpack cannot parse it -- any module that imports it, directly or
// transitively, fails `next build` with "Module parse failed: Unexpected
// character". validateSession runs on effectively every request, so keeping it
// in the same module as password hashing meant every route that checks a
// session dragged a native binary into its bundle and broke the build.
//
// auth.ts must therefore NEVER import from this file. Login is the only flow
// that needs a password, so attemptLogin lives here with it.
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import type { PrismaClient, User } from "@desire/db";

const FAILED_LOGIN_LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MINUTES = 15;

export class AccountLockedError extends Error {
  constructor(public readonly lockedUntil: Date) {
    super(`Account is locked until ${lockedUntil.toISOString()}.`);
    this.name = "AccountLockedError";
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid email or password.");
    this.name = "InvalidCredentialsError";
  }
}


// ── Passwords ────────────────────────────────────────────────────────────

/** argon2id, per docs/10-SECURITY.md. @node-rs/argon2 defaults to argon2id
 *  with OWASP-recommended parameters -- not overridden here, so a future
 *  library upgrade that revises its safe defaults upward is inherited for
 *  free rather than pinned to today's guess at "good enough". */
export async function hashPassword(plaintext: string): Promise<string> {
  return argon2Hash(plaintext);
}

export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  return argon2Verify(hash, plaintext);
}

// ── Login, with per-account lockout ─────────────────────────────────────
//
// This covers ACCOUNT lockout (schema-backed: User.failedLoginCount /
// lockedUntil). Per-IP rate limiting (docs/10-SECURITY.md: "5 / 15 min per
// IP+account") additionally needs a request-rate store this schema does not
// provide -- deliberately not implemented here rather than faked with an
// in-memory counter that would not survive a serverless cold start or work
// across concurrent function instances. See PROGRESS.md Phase 0 for the open
// item; a Netlify edge rate limit or Upstash-backed counter are the likely
// candidates once this is hosted.

export interface LoginResult {
  user: User;
}

export async function attemptLogin(
  db: PrismaClient,
  email: string,
  orgId: string,
  plaintextPassword: string,
): Promise<LoginResult> {
  const user = await db.user.findUnique({ where: { orgId_email: { orgId, email } } });

  // Same error for "no such user" and "wrong password" -- do not let login
  // reveal whether an email exists in the system.
  if (!user) throw new InvalidCredentialsError();

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AccountLockedError(user.lockedUntil);
  }

  const valid = await verifyPassword(user.passwordHash, plaintextPassword);
  if (!valid) {
    await recordFailedLogin(db, user.id, user.failedLoginCount);
    throw new InvalidCredentialsError();
  }

  await db.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  return { user };
}

async function recordFailedLogin(db: PrismaClient, userId: string, currentCount: number): Promise<void> {
  const newCount = currentCount + 1;
  const shouldLock = newCount >= FAILED_LOGIN_LOCKOUT_THRESHOLD;

  await db.user.update({
    where: { id: userId },
    data: {
      failedLoginCount: newCount,
      ...(shouldLock
        ? { lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MINUTES * 60_000) }
        : {}),
    },
  });
}
