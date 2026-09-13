// Grade master + effective-dated grade assignment -- Phase 3 Slice 1
// (PROGRESS.md, docs/03-DATA-MODEL.md, docs/04-COMMISSION-SPEC.md §2).
//
// Grade master (names/ranks/rates) and grade-qualification thresholds are
// BLOCKED#4/#8 in the Blocked-on-client table -- PLACEHOLDER, same status
// as every other unconfirmed number in this project (discount bands, hold
// TTL, escalation-ladder offsets). The mechanism here is real; the specific
// grade names/ranks/thresholds a caller creates are not this file's concern.
import { Prisma } from "@desire/db";
import type { PrismaClient, Grade, AssociateGrade } from "@desire/db";
export type { Grade, AssociateGrade };
import { writeAuditLog, type AuditContext } from "./audit";
import { assertPermission, ForbiddenError, getAccessibleAssociateIds, type ScopeMode } from "./rbac";

const GRADE_WRITE_PERMISSION = "project.write";
const ASSIGN_PERMISSION = "grade.change";
// Reading grade history is a view of associate data, gated the same as
// associates.ts's own listAssociates/getAssociateTree, not a new capability.
const READ_PERMISSION = "associate.read";
const ADMIN_ROLE_CODES: ReadonlySet<string> = new Set(["SUPER_ADMIN", "FINANCE_ADMIN", "SALES_HEAD", "SALES_ADMIN", "AUDITOR"]);

// ── Errors ─────────────────────────────────────────────────────────────

export class GradeNotFoundError extends Error {
  constructor(public readonly gradeId: string) {
    super(`Grade ${gradeId} not found.`);
    this.name = "GradeNotFoundError";
  }
}

export class DuplicateGradeCodeError extends Error {
  constructor(public readonly code: string) {
    super(`Grade code "${code}" is already in use for this organisation.`);
    this.name = "DuplicateGradeCodeError";
  }
}

export class AssociateNotFoundError extends Error {
  constructor(public readonly associateId: string) {
    super(`Associate ${associateId} not found.`);
    this.name = "AssociateNotFoundError";
  }
}

// ── Shared helpers (duplicated per file -- this codebase's own convention)

function requireActor(audit: AuditContext): string {
  if (!audit.actorId) {
    throw new ForbiddenError("Grade mutations require a user actor, not a system actor.");
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

async function withUniqueCode<T>(field: string, code: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new DuplicateGradeCodeError(code);
    }
    throw err;
  }
}

// ── Grade master CRUD ────────────────────────────────────────────────────

export interface CreateGradeParams {
  code: string;
  name: string;
  rank: number;
  description?: string | null;
  /** All PLACEHOLDER, per the schema's own comment -- null = not evaluated
   *  by runGradeQualificationSweep (Slice 6). */
  minCumulativeSalesValue?: Prisma.Decimal | string | null;
  minBookingsInPeriod?: number | null;
  minTeamSize?: number | null;
  minTenureMonths?: number | null;
  holdQuota?: number;
  audit: AuditContext;
}

export async function createGrade(db: PrismaClient, params: CreateGradeParams): Promise<Grade> {
  const actorId = requireActor(params.audit);

  return withUniqueCode("Grade code", params.code, () =>
    db.$transaction(async (tx) => {
      // No projectId to scope against -- Grade is org-level master data,
      // same reasoning createProject uses for project.write with no
      // projectId option: only an org-wide grant qualifies.
      await assertPermission(tx, actorId, GRADE_WRITE_PERMISSION);

      const data = {
        orgId: params.audit.orgId,
        code: params.code,
        name: params.name,
        rank: params.rank,
        description: params.description ?? undefined,
        minCumulativeSalesValue: params.minCumulativeSalesValue != null ? new Prisma.Decimal(params.minCumulativeSalesValue) : undefined,
        minBookingsInPeriod: params.minBookingsInPeriod ?? undefined,
        minTeamSize: params.minTeamSize ?? undefined,
        minTenureMonths: params.minTenureMonths ?? undefined,
        holdQuota: params.holdQuota ?? undefined,
      } satisfies Prisma.GradeUncheckedCreateInput;

      const grade = await tx.grade.create({ data });
      await writeAuditLog(tx, params.audit, { action: "CREATE", entity: "Grade", entityId: grade.id, after: auditSnapshot(data) });
      return grade;
    }),
  );
}

export interface UpdateGradeParams {
  gradeId: string;
  name?: string;
  description?: string | null;
  isActive?: boolean;
  minCumulativeSalesValue?: Prisma.Decimal | string | null;
  minBookingsInPeriod?: number | null;
  minTeamSize?: number | null;
  minTenureMonths?: number | null;
  holdQuota?: number;
  audit: AuditContext;
}

/** `code` and `rank` are deliberately not patchable here -- both are stable
 *  identifiers other rows key off of (SchemeGradeRate, `@@unique([orgId,
 *  rank])` ordering), same reasoning updateProject excludes `code`. */
export async function updateGrade(db: PrismaClient, params: UpdateGradeParams): Promise<Grade> {
  const actorId = requireActor(params.audit);

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "grades" WHERE "id" = ${params.gradeId} FOR UPDATE`;

    const existing = await tx.grade.findUnique({ where: { id: params.gradeId } });
    if (!existing) throw new GradeNotFoundError(params.gradeId);
    if (existing.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Grade ${params.gradeId} belongs to another organisation.`);
    }

    await assertPermission(tx, actorId, GRADE_WRITE_PERMISSION);

    const data: Prisma.GradeUncheckedUpdateInput = {};
    if (params.name !== undefined) data.name = params.name;
    if (params.description !== undefined) data.description = params.description;
    if (params.isActive !== undefined) data.isActive = params.isActive;
    if (params.minCumulativeSalesValue !== undefined) {
      data.minCumulativeSalesValue = params.minCumulativeSalesValue == null ? null : new Prisma.Decimal(params.minCumulativeSalesValue);
    }
    if (params.minBookingsInPeriod !== undefined) data.minBookingsInPeriod = params.minBookingsInPeriod;
    if (params.minTeamSize !== undefined) data.minTeamSize = params.minTeamSize;
    if (params.minTenureMonths !== undefined) data.minTenureMonths = params.minTenureMonths;
    if (params.holdQuota !== undefined) data.holdQuota = params.holdQuota;

    if (Object.keys(data).length === 0) return existing;

    const updated = await tx.grade.update({ where: { id: existing.id }, data });
    const { before, after } = auditDiff(existing, data);
    await writeAuditLog(tx, params.audit, { action: "UPDATE", entity: "Grade", entityId: updated.id, before, after });
    return updated;
  });
}

// ── Effective-dated grade assignment ──────────────────────────────────────

export interface AssignGradeParams {
  associateId: string;
  gradeId: string;
  reason?: string | null;
  effectiveFrom?: Date;
  audit: AuditContext;
}

/** NEVER updates an AssociateGrade row to change a grade (schema's own
 *  comment) -- closes the current one (`validTo`) and inserts a new one.
 *  A commission run for a March sale must resolve the grade that was valid
 *  in March; overwriting a row in place would make that impossible. */
export async function assignGrade(db: PrismaClient, params: AssignGradeParams): Promise<AssociateGrade> {
  const actorId = requireActor(params.audit);
  const now = params.effectiveFrom ?? new Date();

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "associates" WHERE "id" = ${params.associateId} FOR UPDATE`;

    const associate = await tx.associate.findUnique({ where: { id: params.associateId } });
    if (!associate) throw new AssociateNotFoundError(params.associateId);
    if (associate.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Associate ${params.associateId} belongs to another organisation.`);
    }

    const grade = await tx.grade.findUnique({ where: { id: params.gradeId } });
    if (!grade) throw new GradeNotFoundError(params.gradeId);
    if (grade.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Grade ${params.gradeId} belongs to another organisation.`);
    }

    await assertPermission(tx, actorId, ASSIGN_PERMISSION);

    const current = await tx.associateGrade.findFirst({ where: { associateId: associate.id, validTo: null } });
    if (current) {
      await tx.associateGrade.update({ where: { id: current.id }, data: { validTo: now } });
    }

    const created = await tx.associateGrade.create({
      data: {
        associateId: associate.id,
        gradeId: grade.id,
        validFrom: now,
        validTo: null,
        reason: params.reason ?? undefined,
        approvedById: actorId,
      },
    });

    await writeAuditLog(tx, params.audit, {
      action: "CREATE",
      entity: "AssociateGrade",
      entityId: created.id,
      after: auditSnapshot(created),
      reason: params.reason ?? undefined,
    });

    return created;
  });
}

// ── Grade auto-qualification sweep -- Phase 3 Slice 6 ───────────────────

// PLACEHOLDER: the spec doesn't define the "personal bookings in period"
// window, stated explicitly rather than silently assumed.
const QUALIFICATION_BOOKINGS_WINDOW_MONTHS = 12;

interface QualificationStats {
  cumulativeSalesValue: Prisma.Decimal;
  personalBookingsInPeriod: number;
  teamSize: number;
  tenureMonths: number;
}

/** A grade with every threshold field null is vacuously never auto-
 *  qualified into (schema's own comment: "null = not evaluated") -- this
 *  guards the accidental promote-everyone bug a naive "every non-null check
 *  passes" predicate would have on an unconfigured grade. */
function qualifiesFor(grade: Grade, stats: QualificationStats): boolean {
  const thresholds = [grade.minCumulativeSalesValue, grade.minBookingsInPeriod, grade.minTeamSize, grade.minTenureMonths];
  if (thresholds.every((t) => t === null)) return false;

  if (grade.minCumulativeSalesValue !== null && stats.cumulativeSalesValue.lessThan(grade.minCumulativeSalesValue)) return false;
  if (grade.minBookingsInPeriod !== null && stats.personalBookingsInPeriod < grade.minBookingsInPeriod) return false;
  if (grade.minTeamSize !== null && stats.teamSize < grade.minTeamSize) return false;
  if (grade.minTenureMonths !== null && stats.tenureMonths < grade.minTenureMonths) return false;
  return true;
}

function describeThresholdsMet(grade: Grade, stats: QualificationStats): string {
  const parts: string[] = [];
  if (grade.minCumulativeSalesValue !== null) parts.push(`cumulativeSalesValue ${stats.cumulativeSalesValue.toString()}>=${grade.minCumulativeSalesValue.toString()}`);
  if (grade.minBookingsInPeriod !== null) parts.push(`personalBookingsInPeriod ${stats.personalBookingsInPeriod}>=${grade.minBookingsInPeriod}`);
  if (grade.minTeamSize !== null) parts.push(`teamSize ${stats.teamSize}>=${grade.minTeamSize}`);
  if (grade.minTenureMonths !== null) parts.push(`tenureMonths ${stats.tenureMonths}>=${grade.minTenureMonths}`);
  return parts.join(", ");
}

function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

export interface GradeQualificationSweepResult {
  evaluated: number;
  promoted: number;
}

/** Copies expireStaleHolds/runCollectionsSweep's exact shape: one
 *  transaction per associate, a system actor (actorId: null), no RBAC
 *  check -- this is a cron job gated by the route's x-job-secret, not a
 *  user-facing mutation, so it does NOT go through assignGrade (which
 *  requires a user actor by design: "Grade mutations require a user actor,
 *  not a system actor"). It reimplements the same close-and-insert
 *  discipline directly, with approvedById left null to honestly record
 *  that nobody personally approved this promotion. */
export async function runGradeQualificationSweep(db: PrismaClient, params: { now?: Date } = {}): Promise<GradeQualificationSweepResult> {
  const now = params.now ?? new Date();
  let evaluated = 0;
  let promoted = 0;

  const associates = await db.associate.findMany({ where: { status: "ACTIVE" }, select: { id: true, orgId: true, joinDate: true } });

  for (const associate of associates) {
    await db.$transaction(async (tx) => {
      evaluated++;

      const current = await tx.associateGrade.findFirst({
        where: { associateId: associate.id, validTo: null },
        include: { grade: true },
      });

      const grades = await tx.grade.findMany({ where: { orgId: associate.orgId, isActive: true }, orderBy: { rank: "desc" } });
      const higherGrades = grades.filter((g) => !current || g.rank > current.grade.rank);
      if (higherGrades.length === 0) return;

      const windowStart = new Date(now);
      windowStart.setMonth(windowStart.getMonth() - QUALIFICATION_BOOKINGS_WINDOW_MONTHS);

      const [salesAgg, bookingsInPeriod, accessibleIds] = await Promise.all([
        tx.commissionEntry.aggregate({
          where: { beneficiaryAssociateId: associate.id, role: "SELF", status: { not: "REVERSED" } },
          _sum: { baseAmount: true },
        }),
        tx.booking.count({ where: { sellingAssociateId: associate.id, status: { not: "DRAFT" }, bookingDate: { gte: windowStart, lte: now } } }),
        getAccessibleAssociateIds(tx, associate.id, "OWN_AND_DOWNLINE"),
      ]);

      const stats: QualificationStats = {
        cumulativeSalesValue: salesAgg._sum.baseAmount ?? new Prisma.Decimal(0),
        personalBookingsInPeriod: bookingsInPeriod,
        teamSize: accessibleIds.length - 1, // exclude self
        tenureMonths: monthsBetween(associate.joinDate, now),
      };

      // Highest-rank qualifying grade above the current one -- grades is
      // already rank-desc, so the first match is the best available.
      const target = higherGrades.find((g) => qualifiesFor(g, stats));
      if (!target) return;

      if (current) {
        await tx.associateGrade.update({ where: { id: current.id }, data: { validTo: now } });
      }
      const created = await tx.associateGrade.create({
        data: {
          associateId: associate.id,
          gradeId: target.id,
          validFrom: now,
          validTo: null,
          reason: `Auto-qualified: ${describeThresholdsMet(target, stats)}`,
          approvedById: null,
        },
      });

      await writeAuditLog(tx, { orgId: associate.orgId, actorId: null, actorLabel: "system:grade-qualification-sweep" }, {
        action: "CREATE",
        entity: "AssociateGrade",
        entityId: created.id,
        after: auditSnapshot(created),
        reason: created.reason ?? undefined,
      });

      promoted++;
    });
  }

  return { evaluated, promoted };
}

// ── Read ───────────────────────────────────────────────────────────────

async function resolveActorRoleCodes(db: PrismaClient, actorId: string): Promise<Set<string>> {
  const roles = await db.userRole.findMany({ where: { userId: actorId }, select: { role: { select: { code: true } } } });
  return new Set(roles.map((r) => r.role.code));
}

export interface GradeHistoryRow {
  id: string;
  associateId: string;
  associateCode: string;
  associateName: string;
  gradeCode: string;
  gradeName: string;
  validFrom: string;
  validTo: string | null;
  reason: string | null;
  approvedById: string | null;
}

export interface ListGradeHistoryParams {
  orgId: string;
  actorId: string;
  associateId?: string;
}

/** Phase 3.5 Slice 12 -- "Promotions" (docs/08-SCREENS.md). The plan's own
 *  first guess was HierarchyChangeLog, but that table records ORG-TREE
 *  moves (moveAssociate: who reports to whom) -- a different concept from a
 *  grade change. A promotion is an AssociateGrade row: runGradeQualification
 *  Sweep and assignGrade both close the current row (`validTo`) and insert a
 *  new one, exactly the history this screen needs, with `approvedById: null`
 *  already distinguishing an auto-qualification from a human decision.
 *  Scoped identically to listAssociates (ASSOCIATE own, TEAM_LEAD own +
 *  downline, admin-shaped roles and AUDITOR see the whole org) since this is
 *  the same underlying associate set, viewed through the same permission. */
export async function listGradeHistory(db: PrismaClient, params: ListGradeHistoryParams): Promise<GradeHistoryRow[]> {
  await assertPermission(db, params.actorId, READ_PERMISSION);

  const roleCodes = await resolveActorRoleCodes(db, params.actorId);
  const isUnrestricted = [...roleCodes].some((r) => ADMIN_ROLE_CODES.has(r));

  let associateIds: string[] | undefined;
  if (!isUnrestricted) {
    const caller = await db.associate.findUnique({ where: { userId: params.actorId }, select: { id: true } });
    if (!caller) return [];
    const mode: ScopeMode = roleCodes.has("TEAM_LEAD") ? "OWN_AND_DOWNLINE" : "OWN";
    const accessible = await getAccessibleAssociateIds(db, caller.id, mode);
    if (params.associateId && !accessible.includes(params.associateId)) return [];
    associateIds = params.associateId ? [params.associateId] : accessible;
  } else if (params.associateId) {
    associateIds = [params.associateId];
  }

  const rows = await db.associateGrade.findMany({
    where: {
      associate: { orgId: params.orgId },
      ...(associateIds ? { associateId: { in: associateIds } } : {}),
    },
    include: { associate: { select: { code: true, user: { select: { name: true } } } }, grade: { select: { code: true, name: true } } },
    orderBy: { validFrom: "desc" },
  });

  return rows.map((row) => ({
    id: row.id,
    associateId: row.associateId,
    associateCode: row.associate.code,
    associateName: row.associate.user.name,
    gradeCode: row.grade.code,
    gradeName: row.grade.name,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo?.toISOString() ?? null,
    reason: row.reason,
    approvedById: row.approvedById,
  }));
}
