// Authorization. Two distinct concerns, kept separate on purpose:
//
//   1. PERMISSION checks -- "can this user perform this action at all"
//      (role -> permission, via UserRole/RolePermission/Permission).
//   2. SCOPE checks -- "which associates' data can this user see"
//      (own vs. own+downline, via the hierarchy path).
//
// docs/09-RBAC-MATRIX.md is explicit that scope resolution goes through ONE
// function, never ad-hoc `where` clauses per query -- that is what stops an
// accidental leak of another team's earnings. This file is that one place.
import type { PrismaClient, Prisma } from "@desire/db";

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

// ── Permission checks ───────────────────────────────────────────────────────

export interface PermissionCheckOptions {
  /** Restricts the check to a role grant scoped to this project, OR an
   *  org-wide grant (projectId IS NULL). A user with only a project-scoped
   *  Project Manager role for project A does not gain that role's
   *  permissions when checked against project B. */
  projectId?: string;
}

async function getPermissionCodes(
  db: PrismaClient | Prisma.TransactionClient,
  userId: string,
  options: PermissionCheckOptions = {},
): Promise<Set<string>> {
  const userRoles = await db.userRole.findMany({
    where: {
      userId,
      OR: [{ projectId: null }, ...(options.projectId ? [{ projectId: options.projectId }] : [])],
    },
    include: {
      role: {
        include: { rolePermissions: { include: { permission: true } } },
      },
    },
  });

  const codes = new Set<string>();
  for (const ur of userRoles) {
    for (const rp of ur.role.rolePermissions) {
      codes.add(rp.permission.code);
    }
  }
  return codes;
}

/** Public wrapper around getPermissionCodes -- the one-round-trip permission
 *  set a UI shell needs to filter its nav to what the actor can reach
 *  (Phase 3.5 plan, Shared patterns). hasPermission/assertPermission keep
 *  calling getPermissionCodes directly rather than routing through this. */
export async function getSessionPermissions(
  db: PrismaClient | Prisma.TransactionClient,
  userId: string,
  options?: PermissionCheckOptions,
): Promise<Set<string>> {
  return getPermissionCodes(db, userId, options);
}

export async function hasPermission(
  db: PrismaClient | Prisma.TransactionClient,
  userId: string,
  permissionCode: string,
  options?: PermissionCheckOptions,
): Promise<boolean> {
  const codes = await getPermissionCodes(db, userId, options);
  return codes.has(permissionCode);
}

/** Throws ForbiddenError rather than returning false -- callers should not be
 *  able to forget to check the result. */
export async function assertPermission(
  db: PrismaClient | Prisma.TransactionClient,
  userId: string,
  permissionCode: string,
  options?: PermissionCheckOptions,
): Promise<void> {
  if (!(await hasPermission(db, userId, permissionCode, options))) {
    throw new ForbiddenError(`User ${userId} lacks permission "${permissionCode}".`);
  }
}

// ── Scope resolution ─────────────────────────────────────────────────────
//
// Convention (not fully pinned in the schema comment, made concrete here):
// AssociateHierarchy.path holds the chain of ANCESTOR ids for that associate,
// not including themself, formatted "/id1/id2/.../idN/" from the top of the
// tree down to their immediate parent. An associate at the top of the tree
// has path "/". A descendant of X therefore always has X's id appearing as a
// "/X/" segment somewhere in their own path -- this is what makes "all of my
// downline" a substring/prefix scan instead of a recursive CTE.

export interface HierarchyPathRow {
  associateId: string;
  /** This associate's own ancestor-chain path, as above. */
  path: string;
}

/** Pure and DB-free on purpose -- see packages/commission's resolve.ts for
 *  the same reasoning. Takes the candidate's own path (not the actor's) and
 *  checks whether the actor's id appears as a path segment within it, or
 *  whether the candidate IS the actor. */
export function isInScope(actorAssociateId: string, candidate: HierarchyPathRow): boolean {
  if (candidate.associateId === actorAssociateId) return true;
  return candidate.path.includes(`/${actorAssociateId}/`);
}

export type ScopeMode = "OWN" | "OWN_AND_DOWNLINE";

/** Filters a list of hierarchy rows down to what `actorAssociateId` may see,
 *  under the given mode. Pure -- callers fetch the rows (a plain
 *  AssociateHierarchy query with validTo: null, i.e. current placements
 *  only) and pass them in. */
export function resolveAccessibleAssociateIds(
  actorAssociateId: string,
  mode: ScopeMode,
  allCurrentPlacements: readonly HierarchyPathRow[],
): string[] {
  if (mode === "OWN") return [actorAssociateId];

  const ids = allCurrentPlacements
    .filter((row) => isInScope(actorAssociateId, row))
    .map((row) => row.associateId);

  // The actor is always in their own scope even if, for some reason, they
  // have no row in allCurrentPlacements (e.g. sits at the very top with an
  // empty path and was excluded by an incomplete fetch upstream).
  return ids.includes(actorAssociateId) ? ids : [actorAssociateId, ...ids];
}

/** DB-backed convenience wrapper around the pure resolver above -- fetches
 *  current placements and applies resolveAccessibleAssociateIds. This is the
 *  ONE place a service should call for row scoping; never hand-roll a
 *  `where: { associateId: { in: [...] } }` filter elsewhere. */
export async function getAccessibleAssociateIds(
  db: PrismaClient | Prisma.TransactionClient,
  actorAssociateId: string,
  mode: ScopeMode,
): Promise<string[]> {
  if (mode === "OWN") return [actorAssociateId];

  // Two indexed lookups instead of loading the whole table.
  //
  // This used to read EVERY current placement -- no orgId filter, no bound --
  // and narrow it in memory with resolveAccessibleAssociateIds. That is one
  // full-table read per scoped query, on a model sized for 2,000 associates,
  // and it runs on most list screens. (It was never a data leak: isInScope
  // frames the match as "/<cuid>/", and cuids are globally unique, so a row
  // from another org could not match. It was purely waste.)
  //
  // A descendant is exactly a row whose path begins with the actor's own path
  // plus the actor's id -- the same prefix form associates.ts already uses for
  // subtree reads -- so the database can answer this with the
  // associate_hierarchy_path_prefix index (text_pattern_ops, added
  // 2026-09-20) rather than handing us every row to filter. It also makes the
  // org filter moot: a descendant of this actor is in this actor's org by
  // construction.
  //
  // Equivalence with the in-memory resolver is asserted in rbac-scope.test.ts
  // against a real tree, using resolveAccessibleAssociateIds as the oracle --
  // the pure function is the well-tested one, so the DB path is checked
  // against it rather than re-specified.
  const placement = await db.associateHierarchy.findFirst({
    where: { associateId: actorAssociateId, validTo: null },
    select: { path: true },
  });

  // No current placement: the actor can still always see themselves. Same
  // fallback the pure resolver applies for a row missing from the set.
  if (!placement) return [actorAssociateId];

  const descendants = await db.associateHierarchy.findMany({
    where: { validTo: null, path: { startsWith: `${placement.path}${actorAssociateId}/` } },
    select: { associateId: true },
  });

  return [actorAssociateId, ...descendants.map((row) => row.associateId)];
}
