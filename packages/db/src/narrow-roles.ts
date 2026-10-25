// Brings an EXISTING database in line with the three-role matrix
// (permission-matrix.ts). The seed cannot do it: its upserts use `update: {}`,
// so it never removes a grant, a user's old role or a role row.
//
// Split in two so the risky half is inspectable: planNarrowing only READS and
// returns what would change; applyNarrowing performs exactly that plan in one
// transaction. scripts/narrow-roles.ts runs the first by default and the second
// only with --apply.
//
// Not exported from index.ts on purpose: nothing in the app should import it.
import type { Prisma, PrismaClient } from "./generated/prisma/client";
import {
  MFA_REQUIRED_ROLES,
  PERMISSION_CODES,
  ROLE_CODES,
  ROLE_NAMES,
  permissionsForRole,
  type RoleCode,
} from "./permission-matrix";

/** Where the users of each removed role go. `null` = no equivalent: a person
 *  decides, so those users are reported and their role is left alone. */
export const ROLE_REMAP: Readonly<Record<string, RoleCode | null>> = {
  TEAM_LEAD: "ASSOCIATE",
  SALES_HEAD: "ADMIN",
  SALES_ADMIN: "ADMIN",
  PROJECT_MANAGER: "ADMIN",
  FINANCE_ADMIN: "ADMIN",
  AUDITOR: null,
};

const ACTIVE: ReadonlySet<string> = new Set(ROLE_CODES);

export interface ReRole {
  userRoleId: string;
  userId: string;
  userEmail: string;
  fromRole: string;
  toRole: RoleCode;
  /** Kept as it was: a project-scoped grant stays project-scoped. */
  projectId: string | null;
}

export interface NarrowingPlan {
  orgId: string;
  permissionsToCreate: string[];
  rolesToCreate: RoleCode[];
  grantsToAdd: { role: RoleCode; permission: string }[];
  grantsToRemove: { role: RoleCode; permission: string }[];
  reRole: ReRole[];
  /** Users whose removed role has no mapping; nothing is changed for them. */
  needsDecision: { userEmail: string; role: string }[];
  rolesToDelete: string[];
  /** Removed roles that stay because someone still holds them. */
  rolesKept: { role: string; holders: number }[];
}

export async function planNarrowing(db: PrismaClient, orgId: string): Promise<NarrowingPlan> {
  const [permissions, roles] = await Promise.all([
    db.permission.findMany({ select: { code: true } }),
    db.role.findMany({
      where: { orgId },
      select: { code: true, rolePermissions: { select: { permission: { select: { code: true } } } } },
    }),
  ]);
  const knownPermissions = new Set(permissions.map((p) => p.code));
  const roleByCode = new Map(roles.map((role) => [role.code, role]));

  const plan: NarrowingPlan = {
    orgId,
    permissionsToCreate: PERMISSION_CODES.filter((code) => !knownPermissions.has(code)),
    rolesToCreate: [],
    grantsToAdd: [],
    grantsToRemove: [],
    reRole: [],
    needsDecision: [],
    rolesToDelete: [],
    rolesKept: [],
  };

  for (const code of ROLE_CODES) {
    const wanted = new Set<string>(permissionsForRole(code));
    const existing = roleByCode.get(code);
    if (!existing) plan.rolesToCreate.push(code);
    const have = new Set(existing?.rolePermissions.map((rp) => rp.permission.code) ?? []);
    for (const permission of wanted) if (!have.has(permission)) plan.grantsToAdd.push({ role: code, permission });
    for (const permission of have) if (!wanted.has(permission)) plan.grantsToRemove.push({ role: code, permission });
  }

  const holders = await db.userRole.findMany({
    where: { role: { orgId, code: { notIn: [...ROLE_CODES] } } },
    select: {
      id: true,
      userId: true,
      projectId: true,
      role: { select: { code: true } },
      user: { select: { email: true } },
    },
  });
  const holdersByRole = new Map<string, number>();
  for (const holder of holders) {
    const from = holder.role.code;
    const to = ROLE_REMAP[from];
    if (to) {
      plan.reRole.push({
        userRoleId: holder.id,
        userId: holder.userId,
        userEmail: holder.user.email,
        fromRole: from,
        toRole: to,
        projectId: holder.projectId,
      });
    } else {
      plan.needsDecision.push({ userEmail: holder.user.email, role: from });
      holdersByRole.set(from, (holdersByRole.get(from) ?? 0) + 1);
    }
  }

  for (const role of roles) {
    if (ACTIVE.has(role.code)) continue;
    const kept = holdersByRole.get(role.code);
    if (kept) plan.rolesKept.push({ role: role.code, holders: kept });
    else plan.rolesToDelete.push(role.code);
  }

  return plan;
}

export async function applyNarrowing(db: PrismaClient, plan: NarrowingPlan): Promise<void> {
  await db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      for (const code of plan.permissionsToCreate) {
        const [resource, action] = code.split(".");
        await tx.permission.create({ data: { code, resource: resource ?? code, action: action ?? "" } });
      }

      for (const code of plan.rolesToCreate) {
        await tx.role.create({
          data: {
            orgId: plan.orgId,
            code,
            name: ROLE_NAMES[code],
            isSystem: true,
            requiresMfa: (MFA_REQUIRED_ROLES as string[]).includes(code),
          },
        });
      }

      const roles = await tx.role.findMany({ where: { orgId: plan.orgId }, select: { id: true, code: true } });
      const roleId = new Map(roles.map((role) => [role.code, role.id]));
      const permissions = await tx.permission.findMany({ select: { id: true, code: true } });
      const permissionId = new Map(permissions.map((permission) => [permission.code, permission.id]));

      for (const grant of plan.grantsToAdd) {
        await tx.rolePermission.create({
          data: { roleId: must(roleId, grant.role), permissionId: must(permissionId, grant.permission) },
        });
      }
      for (const grant of plan.grantsToRemove) {
        await tx.rolePermission.delete({
          where: {
            roleId_permissionId: { roleId: must(roleId, grant.role), permissionId: must(permissionId, grant.permission) },
          },
        });
      }

      for (const move of plan.reRole) {
        const targetRoleId = must(roleId, move.toRole);
        const already = await tx.userRole.findFirst({
          where: { userId: move.userId, roleId: targetRoleId, projectId: move.projectId },
          select: { id: true },
        });
        if (!already) {
          await tx.userRole.create({
            data: { userId: move.userId, roleId: targetRoleId, projectId: move.projectId },
          });
        }
        await tx.userRole.delete({ where: { id: move.userRoleId } });
        // docs/10-SECURITY.md: a role change revokes every session of that user.
        await tx.session.updateMany({
          where: { userId: move.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            orgId: plan.orgId,
            actorId: null,
            actorLabel: "narrow-roles script",
            action: "UPDATE",
            entity: "User",
            entityId: move.userId,
            before: { roleCode: move.fromRole },
            after: { roleCode: move.toRole },
            reason: "Scope cut to three roles",
          },
        });
      }

      for (const code of plan.rolesToDelete) {
        // RolePermission and UserRole rows go with it (onDelete: Cascade); the
        // plan only lists roles nobody holds any more.
        await tx.role.deleteMany({ where: { orgId: plan.orgId, code } });
      }
    },
    { timeout: 60_000 },
  );
}

function must<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`narrow-roles: missing ${String(key)}`);
  return value;
}
