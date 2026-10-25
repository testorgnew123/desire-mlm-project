"use server";

// Errors redirect back to /login with a query param rather than using
// useActionState -- this keeps the whole login flow plain RSC + Server
// Actions with no client-side form-state hook, per the Phase 3.5 data-layer
// choice (Server Components + Server Actions only, no client state library).
import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { AccountLockedError, InvalidCredentialsError, attemptLogin } from "@desire/services/password";
import { continueAfterPassword } from "./continue";
import { setPendingPasswordChangeCookie } from "./pending";

export async function loginAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    redirect("/login?error=missing_fields");
  }

  const db = getPrismaClient();

  // Single-tenant today: exactly one seeded Organization row. A second real
  // org would need this resolved from a subdomain or an org picker instead --
  // tracked in PROGRESS.md, not silently hardcoded forever.
  const org = await db.organization.findFirst({ select: { id: true } });
  if (!org) {
    redirect("/login?error=no_org");
  }

  let userId: string;
  let mfaEnabled: boolean;
  let mustChangePassword: boolean;
  try {
    const { user } = await attemptLogin(db, email, org.id, password);
    userId = user.id;
    mfaEnabled = user.mfaEnabled;
    mustChangePassword = user.mustChangePassword;
  } catch (error) {
    if (error instanceof AccountLockedError) {
      redirect(`/login?error=account_locked&until=${encodeURIComponent(error.lockedUntil.toISOString())}`);
    }
    if (error instanceof InvalidCredentialsError) {
      redirect("/login?error=invalid_credentials");
    }
    throw error;
  }

  // A temporary password (new account, admin reset) is good for exactly one
  // thing: choosing a real one. No session exists until that is done.
  if (mustChangePassword) {
    await setPendingPasswordChangeCookie(userId);
    redirect("/login/change-password");
  }

  await continueAfterPassword(db, userId, mfaEnabled);
}
