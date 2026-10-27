"use client";

import { useState } from "react";
import { MAX_PLOTS_PER_BLOCK, describePlotRows } from "@desire/services/plot-numbering";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createTowerAction } from "./actions";

export interface PlotTypeOption {
  id: string;
  /** Already formatted on the server ("PLOT-200 — 200.00 sq yd"): a Decimal
   *  cannot cross into a client component, and formatArea is server-only. */
  label: string;
}

interface SizeRow {
  key: number;
  count: string;
  typeId: string;
}

const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-sm disabled:opacity-50";

/** Adds a plotted block. A block can mix sizes: each row is "how many plots of
 *  which type", and the rows are numbered in order -- the first row gets
 *  `<code>-01...`, the next carries on. The plots are created with the block, in
 *  one transaction (createBlockWithPlots). The preview uses the very function
 *  the server uses, so what is shown is what is made.
 *
 *  The row is a grid with the count in a fixed column and the type taking the
 *  rest: the select used to share a flex row with a full-width number input and
 *  was squeezed to a sliver showing one letter. */
export function GroupForm({ projectId, plotTypes }: { projectId: string; plotTypes: PlotTypeOption[] }) {
  const [code, setCode] = useState("");
  const [rows, setRows] = useState<SizeRow[]>([{ key: 0, count: "", typeId: "" }]);
  const [nextKey, setNextKey] = useState(1);

  const plotsDisabled = plotTypes.length === 0;
  const labelOf = (id: string) => plotTypes.find((type) => type.id === id)?.label ?? "";

  const patch = (key: number, change: Partial<SizeRow>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));

  // Rows with nothing in them are ignored, as the server ignores them. A row
  // with only one half filled is shown as a problem rather than guessed at.
  const filled = rows.filter((row) => row.count.trim() !== "" || row.typeId !== "");
  const incomplete = filled.some((row) => row.count.trim() === "" || row.typeId === "");
  const parsed = filled.map((row) => ({ count: Number(row.count), type: row.typeId }));
  const preview = filled.length > 0 && !incomplete ? describePlotRows(code, parsed) : null;
  const total = parsed.reduce((sum, row) => sum + (Number.isFinite(row.count) ? row.count : 0), 0);

  const used = rows.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
  const remaining = (row: SizeRow) => Math.max(1, MAX_PLOTS_PER_BLOCK - (used - (Number(row.count) || 0)));

  return (
    <form action={createTowerAction} className="flex flex-col gap-2 border-t border-border pt-3">
      <input type="hidden" name="projectId" value={projectId} />

      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          name="code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="Block code (e.g. A)"
          required
        />
        <Input name="name" placeholder="Block name (e.g. Block A)" required />
      </div>

      {plotsDisabled ? null : (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium">Plots in this block</p>
          {rows.map((row, index) => (
            <div key={row.key} className="grid grid-cols-[6rem_minmax(0,1fr)_auto] items-center gap-2">
              <Input
                name="plotCount"
                type="number"
                min="1"
                max={remaining(row)}
                value={row.count}
                onChange={(event) => patch(row.key, { count: event.target.value })}
                placeholder="How many"
                aria-label={`Number of plots, size ${index + 1}`}
                className="w-24 shrink-0"
              />
              <select
                name="plotUnitTypeId"
                aria-label={`Plot type, size ${index + 1}`}
                value={row.typeId}
                onChange={(event) => patch(row.key, { typeId: event.target.value })}
                className={SELECT_CLASS}
              >
                <option value="">Choose size…</option>
                {plotTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.label}
                  </option>
                ))}
              </select>
              {rows.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                  aria-label={`Remove size ${index + 1}`}
                >
                  Remove
                </Button>
              ) : (
                <span />
              )}
            </div>
          ))}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setRows((current) => [...current, { key: nextKey, count: "", typeId: "" }]);
                setNextKey((key) => key + 1);
              }}
            >
              Add another size
            </Button>
          </div>
        </div>
      )}

      {plotsDisabled ? (
        <p className="text-xs text-muted-foreground">
          Add a plot type (sq yd) first to create plots along with the block. You can still add the
          block on its own.
        </p>
      ) : preview ? (
        <div className="text-xs text-muted-foreground">
          <ul>
            {preview.rows.map((row, index) => (
              <li key={index}>
                {row.first} to {row.last} — {labelOf(row.type).split(" — ")[0]} ({row.count})
              </li>
            ))}
          </ul>
          <p>
            {preview.total} plots in all, all available. They can&rsquo;t be deleted from here, so
            check the counts.
          </p>
        </div>
      ) : incomplete ? (
        <p role="alert" className="text-xs text-danger">
          Each size needs both a number of plots and a plot type.
        </p>
      ) : filled.length > 0 ? (
        <p role="alert" className="text-xs text-danger">
          Enter whole numbers of plots, 1 or more, at most {MAX_PLOTS_PER_BLOCK} in all
          {total > MAX_PLOTS_PER_BLOCK ? ` (that is ${total})` : ""}.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Leave the numbers empty to add the block on its own and load plots later.
        </p>
      )}

      <Button type="submit" size="sm" disabled={incomplete || (filled.length > 0 && preview === null)}>
        Add block
      </Button>
    </form>
  );
}
