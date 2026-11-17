"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import type { NotificationChannel, RoleCode } from "@desire/db";
import {
  createUser,
  deleteUser,
  resetUserPassword,
  setUserDisabled,
  updateUser,
  updateUserRoles,
  type IssuedCredentials,
} from "@desire/services/admin";
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

export async function updateUserAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const db = getPrismaClient();
  const userId = String(formData.get("userId") ?? "");

  try {
    const updated = await updateUser(db, {
      userId,
      name: String(formData.get("name") ?? ""),
      email: String(formData.get("email") ?? ""),
      audit: auditFor(session),
    });
    revalidatePath("/admin/users");
    revalidatePath(`/admin/users/${userId}`);
    if (!updated.changed) return { ok: true, message: "Nothing to change." };
    return {
      ok: true,
      message: updated.emailChanged
        ? `Saved. The login ID is now ${updated.email}. Nothing was sent to it: use Reset password to email the login to the new address.`
        : "Saved.",
    };
  } catch (error) {
    if (error instanceof Error) return { ok: false, error: error.message };
    throw error;
  }
}

export async function setUserDisabledAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const db = getPrismaClient();
  const userId = String(formData.get("userId") ?? "");
  const disabled = formData.get("disabled") === "true";

  try {
    const result = await setUserDisabled(db, { userId, disabled, audit: auditFor(session) });
    revalidatePath("/admin/users");
    revalidatePath(`/admin/users/${userId}`);
    if (!result.changed) return { ok: true, message: disabled ? "Already disabled." : "Already enabled." };
    return {
      ok: true,
      message: disabled
        ? `Disabled. ${result.email} is signed out and cannot sign in until the account is enabled.`
        : `Enabled. ${result.email} can sign in again.`,
    };
  } catch (error) {
    if (error instanceof Error) return { ok: false, error: error.message };
    throw error;
  }
}

export async function deleteUserAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const db = getPrismaClient();

  try {
    const deleted = await deleteUser(db, { userId: String(formData.get("userId") ?? ""), audit: auditFor(session) });
    revalidatePath("/admin/users");
    return { ok: true, message: `Deleted ${deleted.email}.`, redirectTo: "/admin/users" };
  } catch (error) {
    if (error instanceof Error) return { ok: false, error: error.message };
    throw error;
  }
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
