"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

interface RowError {
  rowNumber: number;
  field: string;
  value: unknown;
  message: string;
}

interface ImportReport {
  imported: number;
  skipped: number;
  errors: RowError[];
  /** Lines the importer skipped because they start with # (notes/examples). */
  ignoredComments?: number;
}

const TEMPLATE_HEADER =
  "unitNumber,unitTypeCode,floor,facing,plcTags,carpetAreaOverride,saleableAreaOverride";

/** One line for the whole file, in the user's words. The service's own message
 *  ("rejected under ALL_OR_NOTHING: 149 problem(s) across 150 row(s)") is written
 *  for logs and counts a problem per field, so a file whose every row has one bad
 *  cell reads as "problems across all rows". */
function describeRejection(report: ImportReport): string {
  const badRows = new Set(report.errors.map((error) => error.rowNumber)).size;
  return `Nothing was imported: ${badRows} of ${report.skipped} row(s) have a problem. Fix the file and upload it again.`;
}

/** The same problems, one line per column instead of one per cell: a file where
 *  every row has the same mistake (a plot type that does not exist, say) is one
 *  thing to fix, not 150. */
function summariseByField(errors: RowError[]): Array<{ field: string; rows: number; example: RowError }> {
  const groups = new Map<string, { rows: Set<number>; example: RowError }>();
  for (const error of errors) {
    const group = groups.get(error.field) ?? { rows: new Set<number>(), example: error };
    group.rows.add(error.rowNumber);
    groups.set(error.field, group);
  }
  return [...groups.entries()].map(([field, group]) => ({ field, rows: group.rows.size, example: group.example }));
}

/** Quoted only when it has to be, so each note stays ONE cell in a spreadsheet
 *  even though it contains commas -- and so a round trip through Excel, which
 *  quotes such cells itself, still parses to the same thing. */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** The downloadable template: the header, then notes and two example rows that
 *  the importer ignores because they start with #.
 *
 *  Ignored rather than real data on purpose. Units cannot be deleted from the
 *  UI, so an example row that imported when the file was uploaded unchanged
 *  would leave junk in live inventory. To use an example, delete the # in front
 *  of its unit number. The examples use this project's own unit type codes when
 *  it has them, so an uncommented row is close to valid as it stands. */
function buildTemplate(unitTypes: ReadonlyArray<{ code: string }>, facings: readonly string[]): string {
  const plotCode = unitTypes[0]?.code ?? "PLOT-200";
  const typeList = unitTypes.length > 0 ? unitTypes.map((type) => type.code).join(", ") : "none yet - add one first";

  const note = (text: string) => csvCell(`# ${text}`);
  const lines = [
    TEMPLATE_HEADER,
    note(
      "Lines whose first cell starts with # are ignored, so these notes and examples import nothing. To use an example, delete the # in front of its unit number and edit the row.",
    ),
    note("unitNumber (required): unique across the whole project, e.g. B-17."),
    note(`unitTypeCode (required): must match one of this project's plot types: ${typeList}.`),
    note("floor: leave it EMPTY. A plot has no floor."),
    note(`facing (optional): one of ${facings.join(", ")}.`),
    note(
      "plcTags (optional): preferred-location tags such as CORNER or PARK_FACING. Separate several with a pipe, e.g. CORNER|PARK_FACING. Each tag needs a charge in the price list before the plot can be priced.",
    ),
    note(
      "carpetAreaOverride and saleableAreaOverride (optional): only when this plot differs from its plot type. Leave empty to use the type's area.",
    ),
    note(
      "Filling down in Excel: dragging a cell such as PLOT-100 counts it up (PLOT-101, PLOT-102, ...) and those types do not exist. Copy the cell (Ctrl+C) and paste it over the rows instead.",
    ),
    note("Example - a corner plot (choose its block as the import target):"),
    `#B-17,${csvCell(plotCode)},,N,CORNER,,`,
  ];
  return `${lines.join("\r\n")}\r\n`;
}

/** CSV upload for bulk unit/plot entry.
 *
 *  A client fetch rather than a Server Action, for the same reason the hold
 *  POST is: the response is not a redirect but a per-row error report that
 *  this component has to render in place. The route returns 422 WITH the full
 *  report attached, because the service's default ALL_OR_NOTHING mode refuses
 *  the whole batch on any bad row -- surfacing one error per upload would make
 *  a 400-row file take 400 uploads. */
export function UnitImportForm({
  projectId,
  towers,
  unitTypes,
  facings,
}: {
  projectId: string;
  /** Blocks only: nothing but plotted blocks can be loaded with units now. */
  towers: ReadonlyArray<{ id: string; code: string }>;
  /** Plot types only. */
  unitTypes: ReadonlyArray<{ code: string }>;
  facings: readonly string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setReport(null);
    setMessage(null);

    try {
      const response = await fetch(`/api/v1/projects/${projectId}/units/import`, {
        method: "POST",
        body: new FormData(form),
        credentials: "same-origin",
      });
      const body = (await response.json().catch(() => null)) as
        | (ImportReport & { detail?: string; report?: ImportReport })
        | null;

      if (response.ok && body) {
        const ignored = body.ignoredComments ?? 0;
        setMessage(
          `Imported ${body.imported} unit(s).` +
            (ignored > 0 ? ` Ignored ${ignored} line(s) starting with #.` : ""),
        );
        form.reset();
        // The units live on the board, not this page, so refresh rather than
        // trying to splice them into a list that is not rendered here.
        router.refresh();
        return;
      }

      if (body?.report) {
        setReport(body.report);
        setMessage(describeRejection(body.report));
      } else {
        setMessage(body?.detail ?? `Import failed (HTTP ${response.status}).`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  const templateHref = `data:text/csv;charset=utf-8,${encodeURIComponent(buildTemplate(unitTypes, facings))}`;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          name="towerId"
          aria-label="Import into"
          required
          className="h-9 flex-1 rounded-md border border-border bg-background px-2 text-sm"
        >
          {towers.map((tower) => (
            <option key={tower.id} value={tower.id}>
              {tower.code} — block
            </option>
          ))}
        </select>
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          required
          aria-label="CSV file"
          className="flex-1 text-sm file:mr-2 file:rounded-md file:border file:border-border file:bg-background file:px-2 file:py-1 file:text-sm"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Importing…" : "Import CSV"}
        </Button>
        <a href={templateHref} download="units-template.csv" className="text-xs underline">
          Download template (with examples)
        </a>
      </div>

      <p className="text-xs text-muted-foreground">
        The template explains each column and has an example plot. Lines starting with{" "}
        <code>#</code> are notes and are ignored. Leave <code>floor</code> empty. Nothing is
        imported unless every row is valid.
      </p>

      {message ? (
        <p role="status" className={report ? "text-sm text-danger" : "text-sm text-success"}>
          {message}
        </p>
      ) : null}

      {report && report.errors.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs">
          {summariseByField(report.errors).map((group) => (
            <li key={group.field}>
              <span className="font-medium">{group.field}</span>: {group.rows} row(s). For example, row{" "}
              {group.example.rowNumber + 1}: {group.example.message}
            </li>
          ))}
        </ul>
      ) : null}

      {report && report.errors.length > 0 ? (
        <div className="max-h-64 overflow-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th className="px-2 py-1 text-left">Row</th>
                <th className="px-2 py-1 text-left">Field</th>
                <th className="px-2 py-1 text-left">Value</th>
                <th className="px-2 py-1 text-left">Problem</th>
              </tr>
            </thead>
            <tbody>
              {report.errors.map((error, index) => (
                <tr key={`${error.rowNumber}-${error.field}-${index}`} className="border-t border-border">
                  {/* rowNumber is 1-based over DATA rows, so a file with a
                      header shows this at spreadsheet line rowNumber + 1. */}
                  <td className="px-2 py-1 tabular-nums">{error.rowNumber + 1}</td>
                  <td className="px-2 py-1">{error.field}</td>
                  <td className="px-2 py-1 text-muted-foreground">{String(error.value ?? "")}</td>
                  <td className="px-2 py-1">{error.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </form>
  );
}
