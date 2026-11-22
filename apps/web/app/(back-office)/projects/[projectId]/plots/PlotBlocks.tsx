"use client";

import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import type { UnitStatus } from "@desire/db";
import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";
import { unitStatusTone } from "@/lib/status-tone";

/** One plot as the Plots screen lists it, formatted on the server. */
export interface PlotRow {
  id: string;
  unitNumber: string;
  blockId: string;
  /** Plot type code and size, e.g. "PLOT-200 · 200.00 sq yd". */
  size: string;
  status: UnitStatus;
  plcTags: string[];
  /** Why it is blocked; null for people who may not block plots. */
  blockReason: string | null;
}

/** The block buttons and the plot table of the Plots screen. Every block's plots are
 *  on the page, so a block opens at once, with no server round trip.
 *
 *  Each block used to be its own page (`?block=`), opened through the router, and in
 *  the production build that click almost never repainted: the server answered, the
 *  router took the new block, and the screen stayed on the old one. Seen 19 times in
 *  20 on `next start`, with or without network delay; Next 15.5.29, React 19.2.9 and
 *  19.3.1, and Next's segment cache did the same, and only a link whose page was
 *  fully prefetched before the click repainted. Switching in React state takes the
 *  router out of it. The address still names the block (replaceState, which Next
 *  follows without a request), so a reload, a bookmark or the form's recovery reload
 *  opens the same block; before the page has hydrated a block button is a plain link. */
export function PlotBlocks({
  projectId,
  blocks,
  initialBlockId,
  plots,
  actions,
  controls,
  notes,
}: {
  projectId: string;
  blocks: Array<{ id: string; code: string }>;
  initialBlockId: string;
  plots: PlotRow[];
  /** The ActionForm's `intent` actions (see components/action-form.tsx). */
  actions: Record<string, (formData: FormData) => Promise<ActionResult>>;
  /** The rows of inputs and buttons above the table. */
  controls: ReactNode;
  /** The help text under the table. */
  notes: ReactNode;
}) {
  const [blockId, setBlockId] = useState(initialBlockId);
  const shown = blocks.find((block) => block.id === blockId) ?? blocks[0]!;
  const rows = useMemo(() => plots.filter((plot) => plot.blockId === shown.id), [plots, shown.id]);

  function openBlock(event: MouseEvent<HTMLElement>, id: string) {
    // A new tab or window keeps the browser's own behaviour.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setBlockId(id);
    window.history.replaceState(null, "", `/projects/${projectId}/plots?block=${id}`);
  }

  return (
    <>
      <nav aria-label="Blocks" className="flex flex-wrap gap-2">
        {blocks.map((block) => (
          <Button
            key={block.id}
            nativeButton={false}
            size="sm"
            variant={block.id === shown.id ? "default" : "outline"}
            aria-current={block.id === shown.id ? "page" : undefined}
            onClick={(event) => openBlock(event, block.id)}
            render={<a href={`/projects/${projectId}/plots?block=${block.id}`} />}
          >
            {block.code}
          </Button>
        ))}
      </nav>

      <ActionForm id="plots" feedback="top" actions={actions} className="flex flex-col gap-3">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="towerId" value={shown.id} />

        {controls}

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="w-10 px-3 py-2">
                  <span className="sr-only">Pick</span>
                </th>
                <th className="px-3 py-2 font-medium">Plot</th>
                <th className="px-3 py-2 font-medium">Size</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Tags</th>
                <th className="px-3 py-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((plot) => (
                <tr key={plot.id}>
                  <td className="px-3 py-2">
                    <input type="checkbox" name="unitId" value={plot.id} aria-label={`Pick plot ${plot.unitNumber}`} />
                  </td>
                  <td className="px-3 py-2 font-medium">{plot.unitNumber}</td>
                  <td className="px-3 py-2 text-muted-foreground">{plot.size}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={plot.status} tone={unitStatusTone(plot.status)} />
                  </td>
                  <td className="px-3 py-2">
                    {plot.plcTags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="mr-1 font-normal">
                        {tag.replaceAll("_", " ")}
                      </Badge>
                    ))}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{plot.blockReason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {notes}
      </ActionForm>
    </>
  );
}
