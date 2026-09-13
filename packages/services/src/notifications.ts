// Notifications -- Phase 2 Slice 7 (PROGRESS.md, docs/05-COLLECTIONS-SPEC.md:
// "Offsets, audiences and channels are NotificationRule rows, not code").
//
// STATED PLAINLY, NOT HIDDEN: nothing in this file sends an EMAIL/WHATSAPP/
// SMS-channel Notification anywhere. Every row this creates is left
// QUEUED forever until a real provider is chosen and wired -- a follow-up,
// not a defect in this slice, matching /api/health's own honest "not yet
// implemented". What IS real and useful immediately: IN_APP notifications,
// queued by evaluateNotificationRules and readable via listNotifications.
import { Prisma } from "@desire/db";
import type { PrismaClient, Prisma as PrismaNS, NotificationRule, Notification, NotificationChannel } from "@desire/db";
export type { NotificationRule, Notification };
import { writeAuditLog, type AuditContext } from "./audit";
import { assertPermission, ForbiddenError } from "./rbac";

const RULE_PERMISSION = "rbac.manage";

// ── Errors ─────────────────────────────────────────────────────────────

export class DuplicateNotificationRuleCodeError extends Error {
  constructor(public readonly code: string) {
    super(`Notification rule code "${code}" is already in use for this organisation.`);
    this.name = "DuplicateNotificationRuleCodeError";
  }
}

export class NotificationRuleNotFoundError extends Error {
  constructor(public readonly ruleId: string) {
    super(`Notification rule ${ruleId} not found.`);
    this.name = "NotificationRuleNotFoundError";
  }
}

// ── Shared helpers (duplicated per file -- this codebase's own convention)

function requireActor(audit: AuditContext): string {
  if (!audit.actorId) {
    throw new ForbiddenError("Notification rule mutations require a user actor, not a system actor.");
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

// ── Rule config ──────────────────────────────────────────────────────────

export interface CreateNotificationRuleParams {
  code: string;
  name: string;
  channels: NotificationChannel[];
  /** Role codes and/or relative targets ("ASSOCIATE" = the event's own
   *  associate, "UPLINE_L1" = their immediate parent) -- schema comment on
   *  NotificationRule.audience. */
  audience: string[];
  offsetDays?: number | null;
  templateKey: string;
  escalates?: boolean;
  audit: AuditContext;
}

/** Config, gated the same way RBAC config itself is (rbac.manage,
 *  SUPER_ADMIN only) -- deciding who gets notified about what is a policy
 *  decision, not routine work, and NotificationRule has no projectId to
 *  scope it any narrower. No route exists for this yet (the plan's own
 *  scope for this slice is evaluateNotificationRules + the read endpoint);
 *  built and tested as a service only so evaluateNotificationRules has
 *  something real to evaluate against. */
export async function createNotificationRule(db: PrismaClient, params: CreateNotificationRuleParams): Promise<NotificationRule> {
  const actorId = requireActor(params.audit);

  return db.$transaction(async (tx) => {
    await assertPermission(tx, actorId, RULE_PERMISSION);

    let rule: NotificationRule;
    try {
      rule = await tx.notificationRule.create({
        data: {
          orgId: params.audit.orgId,
          code: params.code,
          name: params.name,
          channels: params.channels,
          audience: params.audience,
          offsetDays: params.offsetDays ?? undefined,
          templateKey: params.templateKey,
          escalates: params.escalates ?? undefined,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new DuplicateNotificationRuleCodeError(params.code);
      }
      throw err;
    }

    await writeAuditLog(tx, params.audit, { action: "CREATE", entity: "NotificationRule", entityId: rule.id, after: auditSnapshot(rule) });
    return rule;
  });
}

// ── Evaluation ───────────────────────────────────────────────────────────

/** "ASSOCIATE" resolves to the event's own selling/owning associate;
 *  "UPLINE_L1" to their immediate parent -- the exact same immediate-
 *  parent lookup collections-sweep.ts's recipientsFor already does for
 *  CollectionAlert.recipients, duplicated here per this codebase's own
 *  convention rather than shared. Anything else is treated as a role code:
 *  every user in this org holding that role. */
async function resolveAudienceUserIds(
  tx: PrismaNS.TransactionClient,
  params: { orgId: string; audience: string[]; associateId?: string | null },
): Promise<Set<string>> {
  const userIds = new Set<string>();

  for (const target of params.audience) {
    if (target === "ASSOCIATE") {
      if (!params.associateId) continue;
      const associate = await tx.associate.findUnique({ where: { id: params.associateId }, select: { userId: true } });
      if (associate) userIds.add(associate.userId);
    } else if (target === "UPLINE_L1") {
      if (!params.associateId) continue;
      const hierarchy = await tx.associateHierarchy.findFirst({ where: { associateId: params.associateId, validTo: null } });
      if (hierarchy?.parentId) {
        const parent = await tx.associate.findUnique({ where: { id: hierarchy.parentId }, select: { userId: true } });
        if (parent) userIds.add(parent.userId);
      }
    } else {
      const holders = await tx.userRole.findMany({ where: { role: { orgId: params.orgId, code: target } }, select: { userId: true } });
      for (const holder of holders) userIds.add(holder.userId);
    }
  }

  return userIds;
}

export interface EvaluateNotificationRulesParams {
  orgId: string;
  /** Matches NotificationRule.code exactly -- e.g. "DEMAND_OVERDUE_1",
   *  "RECEIPT_CHEQUE_BOUNCED". The caller (collections-sweep.ts,
   *  receipts.ts) picks the code for the event that just happened. */
  code: string;
  /** Resolves "ASSOCIATE"/"UPLINE_L1" in the rule's audience, when set. */
  associateId?: string | null;
  title: string;
  body: string;
  actionUrl?: string | null;
  entity?: string | null;
  entityId?: string | null;
}

/** Given an ENABLED NotificationRule matching `code`, resolves its audience
 *  into real userIds and creates one Notification row per (user, channel)
 *  in the rule's channels[], status QUEUED. A no-op, not an error, when no
 *  such rule exists or it is disabled -- exactly how an unconfigured
 *  feature should behave (docs/07-API.md's own "not yet implemented"
 *  honesty, not a thrown exception for missing config). Takes a bare
 *  db/tx so callers already inside a transaction (the collections sweep,
 *  bounceReceipt) can pass their own `tx` rather than opening a nested
 *  transaction. */
export async function evaluateNotificationRules(
  db: PrismaClient | PrismaNS.TransactionClient,
  params: EvaluateNotificationRulesParams,
): Promise<Notification[]> {
  const rule = await db.notificationRule.findUnique({ where: { orgId_code: { orgId: params.orgId, code: params.code } } });
  if (!rule || !rule.enabled) return [];

  const userIds = await resolveAudienceUserIds(db, { orgId: params.orgId, audience: rule.audience, associateId: params.associateId });
  if (userIds.size === 0 || rule.channels.length === 0) return [];

  const notifications: Notification[] = [];
  for (const userId of userIds) {
    for (const channel of rule.channels) {
      const notification = await db.notification.create({
        data: {
          orgId: params.orgId,
          userId,
          channel,
          ruleCode: rule.code,
          title: params.title,
          body: params.body,
          actionUrl: params.actionUrl ?? undefined,
          entity: params.entity ?? undefined,
          entityId: params.entityId ?? undefined,
        },
      });
      notifications.push(notification);
    }
  }

  return notifications;
}

// ── Read ───────────────────────────────────────────────────────────────

/** Own notifications only -- there is no scope split to resolve here (a
 *  notification already targets exactly one user), so no permission check
 *  beyond authentication is needed, the same posture as a booking-preview
 *  read. No markAsRead exists yet (not asked for by this slice), so
 *  `readAt` is a real but currently-unset column -- not filtered on here. */
export async function listNotifications(db: PrismaClient, params: { userId: string }): Promise<Notification[]> {
  return db.notification.findMany({
    where: { userId: params.userId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

// ── Rule config: read + enable/disable ──────────────────────────────────

/** Phase 3.5 Slice 15 -- Admin > Notification rules. createNotificationRule
 *  already existed (built in Phase 2 as a service only, with no route or
 *  screen); this adds exactly what the plan calls for reading the config
 *  and toggling it, not a redesign of the rule shape itself. */
export async function listNotificationRules(db: PrismaClient, params: { orgId: string; actorId: string }): Promise<NotificationRule[]> {
  await assertPermission(db, params.actorId, RULE_PERMISSION);
  return db.notificationRule.findMany({ where: { orgId: params.orgId }, orderBy: { code: "asc" } });
}

export async function updateNotificationRule(
  db: PrismaClient,
  params: { ruleId: string; enabled: boolean; audit: AuditContext },
): Promise<NotificationRule> {
  const actorId = requireActor(params.audit);

  return db.$transaction(async (tx) => {
    await assertPermission(tx, actorId, RULE_PERMISSION);

    const existing = await tx.notificationRule.findUnique({ where: { id: params.ruleId } });
    if (!existing) throw new NotificationRuleNotFoundError(params.ruleId);
    if (existing.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Notification rule ${params.ruleId} belongs to another organisation.`);
    }

    const updated = await tx.notificationRule.update({ where: { id: existing.id }, data: { enabled: params.enabled } });

    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "NotificationRule",
      entityId: updated.id,
      before: { enabled: existing.enabled },
      after: { enabled: updated.enabled },
    });

    return updated;
  });
}
