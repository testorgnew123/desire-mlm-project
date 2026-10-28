// The Associate profile holds and bookings are made under.
//
// Kept apart from admin.ts on purpose: this module imports only the database
// and the audit writer, so a deploy script can run it without loading the
// password hasher (a native addon) that admin.ts pulls in.
import type { Prisma, PrismaClient } from "@desire/db";
import { writeAuditLog, type AuditContext } from "./audit";

/** A new associate needs a grade to hold plots under (holdQuota); with none
 *  configured they could never hold anything. */
export class NoDefaultGradeError extends Error {
  constructor() {
    super("No grade is configured for this organisation, so an associate profile cannot be created.");
    this.name = "NoDefaultGradeError";
  }
}

export interface EnsuredAssociate {
  associateId: string;
  code: string;
  created: boolean;
}

/** Gives a user the Associate profile holds and bookings are made under.
 *  Idempotent. Nothing else in the app creates one, so without this an account
 *  made on the admin screen could log in and then do nothing: a hold needs the
 *  profile and a grade whose holdQuota is above zero.
 *
 *  Engagement type CHANNEL_PARTNER and the lowest-rank grade are the defaults;
 *  the tax path the first drives is unused while payouts are off. No hierarchy
 *  row: commission is off and OWN scope short-circuits without one. */
export async function ensureAssociateProfile(
  tx: Prisma.TransactionClient,
  params: { userId: string; audit: AuditContext },
): Promise<EnsuredAssociate> {
  const existing = await tx.associate.findUnique({ where: { userId: params.userId }, select: { id: true, code: true } });
  if (existing) return { associateId: existing.id, code: existing.code, created: false };

  const orgId = params.audit.orgId;
  const grade = await tx.grade.findFirst({
    where: { orgId, isActive: true },
    orderBy: { rank: "asc" },
    select: { id: true },
  });
  if (!grade) throw new NoDefaultGradeError();

  // Next A-0001 style code. Non-sequential codes (seeded demo associates) are
  // ignored. The (orgId, code) unique index is the backstop for two admins
  // creating at the same instant: one of them gets an error and retries.
  const taken = await tx.associate.findMany({ where: { orgId, code: { startsWith: "A-" } }, select: { code: true } });
  let highest = 0;
  for (const { code } of taken) {
    const match = /^A-(\d+)$/.exec(code);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  const code = `A-${String(highest + 1).padStart(4, "0")}`;

  const now = new Date();
  const associate = await tx.associate.create({
    data: { orgId, userId: params.userId, code, engagementType: "CHANNEL_PARTNER", status: "ACTIVE", joinDate: now },
  });
  await tx.associateGrade.create({ data: { associateId: associate.id, gradeId: grade.id, validFrom: now } });

  await writeAuditLog(tx, params.audit, {
    action: "CREATE",
    entity: "Associate",
    entityId: associate.id,
    after: { userId: params.userId, code, engagementType: "CHANNEL_PARTNER", gradeId: grade.id },
  });
  return { associateId: associate.id, code, created: true };
}

/** The roles whose holders may also hold and book plots, and so need a profile. */
export const ROLES_THAT_SELL: readonly string[] = ["ADMIN", "SUPER_ADMIN"];

/** An admin's profile is a convenience, not a precondition: an admin account must
 *  still be created or changed when the organisation has no grade yet, so a
 *  missing grade is reported as "not created", never thrown. */
export async function ensureAdminAssociateProfile(
  tx: Prisma.TransactionClient,
  params: { userId: string; audit: AuditContext },
): Promise<EnsuredAssociate | null> {
  try {
    return await ensureAssociateProfile(tx, params);
  } catch (error) {
    if (error instanceof NoDefaultGradeError) return null;
    throw error;
  }
}

export interface AdminProfileOutcome {
  email: string;
  /** The code the profile has, or would get for a dry run's "created". */
  code: string | null;
  result: "created" | "would create" | "skipped (no grade)";
}

/** Gives every Admin and Super Admin who has no associate profile one. For the
 *  accounts that existed before admins could sell: run on every production
 *  deploy, so nobody has to re-assign a role by hand. Idempotent, add-only (it
 *  never removes a profile or changes an existing one), and a dry run lists who
 *  would get one without writing anything. */
export async function ensureAdminAssociateProfiles(
  db: PrismaClient,
  params: { apply: boolean; orgId?: string },
): Promise<AdminProfileOutcome[]> {
  const users = await db.user.findMany({
    where: {
      ...(params.orgId ? { orgId: params.orgId } : {}),
      associate: null,
      userRoles: { some: { role: { code: { in: [...ROLES_THAT_SELL] } } } },
    },
    select: { id: true, orgId: true, email: true },
    orderBy: [{ orgId: "asc" }, { email: "asc" }],
  });

  const outcomes: AdminProfileOutcome[] = [];
  for (const user of users) {
    if (!params.apply) {
      const grade = await db.grade.findFirst({ where: { orgId: user.orgId, isActive: true }, select: { id: true } });
      outcomes.push({ email: user.email, code: null, result: grade ? "would create" : "skipped (no grade)" });
      continue;
    }
    const audit: AuditContext = { orgId: user.orgId, actorId: null, actorLabel: "deploy: admin associate profiles" };
    const ensured = await db.$transaction((tx) => ensureAdminAssociateProfile(tx, { userId: user.id, audit }));
    outcomes.push(
      ensured
        ? { email: user.email, code: ensured.code, result: "created" }
        : { email: user.email, code: null, result: "skipped (no grade)" },
    );
  }
  return outcomes;
}
