import { redirect } from "next/navigation";
import type { PrismaClient } from "@desire/db";
import { userRequiresMfa } from "@desire/services/auth";
import { getLandingPath } from "@/lib/landing";
import { setPendingMfaCookie } from "./pending";
import { establishSession } from "./session";

/** Everything after the password is settled -- right, and if it was a temporary
 *  one, replaced by the person's own: the MFA challenge or enrolment where it
 *  applies, otherwise a real session and the landing page. Shared by the sign-in
 *  form and the forced password change, so the two cannot drift apart. */
export async function continueAfterPassword(db: PrismaClient, userId: string, mfaEnabled: boolean): Promise<never> {
  if (mfaEnabled) {
    await setPendingMfaCookie(userId);
    redirect("/login/mfa");
  }

  if (await userRequiresMfa(db, userId)) {
    await setPendingMfaCookie(userId);
    redirect("/login/mfa-enroll");
  }

  await establishSession(db, userId);
  redirect(await getLandingPath(db, userId));
}
