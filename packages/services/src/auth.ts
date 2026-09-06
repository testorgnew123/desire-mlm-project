// Session lifecycle and MFA.
//
// Password hashing and the login flow live in password.ts, NOT here: that
// module imports @node-rs/argon2, a native .node addon webpack cannot parse.
// validateSession is on the hot path for every request, so this file must stay
// free of native dependencies -- do not import password.ts from here.
// Hand-rolled session auth against the schema as designed, rather than
// Auth.js's Prisma adapter conventions -- see docs/02-ARCHITECTURE.md and
// PROGRESS.md decision log for why. Matches docs/10-SECURITY.md exactly:
// argon2id hashing, httpOnly session cookie backed by a server-side row,
// 12h idle / 7d absolute timeout, per-account lockout after 5 failed
// attempts, server-side revocation on demand.
import { randomBytes, createHash } from "node:crypto";
import { authenticator } from "otplib";
import type { PrismaClient, Prisma } from "@desire/db";
import { decryptField, encryptField } from "./encryption";

const SESSION_TOKEN_BYTES = 32;
const SESSION_IDLE_TIMEOUT_MINUTES = 12 * 60;
const SESSION_ABSOLUTE_TIMEOUT_DAYS = 7;

export class SessionInvalidError extends Error {
  constructor(reason: string) {
    super(`Session invalid: ${reason}`);
    this.name = "SessionInvalidError";
  }
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
