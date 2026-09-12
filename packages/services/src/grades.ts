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
import { assertPermission, ForbiddenError } from "./rbac";

const GRADE_WRITE_PERMISSION = "project.write";
const ASSIGN_PERMISSION = "grade.change";

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
