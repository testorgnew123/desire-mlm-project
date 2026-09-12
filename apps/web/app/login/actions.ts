"use server";

// Errors redirect back to /login with a query param rather than using
// useActionState -- this keeps the whole login flow plain RSC + Server
// Actions with no client-side form-state hook, per the Phase 3.5 data-layer
// choice (Server Components + Server Actions only, no client state library).
import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { AccountLockedError, InvalidCredentialsError, attemptLogin } from "@desire/services/password";
import { userRequiresMfa } from "@desire/services/auth";
import { setPendingMfaCookie } from "./pending";
import { establishSession } from "./session";

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
  try {
    const { user } = await attemptLogin(db, email, org.id, password);
    userId = user.id;
    mfaEnabled = user.mfaEnabled;
  } catch (error) {
    if (error instanceof AccountLockedError) {
      redirect(`/login?error=account_locked&until=${encodeURIComponent(error.lockedUntil.toISOString())}`);
    }
    if (error instanceof InvalidCredentialsError) {
      redirect("/login?error=invalid_credentials");
    }
    throw error;
  }

  if (mfaEnabled) {
    await setPendingMfaCookie(userId);
    redirect("/login/mfa");
  }

  if (await userRequiresMfa(db, userId)) {
    await setPendingMfaCookie(userId);
    redirect("/login/mfa-enroll");
  }

  await establishSession(db, userId);
  redirect("/");
}
