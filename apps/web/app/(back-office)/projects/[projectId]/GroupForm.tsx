"use client";

import { useState } from "react";
import { MAX_PLOTS_PER_BLOCK, plotRange } from "@desire/services/plot-numbering";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createTowerAction } from "./actions";

export interface PlotTypeOption {
  id: string;
  /** Already formatted on the server ("PLOT-200 — 200.00 sq yd"): a Decimal
   *  cannot cross into a client component, and formatArea is server-only. */
  label: string;
}

const SELECT_CLASS =
  "h-9 rounded-md border border-border bg-background px-2 text-sm disabled:opacity-50";

/** Adds a plotted block. This used to be one form for towers and blocks, with a
 *  kind dropdown that changed the wording and the fields; only blocks can be
 *  created now (the service refuses anything else), so the dropdown, the tower
 *  wording and the floor count are gone.
 *
 *  A block takes a plot count. The plots are created with the block, in one
 *  transaction (createBlockWithPlots), numbered `<code>-01`, `<code>-02`, ...
 *  The preview line uses the very function the server uses, so what is shown is
 *  what is made. */
export function GroupForm({
  projectId,
  plotTypes,
  plotsBlockedReason,
}: {
  projectId: string;
  plotTypes: PlotTypeOption[];
  /** Why plots cannot be created with the block right now, or null. */
  plotsBlockedReason: string | null;
}) {
  const [code, setCode] = useState("");
  const [plotCount, setPlotCount] = useState("");
  const [plotTypeId, setPlotTypeId] = useState(plotTypes[0]?.id ?? "");

  const plotsDisabled = plotsBlockedReason !== null || plotTypes.length === 0;
  const count = plotCount.trim() === "" ? null : Number(plotCount);
  const range = count === null ? null : plotRange(code, count);

  return (
    <form action={createTowerAction} className="flex flex-col gap-2 border-t border-border pt-3">
      <input type="hidden" name="projectId" value={projectId} />

      <div className="flex gap-2">
        <Input
          name="code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="Block code (e.g. A)"
          required
        />
        <Input name="name" placeholder="Block name (e.g. Block A)" required />
      </div>

      <div className="flex gap-2">
        <Input
          name="plotCount"
          type="number"
          min="1"
          max={MAX_PLOTS_PER_BLOCK}
          value={plotCount}
          onChange={(event) => setPlotCount(event.target.value)}
          placeholder="Number of plots"
          aria-label="Number of plots in this block"
          disabled={plotsDisabled}
        />
        <select
          name="plotUnitTypeId"
          aria-label="Plot type"
          value={plotTypeId}
          onChange={(event) => setPlotTypeId(event.target.value)}
          disabled={plotsDisabled}
          className={`${SELECT_CLASS} min-w-0 flex-1`}
        >
          {plotTypes.map((type) => (
            <option key={type.id} value={type.id}>
              {type.label}
            </option>
          ))}
        </select>
      </div>

      {plotsBlockedReason !== null ? (
        <p className="text-xs text-muted-foreground">{plotsBlockedReason}</p>
      ) : plotTypes.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Add a plot type (sq yd) first to create plots along with the block. You can still add the
          block on its own.
        </p>
      ) : range !== null ? (
        <p className="text-xs text-muted-foreground">
          Creates {count} plots, {range.first} to {range.last}, all available. They can&rsquo;t be
          deleted from here, so check the count.
        </p>
      ) : count !== null ? (
        <p role="alert" className="text-xs text-danger">
          Enter a whole number of plots from 1 to {MAX_PLOTS_PER_BLOCK}.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Leave the number empty to add the block on its own and load plots later.
        </p>
      )}

      <Button type="submit" size="sm">
        Add block
      </Button>
    </form>
  );
}
