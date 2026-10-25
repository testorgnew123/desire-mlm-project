// Choosing a new password, three ways in:
//   - "Forgot password": requestPasswordReset emails a single-use link and
//     resetPasswordWithToken spends it;
//   - first sign-in with a temporary password: completeForcedPasswordChange
//     (the web layer calls it only after attemptLogin has just passed);
//   - an admin reset lives in admin.ts, because it is a user-management action.
//
// Imports password.ts, so it carries argon2: keep it out of anything that runs
// on every request (see the note at the top of password.ts).
import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@desire/db";
import { appBaseUrl, sendPasswordResetLink } from "./account-mail";
import { writeAuditLog } from "./audit";
import { revokeAllSessions } from "./auth";
import { hashPassword, verifyPassword } from "./password";

export const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 128;
export const RESET_TOKEN_TTL_MINUTES = 30;
export const RESET_REQUEST_COOLDOWN_SECONDS = 60;

export class WeakPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeakPasswordError";
  }
}

export class InvalidResetTokenError extends Error {
  constructor() {
    super("This password reset link is not valid. It may have expired or already been used.");
    this.name = "InvalidResetTokenError";
  }
}

export class PasswordChangeNotRequiredError extends Error {
  constructor() {
    super("This account is not waiting for a new password.");
    this.name = "PasswordChangeNotRequiredError";
  }
}

export function assertAcceptablePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new WeakPasswordError(`Choose a password of at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const BLOCKED_STATUSES: ReadonlySet<string> = new Set(["SUSPENDED", "DISABLED"]);

// ── Forgot password ────────────────────────────────────────────────────

/** What happened, for tests and logs. The screen shows the same neutral message
 *  for every one of these, so it cannot be used to find out who has an account. */
export type ResetRequestOutcome =
  | "SENT"
  | "NO_SUCH_USER"
  | "NOT_ALLOWED"
  | "THROTTLED"
  | "NOT_CONFIGURED"
  | "SEND_FAILED";

/** Issues a reset link by email. At most one request per account per
 *  RESET_REQUEST_COOLDOWN_SECONDS (a per-account limit; there is no store for a
 *  per-IP one, see password.ts). A new link voids any earlier unused one. */
export async function requestPasswordReset(
  db: PrismaClient,
  params: { orgId: string; email: string },
): Promise<ResetRequestOutcome> {
  const user = await db.user.findUnique({
    where: { orgId_email: { orgId: params.orgId, email: params.email.trim().toLowerCase() } },
    select: { id: true, name: true, email: true, status: true },
  });
  if (!user) return "NO_SUCH_USER";
  if (BLOCKED_STATUSES.has(user.status)) return "NOT_ALLOWED";

  const base = appBaseUrl();
  if (!base) return "NOT_CONFIGURED";

  const recent = await db.passwordResetToken.findFirst({
    where: { userId: user.id, createdAt: { gt: new Date(Date.now() - RESET_REQUEST_COOLDOWN_SECONDS * 1000) } },
    select: { id: true },
  });
  if (recent) return "THROTTLED";

  const rawToken = randomBytes(32).toString("base64url");
  const now = new Date();
  await db.$transaction([
    db.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } }),
    db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(rawToken),
        expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MINUTES * 60_000),
      },
    }),
  ]);

  const mail = await sendPasswordResetLink({
    to: user.email,
    name: user.name,
    link: `${base}/login/reset?token=${rawToken}`,
    minutes: RESET_TOKEN_TTL_MINUTES,
  });
  return mail.sent ? "SENT" : "SEND_FAILED";
}

/** For the reset page to say "this link has expired" before someone types a
 *  password into a form that cannot succeed. */
export async function isResetTokenUsable(db: PrismaClient, rawToken: string): Promise<boolean> {
  const row = await db.passwordResetToken.findUnique({
    where: { tokenHash: sha256(rawToken) },
    select: { usedAt: true, expiresAt: true, user: { select: { status: true } } },
  });
  return !!row && row.usedAt === null && row.expiresAt > new Date() && !BLOCKED_STATUSES.has(row.user.status);
}

/** Spends a reset link. Single use is enforced by the UPDATE itself (it only
 *  matches an unused, unexpired row), so two submissions of the same link cannot
 *  both win. Success also clears a lockout and a pending forced change, and
 *  revokes every session, because the person may be resetting precisely because
 *  someone else knows the old password. */
export async function resetPasswordWithToken(
  db: PrismaClient,
  params: { token: string; newPassword: string },
): Promise<void> {
  assertAcceptablePassword(params.newPassword);

  const row = await db.passwordResetToken.findUnique({
    where: { tokenHash: sha256(params.token) },
    select: { id: true, userId: true, usedAt: true, expiresAt: true, user: { select: { orgId: true, name: true, status: true } } },
  });
  const now = new Date();
  if (!row || row.usedAt !== null || row.expiresAt <= now || BLOCKED_STATUSES.has(row.user.status)) {
    throw new InvalidResetTokenError();
  }

  // Hashed before the transaction opens: argon2 is deliberately slow.
  const passwordHash = await hashPassword(params.newPassword);

  await db.$transaction(async (tx) => {
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw new InvalidResetTokenError();
    await tx.passwordResetToken.updateMany({ where: { userId: row.userId, usedAt: null }, data: { usedAt: now } });

    await tx.user.update({
      where: { id: row.userId },
      data: {
        passwordHash,
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
        ...(row.user.status === "INVITED" ? { status: "ACTIVE" as const } : {}),
      },
    });
    await revokeAllSessions(tx, row.userId);
    await writeAuditLog(
      tx,
      { orgId: row.user.orgId, actorId: row.userId, actorLabel: row.user.name },
      { action: "UPDATE", entity: "User", entityId: row.userId, after: { passwordReset: "self-service link" } },
    );
  });
}

// ── First sign-in with a temporary password ────────────────────────────

/** The person chooses their own password, replacing the temporary one they were
 *  sent. The caller must have just verified the temporary password (login does,
 *  and holds the result in a short-lived signed cookie); this checks the account
 *  really is waiting for it, so the pending cookie cannot be used to change a
 *  password that is not temporary. */
export async function completeForcedPasswordChange(
  db: PrismaClient,
  params: { userId: string; newPassword: string },
): Promise<void> {
  assertAcceptablePassword(params.newPassword);

  const user = await db.user.findUnique({
    where: { id: params.userId },
    select: { id: true, orgId: true, name: true, status: true, passwordHash: true, mustChangePassword: true },
  });
  if (!user || !user.mustChangePassword) throw new PasswordChangeNotRequiredError();
  if (await verifyPassword(user.passwordHash, params.newPassword)) {
    throw new WeakPasswordError("Choose a password different from the temporary one.");
  }

  const passwordHash = await hashPassword(params.newPassword);
  await db.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: { id: user.id, mustChangePassword: true },
      data: {
        passwordHash,
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
        ...(user.status === "INVITED" ? { status: "ACTIVE" as const } : {}),
      },
    });
    if (updated.count !== 1) throw new PasswordChangeNotRequiredError();
    await writeAuditLog(
      tx,
      { orgId: user.orgId, actorId: user.id, actorLabel: user.name },
      { action: "UPDATE", entity: "User", entityId: user.id, after: { passwordChanged: "first sign-in" } },
    );
  });
}
