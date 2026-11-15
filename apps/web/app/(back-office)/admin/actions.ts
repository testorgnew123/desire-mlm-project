"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import type { NotificationChannel, RoleCode } from "@desire/db";
import { createUser, resetUserPassword, updateUserRoles, type IssuedCredentials } from "@desire/services/admin";
import { createNotificationRule, updateNotificationRule } from "@desire/services/notifications";
import { requireSession } from "@/lib/session";
import type { ActionResult } from "@/lib/action-result";

function auditFor(session: { user: { orgId: string; id: string; name: string } }) {
  return { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name };
}

async function runAction(path: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) {
      redirect(`${path}?error=${encodeURIComponent(error.message)}`);
    }
    throw error;
  }

  redirect(path);
}

/** What the admin is told after credentials were issued. The login details go to
 *  the person by email; the admin sees the temporary password only when that
 *  email did not go, so they can pass it on by hand. It is returned as the
 *  result's `secret` -- held in the form's memory, shown once -- and no longer as
 *  a query param, which left the password in the address bar and the browser's
 *  history (never logged, never persisted anywhere except as the row's own
 *  argon2id hash). */
function issuedResult(kind: "created" | "reset", issued: IssuedCredentials): ActionResult {
  const what = kind === "reset" ? "Password reset" : "Account created";
  if (issued.emailSent) {
    return {
      ok: true,
      message: `${what} for ${issued.email}. Their login ID and a temporary password were emailed to them; they choose their own at first sign-in.`,
    };
  }
  return {
    ok: true,
    message:
      `${what} for ${issued.email}, but the email was not sent${issued.emailNote ? ` (${issued.emailNote})` : ""}. ` +
      "Give them this one-time temporary password (copy it now, it will not be shown again):",
    secret: issued.temporaryPassword,
  };
}

async function issueCredentials(
  kind: "created" | "reset",
  run: () => Promise<IssuedCredentials>,
): Promise<ActionResult> {
  let issued: IssuedCredentials;
  try {
    issued = await run();
  } catch (error) {
    if (error instanceof Error) return { ok: false, error: error.message };
    throw error;
  }
  revalidatePath("/admin/users");
  return issuedResult(kind, issued);
}

export async function createUserAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const db = getPrismaClient();

  return issueCredentials("created", () =>
    createUser(db, {
      email: String(formData.get("email") ?? ""),
      name: String(formData.get("name") ?? ""),
      roleCode: String(formData.get("roleCode") ?? "") as RoleCode,
      audit: auditFor(session),
    }),
  );
}

export async function resetUserPasswordAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const db = getPrismaClient();

  return issueCredentials("reset", () =>
    resetUserPassword(db, { userId: String(formData.get("userId") ?? ""), audit: auditFor(session) }),
  );
}

export async function updateUserRolesAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const db = getPrismaClient();

  try {
    await updateUserRoles(db, {
      userId: String(formData.get("userId") ?? ""),
      roleCode: String(formData.get("roleCode") ?? "") as RoleCode,
      audit: auditFor(session),
    });
  } catch (error) {
    if (error instanceof Error) return { ok: false, error: error.message };
    throw error;
  }
  revalidatePath("/admin/users");
  return { ok: true, message: "Role updated." };
}

export async function createNotificationRuleAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const db = getPrismaClient();

  const channels = String(formData.get("channels") ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean) as NotificationChannel[];
  const audience = String(formData.get("audience") ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  await runAction("/admin/notification-rules", () =>
    createNotificationRule(db, {
      code: String(formData.get("code") ?? ""),
      name: String(formData.get("name") ?? ""),
      channels,
      audience,
      templateKey: String(formData.get("templateKey") ?? ""),
      audit: auditFor(session),
    }).then(() => undefined),
  );
}

export async function toggleNotificationRuleAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const ruleId = String(formData.get("ruleId") ?? "");
  const enabled = formData.get("enabled") === "true";
  const db = getPrismaClient();

  await runAction("/admin/notification-rules", () =>
    updateNotificationRule(db, { ruleId, enabled, audit: auditFor(session) }).then(() => undefined),
  );
}
