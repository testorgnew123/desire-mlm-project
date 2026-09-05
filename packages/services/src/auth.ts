// Hand-rolled session auth against the schema as designed, rather than
// Auth.js's Prisma adapter conventions -- see docs/02-ARCHITECTURE.md and
// PROGRESS.md decision log for why. Matches docs/10-SECURITY.md exactly:
// argon2id hashing, httpOnly session cookie backed by a server-side row,
// 12h idle / 7d absolute timeout, per-account lockout after 5 failed
// attempts, server-side revocation on demand.
import { randomBytes, createHash } from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { authenticator } from "otplib";
import type { PrismaClient, Prisma, User } from "@desire/db";
import { decryptField, encryptField } from "./encryption";

const SESSION_TOKEN_BYTES = 32;
const FAILED_LOGIN_LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MINUTES = 15;
const SESSION_IDLE_TIMEOUT_MINUTES = 12 * 60;
const SESSION_ABSOLUTE_TIMEOUT_DAYS = 7;

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

export class SessionInvalidError extends Error {
  constructor(reason: string) {
    super(`Session invalid: ${reason}`);
    this.name = "SessionInvalidError";
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

// ── Sessions ─────────────────────────────────────────────────────────────
//
// The RAW token is what becomes the cookie value and is returned to the
// caller exactly once, at creation. Only its SHA-256 hash is ever persisted
// (Session.tokenHash) -- a database leak must not hand out usable sessions.

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export interface CreatedSession {
  rawToken: string;
  expiresAt: Date;
}

export async function createSession(
  db: PrismaClient,
  userId: string,
  meta: { ipAddress?: string; userAgent?: string },
): Promise<CreatedSession> {
  const rawToken = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_TIMEOUT_DAYS * 24 * 60 * 60_000);

  await db.session.create({
    data: {
      userId,
      tokenHash: hashToken(rawToken),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      expiresAt,
    },
  });

  return { rawToken, expiresAt };
}

/** Validates a raw session token from the cookie. Checks, in order: exists,
 *  not revoked, not past absolute expiry, not idle-timed-out. Touches
 *  lastActiveAt on success -- callers should not call this more than once
 *  per request. */
export async function validateSession(db: PrismaClient, rawToken: string) {
  const tokenHash = hashToken(rawToken);
  const session = await db.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!session) throw new SessionInvalidError("no such session");
  if (session.revokedAt) throw new SessionInvalidError("revoked");
  if (session.expiresAt < new Date()) throw new SessionInvalidError("absolute timeout expired");

  const idleDeadline = new Date(
    session.lastActiveAt.getTime() + SESSION_IDLE_TIMEOUT_MINUTES * 60_000,
  );
  if (idleDeadline < new Date()) throw new SessionInvalidError("idle timeout expired");

  await db.session.update({
    where: { id: session.id },
    data: { lastActiveAt: new Date() },
  });

  return session;
}

export async function revokeSession(db: PrismaClient, rawToken: string): Promise<void> {
  await db.session.updateMany({
    where: { tokenHash: hashToken(rawToken) },
    data: { revokedAt: new Date() },
  });
}

/** Role change or password reset revokes EVERY session for the user --
 *  docs/10-SECURITY.md. */
export async function revokeAllSessions(
  db: PrismaClient | Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// ── MFA (TOTP) ───────────────────────────────────────────────────────────
//
// mfaSecret is stored encrypted (via the same AES-256-GCM used for KYC
// fields) even though the schema does not split it into separate
// ciphertext/last4 columns the way PAN/Aadhaar do -- it is a single opaque
// String column, so the "keyId:iv:tag:ciphertext" format from encryptField
// fits it directly with no schema change. A TOTP secret is as sensitive as a
// password; storing it in the clear next to an argon2id hash would be an
// inconsistent security posture for no benefit.

export function generateMfaSecret(): string {
  return authenticator.generateSecret();
}

export function buildMfaEnrollmentUri(secret: string, accountLabel: string, issuer: string): string {
  return authenticator.keyuri(accountLabel, issuer, secret);
}

export function verifyMfaToken(encryptedSecret: string, token: string): boolean {
  const secret = decryptField(encryptedSecret);
  return authenticator.verify({ token, secret });
}

export function encryptMfaSecret(plainSecret: string): string {
  return encryptField(plainSecret);
}

/** Roles requiring MFA per docs/09-RBAC-MATRIX.md. `Role.requiresMfa` in the
 *  schema is the seeded source of truth the real login flow checks (via a
 *  DB lookup through the user's actual roles) -- this constant exists for
 *  tests and for a seed-time assertion that the matrix was seeded
 *  consistently with the doc, not as a second, divergent source of truth. */
export const MFA_REQUIRED_ROLE_CODES = ["SUPER_ADMIN", "FINANCE_ADMIN", "SALES_HEAD"] as const;
