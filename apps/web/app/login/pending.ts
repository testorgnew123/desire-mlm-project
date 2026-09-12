// Carries "which user passed the password check" between the password step
// and the MFA step, without creating a real Session row before MFA (where
// required) actually passes.
//
// Reuses encryptField/decryptField (packages/services/src/encryption.ts)
// rather than inventing a second signing scheme: it is already an
// authenticated (AES-256-GCM) box keyed off PII_ENCRYPTION_KEY, so a tampered
// or forged cookie fails to decrypt rather than silently naming a different
// user. This is not a PII field -- it is a generic reuse of an existing,
// already-provisioned app secret for a second short-lived purpose.
import { cookies } from "next/headers";
import { decryptField, DecryptionError, encryptField } from "@desire/services/encryption";

export const PENDING_MFA_COOKIE = "desire_pending_mfa";

/** Five minutes to complete MFA (enroll or challenge) after the password
 *  check succeeds -- long enough to read a QR code or an authenticator app,
 *  short enough that a laptop left mid-login doesn't leave a lingering
 *  half-authenticated cookie. */
const PENDING_MFA_TTL_MS = 5 * 60_000;

interface PendingMfaPayload {
  userId: string;
  exp: number;
}

export async function setPendingMfaCookie(userId: string): Promise<void> {
  const payload: PendingMfaPayload = { userId, exp: Date.now() + PENDING_MFA_TTL_MS };
  const token = encryptField(JSON.stringify(payload));
  const store = await cookies();
  store.set(PENDING_MFA_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/login",
    maxAge: PENDING_MFA_TTL_MS / 1000,
  });
}

/** Returns the pending user's id, or null if there is no cookie, it is
 *  expired, or it fails to decrypt (tampered or forged). */
export async function readPendingMfaUserId(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(PENDING_MFA_COOKIE)?.value;
  if (!token) return null;

  let payload: PendingMfaPayload;
  try {
    payload = JSON.parse(decryptField(token)) as PendingMfaPayload;
  } catch (error) {
    if (error instanceof DecryptionError || error instanceof SyntaxError) return null;
    throw error;
  }

  if (typeof payload.userId !== "string" || payload.exp < Date.now()) return null;
  return payload.userId;
}

export async function clearPendingMfaCookie(): Promise<void> {
  const store = await cookies();
  store.delete(PENDING_MFA_COOKIE);
}
