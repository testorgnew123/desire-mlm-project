import type { PrismaClient } from "@desire/db";

/** Roles that work the Associate PWA rather than the back-office
 *  (docs/08-SCREENS.md: "Associates work standing up, one-handed... they will
 *  never open the desktop app"). */
const PWA_ROLE_CODES: ReadonlySet<string> = new Set(["ASSOCIATE"]);

/** Where a user starts. The dashboard and the PWA home are switched off, so the
 *  associate lands on the plot grid and everyone else on the project list. */
export function landingPathFor(roleCodes: Iterable<string>): string {
  for (const code of roleCodes) {
    if (PWA_ROLE_CODES.has(code)) return "/inventory";
  }
  return "/projects";
}

/** One query. Login and the MFA steps redirect straight here instead of to `/`,
 *  which used to cost a second round of the same lookup plus an extra hop. */
export async function getLandingPath(db: PrismaClient, userId: string): Promise<string> {
  const userRoles = await db.userRole.findMany({
    where: { userId },
    select: { role: { select: { code: true } } },
  });
  return landingPathFor(userRoles.map((userRole) => userRole.role.code));
}
