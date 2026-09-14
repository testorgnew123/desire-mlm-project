// Report builder (docs/20-REPORTS.md, Phase 5): "Saved views over a curated
// set of fields... schedulable to email. Not raw SQL access." A saved view
// is just a persisted reportKey + filters -- runScheduledReportEmails
// re-runs the exact same scoped report function every time, so a view can
// never see more than the user who created it could see live.
import { CronExpressionParser } from "cron-parser";
import type { Prisma, PrismaClient, SavedReportView } from "@desire/db";
import { ForbiddenError } from "./rbac";
import { toCsv, writeExportAudit } from "./export";
import { sendEmail, EmailConfigError } from "./email";
import {
  getAuditTrailReport,
  getCommissionLiabilityReport,
  getOutstandingAgingReport,
  getSalesFunnelReport,
  getStockStatementReport,
  getTallyTransactionExport,
  type ReportResult,
} from "./reports";
import { type AuditContext } from "./audit";

type ReportFn = (db: PrismaClient, params: { orgId: string; actorId: string; projectId?: string }) => Promise<ReportResult>;

const REPORT_FUNCTIONS: Record<string, ReportFn> = {
  "stock-statement": getStockStatementReport,
  "sales-funnel": getSalesFunnelReport,
  "outstanding-aging": getOutstandingAgingReport,
  "commission-liability": getCommissionLiabilityReport,
  "audit-trail": getAuditTrailReport,
  "tally-export": getTallyTransactionExport,
};

export class UnknownReportKeyError extends Error {
  constructor(reportKey: string) {
    super(`No report named "${reportKey}".`);
  }
}

export class SavedViewNotFoundError extends Error {
  constructor(id: string) {
    super(`Saved report view ${id} not found.`);
  }
}

function requireActor(audit: AuditContext): string {
  if (!audit.actorId) throw new ForbiddenError("Saved report views require a user actor, not a system actor.");
  return audit.actorId;
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export interface CreateSavedViewParams {
  reportKey: string;
  name: string;
  filters?: Record<string, unknown>;
  scheduleCron?: string | null;
  audit: AuditContext;
}

export async function createSavedView(db: PrismaClient, params: CreateSavedViewParams): Promise<SavedReportView> {
  const actorId = requireActor(params.audit);
  if (!REPORT_FUNCTIONS[params.reportKey]) throw new UnknownReportKeyError(params.reportKey);
  if (params.scheduleCron) CronExpressionParser.parse(params.scheduleCron); // throws on a malformed expression

  return db.savedReportView.create({
    data: {
      orgId: params.audit.orgId,
      userId: actorId,
      reportKey: params.reportKey,
      name: params.name,
      filters: (params.filters ?? {}) as Prisma.InputJsonValue,
      scheduleCron: params.scheduleCron ?? null,
    },
  });
}

export async function listSavedViews(db: PrismaClient, params: { audit: AuditContext }): Promise<SavedReportView[]> {
  const actorId = requireActor(params.audit);
  return db.savedReportView.findMany({
    where: { orgId: params.audit.orgId, userId: actorId },
    orderBy: { createdAt: "desc" },
  });
}

export async function deleteSavedView(db: PrismaClient, params: { id: string; audit: AuditContext }): Promise<void> {
  const actorId = requireActor(params.audit);
  const view = await db.savedReportView.findUnique({ where: { id: params.id } });
  if (!view || view.orgId !== params.audit.orgId || view.userId !== actorId) {
    throw new SavedViewNotFoundError(params.id);
  }
  await db.savedReportView.delete({ where: { id: params.id } });
}

// ── Scheduled send ────────────────────────────────────────────────────────

/** A view is due when its cron expression's most recent scheduled fire time
 *  is at or after its own lastRunAt (or it has never run) -- computed via
 *  prev(), not by comparing to "now" against a stored next-run field, so a
 *  missed run (the job endpoint down, or the GitHub Actions trigger
 *  delayed) still fires exactly once on the next check rather than being
 *  silently skipped, same "correct even if delayed" discipline as every
 *  other job in this project. */
function isDue(view: SavedReportView, now: Date): boolean {
  if (!view.scheduleCron) return false;
  const mostRecentFire = CronExpressionParser.parse(view.scheduleCron, { currentDate: now }).prev().toDate();
  return !view.lastRunAt || mostRecentFire > view.lastRunAt;
}

export interface ScheduledReportRunResult {
  sent: number;
  failed: number;
}

export async function runScheduledReportEmails(db: PrismaClient, now: Date = new Date()): Promise<ScheduledReportRunResult> {
  const views = await db.savedReportView.findMany({
    where: { scheduleCron: { not: null } },
    include: { user: { select: { email: true, orgId: true, name: true } } },
  });

  let sent = 0;
  let failed = 0;

  for (const view of views) {
    if (!isDue(view, now)) continue;

    const reportFn = REPORT_FUNCTIONS[view.reportKey];
    if (!reportFn) {
      failed++;
      continue;
    }

    try {
      const filters = (view.filters ?? {}) as { projectId?: string };
      const report = await reportFn(db, { orgId: view.orgId, actorId: view.userId, projectId: filters.projectId });
      const csv = toCsv(report.columns.map((c) => c.label), report.rows);

      await sendEmail({
        to: view.user.email,
        subject: `${view.name} -- scheduled report`,
        text: `Attached: ${view.name}, as of ${report.asOf.toISOString()}.`,
        attachment: { filename: `${view.reportKey}.csv`, content: csv, contentType: "text/csv" },
      });

      await writeExportAudit(
        db,
        { orgId: view.orgId, actorId: null, actorLabel: `Scheduled report: ${view.name}` },
        { reportKey: view.reportKey, format: "csv", rowCount: report.rows.length },
      );

      await db.savedReportView.update({ where: { id: view.id }, data: { lastRunAt: now } });
      sent++;
    } catch (error) {
      // EmailConfigError means no SMTP account is configured yet -- expected
      // until the client points MAIL_FROM/SMTP_* at a real free account
      // (see email.ts's header comment). Every other error is a real
      // failure; both count against this run, neither crashes the sweep.
      if (!(error instanceof EmailConfigError)) console.error(`Scheduled report ${view.id} failed:`, error);
      failed++;
    }
  }

  return { sent, failed };
}
