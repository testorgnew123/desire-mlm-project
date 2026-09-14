// Shared export mechanics -- Phase 5's reporting surface is the second real
// caller of what used to be payouts.ts's private CSV helpers (its
// bank-file/payroll-handoff export), which is what makes this a real shared
// invariant rather than the usual per-file duplication convention in this
// codebase. XLSX is new -- docs/20-REPORTS.md requires "CSV and XLSX" for
// every report.
import ExcelJS from "exceljs";
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

/** Rows are plain strings, same as toCsv -- reports format money/dates
 *  themselves before handing rows here, so both export formats show
 *  identical values (docs/20-REPORTS.md's own convention: exact figures,
 *  DD-MMM-YYYY dates). */
export async function toXlsx(columns: ReportColumn[], rows: string[][], asOf: Date): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Report");

  sheet.columns = columns.map((column) => ({ header: column.label, key: column.key }));
  for (const row of rows) {
    sheet.addRow(row);
  }
  sheet.getRow(1).font = { bold: true };

  // docs/20-REPORTS.md: "As-of timestamp printed on every export."
  const asOfRow = sheet.addRow([]);
  asOfRow.getCell(1).value = `As of ${asOf.toISOString()}`;
  asOfRow.font = { italic: true };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
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
