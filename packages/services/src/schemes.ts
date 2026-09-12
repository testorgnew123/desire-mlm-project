// Versioned commission schemes -- Phase 3 Slice 2 (docs/04-COMMISSION-SPEC.md,
// PROGRESS.md's "Scheme builder"). Publish lifecycle is IDENTICAL in shape to
// price-lists.ts's PriceList (DRAFT -> PENDING_APPROVAL -> ACTIVE -> ARCHIVED,
// @@unique([projectId, version]), validFrom/validTo) -- this file reuses that
// file's pattern line-for-line, including its maker-checker and locking
// discipline.
//
// Grade ladder and level-rate PERCENTAGES are BLOCKED#4/#5/#6 in the
// Blocked-on-client table -- PLACEHOLDER, same status as every other
// unconfirmed number in this project. The mechanism (versioning,
// maker-checker publish, incumbent archiving) is real regardless of what
// numbers a caller puts into it.
import { Prisma } from "@desire/db";
import type {
  CommissionScheme,
  PayoutMode,
  PrismaClient,
  PublishStatus,
  RateType,
  ReleaseTriggerType,
} from "@desire/db";
import { writeAuditLog, type AuditContext } from "./audit";
import { assertPermission, ForbiddenError } from "./rbac";

const PREPARE_PERMISSION = "scheme.prepare";
const APPROVE_PERMISSION = "scheme.approve";

// ── Errors ─────────────────────────────────────────────────────────────

export class SchemeNotFoundError extends Error {
  constructor(schemeId: string) {
    super(`Commission scheme ${schemeId} not found.`);
    this.name = "SchemeNotFoundError";
  }
}

export class SchemeProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} not found.`);
    this.name = "SchemeProjectNotFoundError";
  }
}

export class SchemeMakerCheckerViolationError extends Error {
  constructor(
    public readonly schemeId: string,
    public readonly preparedById: string,
  ) {
    super(
      `Commission scheme ${schemeId} was prepared by ${preparedById}; the same user cannot ` +
        `approve it. A second person must publish it.`,
    );
    this.name = "SchemeMakerCheckerViolationError";
  }
}

export class SchemeNotPublishableError extends Error {
  constructor(
    public readonly schemeId: string,
    public readonly status: PublishStatus,
  ) {
    super(`Commission scheme ${schemeId} cannot be published from status ${status}.`);
    this.name = "SchemeNotPublishableError";
  }
}

export class EmptySchemeError extends Error {
  constructor(public readonly schemeId: string) {
    super(`Commission scheme ${schemeId} has no grade rates; there is nothing to publish.`);
    this.name = "EmptySchemeError";
  }
}

export class SchemeNotEditableError extends Error {
  constructor(
    public readonly schemeId: string,
    public readonly status: PublishStatus,
  ) {
    super(
      `Commission scheme ${schemeId} is ${status}, not DRAFT. Published schemes are immutable ` +
        `-- create a new version instead.`,
    );
    this.name = "SchemeNotEditableError";
  }
}

export class SchemeVersionConflictError extends Error {
  constructor(public readonly projectId: string) {
    super(`Another commission scheme version was created for project ${projectId} concurrently. Retry.`);
    this.name = "SchemeVersionConflictError";
  }
}

export class DuplicateGradeRateError extends Error {
  constructor(public readonly gradeId: string) {
    super(`More than one grade rate targets grade ${gradeId} on this scheme.`);
    this.name = "DuplicateGradeRateError";
  }
}

export class DuplicateLevelRateError extends Error {
  constructor(public readonly level: number) {
    super(`More than one level rate targets level ${level} on this scheme.`);
    this.name = "DuplicateLevelRateError";
  }
}

// ── Shared helpers (duplicated per file -- this codebase's own convention)

function requireActor(audit: AuditContext): string {
  if (!audit.actorId) {
    throw new ForbiddenError("Commission scheme mutations require a user actor, not a system actor.");
  }
  return audit.actorId;
}

async function lockProject(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "projects" WHERE "id" = ${projectId} FOR UPDATE
  `;
  if (!locked[0]) throw new SchemeProjectNotFoundError(projectId);
}

function laterOf(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

// ── Create a draft ─────────────────────────────────────────────────────

export interface GradeRateInput {
  gradeId: string;
  rateType?: RateType;
  rateValue: Prisma.Decimal | string;
}

export interface LevelRateInput {
  level: number;
  pctOfSellerCommission: Prisma.Decimal | string;
}

export interface CreateSchemeParams {
  projectId: string;
  name: string;
  validFrom: Date;
  /** { chargeHeadCodes: ["BSP"], netOfDiscount: true, netOfGst: true } --
   *  metadata only. The actual commissionable value is already correctly
   *  resolved by computeCostSheet and frozen onto Booking.commissionableValue
   *  at confirm time; this documents the rule, it does not implement it. */
  baseDefinition: Record<string, unknown>;
  maxLevel?: number;
  compressionMode?: "NONE" | "ROLL_UP";
  maxTotalPct: Prisma.Decimal | string;
  eligibilityRules?: Record<string, unknown> | null;
  gradeRates: readonly GradeRateInput[];
  levelRates?: readonly LevelRateInput[];
  audit: AuditContext;
}

function assertGradeRatesValid(rates: readonly GradeRateInput[]): void {
  const seen = new Set<string>();
  for (const rate of rates) {
    if (seen.has(rate.gradeId)) throw new DuplicateGradeRateError(rate.gradeId);
    seen.add(rate.gradeId);
  }
}

function assertLevelRatesValid(rates: readonly LevelRateInput[]): void {
  const seen = new Set<number>();
  for (const rate of rates) {
    if (seen.has(rate.level)) throw new DuplicateLevelRateError(rate.level);
    seen.add(rate.level);
  }
}

/** Version allocation, locking and the P2002 backstop all follow
 *  createDraftPriceList's exact reasoning: lock the PROJECT row (there is no
 *  scheme row yet to lock), read max(version) under that lock, insert N+1. */
export async function createScheme(
  db: PrismaClient,
  params: CreateSchemeParams,
): Promise<{ schemeId: string; version: number }> {
  const preparedById = requireActor(params.audit);
  assertGradeRatesValid(params.gradeRates);
  assertLevelRatesValid(params.levelRates ?? []);

  try {
    return await db.$transaction(
      async (tx) => {
        await lockProject(tx, params.projectId);

        const project = await tx.project.findUniqueOrThrow({
          where: { id: params.projectId },
          select: { orgId: true },
        });
        if (project.orgId !== params.audit.orgId) {
          throw new ForbiddenError(`Project ${params.projectId} belongs to another organisation.`);
        }

        await assertPermission(tx, preparedById, PREPARE_PERMISSION, { projectId: params.projectId });

        const latest = await tx.commissionScheme.findFirst({
          where: { projectId: params.projectId },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        const version = (latest?.version ?? 0) + 1;

        const created = await tx.commissionScheme.create({
          data: {
            orgId: params.audit.orgId,
            projectId: params.projectId,
            name: params.name,
            version,
            status: "DRAFT",
            validFrom: params.validFrom,
            baseDefinition: params.baseDefinition as Prisma.InputJsonValue,
            maxLevel: params.maxLevel ?? undefined,
            compressionMode: params.compressionMode ?? undefined,
            maxTotalPct: new Prisma.Decimal(params.maxTotalPct),
            eligibilityRules: (params.eligibilityRules ?? undefined) as Prisma.InputJsonValue | undefined,
            preparedById,
            gradeRates: {
              create: params.gradeRates.map((r) => ({
                gradeId: r.gradeId,
                rateType: r.rateType ?? undefined,
                rateValue: new Prisma.Decimal(r.rateValue),
              })),
            },
            levelRates: {
              create: (params.levelRates ?? []).map((r) => ({
                level: r.level,
                pctOfSellerCommission: new Prisma.Decimal(r.pctOfSellerCommission),
              })),
            },
          },
          select: { id: true, version: true },
        });

        await writeAuditLog(tx, params.audit, {
          action: "CREATE",
          entity: "CommissionScheme",
          entityId: created.id,
          after: {
            projectId: params.projectId,
            version,
            name: params.name,
            status: "DRAFT",
            validFrom: params.validFrom.toISOString(),
            preparedById,
            gradeRateCount: params.gradeRates.length,
            levelRateCount: (params.levelRates ?? []).length,
          },
        });

        return { schemeId: created.id, version: created.version };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new SchemeVersionConflictError(params.projectId);
    }
    throw err;
  }
}

// ── Publish (maker-checker) ────────────────────────────────────────────

export interface PublishSchemeParams {
  schemeId: string;
  audit: AuditContext;
  now?: Date;
}

export interface PublishedScheme {
  schemeId: string;
  version: number;
  publishedAt: Date;
  archivedSchemeIds: string[];
}

/** publishPriceList's pattern exactly: lock the project, re-read the scheme
 *  under that lock, permission before maker-checker identity before state,
 *  archive every currently-ACTIVE incumbent for the project (validTo clamped
 *  to not precede its own validFrom), one audit row per archived incumbent
 *  plus one for the publish itself. */
export async function publishScheme(
  db: PrismaClient,
  params: PublishSchemeParams,
): Promise<PublishedScheme> {
  const approvedById = requireActor(params.audit);
  const now = params.now ?? new Date();

  return db.$transaction(
    async (tx) => {
      const target = await tx.commissionScheme.findUnique({
        where: { id: params.schemeId },
        select: { orgId: true, projectId: true },
      });
      if (!target) throw new SchemeNotFoundError(params.schemeId);
      if (target.orgId !== params.audit.orgId) {
        throw new ForbiddenError(`Commission scheme ${params.schemeId} belongs to another organisation.`);
      }

      await lockProject(tx, target.projectId);

      const scheme = await tx.commissionScheme.findUniqueOrThrow({
        where: { id: params.schemeId },
        select: {
          id: true,
          projectId: true,
          version: true,
          status: true,
          preparedById: true,
          _count: { select: { gradeRates: true } },
        },
      });

      await assertPermission(tx, approvedById, APPROVE_PERMISSION, { projectId: scheme.projectId });
      if (scheme.preparedById === approvedById) {
        throw new SchemeMakerCheckerViolationError(scheme.id, scheme.preparedById);
      }
      if (scheme.status !== "DRAFT" && scheme.status !== "PENDING_APPROVAL") {
        throw new SchemeNotPublishableError(scheme.id, scheme.status);
      }
      if (scheme._count.gradeRates === 0) {
        throw new EmptySchemeError(scheme.id);
      }

      const incumbents = await tx.commissionScheme.findMany({
        where: { projectId: scheme.projectId, status: "ACTIVE" },
        select: { id: true, version: true, validFrom: true, validTo: true },
      });

      const archivedSchemeIds: string[] = [];
      for (const incumbent of incumbents) {
        const validTo = laterOf(now, incumbent.validFrom);
        await tx.commissionScheme.update({
          where: { id: incumbent.id },
          data: { status: "ARCHIVED", validTo },
        });
        await writeAuditLog(tx, params.audit, {
          action: "UPDATE",
          entity: "CommissionScheme",
          entityId: incumbent.id,
          before: { status: "ACTIVE", validTo: incumbent.validTo },
          after: { status: "ARCHIVED", validTo },
          reason: `superseded by commission scheme version ${scheme.version}`,
        });
        archivedSchemeIds.push(incumbent.id);
      }

      await tx.commissionScheme.update({
        where: { id: scheme.id },
        data: { status: "ACTIVE", approvedById, publishedAt: now },
      });
      await writeAuditLog(tx, params.audit, {
        action: "APPROVE",
        entity: "CommissionScheme",
        entityId: scheme.id,
        before: { status: scheme.status, approvedById: null, publishedAt: null },
        after: { status: "ACTIVE", approvedById, publishedAt: now },
        reason: `published version ${scheme.version}`,
      });

      return { schemeId: scheme.id, version: scheme.version, publishedAt: now, archivedSchemeIds };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}

// ── Read ───────────────────────────────────────────────────────────────

export type ActiveScheme = CommissionScheme & {
  gradeRates: Array<{ gradeId: string; grade: { code: string }; rateType: RateType; rateValue: Prisma.Decimal }>;
  levelRates: Array<{ level: number; pctOfSellerCommission: Prisma.Decimal }>;
  /** One payout schedule per scheme, by this codebase's own convention
   *  (nothing in the schema enforces it, but nothing has ever created a
   *  second one either) -- `schedules[0]?.mode` is what accrueCommission
   *  (ON_BOOKING) and releaseMilestoneCommission (MILESTONE) key off. */
  schedules: Array<{
    mode: PayoutMode;
    slabs: Array<{ sequence: number; triggerType: ReleaseTriggerType; triggerRef: string | null; releasePct: Prisma.Decimal }>;
  }>;
};

/** Any status, by id -- simulateScheme's "what would THIS scheme (however
 *  still DRAFT) produce" doesn't restrict to ACTIVE the way accrual does. */
export async function getSchemeById(
  db: PrismaClient | Prisma.TransactionClient,
  schemeId: string,
): Promise<ActiveScheme | null> {
  return db.commissionScheme.findUnique({
    where: { id: schemeId },
    include: {
      gradeRates: { include: { grade: { select: { code: true } } } },
      levelRates: true,
      schedules: { include: { slabs: true } },
    },
  });
}

/** Same shape as getActivePriceList -- the scheme a booking made on `asOf`
 *  must be resolved from. */
export async function getActiveScheme(
  db: PrismaClient | Prisma.TransactionClient,
  params: { projectId: string; asOf?: Date },
): Promise<ActiveScheme | null> {
  const asOf = params.asOf ?? new Date();
  return db.commissionScheme.findFirst({
    where: {
      projectId: params.projectId,
      status: "ACTIVE",
      validFrom: { lte: asOf },
      OR: [{ validTo: null }, { validTo: { gt: asOf } }],
    },
    include: {
      gradeRates: { include: { grade: { select: { code: true } } } },
      levelRates: true,
      schedules: { include: { slabs: true } },
    },
    orderBy: { version: "desc" },
  });
}
