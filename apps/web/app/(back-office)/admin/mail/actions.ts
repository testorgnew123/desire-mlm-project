"use server";

import { getPrismaClient } from "@desire/db";
import { sendTestEmail } from "@desire/services/account-mail";
import { assertPermission } from "@desire/services/rbac";
import { requireSession } from "@/lib/session";
import type { ActionResult } from "@/lib/action-result";

/** Sends the one test message and answers with what happened: "Sent", or the
 *  reason it did not go. Never the address the mail went to, and never a
 *  setting. */
export async function sendTestEmailAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  // Mail settings are an administrator's concern: the same permission as creating
  // an account, which is what sends the first mail.
  await assertPermission(getPrismaClient(), session.user.id, "user.manage");

  const result = await sendTestEmail({
    to: String(formData.get("to") ?? ""),
    requestedBy: session.user.name,
  });
  if (!result.sent) return { ok: false, error: result.message };
  return { ok: true, message: "Sent. Check that inbox, and its spam folder, to be sure it arrived." };
}
