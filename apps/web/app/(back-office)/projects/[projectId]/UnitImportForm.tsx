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
}

const TEMPLATE_HEADER =
  "unitNumber,unitTypeCode,floor,facing,plcTags,carpetAreaOverride,saleableAreaOverride";

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
}: {
  projectId: string;
  towers: ReadonlyArray<{ id: string; code: string; kind: "TOWER" | "BLOCK" }>;
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
        setMessage(`Imported ${body.imported} unit(s).`);
        form.reset();
        // The units live on the board, not this page, so refresh rather than
        // trying to splice them into a list that is not rendered here.
        router.refresh();
        return;
      }

      if (body?.report) setReport(body.report);
      setMessage(body?.detail ?? `Import failed (HTTP ${response.status}).`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  const templateHref = `data:text/csv;charset=utf-8,${encodeURIComponent(`${TEMPLATE_HEADER}\n`)}`;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          name="towerId"
          aria-label="Import into"
          className="h-9 flex-1 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="">No tower or block</option>
          {towers.map((tower) => (
            <option key={tower.id} value={tower.id}>
              {tower.code} — {tower.kind === "BLOCK" ? "block" : "tower"}
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
          Download template
        </a>
      </div>

      <p className="text-xs text-muted-foreground">
        Leave <code>floor</code> empty for plots in a block. Separate multiple{" "}
        <code>plcTags</code> with a pipe, e.g. <code>CORNER|PARK_FACING</code>. Nothing is imported
        unless every row is valid.
      </p>

      {message ? (
        <p role="status" className={report ? "text-sm text-danger" : "text-sm text-success"}>
          {message}
        </p>
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
