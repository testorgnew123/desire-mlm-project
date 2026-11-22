import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CircleAlert } from "lucide-react";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError, assertPermission } from "@desire/services/rbac";
import { getUnpricedPlcTags } from "@desire/services/unit-tags";
import { MAX_BLOCK_REASON_LENGTH } from "@desire/services/units";
import { getCachedSessionPermissions, requireSession } from "@/lib/session";
import { formatArea } from "@/lib/money";
import { unitStatusTone } from "@/lib/status-tone";
import { StatusBadge } from "@/components/status-badge";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_SIZE_REASON_LENGTH } from "@/lib/plot-size";
import {
  blockPlotsAction,
  changePlotSizeAction,
  clearCornerAction,
  deletePlotsAction,
  markCornerAction,
  unblockPlotsAction,
} from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Plots — Desire",
};

/** The "New size" list: a native select, as the other forms pick from a list, drawn
 *  like the text boxes beside it so the row lines up. */
const SIZE_SELECT_CLASS =
  "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** One block's plots, to change their size, to block or unblock them, to mark
 *  which are corner and to delete ones added by mistake. Tick plots, press a button. The buttons are the `intent`
 *  buttons of one ActionForm, which shows what happened above the table. The size
 *  row comes first so that Enter in any box runs "Change size", which asks for
 *  what it needs and changes nothing otherwise, not Block. What a person sees is
 *  gated by what they may do (unit.block, project.write); the services check again. */
export default async function ProjectPlotsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ block?: string }>;
}) {
  const { projectId } = await params;
  const { block } = await searchParams;
  const session = await requireSession();
  const db = getPrismaClient();

  try {
    await assertPermission(db, session.user.id, "project.read", { projectId });
  } catch (failure) {
    if (failure instanceof ForbiddenError) notFound();
    throw failure;
  }

  const [project, towers, permissions] = await Promise.all([
    db.project.findUnique({ where: { id: projectId, orgId: session.user.orgId }, select: { id: true, name: true, code: true } }),
    db.tower.findMany({
      where: { projectId, kind: "BLOCK" },
      orderBy: [{ displayOrder: "asc" }, { code: "asc" }],
      select: { id: true, code: true, name: true },
    }),
    getCachedSessionPermissions(db, session.user.id, { projectId }),
  ]);
  if (!project) notFound();

  const selected = towers.find((tower) => tower.id === block) ?? towers[0] ?? null;
  const canBlock = permissions.has("unit.block");
  const canMark = permissions.has("project.write");

  const [units, unpriced, blockedCount, plotTypes] = await Promise.all([
    selected
      ? db.unit.findMany({
          where: { projectId, towerId: selected.id },
          orderBy: { unitNumber: "asc" },
          select: {
            id: true,
            unitNumber: true,
            status: true,
            plcTags: true,
            blockReason: true,
            saleableAreaOverride: true,
            unitType: { select: { code: true, areaBasis: true, saleableArea: true } },
          },
        })
      : [],
    getUnpricedPlcTags(db, { projectId }),
    db.unit.count({ where: { projectId, status: "BLOCKED" } }),
    // What the "New size" list offers: the project's plot types, smallest first. A
    // plot type is a size with its code, so picking one moves a plot to it. Only read
    // for people who may change sizes.
    canMark
      ? db.unitType.findMany({
          where: { projectId, areaBasis: "SQYD" },
          orderBy: [{ saleableArea: "asc" }, { code: "asc" }],
          select: { id: true, code: true, saleableArea: true },
        })
      : [],
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href={`/projects/${project.id}`} className="text-sm text-primary hover:underline">
          ← {project.name}
        </Link>
        <h1 className="text-lg font-semibold">Plots</h1>
        <p className="text-sm text-muted-foreground">
          Change a plot&apos;s size, block plots to take them off sale, and mark corner plots.{" "}
          {blockedCount} blocked in this project.
        </p>
      </div>

      {unpriced.length > 0 ? (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-warning">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            The live price list has no rate for{" "}
            {unpriced.map((entry) => `${entry.tag.replaceAll("_", " ").toLowerCase()} (${entry.plots} plots)`).join(", ")}, so those
            plots cannot be booked yet.{" "}
            <Link href={`/projects/${project.id}`} className="underline">
              Add the rate in a new price list version.
            </Link>
          </span>
        </p>
      ) : null}

      {towers.length === 0 ? (
        <p className="text-sm text-muted-foreground">This project has no blocks yet.</p>
      ) : (
        <>
          <nav aria-label="Blocks" className="flex flex-wrap gap-2">
            {towers.map((tower) => (
              <Button
                key={tower.id}
                nativeButton={false}
                size="sm"
                variant={tower.id === selected?.id ? "default" : "outline"}
                render={<Link href={`/projects/${project.id}/plots?block=${tower.id}`} />}
              >
                {tower.code}
              </Button>
            ))}
          </nav>

          {selected ? (
            <ActionForm
              id="plots"
              feedback="top"
              actions={{
                changeSize: changePlotSizeAction,
                block: blockPlotsAction,
                unblock: unblockPlotsAction,
                markCorner: markCornerAction,
                clearCorner: clearCornerAction,
                delete: deletePlotsAction,
              }}
              className="flex flex-col gap-3"
            >
              <input type="hidden" name="projectId" value={project.id} />
              <input type="hidden" name="towerId" value={selected.id} />

              {canMark ? (
                <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
                  <label className="flex w-60 flex-col gap-1 text-xs">
                    New size
                    <select name="unitTypeId" defaultValue="" className={SIZE_SELECT_CLASS}>
                      <option value="">Choose a size…</option>
                      {plotTypes.map((type) => (
                        <option key={type.id} value={type.id}>
                          {`${type.code} · ${(formatArea(type.saleableArea, "saleable", "SQYD") ?? "").replace(" (saleable)", "")}`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs">
                    Reason (for the new size, required)
                    <Input name="sizeReason" maxLength={MAX_SIZE_REASON_LENGTH} placeholder="e.g. Re-measured after survey" />
                  </label>
                  <SubmitButton name="intent" value="changeSize" pendingLabel="Changing…" size="sm" variant="outline">
                    Change size
                  </SubmitButton>
                </div>
              ) : null}

              {canBlock || canMark ? (
                <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
                  {canBlock ? (
                    <>
                      <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs">
                        Reason (to block, required)
                        <Input name="reason" maxLength={MAX_BLOCK_REASON_LENGTH} placeholder="e.g. Title dispute" />
                      </label>
                      <SubmitButton
                        name="intent"
                        value="block"
                        confirm="Take the ticked plots off sale? Anyone holding one loses the hold."
                        pendingLabel="Blocking…"
                        size="sm"
                        variant="destructive"
                      >
                        Block
                      </SubmitButton>
                      <SubmitButton name="intent" value="unblock" pendingLabel="Unblocking…" size="sm" variant="outline">
                        Unblock
                      </SubmitButton>
                    </>
                  ) : null}
                  {canMark ? (
                    <>
                      <SubmitButton name="intent" value="markCorner" pendingLabel="Marking…" size="sm" variant="outline">
                        Mark corner
                      </SubmitButton>
                      <SubmitButton name="intent" value="clearCorner" pendingLabel="Clearing…" size="sm" variant="outline">
                        Clear corner
                      </SubmitButton>
                      <SubmitButton
                        name="intent"
                        value="delete"
                        confirm="Delete the ticked plots? This cannot be undone."
                        pendingLabel="Deleting…"
                        size="sm"
                        variant="destructive"
                      >
                        Delete
                      </SubmitButton>
                    </>
                  ) : null}
                </div>
              ) : null}

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
                    {units.map((unit) => (
                      <tr key={unit.id}>
                        <td className="px-3 py-2">
                          <input type="checkbox" name="unitId" value={unit.id} aria-label={`Pick plot ${unit.unitNumber}`} />
                        </td>
                        <td className="px-3 py-2 font-medium">{unit.unitNumber}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {unit.unitType.code} ·{" "}
                          {(formatArea(unit.saleableAreaOverride ?? unit.unitType.saleableArea, "saleable", unit.unitType.areaBasis) ?? "").replace(" (saleable)", "")}
                        </td>
                        <td className="px-3 py-2">
                          <StatusBadge status={unit.status} tone={unitStatusTone(unit.status)} />
                        </td>
                        <td className="px-3 py-2">
                          {unit.plcTags.map((tag) => (
                            <Badge key={tag} variant="secondary" className="mr-1 font-normal">
                              {tag.replaceAll("_", " ")}
                            </Badge>
                          ))}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{canBlock ? (unit.blockReason ?? "") : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">
                Only plots that are free or held can be blocked. A held plot with a booking waiting must be
                confirmed or cancelled first. Held or sold plots cannot be resized or marked or cleared as
                corner, because the price would change under the buyer: to resize a held plot, block it
                first (that releases the hold) and unblock it afterwards; for a sold plot, cancel its
                booking first.
              </p>
              <p className="text-xs text-muted-foreground">
                Picking a size moves the ticked plots to that plot type: their plot code and size change
                together, and the plot type&apos;s rate applies. The list shows the plot types already in
                this project; to offer another size, add a plot type on the project page. To change many
                plots at once, use the CSV import on the project page with &quot;Update plots that already
                exist&quot;.
              </p>
              {canMark ? (
                <p className="text-xs text-muted-foreground">
                  Delete is for plots added by mistake: only a plot that was never held or booked can be
                  deleted. To take any other plot off sale, block it.
                </p>
              ) : null}
            </ActionForm>
          ) : null}
        </>
      )}
    </div>
  );
}
