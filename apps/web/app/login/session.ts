// Shared by every terminal step of the login flow (plain password, MFA
// challenge, MFA enrollment): creates the real session and sets the cookie
// every other route in apps/web already reads (SESSION_COOKIE_NAME from
// lib/api-session.ts), then clears the pending-MFA cookie so it can't be
// replayed.
import { cookies } from "next/headers";
import type { PrismaClient } from "@desire/db";
import { createSession } from "@desire/services/auth";
import { SESSION_COOKIE_NAME } from "@/lib/api-session";
import { clearPendingMfaCookie } from "./pending";

export async function establishSession(db: PrismaClient, userId: string): Promise<void> {
  const { rawToken, expiresAt } = await createSession(db, userId, {});
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
