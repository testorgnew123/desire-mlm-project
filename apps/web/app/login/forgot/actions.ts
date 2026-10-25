"use server";

import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { requestPasswordReset } from "@desire/services/password-reset";

/** Always ends at the same "if that address has an account" page, whatever
 *  happened, so the form cannot be used to find out who has one. What did
 *  happen is only logged, for whoever runs the server. */
export async function requestResetAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) redirect("/login/forgot?error=missing");

  const db = getPrismaClient();
  const org = await db.organization.findFirst({ select: { id: true } });
  if (org) {
    const outcome = await requestPasswordReset(db, { orgId: org.id, email });
    if (outcome === "NOT_CONFIGURED" || outcome === "SEND_FAILED") {
      console.error(`password reset not delivered: ${outcome} (is APP_BASE_URL and the SMTP_* mail setting configured?)`);
    }
  }

  redirect("/login/forgot?sent=1");
}
