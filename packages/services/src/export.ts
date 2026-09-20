// Shared export mechanics -- Phase 5's reporting surface is the second real
// caller of what used to be payouts.ts's private CSV helpers (its
// bank-file/payroll-handoff export), which is what makes this a real shared
// invariant rather than the usual per-file duplication convention in this
// codebase.
//
// This module is deliberately dependency-light: CSV needs no library, and
// keeping it that way is what allows payouts.ts (and, through it, grades.ts
// and associates.ts) to import toCsv without dragging a spreadsheet engine
// into their bundles. XLSX lives in ./xlsx, which owns the heavy `exceljs`
// import -- see that file's header for the measurement that forced the
// split. docs/20-REPORTS.md still requires "CSV and XLSX" for every report;
// only the module boundary changed, not the capability.
import type { PrismaClient, Prisma as PrismaNS } from "@desire/db";
import { writeAuditLog, type AuditContext } from "./audit";

export interface ReportColumn {
  key: string;
  label: string;
}

export function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((row) => row.map(csvField).join(",")).join("\r\n");
}

/** docs/20-REPORTS.md: "Every export writes AuditAction.EXPORT." Not tied to
 *  one entity row -- entityId is the report key itself, same as how a
 *  synthetic id is fine anywhere AuditLog.entityId isn't a real FK. */
export async function writeExportAudit(
  tx: PrismaClient | PrismaNS.TransactionClient,
  audit: AuditContext,
  params: { reportKey: string; format: "csv" | "xlsx"; rowCount: number },
): Promise<void> {
  await writeAuditLog(tx, audit, {
    action: "EXPORT",
    entity: "Report",
    entityId: params.reportKey,
    after: { format: params.format, rowCount: params.rowCount },
  });
}
