"use server";

import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { sendTestEmail } from "@desire/services/account-mail";
import { assertPermission } from "@desire/services/rbac";
import { requireSession } from "@/lib/session";

/** Sends the one test message and comes back with what happened. The result is in
 *  the address as a short flag and, when it failed, the reason: never the address
 *  the mail went to, and never a setting. */
export async function sendTestEmailAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  // Mail settings are an administrator's concern: the same permission as creating
  // an account, which is what sends the first mail.
  await assertPermission(getPrismaClient(), session.user.id, "user.manage");

  const result = await sendTestEmail({
    to: String(formData.get("to") ?? ""),
    requestedBy: session.user.name,
  });
  const query = new URLSearchParams(result.sent ? { sent: "1" } : { error: result.message });
  redirect(`/admin/mail?${query.toString()}`);
}
