// Payout batch: prepare/approve maker-checker, tax by engagementType, the
// per-cycle recovery deduction cap -- Phase 3 Slice 4 (PROGRESS.md, docs/
// 04-COMMISSION-SPEC.md §6, docs/11-COMPLIANCE-INDIA.md's engagementType
// mapping). Clawback -> contra entry -> Recovery persistence is already done
// (bookings.ts's cancelBooking, Phase 2 Slice 2); this file closes the one
// remaining piece that only has meaning at payout-batch time: the deduction
// cap, "so nobody's take-home drops to zero without a conversation first"
// (spec's own words).
import { Prisma } from "@desire/db";
import type { PrismaClient, PayoutBatch, PayoutBatchStatus, TdsSection, EngagementType, PayoutLine, Recovery, RecoveryStatus, Adjustment } from "@desire/db";
export type { PayoutBatch, PayoutLine, Recovery, Adjustment };
import { writeAuditLog, type AuditContext } from "./audit";
import { assertPermission, ForbiddenError } from "./rbac";

const PREPARE_PERMISSION = "payout.prepare";
const APPROVE_PERMISSION = "payout.approve";
const EXPORT_PERMISSION = "payout.export";

// PLACEHOLDER, per docs/04-COMMISSION-SPEC.md section 5 -- BLOCKED-table
// status unchanged by this being wired for real.
const PAYOUT_RECOVERY_MAX_DEDUCTION_PCT = new Prisma.Decimal("50");
// PLACEHOLDER, per docs/11-COMPLIANCE-INDIA.md's own stated rate ("18% if
// registered") for CONSULTANT/CHANNEL_PARTNER associates who are GST-registered.
const GST_RATE_PCT_IF_REGISTERED = new Prisma.Decimal("18.00");

const D = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v);

// docs/11-COMPLIANCE-INDIA.md's own mapping table.
const TDS_SECTION_BY_ENGAGEMENT: Record<EngagementType, TdsSection> = {
  EMPLOYEE: "SEC_192",
  CONSULTANT: "SEC_194J",
  CHANNEL_PARTNER: "SEC_194H",
};

// ── Errors ─────────────────────────────────────────────────────────────

export class PayoutBatchNotFoundError extends Error {
  constructor(public readonly batchId: string) {
    super(`Payout batch ${batchId} not found.`);
    this.name = "PayoutBatchNotFoundError";
  }
}

export class DuplicatePayoutPeriodError extends Error {
  constructor(
    public readonly periodStart: Date,
    public readonly periodEnd: Date,
  ) {
    super(`A payout batch for the period ${periodStart.toISOString()} - ${periodEnd.toISOString()} already exists.`);
    this.name = "DuplicatePayoutPeriodError";
  }
}

export class PayoutBatchNumberConflictError extends Error {
  constructor(public readonly orgId: string) {
    super(`Could not allocate a unique batch number for org ${orgId}. Retry.`);
    this.name = "PayoutBatchNumberConflictError";
  }
}

export class NoTaxRateConfiguredError extends Error {
  constructor(
    public readonly orgId: string,
    public readonly section: TdsSection,
    public readonly asOf: Date,
  ) {
    super(`No TaxRate configured for ${section} in org ${orgId} as of ${asOf.toISOString()}. Configure one before preparing a batch.`);
    this.name = "NoTaxRateConfiguredError";
  }
}

export class PayoutMakerCheckerViolationError extends Error {
  constructor(
    public readonly batchId: string,
    public readonly preparedById: string,
  ) {
    super(
      `Payout batch ${batchId} was prepared by ${preparedById}; the same user cannot approve it. ` +
        `A second person must approve it.`,
    );
    this.name = "PayoutMakerCheckerViolationError";
  }
}

export class PayoutBatchNotApprovableError extends Error {
  constructor(
    public readonly batchId: string,
    public readonly status: PayoutBatchStatus,
  ) {
    super(`Payout batch ${batchId} cannot be approved from status ${status}.`);
    this.name = "PayoutBatchNotApprovableError";
  }
}

export class PayoutBatchNotExportableError extends Error {
  constructor(
    public readonly batchId: string,
    public readonly status: PayoutBatchStatus,
  ) {
    super(`Payout batch ${batchId} cannot be exported from status ${status}.`);
    this.name = "PayoutBatchNotExportableError";
  }
}

// ── Shared helpers (duplicated per file -- this codebase's own convention)

function requireActor(audit: AuditContext): string {
  if (!audit.actorId) {
    throw new ForbiddenError("Payout batch mutations require a user actor, not a system actor.");
  }
  return audit.actorId;
}

/** Same reasoning as schemes.ts's lockProject / price-lists.ts's lockProject:
 *  there is no PayoutBatch row yet to lock when checking "does one already
 *  exist for this period", so the parent (the org) is locked instead,
 *  serialising the check-then-insert. This IS the concurrency guard for two
 *  prepareBatch calls racing on the same period -- the second one blocks on
 *  this lock until the first commits, then sees the first's batch and
 *  refuses via DuplicatePayoutPeriodError. */
async function lockOrg(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${orgId} FOR UPDATE`;
}

// ── Prepare ────────────────────────────────────────────────────────────

export interface PrepareBatchParams {
  orgId: string;
  periodStart: Date;
  periodEnd: Date;
  audit: AuditContext;
  now?: Date;
}

export interface PreparedBatch {
  batchId: string;
  batchNumber: string;
  lineCount: number;
  totalNetPayable: Prisma.Decimal;
}

export async function prepareBatch(db: PrismaClient, params: PrepareBatchParams): Promise<PreparedBatch> {
  const preparedById = requireActor(params.audit);
  const asOf = params.now ?? new Date();

  return db.$transaction(
    async (tx) => {
      await lockOrg(tx, params.orgId);

      await assertPermission(tx, preparedById, PREPARE_PERMISSION);

      const existing = await tx.payoutBatch.findFirst({
        where: { orgId: params.orgId, periodStart: params.periodStart, periodEnd: params.periodEnd },
        select: { id: true },
      });
      if (existing) throw new DuplicatePayoutPeriodError(params.periodStart, params.periodEnd);

      // PAYABLE entries accrued in the period -- accruedAt is the only
      // timestamp on CommissionEntry that plausibly denotes "which run this
      // belongs to" (there is no separate payableAt field in the schema).
      const entries = await tx.commissionEntry.findMany({
        where: { orgId: params.orgId, status: "PAYABLE", accruedAt: { gte: params.periodStart, lt: params.periodEnd } },
        include: { beneficiary: { select: { id: true, engagementType: true, isGstRegistered: true, bankAccountLast4: true, bankIfsc: true } } },
      });

      const byBeneficiary = new Map<string, typeof entries>();
      for (const entry of entries) {
        const list = byBeneficiary.get(entry.beneficiaryAssociateId) ?? [];
        list.push(entry);
        byBeneficiary.set(entry.beneficiaryAssociateId, list);
      }

      let batch: { id: string; batchNumber: string } | null = null;
      for (let attempt = 0; attempt < 5 && !batch; attempt++) {
        const count = await tx.payoutBatch.count({ where: { orgId: params.orgId } });
        const batchNumber = `PB-${String(count + 1 + attempt).padStart(6, "0")}`;
        try {
          batch = await tx.payoutBatch.create({
            data: { orgId: params.orgId, batchNumber, periodStart: params.periodStart, periodEnd: params.periodEnd, status: "DRAFT", preparedById },
            select: { id: true, batchNumber: true },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
          throw err;
        }
      }
      if (!batch) throw new PayoutBatchNumberConflictError(params.orgId);

      let totalGross = D(0);
      let totalTds = D(0);
      let totalGst = D(0);
      let totalRecovery = D(0);
      let totalNetPayable = D(0);

      for (const [associateId, lineEntries] of byBeneficiary) {
        const beneficiary = lineEntries[0]!.beneficiary;
        const grossAmount = lineEntries.reduce((sum, e) => sum.plus(e.grossAmount), D(0));

        const section = TDS_SECTION_BY_ENGAGEMENT[beneficiary.engagementType];
        const taxRate = await tx.taxRate.findFirst({
          where: { orgId: params.orgId, section, validFrom: { lte: asOf }, OR: [{ validTo: null }, { validTo: { gt: asOf } }] },
          orderBy: { validFrom: "desc" },
        });
        if (!taxRate) throw new NoTaxRateConfiguredError(params.orgId, section, asOf);
        const tdsAmount = grossAmount.mul(taxRate.ratePct).div(100).toDecimalPlaces(2);

        const gstApplies = beneficiary.engagementType !== "EMPLOYEE" && beneficiary.isGstRegistered;
        const gstRatePct = gstApplies ? GST_RATE_PCT_IF_REGISTERED : null;
        const gstAmount = gstApplies ? grossAmount.mul(GST_RATE_PCT_IF_REGISTERED).div(100).toDecimalPlaces(2) : D(0);

        // Recovery deduction, capped so nobody's take-home drops to zero
        // without a conversation first: at most PAYOUT_RECOVERY_MAX_DEDUCTION_PCT
        // of this line's GROSS, oldest outstanding Recovery first.
        const outstandingRecoveries = await tx.recovery.findMany({
          where: { associateId, status: { in: ["OUTSTANDING", "PARTIALLY_RECOVERED"] } },
          orderBy: { createdAt: "asc" },
        });
        const maxDeduction = grossAmount.mul(PAYOUT_RECOVERY_MAX_DEDUCTION_PCT).div(100).toDecimalPlaces(2);
        let recoveryAdjustment = D(0);
        for (const recovery of outstandingRecoveries) {
          if (recoveryAdjustment.greaterThanOrEqualTo(maxDeduction)) break;
          const room = maxDeduction.minus(recoveryAdjustment);
          const applied = Prisma.Decimal.min(room, recovery.outstandingAmount);
          if (applied.lessThanOrEqualTo(0)) continue;

          const newRecovered = recovery.recoveredAmount.plus(applied);
          const newOutstanding = recovery.outstandingAmount.minus(applied);
          await tx.recovery.update({
            where: { id: recovery.id },
            data: {
              recoveredAmount: newRecovered,
              outstandingAmount: newOutstanding,
              status: newOutstanding.lessThanOrEqualTo(0) ? "RECOVERED" : "PARTIALLY_RECOVERED",
            },
          });
          recoveryAdjustment = recoveryAdjustment.plus(applied);
        }

        const netPayable = grossAmount.plus(gstAmount).minus(tdsAmount).minus(recoveryAdjustment);

        const line = await tx.payoutLine.create({
          data: {
            batchId: batch.id,
            associateId,
            grossAmount,
            tdsSection: section,
            tdsRatePct: taxRate.ratePct,
            tdsAmount,
            gstRatePct: gstRatePct ?? undefined,
            gstAmount,
            recoveryAdjustment,
            netPayable,
            bankAccountLast4: beneficiary.bankAccountLast4 ?? undefined,
            bankIfsc: beneficiary.bankIfsc ?? undefined,
          },
        });
        await tx.payoutLineEntry.createMany({
          data: lineEntries.map((e) => ({ payoutLineId: line.id, entryId: e.id, amount: e.grossAmount })),
        });

        totalGross = totalGross.plus(grossAmount);
        totalTds = totalTds.plus(tdsAmount);
        totalGst = totalGst.plus(gstAmount);
        totalRecovery = totalRecovery.plus(recoveryAdjustment);
        totalNetPayable = totalNetPayable.plus(netPayable);
      }

      await tx.payoutBatch.update({
        where: { id: batch.id },
        data: { totalGross, totalTds, totalGst, totalRecovery, totalNetPayable },
      });

      await writeAuditLog(tx, params.audit, {
        action: "CREATE",
        entity: "PayoutBatch",
        entityId: batch.id,
        after: {
          batchNumber: batch.batchNumber,
          periodStart: params.periodStart.toISOString(),
          periodEnd: params.periodEnd.toISOString(),
          lineCount: byBeneficiary.size,
          totalNetPayable: totalNetPayable.toString(),
        },
      });

      return { batchId: batch.id, batchNumber: batch.batchNumber, lineCount: byBeneficiary.size, totalNetPayable };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}

// ── Approve (maker-checker) ────────────────────────────────────────────

export async function approveBatch(
  db: PrismaClient,
  params: { batchId: string; audit: AuditContext; now?: Date },
): Promise<PayoutBatch> {
  const approvedById = requireActor(params.audit);
  const now = params.now ?? new Date();

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "payout_batches" WHERE "id" = ${params.batchId} FOR UPDATE`;

    const batch = await tx.payoutBatch.findUnique({ where: { id: params.batchId } });
    if (!batch) throw new PayoutBatchNotFoundError(params.batchId);
    if (batch.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Payout batch ${params.batchId} belongs to another organisation.`);
    }

    await assertPermission(tx, approvedById, APPROVE_PERMISSION);
    if (batch.preparedById === approvedById) {
      throw new PayoutMakerCheckerViolationError(batch.id, batch.preparedById);
    }
    if (batch.status !== "DRAFT") {
      throw new PayoutBatchNotApprovableError(batch.id, batch.status);
    }

    const lineEntryIds = (
      await tx.payoutLineEntry.findMany({ where: { payoutLine: { batchId: batch.id } }, select: { entryId: true } })
    ).map((e) => e.entryId);
    if (lineEntryIds.length > 0) {
      await tx.commissionEntry.updateMany({ where: { id: { in: lineEntryIds } }, data: { status: "PAID", paidAt: now } });
    }

    const updated = await tx.payoutBatch.update({
      where: { id: batch.id },
      data: { status: "APPROVED", approvedById, approvedAt: now },
    });

    await writeAuditLog(tx, params.audit, {
      action: "APPROVE",
      entity: "PayoutBatch",
      entityId: batch.id,
      before: { status: "DRAFT", approvedById: null },
      after: { status: "APPROVED", approvedById },
    });

    return updated;
  });
}

// ── Export (structural stub) ────────────────────────────────────────────

/** Structural stub only, matching the Allotment-letter-PDF precedent from
 *  Phase 2: no bank-file library exists anywhere in this repo, and adding
 *  one is the kind of new-dependency decision this project has always
 *  paused on rather than silently pulling in. bankFileStorageKey is set to
 *  a clearly-named stub so the field is real and queryable, not fabricated
 *  file content. */
export async function exportBatch(
  db: PrismaClient,
  params: { batchId: string; audit: AuditContext; now?: Date },
): Promise<PayoutBatch> {
  const actorId = requireActor(params.audit);
  const now = params.now ?? new Date();

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "payout_batches" WHERE "id" = ${params.batchId} FOR UPDATE`;

    const batch = await tx.payoutBatch.findUnique({ where: { id: params.batchId } });
    if (!batch) throw new PayoutBatchNotFoundError(params.batchId);
    if (batch.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Payout batch ${params.batchId} belongs to another organisation.`);
    }

    await assertPermission(tx, actorId, EXPORT_PERMISSION);
    if (batch.status !== "APPROVED") {
      throw new PayoutBatchNotExportableError(batch.id, batch.status);
    }

    const updated = await tx.payoutBatch.update({
      where: { id: batch.id },
      data: { status: "EXPORTED", exportedAt: now, bankFileStorageKey: `stub/payout-batches/${batch.id}.bank-file` },
    });

    await writeAuditLog(tx, params.audit, {
      action: "EXPORT",
      entity: "PayoutBatch",
      entityId: batch.id,
      after: { status: "EXPORTED", bankFileStorageKey: updated.bankFileStorageKey },
    });

    return updated;
  });
}

// ── Read ───────────────────────────────────────────────────────────────
//
// Phase 3.5 Slice 14 -- this whole section had no backend at all beyond
// the three mutations above (prepareBatch/approveBatch/exportBatch had zero
// HTTP routes and no read ever listed a batch). Gated the same way
// prepareBatch itself is: payout.prepare and payout.approve are always
// granted together (permission-matrix.ts), so one code suffices for every
// read here rather than an OR-of-two-permissions check.

export async function listPayoutBatches(db: PrismaClient, params: { orgId: string; actorId: string }): Promise<PayoutBatch[]> {
  await assertPermission(db, params.actorId, PREPARE_PERMISSION);
  return db.payoutBatch.findMany({ where: { orgId: params.orgId }, orderBy: { periodStart: "desc" } });
}

export interface PayoutBatchDetail extends PayoutBatch {
  lines: Array<PayoutLine & { associate: { code: string; user: { name: string } } }>;
}

export async function getPayoutBatch(
  db: PrismaClient,
  params: { orgId: string; actorId: string; batchId: string },
): Promise<PayoutBatchDetail | null> {
  await assertPermission(db, params.actorId, PREPARE_PERMISSION);
  return db.payoutBatch.findFirst({
    where: { id: params.batchId, orgId: params.orgId },
    include: {
      lines: {
        include: { associate: { select: { code: true, user: { select: { name: true } } } } },
        orderBy: { netPayable: "desc" },
      },
    },
  });
}

export interface RecoveryRow extends Recovery {
  associate: { code: string; user: { name: string } };
}

export async function listRecoveries(
  db: PrismaClient,
  params: { orgId: string; actorId: string; status?: RecoveryStatus },
): Promise<RecoveryRow[]> {
  await assertPermission(db, params.actorId, PREPARE_PERMISSION);
  return db.recovery.findMany({
    where: { orgId: params.orgId, ...(params.status ? { status: params.status } : {}) },
    include: { associate: { select: { code: true, user: { select: { name: true } } } } },
    orderBy: { createdAt: "desc" },
  });
}

export interface AdjustmentRow extends Adjustment {
  associate: { code: string; user: { name: string } };
}

/** Read-only: this slice's route list creates no Adjustment-authoring
 *  endpoint (the only place one is created today is commission.ts's
 *  resolveDispute, an approved dispute). This screen shows what exists,
 *  the same "audit-style view, not a mutation screen" scope Slice 12's
 *  Promotions screen used for the same reason. */
export async function listAdjustments(db: PrismaClient, params: { orgId: string; actorId: string }): Promise<AdjustmentRow[]> {
  await assertPermission(db, params.actorId, PREPARE_PERMISSION);
  return db.adjustment.findMany({
    where: { orgId: params.orgId },
    include: { associate: { select: { code: true, user: { select: { name: true } } } } },
    orderBy: { createdAt: "desc" },
  });
}
