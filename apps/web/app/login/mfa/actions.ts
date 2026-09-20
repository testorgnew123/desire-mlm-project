"use server";

import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { verifyMfaToken } from "@desire/services/mfa";
import { readPendingMfaUserId } from "../pending";
import { establishSession } from "../session";

export async function verifyMfaAction(formData: FormData): Promise<void> {
  const userId = await readPendingMfaUserId();
  if (!userId) redirect("/login");

  const code = String(formData.get("code") ?? "").trim();
  if (!code) redirect("/login/mfa?error=invalid_code");

  const db = getPrismaClient();
  const user = await db.user.findUnique({ where: { id: userId }, select: { mfaSecret: true } });
  if (!user?.mfaSecret || !verifyMfaToken(user.mfaSecret, code)) {
    redirect("/login/mfa?error=invalid_code");
  }

  await establishSession(db, userId);
  redirect("/");
}
