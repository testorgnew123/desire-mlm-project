// Shared session reading for RSC / Server Action context.
//
// Replaces the inline cookie-read block that, before this file existed, lived
// only in apps/web/app/board/[projectId]/page.tsx. Narrow subpath imports --
// the @desire/services barrel drags @node-rs/argon2 (a native addon) into the
// build graph via password.ts; see the note at the top of
// packages/services/src/password.ts.
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import type { User } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { getSessionPermissions } from "@desire/services/rbac";
import { SESSION_COOKIE_NAME } from "./api-session";

export interface CurrentSession {
  user: User;
  expiresAt: Date;
}

/** Reads and validates the session cookie for the current request. Returns
 *  null for "no cookie" and for "cookie present but invalid/expired" alike --
 *  callers that need to tell those apart should call validateSession directly.
 *
 *  Wrapped in React's cache() because every back-office/PWA layout AND its
 *  child page independently call this (or requireSession, which calls this)
 *  -- without the wrapper, validateSession's SELECT+JOIN plus its
 *  unconditional lastActiveAt UPDATE ran twice per request. cache() dedupes
 *  to one call per request across every caller that imports this same
 *  function, with zero call-site changes needed. */
export const getSession = cache(async (): Promise<CurrentSession | null> => {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const db = getPrismaClient();
  try {
    const session = await validateSession(db, token);
    return { user: session.user, expiresAt: session.expiresAt };
  } catch (error) {
    if (error instanceof SessionInvalidError) return null;
    throw error;
  }
});

/** cache()-wrapped getSessionPermissions -- same reasoning as getSession
 *  above. Only a handful of call sites compute permissions independently of
 *  the layout that already did (apps/web/app/(back-office)/layout.tsx,
 *  apps/web/app/(pwa)/layout.tsx, commission/disputes and bookings pages);
 *  importing this instead of @desire/services/rbac directly dedupes those
 *  to one query per request. */
export const getCachedSessionPermissions = cache(getSessionPermissions);

/** Same as getSession(), but redirects to /login instead of returning null --
 *  for pages that require an authenticated actor to render at all. */
export async function requireSession(): Promise<CurrentSession> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}
