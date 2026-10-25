"use server";

import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import {
  PasswordChangeNotRequiredError,
  WeakPasswordError,
  completeForcedPasswordChange,
} from "@desire/services/password-reset";
import { continueAfterPassword } from "../continue";
import { clearPendingPasswordChangeCookie, readPendingPasswordChangeUserId } from "../pending";

export async function changePasswordAction(formData: FormData): Promise<void> {
  const userId = await readPendingPasswordChangeUserId();
  if (!userId) redirect("/login");

  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password !== confirm) redirect("/login/change-password?error=mismatch");

  const db = getPrismaClient();
  try {
    await completeForcedPasswordChange(db, { userId, newPassword: password });
  } catch (error) {
    if (error instanceof WeakPasswordError) {
      redirect(`/login/change-password?error=${encodeURIComponent(error.message)}`);
    }
    if (error instanceof PasswordChangeNotRequiredError) {
      await clearPendingPasswordChangeCookie();
      redirect("/login");
    }
    throw error;
  }

  await clearPendingPasswordChangeCookie();
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { mfaEnabled: true } });
  await continueAfterPassword(db, userId, user.mfaEnabled);
}
