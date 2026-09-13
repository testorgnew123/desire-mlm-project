"use server";

import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import type { NotificationChannel, RoleCode } from "@desire/db";
import { createUser, updateUserRoles } from "@desire/services/admin";
import { createNotificationRule, updateNotificationRule } from "@desire/services/notifications";
import { requireSession } from "@/lib/session";

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

export async function createUserAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const db = getPrismaClient();

  await runAction("/admin/users", async () => {
    const result = await createUser(db, {
      email: String(formData.get("email") ?? ""),
      name: String(formData.get("name") ?? ""),
      roleCode: String(formData.get("roleCode") ?? "") as RoleCode,
      audit: auditFor(session),
    });
    // No invite-email flow in this codebase -- the temporary password
    // travels as a one-time query param so the admin can hand it to the
    // new hire, then it is gone (never logged, never persisted anywhere
    // except as the row's own argon2id hash).
    redirect(`/admin/users?created=${result.userId}&tempPassword=${encodeURIComponent(result.temporaryPassword)}`);
  });
}

export async function updateUserRolesAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const db = getPrismaClient();

  await runAction("/admin/users", () =>
    updateUserRoles(db, {
      userId: String(formData.get("userId") ?? ""),
      roleCode: String(formData.get("roleCode") ?? "") as RoleCode,
      audit: auditFor(session),
    }).then(() => undefined),
  );
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
