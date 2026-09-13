// Hierarchy moves + associate listing -- Phase 3 Slice 1
// (PROGRESS.md, docs/03-DATA-MODEL.md's AssociateHierarchy comment,
// docs/07-API.md's Network & grades table).
import { Prisma } from "@desire/db";
import type { PrismaClient, Prisma as PrismaNS, AssociateHierarchy } from "@desire/db";
export type { AssociateHierarchy };
import { writeAuditLog, type AuditContext } from "./audit";
import { assertPermission, ForbiddenError, getAccessibleAssociateIds, type ScopeMode } from "./rbac";
import { AssociateNotFoundError } from "./grades";
import { assertPayoutPeriodNotOpen } from "./payouts";

const MOVE_PERMISSION = "associate.move";
const READ_PERMISSION = "associate.read";

const ADMIN_ROLE_CODES: ReadonlySet<string> = new Set(["SUPER_ADMIN", "FINANCE_ADMIN", "SALES_HEAD", "SALES_ADMIN", "AUDITOR"]);

// ── Errors ─────────────────────────────────────────────────────────────

export class SelfReferralError extends Error {
  constructor(public readonly associateId: string) {
    super(`Associate ${associateId} cannot be their own parent.`);
    this.name = "SelfReferralError";
  }
}

/** Carries both ids so the caller can say exactly what would have looped. */
export class CycleDetectedError extends Error {
  constructor(
    public readonly associateId: string,
    public readonly newParentId: string,
  ) {
    super(`Moving associate ${associateId} under ${newParentId} would make ${associateId} its own ancestor.`);
    this.name = "CycleDetectedError";
  }
}

export class MoveReasonRequiredError extends Error {
  constructor(public readonly associateId: string) {
    super(`Moving associate ${associateId} requires a reason.`);
    this.name = "MoveReasonRequiredError";
  }
}

export class ParentNotPlacedError extends Error {
  constructor(public readonly parentAssociateId: string) {
    super(`Associate ${parentAssociateId} has no current hierarchy placement to attach to.`);
    this.name = "ParentNotPlacedError";
  }
}

// ── Shared helpers (duplicated per file -- this codebase's own convention)

function requireActor(audit: AuditContext): string {
  if (!audit.actorId) {
    throw new ForbiddenError("Hierarchy mutations require a user actor, not a system actor.");
  }
  return audit.actorId;
}

function toAuditValue(value: unknown): unknown {
  if (value instanceof Prisma.Decimal) return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

function auditSnapshot(data: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) out[key] = toAuditValue(value);
  return out;
}

async function resolveActorRoleCodes(db: PrismaClient | PrismaNS.TransactionClient, actorId: string): Promise<Set<string>> {
  const roles = await db.userRole.findMany({ where: { userId: actorId }, select: { role: { select: { code: true } } } });
  return new Set(roles.map((r) => r.role.code));
}

// ── Move ───────────────────────────────────────────────────────────────

export interface MoveAssociateParams {
  associateId: string;
  /** null = move to the top of the tree. */
  newParentId: string | null;
  reason: string;
  audit: AuditContext;
  now?: Date;
}

/** GATE. Self-referral and cycle detection are asserted before any write;
 *  rejected outright while any payout batch for the org is open (schema's
 *  own invariant: "a batch cannot be computed against a hierarchy that
 *  shifts underneath it"). On success, closes the associate's current
 *  AssociateHierarchy row, inserts a new one, and recomputes `path`/`depth`
 *  for the WHOLE SUBTREE -- every associate whose current path names this
 *  associate as an ancestor, not just the one row being moved. */
export async function moveAssociate(db: PrismaClient, params: MoveAssociateParams): Promise<AssociateHierarchy> {
  const actorId = requireActor(params.audit);
  const now = params.now ?? new Date();

  if (!params.reason || !params.reason.trim()) {
    throw new MoveReasonRequiredError(params.associateId);
  }
  if (params.newParentId === params.associateId) {
    throw new SelfReferralError(params.associateId);
  }

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "associates" WHERE "id" = ${params.associateId} FOR UPDATE`;

    const associate = await tx.associate.findUnique({ where: { id: params.associateId } });
    if (!associate) throw new AssociateNotFoundError(params.associateId);
    if (associate.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Associate ${params.associateId} belongs to another organisation.`);
    }

    await assertPermission(tx, actorId, MOVE_PERMISSION);

    await assertPayoutPeriodNotOpen(tx, params.audit.orgId);

    const currentPlacement = await tx.associateHierarchy.findFirst({ where: { associateId: associate.id, validTo: null } });

    let newPath: string;
    let newDepth: number;
    if (params.newParentId) {
      const newParent = await tx.associate.findUnique({ where: { id: params.newParentId }, select: { id: true, orgId: true } });
      if (!newParent) throw new AssociateNotFoundError(params.newParentId);
      if (newParent.orgId !== params.audit.orgId) {
        throw new ForbiddenError(`Associate ${params.newParentId} belongs to another organisation.`);
      }
      const parentPlacement = await tx.associateHierarchy.findFirst({ where: { associateId: params.newParentId, validTo: null } });
      if (!parentPlacement) throw new ParentNotPlacedError(params.newParentId);

      // Cycle detection: the proposed parent's own ancestor chain must not
      // already contain this associate -- reuses the same path-substring
      // check rbac.ts's isInScope does, applied in the opposite direction
      // ("is the target an ancestor of the parent" instead of "is the actor
      // an ancestor of the candidate").
      if (parentPlacement.path.includes(`/${params.associateId}/`)) {
        throw new CycleDetectedError(params.associateId, params.newParentId);
      }

      newPath = `${parentPlacement.path}${params.newParentId}/`;
      newDepth = parentPlacement.depth + 1;
    } else {
      newPath = "/";
      newDepth = 0;
    }

    if (currentPlacement) {
      await tx.associateHierarchy.update({ where: { id: currentPlacement.id }, data: { validTo: now } });
    }

    const created = await tx.associateHierarchy.create({
      data: { associateId: associate.id, parentId: params.newParentId, path: newPath, depth: newDepth, validFrom: now },
    });

    // Subtree recompute: every associate whose CURRENT path names this
    // associate as an ancestor gets its path prefix rewritten and its
    // depth shifted by however much this associate's own depth changed.
    let subtreeSize = 0;
    if (currentPlacement) {
      const oldPrefix = `${currentPlacement.path}${params.associateId}/`;
      const descendants = await tx.associateHierarchy.findMany({ where: { validTo: null, path: { startsWith: oldPrefix } } });
      const depthDelta = newDepth - currentPlacement.depth;
      const newPrefix = `${newPath}${params.associateId}/`;
      for (const descendant of descendants) {
        await tx.associateHierarchy.update({
          where: { id: descendant.id },
          data: { path: newPrefix + descendant.path.slice(oldPrefix.length), depth: descendant.depth + depthDelta },
        });
      }
      subtreeSize = descendants.length;
    }

    await tx.hierarchyChangeLog.create({
      data: {
        orgId: params.audit.orgId,
        associateId: params.associateId,
        fromParentId: currentPlacement?.parentId ?? null,
        toParentId: params.newParentId,
        reason: params.reason,
        movedById: actorId,
        subtreeSize,
      },
    });

    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "AssociateHierarchy",
      entityId: created.id,
      before: currentPlacement ? auditSnapshot(currentPlacement) : undefined,
      after: auditSnapshot(created),
      reason: params.reason,
    });

    return created;
  });
}

// ── Read ───────────────────────────────────────────────────────────────

export interface AssociateSummary {
  associateId: string;
  code: string;
  name: string;
  status: string;
  gradeCode: string | null;
  parentId: string | null;
  depth: number;
}

async function summarize(
  db: PrismaClient | PrismaNS.TransactionClient,
  associateIds: readonly string[],
): Promise<AssociateSummary[]> {
  if (associateIds.length === 0) return [];
  const rows = await db.associate.findMany({
    where: { id: { in: [...associateIds] } },
    select: {
      id: true,
      code: true,
      status: true,
      user: { select: { name: true } },
      grades: { where: { validTo: null }, select: { grade: { select: { code: true } } }, take: 1 },
      hierarchyAsChild: { where: { validTo: null }, select: { parentId: true, depth: true }, take: 1 },
    },
  });
  return rows.map((row) => ({
    associateId: row.id,
    code: row.code,
    name: row.user.name,
    status: row.status,
    gradeCode: row.grades[0]?.grade.code ?? null,
    parentId: row.hierarchyAsChild[0]?.parentId ?? null,
    depth: row.hierarchyAsChild[0]?.depth ?? 0,
  }));
}

/** Scoped exactly as docs/09-RBAC-MATRIX.md documents associate.read:
 *  ASSOCIATE sees own, TEAM_LEAD sees own + downline, admin-shaped roles
 *  and AUDITOR see the whole org -- resolved through the ONE scope
 *  resolver, never a hand-rolled filter. */
export async function listAssociates(db: PrismaClient, params: { orgId: string; actorId: string }): Promise<AssociateSummary[]> {
  await assertPermission(db, params.actorId, READ_PERMISSION);

  const roleCodes = await resolveActorRoleCodes(db, params.actorId);
  const isUnrestricted = [...roleCodes].some((r) => ADMIN_ROLE_CODES.has(r));

  if (isUnrestricted) {
    const all = await db.associate.findMany({ where: { orgId: params.orgId }, select: { id: true } });
    return summarize(db, all.map((a) => a.id));
  }

  const caller = await db.associate.findUnique({ where: { userId: params.actorId }, select: { id: true } });
  if (!caller) return [];
  const mode: ScopeMode = roleCodes.has("TEAM_LEAD") ? "OWN_AND_DOWNLINE" : "OWN";
  const accessible = await getAccessibleAssociateIds(db, caller.id, mode);
  return summarize(db, accessible);
}

export interface AssociateTree {
  associate: AssociateSummary;
  downline: AssociateSummary[];
}

/** GET /associates/:id/tree -- the associate plus their current downline,
 *  same scope rule as listAssociates (an ASSOCIATE may only view their own
 *  tree; a TEAM_LEAD, their downline's). */
export async function getAssociateTree(db: PrismaClient, params: { associateId: string; orgId: string; actorId: string }): Promise<AssociateTree> {
  await assertPermission(db, params.actorId, READ_PERMISSION);

  const target = await db.associate.findFirst({ where: { id: params.associateId, orgId: params.orgId }, select: { id: true } });
  if (!target) throw new AssociateNotFoundError(params.associateId);

  const roleCodes = await resolveActorRoleCodes(db, params.actorId);
  if (![...roleCodes].some((r) => ADMIN_ROLE_CODES.has(r))) {
    const caller = await db.associate.findUnique({ where: { userId: params.actorId }, select: { id: true } });
    if (!caller) throw new ForbiddenError("This account has no associate profile.");
    const mode: ScopeMode = roleCodes.has("TEAM_LEAD") ? "OWN_AND_DOWNLINE" : "OWN";
    const accessible = await getAccessibleAssociateIds(db, caller.id, mode);
    if (!accessible.includes(params.associateId)) {
      throw new ForbiddenError(`Associate ${params.associateId} is outside this session's scope.`);
    }
  }

  const placement = await db.associateHierarchy.findFirst({ where: { associateId: params.associateId, validTo: null } });
  const downlineIds = placement
    ? (await db.associateHierarchy.findMany({ where: { validTo: null, path: { startsWith: `${placement.path}${params.associateId}/` } }, select: { associateId: true } })).map((r) => r.associateId)
    : [];

  const [associateSummary] = await summarize(db, [params.associateId]);
  const downline = await summarize(db, downlineIds);
  return { associate: associateSummary!, downline };
}
