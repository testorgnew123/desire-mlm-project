"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { revokeSession } from "@desire/services/auth";
import { SESSION_COOKIE_NAME } from "./api-session";

/** Shared by both shells (back-office, PWA) -- revokes the real session row,
 *  not just the cookie, so a captured token can't be replayed after
 *  sign-out. No sign-out flow existed anywhere in the app before this. */
export async function signOutAction(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    await revokeSession(getPrismaClient(), token);
    store.delete(SESSION_COOKIE_NAME);
  }
  redirect("/login");
}
