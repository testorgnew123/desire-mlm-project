// Payout batch: prepare/approve maker-checker, tax by engagementType, the
// per-cycle recovery deduction cap -- Phase 3 Slice 4 (PROGRESS.md, docs/
// 04-COMMISSION-SPEC.md §6, docs/11-COMPLIANCE-INDIA.md's engagementType
// mapping). Clawback -> contra entry -> Recovery persistence is already done
// (bookings.ts's cancelBooking, Phase 2 Slice 2); this file closes the one
// remaining piece that only has meaning at payout-batch time: the deduction
// cap, "so nobody's take-home drops to zero without a conversation first"
// (spec's own words).
import { Prisma } from "@desire/db";
import type { PrismaClient, Prisma as PrismaNS, PayoutBatch, PayoutBatchStatus, TdsSection, PayoutLine, Recovery, RecoveryStatus, Adjustment, CommissionEntry } from "@desire/db";
export type { PayoutBatch, PayoutLine, Recovery, Adjustment };
import Decimal from "decimal.js";
import { resolveTdsSection, resolveEffectiveTdsRate, computeTds, gstApplies, computeGst, GST_RATE_PCT_IF_REGISTERED } from "@desire/tax";
import { writeAuditLog, type AuditContext } from "./audit";
import { assertPermission, ForbiddenError, getAccessibleAssociateIds, type ScopeMode } from "./rbac";
import { decryptField } from "./encryption";

const PREPARE_PERMISSION = "payout.prepare";
const APPROVE_PERMISSION = "payout.approve";
const EXPORT_PERMISSION = "payout.export";
const WRITE_OFF_PERMISSION = "recovery.write_off";
// A payout line is downstream of the commission entries it pays out --
// same read gate commission.ts's getEarnings/explainEntry already use for
// "may this actor see this associate's commission data at all".
const STATEMENT_READ_PERMISSION = "commission.read";
const UNRESTRICTED_ROLE_CODES: ReadonlySet<string> = new Set(["SUPER_ADMIN", "FINANCE_ADMIN", "SALES_HEAD", "AUDITOR"]);

// PLACEHOLDER, per docs/04-COMMISSION-SPEC.md section 5 -- BLOCKED-table
// status unchanged by this being wired for real.
const PAYOUT_RECOVERY_MAX_DEDUCTION_PCT = new Prisma.Decimal("50");

const D = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v);

// Batches in these statuses are "open" -- a hierarchy move or grade change
// underneath one would let a batch be computed against a population that
// shifted mid-period (schema's own comment on PayoutBatch). The single
// shared home for this check: associates.ts's moveAssociate and grades.ts's
// assignGrade/runGradeQualificationSweep all call assertPayoutPeriodNotOpen
// below rather than each hand-rolling the same query (unlike this
// codebase's usual per-file duplication of trivial helpers, this is a real
// invariant with a real payload, the same reasoning rbac.ts's
// getAccessibleAssociateIds is never duplicated either).
const OPEN_PAYOUT_BATCH_STATUSES: PayoutBatchStatus[] = ["DRAFT", "PENDING_APPROVAL", "APPROVED"];

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

/** Moved here from associates.ts (Phase 4) -- see OPEN_PAYOUT_BATCH_STATUSES's
 *  own comment. associates.ts re-exports this so its existing import keeps
 *  working. */
export class PayoutPeriodOpenError extends Error {
  constructor(public readonly batchId: string) {
    super(`A payout batch (${batchId}) is currently open; hierarchy moves and grade changes are rejected until it closes.`);
    this.name = "PayoutPeriodOpenError";
  }
}

export class RecoveryNotFoundError extends Error {
  constructor(public readonly recoveryId: string) {
    super(`Recovery ${recoveryId} not found.`);
    this.name = "RecoveryNotFoundError";
  }
}

export class RecoveryAlreadyResolvedError extends Error {
  constructor(
    public readonly recoveryId: string,
    public readonly status: RecoveryStatus,
  ) {
    super(`Recovery ${recoveryId} is already ${status}; nothing left to write off.`);
    this.name = "RecoveryAlreadyResolvedError";
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

/** The one place a caller checks "is a payout period currently open" --
 *  see OPEN_PAYOUT_BATCH_STATUSES's own comment for why this isn't
 *  duplicated per file. Throws PayoutPeriodOpenError if so. */
export async function assertPayoutPeriodNotOpen(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  const openBatch = await tx.payoutBatch.findFirst({
    where: { orgId, status: { in: OPEN_PAYOUT_BATCH_STATUSES } },
    select: { id: true },
  });
  if (openBatch) throw new PayoutPeriodOpenError(openBatch.id);
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

// NOT built this round (deliberate call, see PROGRESS.md's Phase 4 decision
// log): docs/07-API.md's /jobs/payouts/run and docs/adr/0005-netlify-
// native-jobs-no-redis.md both describe a chunked, cursor-persisted design
// for this function -- "process N associates per invocation and chain...
// measure the actual wall clock and tune N from the measurement." There is
// no real payout volume yet to measure against, so building cursor/resume
// logic now would be speculative. prepareBatch stays one transaction until
// a real month-end run shows it's actually needed.
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
        include: {
          beneficiary: {
            select: { id: true, engagementType: true, isGstRegistered: true, bankAccountLast4: true, bankIfsc: true, panEncrypted: true },
          },
        },
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

        const section = resolveTdsSection(beneficiary.engagementType);
        const taxRate = await tx.taxRate.findFirst({
          where: { orgId: params.orgId, section, validFrom: { lte: asOf }, OR: [{ validTo: null }, { validTo: { gt: asOf } }] },
          orderBy: { validFrom: "desc" },
        });
        if (!taxRate) throw new NoTaxRateConfiguredError(params.orgId, section, asOf);

        // Sec. 206AA: a higher rate applies when the deductee has no PAN on
        // file -- the field existed on TaxRate before this but was never
        // actually applied anywhere until now.
        const hasPan = beneficiary.panEncrypted !== null;
        const effectiveTdsRatePct = resolveEffectiveTdsRate(
          { ratePct: new Decimal(taxRate.ratePct.toString()), noPanRatePct: taxRate.noPanRatePct ? new Decimal(taxRate.noPanRatePct.toString()) : null },
          hasPan,
        );
        const tdsRatePct = D(effectiveTdsRatePct.toString());
        const tdsAmount = D(computeTds(new Decimal(grossAmount.toString()), effectiveTdsRatePct).toString());

        const applyGst = gstApplies(beneficiary.engagementType, beneficiary.isGstRegistered);
        const gstRatePct = applyGst ? D(GST_RATE_PCT_IF_REGISTERED.toString()) : null;
        const gstAmount = applyGst ? D(computeGst(new Decimal(grossAmount.toString())).toString()) : D(0);

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
            tdsRatePct,
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

// ── Export ─────────────────────────────────────────────────────────────

function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((row) => row.map(csvField).join(",")).join("\r\n");
}

export interface ExportCsvs {
  /** NEFT/RTGS bank-transfer instructions for CONSULTANT/CHANNEL_PARTNER
   *  lines. Real decrypted account data, not tied to any one bank's
   *  proprietary file layout (none is documented anywhere in docs/) --
   *  served directly in the HTTP response, not persisted to blob storage. */
  bankFileCsv: string;
  /** EMPLOYEE lines: payroll owns the actual bank transfer and Sec. 192
   *  TDS, so this carries the AMOUNT data only, no bank details. */
  payrollHandoffCsv: string;
  bankFileLineCount: number;
  payrollLineCount: number;
}

export interface ExportedBatch extends PayoutBatch, ExportCsvs {}

/** Splits the batch's lines by destination (docs/11-COMPLIANCE-INDIA.md's
 *  own engagement-type table: EMPLOYEE routes through payroll, CONSULTANT/
 *  CHANNEL_PARTNER get a real bank transfer) -- previously every line was
 *  treated identically and only a fake storage key was written. Decrypting
 *  a beneficiary's bank account number for the real bank-file CSV is a PII
 *  reveal, audited the same way KYC document access is (docs/10-SECURITY.md:
 *  "Viewing a KYC document writes AuditAction.VIEW_SENSITIVE") -- one row
 *  per decrypted line, not a single batch-level row, so each reveal is
 *  individually traceable, and happens EVERY time this runs (including a
 *  later re-download), not just the first. Shared by exportBatch (the
 *  one-time state transition) and getBatchExportCsvs (a later re-download
 *  of the same content, since nothing here is persisted to blob storage). */
async function buildExportCsvs(
  tx: PrismaNS.TransactionClient,
  params: { batchId: string; batchNumber: string; audit: AuditContext },
): Promise<ExportCsvs> {
  const lines = await tx.payoutLine.findMany({
    where: { batchId: params.batchId },
    include: {
      associate: {
        select: {
          code: true,
          engagementType: true,
          bankAccountEncrypted: true,
          bankName: true,
          bankBranch: true,
          user: { select: { name: true } },
        },
      },
    },
    orderBy: { netPayable: "desc" },
  });

  const bankFileRows: string[][] = [];
  const payrollRows: string[][] = [];

  for (const line of lines) {
    const { associate } = line;
    if (associate.engagementType === "EMPLOYEE") {
      payrollRows.push([
        associate.user.name,
        associate.code,
        line.grossAmount.toFixed(2),
        line.tdsAmount.toFixed(2),
        line.netPayable.toFixed(2),
      ]);
      continue;
    }

    const accountNumber = associate.bankAccountEncrypted ? decryptField(associate.bankAccountEncrypted) : "";
    if (associate.bankAccountEncrypted) {
      await writeAuditLog(tx, params.audit, {
        action: "VIEW_SENSITIVE",
        entity: "Associate",
        entityId: line.associateId,
        reason: `Bank account decrypted for payout batch ${params.batchNumber} export`,
      });
    }
    bankFileRows.push([
      associate.user.name,
      associate.code,
      associate.bankName ?? "",
      accountNumber,
      line.bankIfsc ?? "",
      line.netPayable.toFixed(2),
    ]);
  }

  return {
    bankFileCsv: toCsv(["Beneficiary name", "Associate code", "Bank name", "Account number", "IFSC", "Net payable"], bankFileRows),
    payrollHandoffCsv: toCsv(["Beneficiary name", "Associate code", "Gross", "TDS", "Net payable"], payrollRows),
    bankFileLineCount: bankFileRows.length,
    payrollLineCount: payrollRows.length,
  };
}

export async function exportBatch(
  db: PrismaClient,
  params: { batchId: string; audit: AuditContext; now?: Date },
): Promise<ExportedBatch> {
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

    const csvs = await buildExportCsvs(tx, { batchId: batch.id, batchNumber: batch.batchNumber, audit: params.audit });

    const updated = await tx.payoutBatch.update({
      where: { id: batch.id },
      data: { status: "EXPORTED", exportedAt: now, bankFileStorageKey: `payout-batches/${batch.id}/${now.toISOString()}` },
    });

    await writeAuditLog(tx, params.audit, {
      action: "EXPORT",
      entity: "PayoutBatch",
      entityId: batch.id,
      after: { status: "EXPORTED", bankFileStorageKey: updated.bankFileStorageKey, bankFileLineCount: csvs.bankFileLineCount, payrollLineCount: csvs.payrollLineCount },
    });

    return { ...updated, ...csvs };
  });
}

/** A later re-download of the same CSVs exportBatch already produced --
 *  nothing is persisted to blob storage, so the only way to get this
 *  content again is to rebuild it from the batch's own PayoutLine rows,
 *  which still exist. Read-only: no state transition, only callable once
 *  the batch has actually been exported. Still re-decrypts and re-audits
 *  every bank account revealed, same as the original export. */
export async function getBatchExportCsvs(
  db: PrismaClient,
  params: { batchId: string; audit: AuditContext },
): Promise<ExportCsvs> {
  const actorId = requireActor(params.audit);

  return db.$transaction(async (tx) => {
    const batch = await tx.payoutBatch.findUnique({ where: { id: params.batchId } });
    if (!batch) throw new PayoutBatchNotFoundError(params.batchId);
    if (batch.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Payout batch ${params.batchId} belongs to another organisation.`);
    }

    await assertPermission(tx, actorId, EXPORT_PERMISSION);
    if (batch.status !== "EXPORTED") {
      throw new PayoutBatchNotExportableError(batch.id, batch.status);
    }

    return buildExportCsvs(tx, { batchId: batch.id, batchNumber: batch.batchNumber, audit: params.audit });
  });
}

// ── Recovery write-off ───────────────────────────────────────────────────

/** Phase 4 -- confirmed gap: recovery.write_off (permission-matrix.ts) and
 *  RecoveryStatus.WRITTEN_OFF (schema) both already existed with nothing
 *  ever setting a Recovery to that status. Zeroes outstandingAmount --
 *  forgiven, not paid, so it should read as fully resolved everywhere
 *  listRecoveries and prepareBatch's own outstanding-recovery query look. */
export async function writeOffRecovery(
  db: PrismaClient,
  params: { recoveryId: string; reason: string; audit: AuditContext },
): Promise<Recovery> {
  const actorId = requireActor(params.audit);
  const now = new Date();

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "recoveries" WHERE "id" = ${params.recoveryId} FOR UPDATE`;

    const recovery = await tx.recovery.findUnique({ where: { id: params.recoveryId } });
    if (!recovery) throw new RecoveryNotFoundError(params.recoveryId);
    if (recovery.orgId !== params.audit.orgId) {
      throw new ForbiddenError(`Recovery ${params.recoveryId} belongs to another organisation.`);
    }

    await assertPermission(tx, actorId, WRITE_OFF_PERMISSION);

    if (recovery.status === "RECOVERED" || recovery.status === "WRITTEN_OFF") {
      throw new RecoveryAlreadyResolvedError(recovery.id, recovery.status);
    }

    const before = { status: recovery.status, outstandingAmount: recovery.outstandingAmount.toString() };
    const updated = await tx.recovery.update({
      where: { id: recovery.id },
      data: { status: "WRITTEN_OFF", outstandingAmount: D(0), writtenOffById: actorId, writtenOffAt: now },
    });

    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "Recovery",
      entityId: updated.id,
      before,
      after: { status: updated.status, outstandingAmount: updated.outstandingAmount.toString() },
      reason: params.reason,
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

// ── Statement (Phase 4 -- data for the commission statement PDF) ─────────

export class PayoutLineNotFoundError extends Error {
  constructor(public readonly payoutLineId: string) {
    super(`Payout line ${payoutLineId} not found.`);
    this.name = "PayoutLineNotFoundError";
  }
}

async function resolveActorRoleCodes(db: PrismaClient | PrismaNS.TransactionClient, actorId: string): Promise<Set<string>> {
  const roles = await db.userRole.findMany({ where: { userId: actorId }, select: { role: { select: { code: true } } } });
  return new Set(roles.map((r) => r.role.code));
}

export interface PayoutLineStatement {
  line: PayoutLine;
  batch: { batchNumber: string; periodStart: Date; periodEnd: Date };
  associate: { code: string; name: string };
  entries: Array<{ entry: CommissionEntry }>;
}

/** The data behind the commission statement PDF -- the route (apps/web)
 *  renders this with @react-pdf/renderer. Scoped identically to
 *  commission.ts's own getEarnings/explainEntry (own line, or an
 *  admin-shaped role, or a TEAM_LEAD's downline) since a payout line is
 *  just as much "this associate's commission data" as an entry is. */
export async function getPayoutLineStatement(
  db: PrismaClient,
  params: { orgId: string; actorId: string; payoutLineId: string },
): Promise<PayoutLineStatement> {
  await assertPermission(db, params.actorId, STATEMENT_READ_PERMISSION);

  const line = await db.payoutLine.findUnique({
    where: { id: params.payoutLineId },
    include: {
      batch: { select: { orgId: true, batchNumber: true, periodStart: true, periodEnd: true } },
      associate: { select: { code: true, user: { select: { name: true } } } },
      entries: { include: { entry: true } },
    },
  });
  if (!line || line.batch.orgId !== params.orgId) throw new PayoutLineNotFoundError(params.payoutLineId);

  const roleCodes = await resolveActorRoleCodes(db, params.actorId);
  if (![...roleCodes].some((r) => UNRESTRICTED_ROLE_CODES.has(r))) {
    const caller = await db.associate.findUnique({ where: { userId: params.actorId }, select: { id: true } });
    if (!caller) throw new ForbiddenError("This account has no associate profile.");
    const mode: ScopeMode = roleCodes.has("TEAM_LEAD") ? "OWN_AND_DOWNLINE" : "OWN";
    const accessible = await getAccessibleAssociateIds(db, caller.id, mode);
    if (!accessible.includes(line.associateId)) {
      throw new ForbiddenError(`Payout line ${params.payoutLineId} is outside this session's scope.`);
    }
  }

  return {
    line,
    batch: line.batch,
    associate: { code: line.associate.code, name: line.associate.user.name },
    entries: line.entries,
  };
}
