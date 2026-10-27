import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CircleAlert, CircleCheck } from "lucide-react";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError, assertPermission } from "@desire/services/rbac";
import { getUnpricedPlcTags } from "@desire/services/unit-tags";
import { MAX_BLOCK_REASON_LENGTH } from "@desire/services/units";
import { getCachedSessionPermissions, requireSession } from "@/lib/session";
import { formatArea } from "@/lib/money";
import { unitStatusTone } from "@/lib/status-tone";
import { StatusBadge } from "@/components/status-badge";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { blockPlotsAction, clearCornerAction, markCornerAction, unblockPlotsAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Plots — Desire",
};

/** One block's plots, to block or unblock them and to mark which are corner.
 *  Plain forms: tick plots, press a button. Each button is a formAction on the one
 *  form, so there is no client code at all. What a person sees is gated by what
 *  they may do (unit.block, project.write); the services check again. */
export default async function ProjectPlotsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ block?: string; error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { block, error, notice } = await searchParams;
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

  const [units, unpriced, blockedCount] = await Promise.all([
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
  ]);

  const unpricedCorner = unpriced.find((entry) => entry.tag === "CORNER");

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href={`/projects/${project.id}`} className="text-sm text-primary hover:underline">
          ← {project.name}
        </Link>
        <h1 className="text-lg font-semibold">Plots</h1>
        <p className="text-sm text-muted-foreground">
          Block plots to take them off sale, and mark corner plots. {blockedCount} blocked in this
          project.
        </p>
      </div>

      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-danger">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="flex items-start gap-1.5 text-sm text-success">
          <CircleCheck className="mt-0.5 size-4 shrink-0" />
          {notice}
        </p>
      ) : null}
      {unpriced.length > 0 ? (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-warning">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            {unpriced.map((entry) => `${entry.tag.replaceAll("_", " ").toLowerCase()} (${entry.plots} plots)`).join(", ")}{" "}
            {unpricedCorner || unpriced.length > 1 ? "have" : "has"} no rate in the live price list, so those
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
            <form className="flex flex-col gap-3">
              <input type="hidden" name="projectId" value={project.id} />
              <input type="hidden" name="towerId" value={selected.id} />

              {canBlock || canMark ? (
                <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
                  {canBlock ? (
                    <>
                      <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs">
                        Reason (to block, required)
                        <Input name="reason" maxLength={MAX_BLOCK_REASON_LENGTH} placeholder="e.g. Title dispute" />
                      </label>
                      <ConfirmSubmitButton
                        formAction={blockPlotsAction}
                        message="Take the ticked plots off sale? Anyone holding one loses the hold."
                        size="sm"
                        variant="destructive"
                      >
                        Block
                      </ConfirmSubmitButton>
                      <Button type="submit" formAction={unblockPlotsAction} size="sm" variant="outline">
                        Unblock
                      </Button>
                    </>
                  ) : null}
                  {canMark ? (
                    <>
                      <Button type="submit" formAction={markCornerAction} size="sm" variant="outline">
                        Mark corner
                      </Button>
                      <Button type="submit" formAction={clearCornerAction} size="sm" variant="outline">
                        Clear corner
                      </Button>
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
                confirmed or cancelled first. Held or sold plots cannot be marked or cleared as corner,
                because the price would change under the buyer.
              </p>
            </form>
          ) : null}
        </>
      )}
    </div>
  );
}
