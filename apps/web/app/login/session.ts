// Shared by every terminal step of the login flow (plain password, MFA
// challenge, MFA enrollment): creates the real session and sets the cookie
// every other route in apps/web already reads (SESSION_COOKIE_NAME from
// lib/api-session.ts), then clears the pending-MFA cookie so it can't be
// replayed.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { PrismaClient } from "@desire/db";
import { AccountDisabledError, createSession, type CreatedSession } from "@desire/services/auth";
import { SESSION_COOKIE_NAME } from "@/lib/api-session";
import { clearPendingMfaCookie } from "./pending";

export async function establishSession(db: PrismaClient, userId: string): Promise<void> {
  let created: CreatedSession;
  try {
    created = await createSession(db, userId, {});
  } catch (error) {
    // Disabled after the password step (a pending MFA or password-change cookie
    // outlives that for a few minutes): no session, and the cookie is of no use.
    if (error instanceof AccountDisabledError) {
      await clearPendingMfaCookie();
      redirect("/login?error=account_disabled");
    }
    throw error;
  }
  const { rawToken, expiresAt } = created;
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  await clearPendingMfaCookie();
}
