// Brings the role tables of EXISTING organisations in line with the permission
// matrix (permission-matrix.ts) by ADDING what is missing, on every production
// build (scripts/migrate-on-deploy.sh) and every preview database
// (.github/workflows/neon-preview-branches.yml).
//
// Why it exists: roles and permissions are rows, but nothing ever wrote them
// after the first hand seed. The 2026-10-25 cut added the ADMIN role and the
// `user.manage` permission in code only, so production could not assign Admin
// ("Role "ADMIN" is not configured for this organisation") and its Admin-to-be
// users kept roles without `booking.confirm`. The seed cannot fix it (demo org
// only, never run on deploy) and a SQL migration would freeze a copy of a matrix
// that lives in TypeScript.
//
// ADD-ONLY on purpose. It creates missing permission rows, missing rows for the
// three active roles, and missing grants for those roles. It never deletes a
// grant, a role or a user's role, so running it can only give access the matrix
// already says a role has; revoking (and moving people off old roles) stays in
// narrow-roles.ts, behind a human go-ahead. Grants a role holds beyond the
// matrix are reported in the plan, not removed.
//
// Idempotent and safe to overlap: every insert is `createMany skipDuplicates`.
//
// Not exported from index.ts, like narrow-roles: nothing in the app imports it.
import type { Prisma, PrismaClient } from "./generated/prisma/client";
import {
  MFA_REQUIRED_ROLES,
  PERMISSION_CODES,
  ROLE_CODES,
  ROLE_NAMES,
  permissionsForRole,
  type RoleCode,
} from "./permission-matrix";

export interface RoleSyncPlan {
  orgId: string;
  /** Global rows (permissions are shared by every organisation). */
  permissionsToCreate: string[];
  rolesToCreate: RoleCode[];
  grantsToAdd: { role: RoleCode; permission: string }[];
  /** Held by an active role beyond the matrix. Reported, never removed. */
  extraGrants: { role: RoleCode; permission: string }[];
}

/** Refuses to sync from a matrix that cannot be right. SUPER_ADMIN holds every
 *  permission by design; a matrix that says otherwise (or is empty) is a broken
 *  edit, and syncing it would hand a database a broken role. */
export function assertMatrixIsSane(): void {
  // Widened: as const tuples have a literal length, so the compiler would call an
  // emptiness check meaningless; at runtime it guards a broken edit of the matrix.
  const roles: readonly string[] = ROLE_CODES;
  const permissions: readonly string[] = PERMISSION_CODES;
  if (roles.length === 0 || permissions.length === 0) {
    throw new Error("role sync: the permission matrix is empty; refusing to sync.");
  }
  const superAdmin = new Set<string>(permissionsForRole("SUPER_ADMIN"));
  const missing = PERMISSION_CODES.filter((code) => !superAdmin.has(code));
  if (missing.length > 0) {
    throw new Error(`role sync: SUPER_ADMIN would not hold ${missing.join(", ")}; refusing to sync.`);
  }
}

export async function planRoleSync(db: PrismaClient, orgId: string): Promise<RoleSyncPlan> {
  assertMatrixIsSane();

  const [permissions, roles] = await Promise.all([
    db.permission.findMany({ select: { code: true } }),
    db.role.findMany({
      where: { orgId, code: { in: [...ROLE_CODES] } },
      select: { code: true, rolePermissions: { select: { permission: { select: { code: true } } } } },
    }),
  ]);
  const knownPermissions = new Set(permissions.map((permission) => permission.code));
  const roleByCode = new Map(roles.map((role) => [role.code, role]));

  const plan: RoleSyncPlan = {
    orgId,
    permissionsToCreate: PERMISSION_CODES.filter((code) => !knownPermissions.has(code)),
    rolesToCreate: [],
    grantsToAdd: [],
    extraGrants: [],
  };

  for (const code of ROLE_CODES) {
    const wanted = new Set<string>(permissionsForRole(code));
    const existing = roleByCode.get(code);
    if (!existing) plan.rolesToCreate.push(code);
    const have = new Set(existing?.rolePermissions.map((grant) => grant.permission.code) ?? []);
    for (const permission of wanted) if (!have.has(permission)) plan.grantsToAdd.push({ role: code, permission });
    for (const permission of have) if (!wanted.has(permission)) plan.extraGrants.push({ role: code, permission });
  }

  return plan;
}

/** One plan per organisation (or just `orgId`). */
export async function planRoleSyncForOrgs(db: PrismaClient, orgId?: string): Promise<RoleSyncPlan[]> {
  const orgs = await db.organization.findMany({
    where: orgId ? { id: orgId } : undefined,
    select: { id: true },
    orderBy: { id: "asc" },
  });
  if (orgId && orgs.length === 0) throw new Error(`role sync: organisation ${orgId} not found.`);
  const plans: RoleSyncPlan[] = [];
  for (const org of orgs) plans.push(await planRoleSync(db, org.id));
  return plans;
}

export async function applyRoleSync(db: PrismaClient, plan: RoleSyncPlan): Promise<void> {
  assertMatrixIsSane();

  await db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      if (plan.permissionsToCreate.length > 0) {
        await tx.permission.createMany({
          data: plan.permissionsToCreate.map((code) => {
            const [resource, action] = code.split(".");
            return { code, resource: resource ?? code, action: action ?? "" };
          }),
          skipDuplicates: true,
        });
      }

      if (plan.rolesToCreate.length > 0) {
        await tx.role.createMany({
          data: plan.rolesToCreate.map((code) => ({
            orgId: plan.orgId,
            code,
            name: ROLE_NAMES[code],
            isSystem: true,
            requiresMfa: (MFA_REQUIRED_ROLES as string[]).includes(code),
          })),
          skipDuplicates: true,
        });
      }

      if (plan.grantsToAdd.length > 0) {
        const roles = await tx.role.findMany({ where: { orgId: plan.orgId }, select: { id: true, code: true } });
        const permissions = await tx.permission.findMany({ select: { id: true, code: true } });
        const roleId = new Map(roles.map((role) => [role.code, role.id]));
        const permissionId = new Map(permissions.map((permission) => [permission.code, permission.id]));
        await tx.rolePermission.createMany({
          data: plan.grantsToAdd.map((grant) => ({
            roleId: must(roleId, grant.role),
            permissionId: must(permissionId, grant.permission),
          })),
          skipDuplicates: true,
        });
      }
    },
    { timeout: 60_000 },
  );
}

function must<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`role sync: missing ${String(key)}`);
  return value;
}
