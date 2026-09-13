// Append-only audit logging -- see docs/10-SECURITY.md. Never update or
// delete an AuditLog row; there is deliberately no updateAuditLog export.
import { Prisma } from "@desire/db";
import type { PrismaClient, AuditAction, AuditLog } from "@desire/db";
import { assertPermission } from "./rbac";

const READ_PERMISSION = "audit.read";

export interface AuditContext {
  orgId: string;
  /** null for system/job actors -- e.g. a scheduled sweep. */
  actorId: string | null;
  /** Denormalised on purpose: the actor may later be deleted, but the audit
   *  trail must still say who did it. */
  actorLabel: string;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

export interface AuditEntryInput {
  action: AuditAction;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/** Writes one audit row. Takes a Prisma transaction client (or the plain
 *  client) so callers can include the audit write in the SAME transaction as
 *  the mutation it describes -- an audited mutation and its audit row must
 *  commit or roll back together, never one without the other. */
export async function writeAuditLog(
  tx: PrismaClient | Prisma.TransactionClient,
  ctx: AuditContext,
  entry: AuditEntryInput,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      orgId: ctx.orgId,
      actorId: ctx.actorId,
      actorLabel: ctx.actorLabel,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      before: toJsonInput(entry.before),
      after: toJsonInput(entry.after),
      reason: entry.reason,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    },
  });
}

// Prisma's JSON column rejects `undefined` (it wants Prisma.JsonNull or a
// concrete value) -- undefined here means "not applicable" (e.g. no `before`
// state on a CREATE), which Prisma.DbNull represents correctly without
// forcing every caller to remember the distinction themselves.
function toJsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

export interface ListAuditLogParams {
  orgId: string;
  actorId: string;
  entity?: string;
  action?: AuditAction;
  /** Capped at 500 -- a browsing screen, not a bulk export (docs/20-REPORTS.md
   *  covers CSV/XLSX export properly and is explicitly out of this phase). */
  take?: number;
}

/** Phase 3.5 Slice 15 -- confirmed gap, `writeAuditLog` is used everywhere
 *  but nothing ever read the log back. Org-wide by design: this is the
 *  compliance/audit view (audit.read, held by SUPER_ADMIN/AUDITOR/
 *  FINANCE_ADMIN per docs/09-RBAC-MATRIX.md), not a per-associate one. */
export async function listAuditLog(db: PrismaClient, params: ListAuditLogParams): Promise<AuditLog[]> {
  await assertPermission(db, params.actorId, READ_PERMISSION);
  return db.auditLog.findMany({
    where: {
      orgId: params.orgId,
      ...(params.entity ? { entity: params.entity } : {}),
      ...(params.action ? { action: params.action } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(params.take ?? 100, 500),
  });
}
