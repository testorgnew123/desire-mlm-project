// Marking plots with a PLC tag -- mostly CORNER, the premium for a corner plot.
//
// A tag on a plot is a price: the cost sheet adds the price list's charge for
// every tag the plot carries, and refuses to quote a plot whose tag the list does
// not price (UnpricedPlcTagError) rather than charge nothing. So marking plots is
// an admin act (project.write), is allowed only while the plot is not sold or
// held (the price of a held or booked plot must not move under the buyer), and
// reports when the live price list does not yet price the tag.
import { Prisma } from "@desire/db";
import type { PrismaClient } from "@desire/db";
import { writeAuditLog, type AuditContext } from "./audit";
import { ForbiddenError, assertPermission } from "./rbac";
import { parsePlcCharges } from "./cost-sheet";
import { getActivePriceList } from "./price-lists";
import { normalizePlcTag } from "./plc-tags";

/** One request marks at most this many plots: a block, not a township. */
export const MAX_PLOTS_PER_TAG_CHANGE = 200;

export class UnitTagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitTagError";
  }
}

export interface SetUnitPlcTagParams {
  projectId: string;
  unitIds: readonly string[];
  tag: string;
  /** true adds the tag, false removes it. */
  present: boolean;
  audit: AuditContext;
}

export interface SetUnitPlcTagResult {
  tag: string;
  changed: number;
  unchanged: number;
}

/** Adds or removes `tag` on each of the plots, in one transaction. Plots that
 *  already are (or already are not) tagged are left alone and counted as
 *  unchanged. Only AVAILABLE and BLOCKED plots can change: a held or sold plot
 *  has a price someone is relying on, and the whole request is refused naming
 *  them rather than half done. */
export async function setUnitPlcTag(db: PrismaClient, params: SetUnitPlcTagParams): Promise<SetUnitPlcTagResult> {
  const actorId = params.audit.actorId;
  if (!actorId) throw new ForbiddenError("Marking plots requires a user actor, not a system actor.");
  const tag = normalizePlcTag(params.tag);
  const ids = [...new Set(params.unitIds)];
  if (ids.length === 0) throw new UnitTagError("Choose at least one plot.");
  if (ids.length > MAX_PLOTS_PER_TAG_CHANGE) {
    throw new UnitTagError(`Choose at most ${MAX_PLOTS_PER_TAG_CHANGE} plots at a time.`);
  }

  return db.$transaction(async (tx) => {
    const project = await tx.project.findUnique({ where: { id: params.projectId }, select: { orgId: true } });
    if (!project || project.orgId !== params.audit.orgId) throw new UnitTagError("Project not found.");
    await assertPermission(tx, actorId, "project.write", { projectId: params.projectId });

    // Lock in a fixed order so two admins marking overlapping sets cannot deadlock.
    await tx.$queryRaw`
      SELECT "id" FROM "units"
      WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
    const units = await tx.unit.findMany({
      where: { id: { in: ids }, projectId: params.projectId },
      select: { id: true, unitNumber: true, status: true, plcTags: true },
    });
    if (units.length !== ids.length) {
      throw new UnitTagError("Some of those plots are not in this project.");
    }
    const locked = units.filter((unit) => unit.status !== "AVAILABLE" && unit.status !== "BLOCKED");
    if (locked.length > 0) {
      const shown = locked.slice(0, 5).map((unit) => unit.unitNumber).join(", ");
      throw new UnitTagError(
        `${shown}${locked.length > 5 ? ` and ${locked.length - 5} more` : ""} ${locked.length === 1 ? "is" : "are"} held or sold, so the price cannot change. Nothing was changed.`,
      );
    }

    const todo = units.filter((unit) => unit.plcTags.includes(tag) !== params.present);
    if (todo.length > 0) {
      const todoIds = todo.map((unit) => unit.id);
      // COALESCE because a plot created without tags can hold NULL rather than an
      // empty array, and NULL poisons both array_append and ANY. Set-based, and "updatedAt" set by hand because raw SQL skips Prisma's
      // @updatedAt -- the board's delta poll keys on it.
      if (params.present) {
        await tx.$executeRaw`
          UPDATE "units" SET "plcTags" = array_append(COALESCE("plcTags", '{}'), ${tag}::text), "updatedAt" = now()
          WHERE "id" IN (${Prisma.join(todoIds)}) AND NOT (${tag}::text = ANY(COALESCE("plcTags", '{}')))`;
      } else {
        await tx.$executeRaw`
          UPDATE "units" SET "plcTags" = array_remove(COALESCE("plcTags", '{}'), ${tag}::text), "updatedAt" = now()
          WHERE "id" IN (${Prisma.join(todoIds)})`;
      }
      for (const unit of todo) {
        const after = params.present ? [...unit.plcTags, tag] : unit.plcTags.filter((t) => t !== tag);
        await writeAuditLog(tx, params.audit, {
          action: "UPDATE",
          entity: "Unit",
          entityId: unit.id,
          before: { plcTags: unit.plcTags },
          after: { plcTags: after },
          reason: params.present ? `marked ${tag}` : `cleared ${tag}`,
        });
      }
    }
    return { tag, changed: todo.length, unchanged: units.length - todo.length };
  });
}

export interface UnpricedPlcTag {
  tag: string;
  /** Plots carrying the tag that the live price list does not price. */
  plots: number;
}

/** Tags in use on plots of this project that the ACTIVE price list does not
 *  price, with how many plots each affects. Empty when there is no active list
 *  (that is a different, louder problem). A per-plot override is read before the
 *  plot type's rate, as the cost sheet does. Used for the warnings on the plots
 *  page; bookPlot uses the single-plot form, unpricedTagsForUnit. */
export async function getUnpricedPlcTags(
  db: PrismaClient,
  params: { projectId: string; asOf?: Date },
): Promise<UnpricedPlcTag[]> {
  const list = await getActivePriceList(db, params);
  if (!list) return [];
  const units = await db.unit.findMany({
    where: { projectId: params.projectId, NOT: { plcTags: { isEmpty: true } } },
    select: { id: true, unitTypeId: true, plcTags: true },
  });
  const counts = new Map<string, number>();
  for (const unit of units) {
    for (const tag of unpricedTags(list.items, unit)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tag, plots]) => ({ tag, plots }));
}

/** The tags on one plot that the given price list items do not price. */
export function unpricedTags(
  items: ReadonlyArray<{ unitId: string | null; unitTypeId: string | null; plcCharges: Prisma.JsonValue | null }>,
  unit: { id: string; unitTypeId: string; plcTags: readonly string[] },
): string[] {
  if (unit.plcTags.length === 0) return [];
  const item = items.find((i) => i.unitId === unit.id) ?? items.find((i) => i.unitTypeId === unit.unitTypeId);
  // No item at all is the "plot not priced" case, reported on its own.
  if (!item) return [];
  const priced = parsePlcCharges(item.plcCharges);
  return unit.plcTags.filter((tag) => priced[tag] === undefined);
}
