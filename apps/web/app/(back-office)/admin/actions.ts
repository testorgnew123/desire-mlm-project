"use server";

import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import type { NotificationChannel, RoleCode } from "@desire/db";
import { createUser, resetUserPassword, updateUserRoles, type IssuedCredentials } from "@desire/services/admin";
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

/** Where to send the admin after credentials were issued. The login details go to
 *  the person by email; the admin sees the temporary password only when that
 *  email did not go, as a one-time query param so they can pass it on by hand
 *  (never logged, never persisted anywhere except as the row's own argon2id
 *  hash). */
function issuedDestination(kind: "created" | "reset", issued: IssuedCredentials): string {
  const query = new URLSearchParams({ issued: kind, to: issued.email });
  if (issued.emailSent) {
    query.set("emailed", "1");
  } else {
    query.set("tempPassword", issued.temporaryPassword);
    if (issued.emailNote) query.set("note", issued.emailNote);
  }
  return `/admin/users?${query.toString()}`;
}

/** redirect() works by throwing, so it must never run inside the try whose catch
 *  turns every Error into `?error=`: it used to, which swallowed the redirect
 *  that carried the temporary password. Work inside the try, redirect after. */
async function issueCredentials(
  kind: "created" | "reset",
  run: () => Promise<IssuedCredentials>,
): Promise<void> {
  let destination: string;
  try {
    destination = issuedDestination(kind, await run());
  } catch (error) {
    if (error instanceof Error) {
      redirect(`/admin/users?error=${encodeURIComponent(error.message)}`);
    }
    throw error;
  }
  redirect(destination);
}

export async function createUserAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const db = getPrismaClient();

  await issueCredentials("created", () =>
    createUser(db, {
      email: String(formData.get("email") ?? ""),
      name: String(formData.get("name") ?? ""),
      roleCode: String(formData.get("roleCode") ?? "") as RoleCode,
      audit: auditFor(session),
    }),
  );
}

export async function resetUserPasswordAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const db = getPrismaClient();

  await issueCredentials("reset", () =>
    resetUserPassword(db, { userId: String(formData.get("userId") ?? ""), audit: auditFor(session) }),
  );
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
