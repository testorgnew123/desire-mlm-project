// XLSX generation, split out of export.ts on purpose.
//
// `exceljs` is ~810 KB once bundled, and it is needed by exactly ONE caller:
// the reports download route, when ?format=xlsx. While toXlsx lived in
// export.ts alongside the CSV helpers, every module that only wanted toCsv
// pulled the whole spreadsheet engine in with it -- payouts.ts for its
// bank-file handoff, and transitively grades.ts and associates.ts, which
// import assertPayoutPeriodNotOpen from payouts.ts.
//
// Measured against the real build before this split: the exceljs chunk
// (8129.js, 812 KB) appeared in the trace of 26 of 98 routes, including the
// PWA home screen and every network/* page -- none of which export a
// spreadsheet. On a serverless function that is dead weight loaded on every
// cold start. Keeping the heavy dependency in its own module is what stops
// that, so import from here only when you genuinely need a workbook.
import ExcelJS from "exceljs";
import type { ReportColumn } from "./export";

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
