// CRM: Lead, LeadClaim, LeadActivity, SiteVisit -- Phase 2 Slice 3
// (PROGRESS.md, docs/07-API.md's Leads table). Independent of
// Booking/Collections -- Booking.leadId is nullable, so none of this needs a
// Booking to exist, and nothing in bookings.ts needs to change for it.
//
// "Claim" is not a separate action/route: docs/07-API.md says lead creation
// itself "runs dedup on phoneHash; returns a conflict if a live claim
// exists" -- so createLead both creates the Lead AND its first LeadClaim in
// one transaction. A lead whose claim has since expired ("on expiry the lead
// returns to the pool", schema comment) is reclaimed via reassignLead, the
// only other place a LeadClaim is created.
import { createHash } from "node:crypto";
import { Prisma } from "@desire/db";
import type {
  PrismaClient,
  Prisma as PrismaNS,
  Lead,
  LeadClaim,
  LeadActivity,
  SiteVisit,
  LeadSource,
  LeadStage,
  ActivityType,
} from "@desire/db";
export type { Lead, LeadClaim, LeadActivity, SiteVisit, LeadSource, LeadStage, ActivityType };
import { writeAuditLog, type AuditContext } from "./audit";
import { assertPermission, ForbiddenError, getAccessibleAssociateIds, type ScopeMode } from "./rbac";

const READ_PERMISSION = "lead.read";
const WRITE_PERMISSION = "lead.write";
const ACTIVITY_PERMISSION = "lead.activity";
const REASSIGN_PERMISSION = "lead.reassign";
const SITEVISIT_PERMISSION = "sitevisit.create";

// PLACEHOLDER -- the schema's own comment on LeadClaim names 90 days, not
// yet confirmed by the client (same status as the hold-TTL/discount-band
// placeholders elsewhere in this project).
const CLAIM_WINDOW_DAYS = 90;

const ADMIN_ROLE_CODES: ReadonlySet<string> = new Set(["SUPER_ADMIN", "SALES_HEAD", "SALES_ADMIN"]);

// ── Errors ─────────────────────────────────────────────────────────────

export class LeadNotFoundError extends Error {
  constructor(public readonly leadId: string) {
    super(`Lead ${leadId} not found.`);
    this.name = "LeadNotFoundError";
  }
}

/** Names the associate already holding the live claim, not just "conflict"
 *  -- docs/07-API.md: a walk-in matching a live claim must surface WHO owns
 *  it, not silently merge or silently create a duplicate lead. */
export class LiveClaimConflictError extends Error {
  constructor(
    public readonly phoneHash: string,
    public readonly claimingAssociateId: string,
  ) {
    super(`A live claim on this phone number is already held by associate ${claimingAssociateId}.`);
    this.name = "LiveClaimConflictError";
  }
}

export class ReassignReasonRequiredError extends Error {
  constructor(public readonly leadId: string) {
    super(`Reassigning lead ${leadId} requires a reason.`);
    this.name = "ReassignReasonRequiredError";
  }
}

export class StageChangeRequiresToStageError extends Error {
  constructor(public readonly leadId: string) {
    super(`Logging a STAGE_CHANGE activity on lead ${leadId} requires toStage.`);
    this.name = "StageChangeRequiresToStageError";
  }
}

export class SiteVisitNotFoundError extends Error {
  constructor(public readonly siteVisitId: string) {
    super(`Site visit ${siteVisitId} not found.`);
    this.name = "SiteVisitNotFoundError";
  }
}

// ── Shared helpers (duplicated per file -- this codebase's own convention,
//    see projects.ts/price-lists.ts/bookings.ts/discounts.ts) ────────────

function requireActor(audit: AuditContext): string {
  if (!audit.actorId) {
    throw new ForbiddenError("Lead mutations require a user actor, not a system actor.");
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

function auditDiff(existing: object, patch: object): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const current = existing as Record<string, unknown>;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [key, next] of Object.entries(patch)) {
    before[key] = toAuditValue(current[key]);
    after[key] = toAuditValue(next);
  }
  return { before, after };
}

/** PLACEHOLDER India-only E.164 normalisation -- every phone example
 *  anywhere in this codebase (seed data, test fixtures, docs) is a bare
 *  10-digit Indian mobile number with no country code. Good enough to make
 *  the SAME real number hash identically regardless of how it was typed;
 *  not a general international phone library. Revisit if this platform ever
 *  needs to accept non-Indian numbers. */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return digits.startsWith("+") ? phone : `+${digits}`;
}

/** SHA-256 -- matches the schema's own comment on Lead.phoneHash/emailHash
 *  exactly: "SHA-256 of the normalised phone (E.164) and lowercased email".
 *  Exported so a test can assert dedup behaves the same regardless of input
 *  formatting without going through a whole createLead call. */
export function hashForDedup(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function resolveActorRoleCodes(
  tx: PrismaClient | PrismaNS.TransactionClient,
  actorId: string,
): Promise<Set<string>> {
  const roles = await tx.userRole.findMany({
    where: { userId: actorId },
    select: { role: { select: { code: true } } },
  });
  return new Set(roles.map((r) => r.role.code));
}

/** Resolves who a lead.write/reassign caller may name as the assignee.
 *  Same shape as bookings.ts's resolveSellingAssociateId (admin-shaped role,
 *  or TEAM_LEAD naming a downline associate, or defaulting to the caller's
 *  own Associate row) -- but checks the admin/downline bypass BEFORE
 *  requiring the caller to have their own Associate row, since a pure
 *  manager account (SUPER_ADMIN/SALES_HEAD/SALES_ADMIN, no Associate
 *  profile) must still be able to assign a lead to someone else. */
async function resolveAssigneeId(
  tx: PrismaNS.TransactionClient,
  params: { callerUserId: string; requested?: string | null },
): Promise<string> {
  if (params.requested) {
    const roleCodes = await resolveActorRoleCodes(tx, params.callerUserId);
    if ([...roleCodes].some((r) => ADMIN_ROLE_CODES.has(r))) return params.requested;
    if (roleCodes.has("TEAM_LEAD")) {
      const caller = await tx.associate.findUnique({ where: { userId: params.callerUserId }, select: { id: true } });
      if (caller) {
        const accessible = await getAccessibleAssociateIds(tx, caller.id, "OWN_AND_DOWNLINE");
        if (accessible.includes(params.requested)) return params.requested;
      }
    }
  }

  const caller = await tx.associate.findUnique({ where: { userId: params.callerUserId }, select: { id: true } });
  if (caller && (!params.requested || params.requested === caller.id)) return caller.id;

  throw new ForbiddenError(
    params.requested
      ? `This session may not assign a lead to associate ${params.requested}; only their own team, if they lead one.`
      : "This account has no associate profile; only associates can be assigned a lead.",
  );
}

/** Enforces the OWN vs OWN+DOWNLINE split docs/09-RBAC-MATRIX.md documents
 *  for lead.read against a SPECIFIC, already-loaded lead -- holding
 *  lead.write/lead.activity/sitevisit.create/lead.reassign (all flat ✓ for
 *  TEAM_LEAD/ASSOCIATE in the matrix, same shape as booking.create) answers
 *  "can you do this at all", not "is THIS lead yours". An admin-shaped role
 *  is unrestricted; an unassigned lead (assignedAssociateId null) is nobody
 *  else's yet, so it is out of scope for a non-admin. */
async function assertLeadInScope(
  tx: PrismaNS.TransactionClient,
  params: { callerUserId: string; assignedAssociateId: string | null },
): Promise<void> {
  const roleCodes = await resolveActorRoleCodes(tx, params.callerUserId);
  if ([...roleCodes].some((r) => ADMIN_ROLE_CODES.has(r))) return;

  const caller = await tx.associate.findUnique({ where: { userId: params.callerUserId }, select: { id: true } });
  if (caller && params.assignedAssociateId) {
    if (roleCodes.has("TEAM_LEAD")) {
      const accessible = await getAccessibleAssociateIds(tx, caller.id, "OWN_AND_DOWNLINE");
      if (accessible.includes(params.assignedAssociateId)) return;
    } else if (params.assignedAssociateId === caller.id) {
      return;
    }
  }
  throw new ForbiddenError("This lead is outside this session's scope.");
}

// ── Create ─────────────────────────────────────────────────────────────

export interface CreateLeadParams {
  name: string;
  phone: string;
  email?: string | null;
  altPhone?: string | null;
  source: LeadSource;
  sourceDetail?: string | null;
  campaignRef?: string | null;
  projectId?: string | null;
  budgetMin?: Prisma.Decimal | string | null;
  budgetMax?: Prisma.Decimal | string | null;
  preferredTypes?: string[];
  requirementNote?: string | null;
  /** Defaults to the caller's own Associate row -- see resolveAssigneeId. */
  assignToAssociateId?: string | null;
  audit: AuditContext;
}

export async function createLead(db: PrismaClient, params: CreateLeadParams): Promise<Lead> {
  const actorId = requireActor(params.audit);
  const now = new Date();
  const phoneHash = hashForDedup(normalizePhone(params.phone));
  const emailHash = params.email ? hashForDedup(params.email.toLowerCase()) : null;

  return db.$transaction(async (tx) => {
    await assertPermission(tx, actorId, WRITE_PERMISSION, { projectId: params.projectId ?? undefined });

    const assigneeId = await resolveAssigneeId(tx, { callerUserId: actorId, requested: params.assignToAssociateId });

    const conflictingClaim = await tx.leadClaim.findFirst({
      where: { releasedAt: null, expiresAt: { gt: now }, lead: { orgId: params.audit.orgId, phoneHash } },
      orderBy: { claimedAt: "desc" },
    });
    if (conflictingClaim) {
      throw new LiveClaimConflictError(phoneHash, conflictingClaim.associateId);
    }

    const lead = await tx.lead.create({
      data: {
        orgId: params.audit.orgId,
        projectId: params.projectId ?? undefined,
        name: params.name,
        phone: params.phone,
        email: params.email ?? undefined,
        altPhone: params.altPhone ?? undefined,
        phoneHash,
        emailHash: emailHash ?? undefined,
        source: params.source,
        sourceDetail: params.sourceDetail ?? undefined,
        campaignRef: params.campaignRef ?? undefined,
        budgetMin: params.budgetMin != null ? new Prisma.Decimal(params.budgetMin) : undefined,
        budgetMax: params.budgetMax != null ? new Prisma.Decimal(params.budgetMax) : undefined,
        preferredTypes: params.preferredTypes ?? [],
        requirementNote: params.requirementNote ?? undefined,
        assignedAssociateId: assigneeId,
        assignedAt: now,
      },
    });

    await tx.leadClaim.create({
      data: {
        leadId: lead.id,
        associateId: assigneeId,
        claimedAt: now,
        expiresAt: new Date(now.getTime() + CLAIM_WINDOW_DAYS * 24 * 60 * 60_000),
      },
    });

    await writeAuditLog(tx, params.audit, {
      action: "CREATE",
      entity: "Lead",
      entityId: lead.id,
      after: auditSnapshot(lead),
    });

    return lead;
  });
}

// ── Update ─────────────────────────────────────────────────────────────

export interface UpdateLeadParams {
  leadId: string;
  name?: string;
  email?: string | null;
  altPhone?: string | null;
  budgetMin?: Prisma.Decimal | string | null;
  budgetMax?: Prisma.Decimal | string | null;
  preferredTypes?: string[];
  requirementNote?: string | null;
  audit: AuditContext;
}

export async function updateLead(db: PrismaClient, params: UpdateLeadParams): Promise<Lead> {
  const actorId = requireActor(params.audit);

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "leads" WHERE "id" = ${params.leadId} FOR UPDATE`;

    const existing = await tx.lead.findUnique({ where: { id: params.leadId } });
    if (!existing) throw new LeadNotFoundError(params.leadId);
    if (existing.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Lead ${params.leadId} belongs to another organisation.`);
    }

    await assertPermission(tx, actorId, WRITE_PERMISSION, { projectId: existing.projectId ?? undefined });
    await assertLeadInScope(tx, { callerUserId: actorId, assignedAssociateId: existing.assignedAssociateId });

    // phone/stage are deliberately NOT patchable here: phone drives the
    // dedup hash (changing it is a bigger structural concern than a field
    // edit) and stage moves only through logActivity's STAGE_CHANGE, which
    // also records WHY (docs/07-API.md's activity log is the stage history).
    const data: Prisma.LeadUncheckedUpdateInput = {};
    if (params.name !== undefined) data.name = params.name;
    if (params.email !== undefined) {
      data.email = params.email;
      data.emailHash = params.email ? hashForDedup(params.email.toLowerCase()) : null;
    }
    if (params.altPhone !== undefined) data.altPhone = params.altPhone;
    if (params.budgetMin !== undefined) data.budgetMin = params.budgetMin == null ? null : new Prisma.Decimal(params.budgetMin);
    if (params.budgetMax !== undefined) data.budgetMax = params.budgetMax == null ? null : new Prisma.Decimal(params.budgetMax);
    if (params.preferredTypes !== undefined) data.preferredTypes = params.preferredTypes;
    if (params.requirementNote !== undefined) data.requirementNote = params.requirementNote;

    if (Object.keys(data).length === 0) return existing;

    const updated = await tx.lead.update({ where: { id: existing.id }, data });
    const { before, after } = auditDiff(existing, data);
    await writeAuditLog(tx, params.audit, { action: "UPDATE", entity: "Lead", entityId: updated.id, before, after });

    return updated;
  });
}

// ── Activity ───────────────────────────────────────────────────────────

export interface LogActivityParams {
  leadId: string;
  type: ActivityType;
  subject?: string | null;
  notes?: string | null;
  outcome?: string | null;
  /** Required when type is STAGE_CHANGE. */
  toStage?: LeadStage;
  dueAt?: Date | null;
  completedAt?: Date | null;
  audit: AuditContext;
}

export async function logActivity(db: PrismaClient, params: LogActivityParams): Promise<LeadActivity> {
  const actorId = requireActor(params.audit);
  const now = new Date();

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "leads" WHERE "id" = ${params.leadId} FOR UPDATE`;

    const lead = await tx.lead.findUnique({ where: { id: params.leadId } });
    if (!lead) throw new LeadNotFoundError(params.leadId);
    if (lead.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Lead ${params.leadId} belongs to another organisation.`);
    }

    await assertPermission(tx, actorId, ACTIVITY_PERMISSION, { projectId: lead.projectId ?? undefined });
    await assertLeadInScope(tx, { callerUserId: actorId, assignedAssociateId: lead.assignedAssociateId });

    if (params.type === "STAGE_CHANGE" && !params.toStage) {
      throw new StageChangeRequiresToStageError(params.leadId);
    }

    const caller = await tx.associate.findUnique({ where: { userId: actorId }, select: { id: true } });

    const activity = await tx.leadActivity.create({
      data: {
        leadId: lead.id,
        associateId: caller?.id ?? undefined,
        type: params.type,
        subject: params.subject ?? undefined,
        notes: params.notes ?? undefined,
        outcome: params.outcome ?? undefined,
        fromStage: params.type === "STAGE_CHANGE" ? lead.stage : undefined,
        toStage: params.type === "STAGE_CHANGE" ? params.toStage : undefined,
        dueAt: params.dueAt ?? undefined,
        completedAt: params.completedAt ?? undefined,
      },
    });

    await tx.lead.update({
      where: { id: lead.id },
      data: {
        lastContactAt: now,
        ...(params.type === "STAGE_CHANGE" ? { stage: params.toStage } : {}),
      },
    });

    await writeAuditLog(tx, params.audit, {
      action: "CREATE",
      entity: "LeadActivity",
      entityId: activity.id,
      after: auditSnapshot(activity),
    });

    return activity;
  });
}

// ── Reassign ───────────────────────────────────────────────────────────

export interface ReassignLeadParams {
  leadId: string;
  toAssociateId: string;
  reason: string;
  audit: AuditContext;
}

export async function reassignLead(db: PrismaClient, params: ReassignLeadParams): Promise<Lead> {
  const actorId = requireActor(params.audit);
  const now = new Date();

  if (!params.reason || !params.reason.trim()) {
    throw new ReassignReasonRequiredError(params.leadId);
  }

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "leads" WHERE "id" = ${params.leadId} FOR UPDATE`;

    const lead = await tx.lead.findUnique({ where: { id: params.leadId } });
    if (!lead) throw new LeadNotFoundError(params.leadId);
    if (lead.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Lead ${params.leadId} belongs to another organisation.`);
    }

    await assertPermission(tx, actorId, REASSIGN_PERMISSION, { projectId: lead.projectId ?? undefined });
    await assertLeadInScope(tx, { callerUserId: actorId, assignedAssociateId: lead.assignedAssociateId });

    // The TARGET must also be within a TEAM_LEAD's own scope -- otherwise
    // "own + downline" would let them hand a lead OUT to someone outside
    // their team, which the doc's T annotation does not intend. Reuses the
    // exact same admin/downline resolution createLead uses for its assignee.
    const toAssociateId = await resolveAssigneeId(tx, { callerUserId: actorId, requested: params.toAssociateId });

    await tx.leadClaim.updateMany({
      where: { leadId: lead.id, releasedAt: null },
      data: { releasedAt: now, releaseReason: `Reassigned: ${params.reason}` },
    });
    await tx.leadClaim.create({
      data: {
        leadId: lead.id,
        associateId: toAssociateId,
        claimedAt: now,
        expiresAt: new Date(now.getTime() + CLAIM_WINDOW_DAYS * 24 * 60 * 60_000),
      },
    });

    const before = auditSnapshot(lead);
    const updated = await tx.lead.update({
      where: { id: lead.id },
      data: { assignedAssociateId: toAssociateId, assignedAt: now },
    });

    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "Lead",
      entityId: updated.id,
      before,
      after: auditSnapshot(updated),
      reason: params.reason,
    });

    return updated;
  });
}

// ── Site visits ────────────────────────────────────────────────────────

export interface ScheduleSiteVisitParams {
  leadId: string;
  projectId: string;
  scheduledAt: Date;
  /** Defaults to the caller's own Associate row -- see resolveAssigneeId. */
  assignToAssociateId?: string | null;
  audit: AuditContext;
}

export async function scheduleSiteVisit(db: PrismaClient, params: ScheduleSiteVisitParams): Promise<SiteVisit> {
  const actorId = requireActor(params.audit);

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "leads" WHERE "id" = ${params.leadId} FOR UPDATE`;

    const lead = await tx.lead.findUnique({ where: { id: params.leadId } });
    if (!lead) throw new LeadNotFoundError(params.leadId);
    if (lead.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Lead ${params.leadId} belongs to another organisation.`);
    }

    await assertPermission(tx, actorId, SITEVISIT_PERMISSION, { projectId: params.projectId });
    await assertLeadInScope(tx, { callerUserId: actorId, assignedAssociateId: lead.assignedAssociateId });

    const associateId = await resolveAssigneeId(tx, { callerUserId: actorId, requested: params.assignToAssociateId });

    const visit = await tx.siteVisit.create({
      data: {
        orgId: params.audit.orgId,
        leadId: lead.id,
        projectId: params.projectId,
        associateId,
        scheduledAt: params.scheduledAt,
      },
    });

    await writeAuditLog(tx, params.audit, {
      action: "CREATE",
      entity: "SiteVisit",
      entityId: visit.id,
      after: auditSnapshot(visit),
    });

    return visit;
  });
}

export interface CompleteSiteVisitParams {
  siteVisitId: string;
  completedAt?: Date;
  feedback?: string | null;
  interestLevel?: number | null;
  unitsShown?: string[];
  audit: AuditContext;
}

/** Structural only this slice -- no route wires to it yet (docs/07-API.md's
 *  Leads table names only POST /leads/:id/site-visits, i.e. scheduling; a
 *  completion endpoint was never specified). Built and tested because
 *  without it SiteVisit.completedAt/feedback/interestLevel would be
 *  permanently unreachable columns. */
export async function completeSiteVisit(db: PrismaClient, params: CompleteSiteVisitParams): Promise<SiteVisit> {
  const actorId = requireActor(params.audit);
  const now = params.completedAt ?? new Date();

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "site_visits" WHERE "id" = ${params.siteVisitId} FOR UPDATE`;

    const visit = await tx.siteVisit.findUnique({ where: { id: params.siteVisitId } });
    if (!visit) throw new SiteVisitNotFoundError(params.siteVisitId);
    if (visit.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Site visit ${params.siteVisitId} belongs to another organisation.`);
    }

    const lead = await tx.lead.findUniqueOrThrow({ where: { id: visit.leadId } });
    await assertPermission(tx, actorId, SITEVISIT_PERMISSION, { projectId: visit.projectId });
    await assertLeadInScope(tx, { callerUserId: actorId, assignedAssociateId: lead.assignedAssociateId });

    const before = auditSnapshot(visit);
    const updated = await tx.siteVisit.update({
      where: { id: visit.id },
      data: {
        completedAt: now,
        feedback: params.feedback ?? undefined,
        interestLevel: params.interestLevel ?? undefined,
        unitsShown: params.unitsShown ?? undefined,
      },
    });

    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "SiteVisit",
      entityId: updated.id,
      before,
      after: auditSnapshot(updated),
    });

    return updated;
  });
}

// ── Read ───────────────────────────────────────────────────────────────

export interface ListLeadsParams {
  orgId: string;
  actorId: string;
  stage?: LeadStage;
  projectId?: string;
}

/** Scoped exactly as docs/09-RBAC-MATRIX.md documents lead.read: ASSOCIATE
 *  sees own, TEAM_LEAD sees own + downline, everyone else with the
 *  permission (admin-shaped roles, AUDITOR) sees the whole org -- resolved
 *  through the ONE scope resolver, never a hand-rolled filter. */
export async function listLeads(db: PrismaClient, params: ListLeadsParams): Promise<Lead[]> {
  await assertPermission(db, params.actorId, READ_PERMISSION, { projectId: params.projectId });

  const where: Prisma.LeadWhereInput = { orgId: params.orgId };
  if (params.stage) where.stage = params.stage;
  if (params.projectId) where.projectId = params.projectId;

  const roleCodes = await resolveActorRoleCodes(db, params.actorId);
  const isUnrestricted = [...roleCodes].some((r) => ADMIN_ROLE_CODES.has(r)) || roleCodes.has("AUDITOR");

  if (!isUnrestricted) {
    const caller = await db.associate.findUnique({ where: { userId: params.actorId }, select: { id: true } });
    if (!caller) return [];
    const mode: ScopeMode = roleCodes.has("TEAM_LEAD") ? "OWN_AND_DOWNLINE" : "OWN";
    const accessible = await getAccessibleAssociateIds(db, caller.id, mode);
    where.assignedAssociateId = { in: accessible };
  }

  return db.lead.findMany({ where, orderBy: { createdAt: "desc" } });
}

export interface SourceRoiRow {
  source: LeadSource;
  leadCount: number;
  bookingCount: number;
  /** bookingCount / leadCount * 100, 0 when leadCount is 0. */
  conversionPct: number;
}

export interface GetSourceRoiParams {
  orgId: string;
  actorId: string;
  from?: Date;
  to?: Date;
}

/** Bookings-per-source vs. leads-per-source (Phase 3.5 Slice 9 -- confirmed
 *  gap, no aggregation existed). "Booked" means the lead has at least one
 *  non-cancelled booking, via the existing Lead.bookings relation -- not a
 *  new join, and not the same thing as `stage === "BOOKED"` (a stage can go
 *  stale if a booking is later cancelled without the stage being walked
 *  back through logActivity). Org-wide by design -- ROI is a leadership
 *  view, not a per-associate one, so this does not apply the OWN/OWN_AND_
 *  DOWNLINE scope listLeads uses. */
export async function getSourceRoi(db: PrismaClient, params: GetSourceRoiParams): Promise<SourceRoiRow[]> {
  await assertPermission(db, params.actorId, READ_PERMISSION);

  const createdAt =
    params.from || params.to
      ? { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) }
      : undefined;

  const [leadCounts, bookingCounts] = await Promise.all([
    db.lead.groupBy({
      by: ["source"],
      where: { orgId: params.orgId, ...(createdAt ? { createdAt } : {}) },
      _count: true,
    }),
    db.lead.groupBy({
      by: ["source"],
      where: {
        orgId: params.orgId,
        ...(createdAt ? { createdAt } : {}),
        bookings: { some: { status: { not: "CANCELLED" } } },
      },
      _count: true,
    }),
  ]);

  const bookingCountBySource = new Map(bookingCounts.map((row) => [row.source, row._count]));

  return leadCounts
    .map((row) => {
      const bookingCount = bookingCountBySource.get(row.source) ?? 0;
      return {
        source: row.source,
        leadCount: row._count,
        bookingCount,
        conversionPct: row._count > 0 ? Math.round((bookingCount / row._count) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.leadCount - a.leadCount);
}
