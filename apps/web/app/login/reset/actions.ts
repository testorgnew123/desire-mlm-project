"use server";

import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import {
  InvalidResetTokenError,
  WeakPasswordError,
  resetPasswordWithToken,
} from "@desire/services/password-reset";

export async function resetPasswordAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (!token) redirect("/login/reset");

  const back = `/login/reset?token=${encodeURIComponent(token)}`;
  if (password !== confirm) redirect(`${back}&error=mismatch`);

  try {
    await resetPasswordWithToken(getPrismaClient(), { token, newPassword: password });
  } catch (error) {
    if (error instanceof WeakPasswordError) redirect(`${back}&error=${encodeURIComponent(error.message)}`);
    if (error instanceof InvalidResetTokenError) redirect("/login/reset");
    throw error;
  }

  redirect("/login?reset=ok");
}
