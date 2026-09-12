"use server";

import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { encryptMfaSecret, verifyMfaToken } from "@desire/services/auth";
import { readPendingMfaUserId } from "../pending";
import { establishSession } from "../session";

export async function enrollMfaAction(formData: FormData): Promise<void> {
  const userId = await readPendingMfaUserId();
  if (!userId) redirect("/login");

  const secret = String(formData.get("secret") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  if (!secret || !code) redirect("/login/mfa-enroll?error=invalid_code");

  // Round-trips through the exact same encrypt-then-decrypt-then-verify path
  // a later login's mfa/actions.ts uses on the persisted secret -- confirming
  // the code verifies BEFORE persisting also confirms the encrypted form we
  // are about to save will itself verify correctly next time.
  const encryptedSecret = encryptMfaSecret(secret);
  if (!verifyMfaToken(encryptedSecret, code)) {
    redirect("/login/mfa-enroll?error=invalid_code");
  }

  const db = getPrismaClient();
  await db.user.update({
    where: { id: userId },
    data: { mfaSecret: encryptedSecret, mfaEnabled: true, mfaEnrolledAt: new Date() },
  });

  await establishSession(db, userId);
  redirect("/");
}
