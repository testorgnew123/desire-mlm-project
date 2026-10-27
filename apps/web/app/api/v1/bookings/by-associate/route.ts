// Sales by associate, as a file -- GET /bookings/by-associate?format=csv|xlsx.
// The same numbers as the Sales report screen, from the same service: view=summary
// (one row per associate, the default) or view=bookings&associate=<id> (the bookings
// behind one row). Who may see which rows is decided in the service from the
// session, never from a parameter, so asking for someone else's id gets a 403.
// Every export writes an audit row (docs/20-REPORTS.md).
import type { BookingStatus } from "@desire/db";
import { getPrismaClient } from "@desire/db";
import { SessionInvalidError, validateSession } from "@desire/services/auth";
import { ForbiddenError } from "@desire/services/rbac";
import { toCsv, writeExportAudit } from "@desire/services/export";
import {
  SalesReportError,
  bookingsToReport,
  getSalesByAssociate,
  listAssociateBookings,
  summaryToReport,
} from "@desire/services/sales-report";
// Narrow subpath: this and the report route are the only places a workbook is built.
import { toXlsx } from "@desire/services/xlsx";
import { readSessionToken } from "@/lib/api-session";

export const dynamic = "force-dynamic";

const STATUSES: readonly BookingStatus[] = [
  "DRAFT",
  "PENDING_APPROVAL",
  "CONFIRMED",
  "AGREEMENT_SIGNED",
  "REGISTERED",
  "POSSESSION_GIVEN",
  "CANCELLED",
];

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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams;

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

  const format = query.get("format") === "xlsx" ? "xlsx" : "csv";
  const view = query.get("view") === "bookings" ? "bookings" : "summary";
  const associateId = query.get("associate") ?? undefined;
  const statusParam = query.get("status");
  const status = STATUSES.find((value) => value === statusParam);
  const filter = {
    projectId: query.get("projectId") || undefined,
    from: query.get("from") || undefined,
    to: query.get("to") || undefined,
  };
  const actor = { orgId: session.user.orgId, actorId: session.userId };

  try {
    if (view === "bookings" && !associateId) {
      return problemResponse({
        status: 400, type: "bad-request", title: "Bad Request",
        detail: "view=bookings needs an associate id.", instance: url.pathname,
      });
    }

    const asOf = new Date();
    const report =
      view === "bookings"
        ? bookingsToReport((await listAssociateBookings(db, { ...actor, ...filter, associateId: associateId!, status })).rows)
        : summaryToReport(await getSalesByAssociate(db, { ...actor, ...filter }));

    await writeExportAudit(
      db,
      { orgId: session.user.orgId, actorId: session.userId, actorLabel: session.user.name },
      { reportKey: view === "bookings" ? "sales-by-associate-bookings" : "sales-by-associate", format, rowCount: report.rows.length },
    );

    const filename = `sales-by-associate${view === "bookings" ? "-bookings" : ""}-${asOf.toISOString().slice(0, 10)}.${format}`;
    if (format === "xlsx") {
      const buffer = await toXlsx(report.columns, report.rows, asOf);
      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": `attachment; filename="${filename}"`,
        },
      });
    }
    const csv = toCsv(report.columns.map((column) => column.label), [...report.rows, [`As of ${asOf.toISOString()}`]]);
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
    if (error instanceof SalesReportError) {
      return problemResponse({
        status: 400, type: "bad-request", title: "Bad Request", detail: error.message, instance: url.pathname,
      });
    }
    throw error;
  }
}
