// Report catalogue -- GET /reports/:reportKey?format=csv|xlsx.
// docs/20-REPORTS.md specs 30 reports; this ships 6 real, tested exemplars
// (one per category) sharing this one route, plus the shared export engine
// in packages/services/src/export.ts. The remaining ~24 follow the same
// {asOf, columns, rows} shape and would slot into REPORT_FUNCTIONS below
// with zero route changes -- not built this pass (PROGRESS.md).
//
// One shared route, not six near-identical files: the six report functions
// differ in real query logic (that lives in packages/services), but the
// route's own job -- auth, ?format, call the matching function, stream the
// file, audit -- is identical across all of them, which is exactly the
// case where sharing earns its keep over this codebase's usual per-file
// duplication convention.
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import {
  getAuditTrailReport,
  getCommissionLiabilityReport,
  getOutstandingAgingReport,
  getSalesFunnelReport,
  getStockStatementReport,
  getTallyTransactionExport,
  type ReportResult,
} from "@desire/services/reports";
import { toCsv, writeExportAudit } from "@desire/services/export";
// Narrow subpath on purpose: @desire/services/xlsx owns the ~810 KB exceljs
// import, and this is the only route in the app that needs a workbook.
import { toXlsx } from "@desire/services/xlsx";
import { readSessionToken } from "@/lib/api-session";

export const dynamic = "force-dynamic";

function problemResponse(params: { status: number; type: string; title: string; detail: string; instance: string }): Response {
  return Response.json(
    {
      type: `https://docs.internal/errors/${params.type}`,
      title: params.title,
      status: params.status,
      detail: params.detail,
      instance: params.instance,
    },
    { status: params.status, headers: { "content-type": "application/problem+json" } },
  );
}

type ReportFn = (db: ReturnType<typeof getPrismaClient>, params: { orgId: string; actorId: string; projectId?: string }) => Promise<ReportResult>;

const REPORT_FUNCTIONS: Record<string, ReportFn> = {
  "stock-statement": getStockStatementReport,
  "sales-funnel": getSalesFunnelReport,
  "outstanding-aging": getOutstandingAgingReport,
  "commission-liability": getCommissionLiabilityReport,
  "audit-trail": getAuditTrailReport,
  "tally-export": getTallyTransactionExport,
};

export async function GET(request: Request, { params }: { params: Promise<{ reportKey: string }> }) {
  const { reportKey } = await params;
  const url = new URL(request.url);

  const reportFn = REPORT_FUNCTIONS[reportKey];
  if (!reportFn) {
    return problemResponse({
      status: 404, type: "report-not-found", title: "Not Found",
      detail: `No report named "${reportKey}".`, instance: url.pathname,
    });
  }

  const format = url.searchParams.get("format") === "xlsx" ? "xlsx" : "csv";
  const projectId = url.searchParams.get("projectId") ?? undefined;

  const token = readSessionToken(request);
  if (token === null) {
    return problemResponse({
      status: 401, type: "unauthenticated", title: "Unauthenticated",
      detail: "A session cookie or bearer token is required.", instance: url.pathname,
    });
  }

  const db = getPrismaClient();

  let session;
  try {
    session = await validateSession(db, token);
  } catch (error) {
    if (error instanceof SessionInvalidError) {
      return problemResponse({
        status: 401, type: "session-invalid", title: "Unauthenticated",
        detail: "The session is unknown, revoked or expired.", instance: url.pathname,
      });
    }
    throw error;
  }

  try {
    const report = await reportFn(db, { orgId: session.user.orgId, actorId: session.userId, projectId });

    await writeExportAudit(
      db,
      { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
      { reportKey, format, rowCount: report.rows.length },
    );

    const filename = `${reportKey}-${report.asOf.toISOString().slice(0, 10)}.${format}`;

    if (format === "xlsx") {
      const buffer = await toXlsx(report.columns, report.rows, report.asOf);
      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    const rowsWithAsOf = [...report.rows, [`As of ${report.asOf.toISOString()}`]];
    const csv = toCsv(report.columns.map((c) => c.label), rowsWithAsOf);
    return new Response(csv, {
      status: 200,
      headers: { "content-type": "text/csv", "content-disposition": `attachment; filename="${filename}"` },
    });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return problemResponse({
        status: 403, type: "forbidden", title: "Forbidden", detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
