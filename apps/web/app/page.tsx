import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { getSession } from "@/lib/session";

/** Roles that work the Associate PWA rather than the back-office
 *  (docs/08-SCREENS.md: "Associates work standing up, one-handed... they
 *  will never open the desktop app"). TEAM_LEAD is included -- the PWA's
 *  Team tab is exactly the manager view for this role. */
const PWA_ROLE_CODES = new Set(["ASSOCIATE", "TEAM_LEAD"]);

export default async function HomePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const usesPwa = await hasPwaRole(session.user.id);
  redirect(usesPwa ? "/home" : "/dashboard");
}

async function hasPwaRole(userId: string): Promise<boolean> {
  const db = getPrismaClient();
  const userRoles = await db.userRole.findMany({
    where: { userId },
    select: { role: { select: { code: true } } },
  });
  return userRoles.some((userRole) => PWA_ROLE_CODES.has(userRole.role.code));
}
