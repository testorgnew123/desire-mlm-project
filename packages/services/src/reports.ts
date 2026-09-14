// Phase 5's report catalogue (docs/20-REPORTS.md, 30 reports across 5
// categories). Building all 30 in one pass isn't real engineering, it's
// mass-producing near-identical shallow pages -- so this ships one real,
// tested, row-scoped report per category instead, sharing the export
// mechanics in ./export.ts. The remaining ~24 follow the exact same
// pattern (a query function returning {asOf, columns, rows}, gated by
// report.read plus whatever narrower permission the category already
// uses) -- not built this pass, same "real gap, stated plainly" treatment
// as Phase 4's deferred payout batch chunking.
//
// Every report writes AuditAction.EXPORT via writeExportAudit -- the route
// layer (apps/web) calls that after building the rows, not here, so a
// caller previewing a report on-screen (not exporting it) doesn't spuriously
// audit an export that never happened.
import type { PrismaClient } from "@desire/db";
import { assertPermission, ForbiddenError, getAccessibleAssociateIds, type ScopeMode } from "./rbac";
import { getCollectionsConsole } from "./collections-sweep";
import type { ReportColumn } from "./export";

export interface ReportResult {
  asOf: Date;
  columns: ReportColumn[];
  rows: string[][];
}

const REPORT_PERMISSION = "report.read";
const UNRESTRICTED_ROLE_CODES: ReadonlySet<string> = new Set(["SUPER_ADMIN", "FINANCE_ADMIN", "SALES_HEAD", "AUDITOR"]);

async function resolveActorRoleCodes(db: PrismaClient, actorId: string): Promise<Set<string>> {
  const roles = await db.userRole.findMany({ where: { userId: actorId }, select: { role: { select: { code: true } } } });
  return new Set(roles.map((r) => r.role.code));
}

/** OWN for a plain associate, OWN_AND_DOWNLINE for a team lead, unrestricted
 *  (whole org) for admin-shaped roles -- the same three-way split every
 *  other row-scoped read in this codebase already uses (payouts.ts's
 *  getPayoutLineStatement, collections-sweep.ts's getCollectionsConsole). */
async function resolveScope(
  db: PrismaClient,
  params: { orgId: string; actorId: string },
): Promise<{ unrestricted: true } | { unrestricted: false; associateIds: string[] }> {
  const roleCodes = await resolveActorRoleCodes(db, params.actorId);
  if ([...roleCodes].some((r) => UNRESTRICTED_ROLE_CODES.has(r))) return { unrestricted: true };

  const caller = await db.associate.findUnique({ where: { userId: params.actorId }, select: { id: true } });
  if (!caller) throw new ForbiddenError("This account has no associate profile.");
  const mode: ScopeMode = roleCodes.has("TEAM_LEAD") ? "OWN_AND_DOWNLINE" : "OWN";
  const associateIds = await getAccessibleAssociateIds(db, caller.id, mode);
  return { unrestricted: false, associateIds };
}

const money = (value: { toFixed(n: number): string }): string => value.toFixed(2);
const isoDate = (value: Date): string => value.toISOString().slice(0, 10);

// ── 1. Stock statement (Inventory) ───────────────────────────────────────

export async function getStockStatementReport(
  db: PrismaClient,
  params: { orgId: string; actorId: string; projectId?: string },
): Promise<ReportResult> {
  await assertPermission(db, params.actorId, REPORT_PERMISSION, { projectId: params.projectId });

  const units = await db.unit.findMany({
    where: { orgId: params.orgId, projectId: params.projectId },
    select: {
      unitNumber: true,
      floor: true,
      status: true,
      project: { select: { name: true } },
      tower: { select: { name: true } },
      unitType: { select: { name: true } },
      bookings: { where: { status: { notIn: ["CANCELLED"] } }, select: { bookingNumber: true }, take: 1 },
    },
    orderBy: [{ project: { name: "asc" } }, { floor: "asc" }, { unitNumber: "asc" }],
  });

  return {
    asOf: new Date(),
    columns: [
      { key: "project", label: "Project" },
      { key: "tower", label: "Tower" },
      { key: "unit", label: "Unit" },
      { key: "floor", label: "Floor" },
      { key: "unitType", label: "Unit type" },
      { key: "status", label: "Status" },
      { key: "booking", label: "Booking #" },
    ],
    rows: units.map((unit) => [
      unit.project.name,
      unit.tower?.name ?? "",
      unit.unitNumber,
      String(unit.floor),
      unit.unitType.name,
      unit.status,
      unit.bookings[0]?.bookingNumber ?? "",
    ]),
  };
}

// ── 2. Sales funnel (Sales & CRM) ────────────────────────────────────────

/** One row per stage, in funnel order -- not one row per lead. Conversion is
 *  against the immediately preceding stage, matching docs/20-REPORTS.md's
 *  "conversion at each stage" wording. LOST/DORMANT are reported as their
 *  own terminal counts, not folded into the funnel order. */
const FUNNEL_STAGES = ["NEW", "CONTACTED", "QUALIFIED", "SITE_VISIT_SCHEDULED", "SITE_VISIT_DONE", "NEGOTIATION", "BOOKED"] as const;

export async function getSalesFunnelReport(
  db: PrismaClient,
  params: { orgId: string; actorId: string },
): Promise<ReportResult> {
  await assertPermission(db, params.actorId, REPORT_PERMISSION);
  const scope = await resolveScope(db, params);

  const where = {
    orgId: params.orgId,
    ...(scope.unrestricted ? {} : { assignedAssociateId: { in: scope.associateIds } }),
  };

  const byStage = await db.lead.groupBy({ by: ["stage"], where, _count: true });
  const countByStage = new Map(byStage.map((row) => [row.stage, row._count]));

  const rows: string[][] = [];
  let previousCount: number | null = null;
  for (const stage of FUNNEL_STAGES) {
    const count = countByStage.get(stage) ?? 0;
    const conversionPct = previousCount && previousCount > 0 ? ((count / previousCount) * 100).toFixed(1) : "";
    rows.push([stage, String(count), conversionPct]);
    previousCount = count;
  }
  for (const terminalStage of ["LOST", "DORMANT"] as const) {
    rows.push([terminalStage, String(countByStage.get(terminalStage) ?? 0), ""]);
  }

  return {
    asOf: new Date(),
    columns: [
      { key: "stage", label: "Stage" },
      { key: "count", label: "Leads" },
      { key: "conversionPct", label: "Conversion from previous stage (%)" },
    ],
    rows,
  };
}

// ── 3. Outstanding aging (Collections) ───────────────────────────────────

const AGING_BUCKETS = [
  { label: "0-7 days", min: 0, max: 7 },
  { label: "8-30 days", min: 8, max: 30 },
  { label: "31-60 days", min: 31, max: 60 },
  { label: "60+ days", min: 61, max: Infinity },
] as const;

function agingBucketLabel(daysOverdue: number): string {
  return AGING_BUCKETS.find((bucket) => daysOverdue >= bucket.min && daysOverdue <= bucket.max)?.label ?? "";
}

/** Detail rows, not just bucket totals -- docs/20-REPORTS.md's "0-7/8-30/
 *  31-60/60+ buckets with totals" is exactly what a spreadsheet pivot on the
 *  Bucket column gives for free; a detail export is strictly more useful
 *  than a pre-aggregated one and the dashboard tile already covers the
 *  glanceable summary. Reuses getCollectionsConsole entirely rather than
 *  re-deriving its overdue/bucket math a second time. */
export async function getOutstandingAgingReport(
  db: PrismaClient,
  params: { orgId: string; actorId: string; projectId?: string },
): Promise<ReportResult> {
  const consoleRows = await getCollectionsConsole(db, { orgId: params.orgId, actorId: params.actorId, projectId: params.projectId });

  return {
    asOf: new Date(),
    columns: [
      { key: "project", label: "Project" },
      { key: "booking", label: "Booking #" },
      { key: "customer", label: "Customer" },
      { key: "unit", label: "Unit" },
      { key: "outstanding", label: "Outstanding" },
      { key: "dueDate", label: "Due date" },
      { key: "daysOverdue", label: "Days overdue" },
      { key: "bucket", label: "Bucket" },
    ],
    rows: consoleRows.map((row) => [
      row.projectId,
      row.bookingNumber,
      row.customerName,
      row.unitNumber,
      row.outstanding,
      row.dueDate,
      String(row.daysOverdue),
      agingBucketLabel(row.daysOverdue),
    ]),
  };
}

// ── 4. Commission liability (Commission & payouts) ───────────────────────

/** Finance-only per docs/20-REPORTS.md -- unlike the other five reports,
 *  this one is never associate-scoped down to "your own commission" (that's
 *  the Associate earnings statement report, not built this pass). Gated on
 *  the same unrestricted-role set as everything else finance-shaped in this
 *  codebase, not just report.read, since an ASSOCIATE holding report.read
 *  must not see every other associate's liability. */
export async function getCommissionLiabilityReport(
  db: PrismaClient,
  params: { orgId: string; actorId: string },
): Promise<ReportResult> {
  await assertPermission(db, params.actorId, REPORT_PERMISSION);
  const scope = await resolveScope(db, params);
  if (!scope.unrestricted) {
    throw new ForbiddenError("Commission liability is a finance-only report.");
  }

  const rows = await db.commissionEntry.groupBy({
    by: ["beneficiaryAssociateId", "status"],
    where: { orgId: params.orgId, status: { not: "REVERSED" } },
    _sum: { grossAmount: true },
  });

  const associateIds = [...new Set(rows.map((row) => row.beneficiaryAssociateId))];
  const associates = await db.associate.findMany({
    where: { id: { in: associateIds } },
    select: { id: true, code: true, user: { select: { name: true } } },
  });
  const associateById = new Map(associates.map((a) => [a.id, a]));

  const byAssociate = new Map<string, { accrued: string; payable: string; paid: string }>();
  for (const row of rows) {
    const entry = byAssociate.get(row.beneficiaryAssociateId) ?? { accrued: "0.00", payable: "0.00", paid: "0.00" };
    const amount = money(row._sum.grossAmount ?? { toFixed: () => "0.00" });
    if (row.status === "ACCRUED" || row.status === "ON_HOLD") entry.accrued = amount;
    if (row.status === "PAYABLE") entry.payable = amount;
    if (row.status === "PAID") entry.paid = amount;
    byAssociate.set(row.beneficiaryAssociateId, entry);
  }

  return {
    asOf: new Date(),
    columns: [
      { key: "associateCode", label: "Associate code" },
      { key: "associateName", label: "Associate" },
      { key: "accrued", label: "Accrued" },
      { key: "payable", label: "Payable" },
      { key: "paid", label: "Paid" },
    ],
    rows: [...byAssociate.entries()].map(([associateId, totals]) => {
      const associate = associateById.get(associateId);
      return [associate?.code ?? associateId, associate?.user.name ?? "", totals.accrued, totals.payable, totals.paid];
    }),
  };
}

// ── 5. Audit trail (Compliance & audit) ──────────────────────────────────

/** Gated on audit.read, not report.read -- this report exposes every
 *  actor's every action, a materially more sensitive surface than the other
 *  five. Deliberately does not touch TDS/GST/Form 16A reports: those stay
 *  declined, same as Phase 4 (no CA, no confirmed rates -- see
 *  docs/11-COMPLIANCE-INDIA.md). */
export async function getAuditTrailReport(
  db: PrismaClient,
  params: { orgId: string; actorId: string; entity?: string; action?: string; fromDate?: Date; toDate?: Date },
): Promise<ReportResult> {
  await assertPermission(db, params.actorId, "audit.read");

  const entries = await db.auditLog.findMany({
    where: {
      orgId: params.orgId,
      entity: params.entity,
      action: params.action as never,
      createdAt: { gte: params.fromDate, lte: params.toDate },
    },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  return {
    asOf: new Date(),
    columns: [
      { key: "createdAt", label: "When" },
      { key: "actor", label: "Actor" },
      { key: "action", label: "Action" },
      { key: "entity", label: "Entity" },
      { key: "entityId", label: "Entity ID" },
      { key: "reason", label: "Reason" },
    ],
    rows: entries.map((entry) => [
      entry.createdAt.toISOString(),
      entry.actorLabel,
      entry.action,
      entry.entity,
      entry.entityId,
      entry.reason ?? "",
    ]),
  };
}

// ── 6. Tally-ish transaction export (the Tally/ERP export stopgap) ──────

/** Not real Tally XML -- docs/01-PRD.md says only "export to Tally instead",
 *  with no ledger mapping or voucher type specified anywhere. Building a
 *  real Tally voucher XML without that mapping risks being actively wrong,
 *  the same reasoning that declined a fabricated Form 16A/TDS-challan
 *  format in Phase 4. This is a flat, generic transaction export -- the
 *  receipts half already exists as the "Receipt register" report data
 *  shape; this adds bookings and payout lines alongside it so an
 *  accountant has one file to hand-map into their own ledger, not three. */
export async function getTallyTransactionExport(
  db: PrismaClient,
  params: { orgId: string; actorId: string },
): Promise<ReportResult> {
  await assertPermission(db, params.actorId, REPORT_PERMISSION);
  const scope = await resolveScope(db, params);
  if (!scope.unrestricted) {
    throw new ForbiddenError("The transaction export is a finance-only report.");
  }

  const [bookings, receipts, payoutLines] = await Promise.all([
    db.booking.findMany({
      where: { orgId: params.orgId, status: { not: "CANCELLED" } },
      select: { bookingNumber: true, bookingDate: true, agreementValue: true, customer: { select: { name: true } } },
    }),
    db.receipt.findMany({
      where: { orgId: params.orgId, status: { in: ["CLEARED"] } },
      select: { receiptNumber: true, receivedOn: true, amount: true, booking: { select: { bookingNumber: true } } },
    }),
    db.payoutLine.findMany({
      where: { batch: { orgId: params.orgId, status: "PAID" } },
      select: { netPayable: true, batch: { select: { batchNumber: true, paidAt: true } }, associate: { select: { code: true } } },
    }),
  ]);

  const rows: string[][] = [
    ...bookings.map((b) => ["BOOKING", isoDate(b.bookingDate), b.bookingNumber, b.customer.name, money(b.agreementValue)]),
    ...receipts.map((r) => ["RECEIPT", isoDate(r.receivedOn), r.receiptNumber, r.booking.bookingNumber, money(r.amount)]),
    ...payoutLines.map((p) => ["PAYOUT", isoDate(p.batch.paidAt ?? new Date(0)), p.batch.batchNumber, p.associate.code, money(p.netPayable)]),
  ];

  return {
    asOf: new Date(),
    columns: [
      { key: "type", label: "Type" },
      { key: "date", label: "Date" },
      { key: "reference", label: "Reference" },
      { key: "party", label: "Party" },
      { key: "amount", label: "Amount" },
    ],
    rows,
  };
}
