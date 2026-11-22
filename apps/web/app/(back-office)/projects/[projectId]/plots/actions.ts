"use server";

import { revalidatePath } from "next/cache";
import { getPrismaClient } from "@desire/db";
import { updateUnit } from "@desire/services/projects";
import { ForbiddenError } from "@desire/services/rbac";
import { blockUnit, unblockUnit } from "@desire/services/units";
import { setUnitPlcTag } from "@desire/services/unit-tags";
import { requireSession } from "@/lib/session";
import { MAX_PLOTS_PER_SIZE_CHANGE, MAX_SIZE_REASON_LENGTH } from "@/lib/plot-size";
import type { ActionResult } from "@/lib/action-result";

/** The ids ticked on the plots table. Duplicates dropped; the services cap the
 *  count and check every id belongs to this project, so nothing is trusted here. */
function pickedUnitIds(formData: FormData): string[] {
  return [...new Set(formData.getAll("unitId").map(String).filter(Boolean))];
}

/** Runs one change and answers with a message for the form. A refusal is an
 *  expected business answer (held plot, no permission), so it is returned and shown
 *  inline, never a crash. No redirect: see lib/action-result.ts. */
async function run(
  formData: FormData,
  change: (ctx: { projectId: string; unitIds: string[]; audit: { orgId: string; actorId: string; actorLabel: string } }) => Promise<string>,
): Promise<ActionResult> {
  const session = await requireSession();
  const projectId = String(formData.get("projectId") ?? "");
  const unitIds = pickedUnitIds(formData);

  let message: string;
  try {
    if (unitIds.length === 0) throw new Error("Tick at least one plot first.");
    message = await change({
      projectId,
      unitIds,
      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { ok: false, error: error.message };
  }

  // This screen, plus what else reads these plots: the project page, the board
  // and the phone grid.
  revalidatePath(`/projects/${projectId}/plots`);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/board/${projectId}`);
  revalidatePath(`/inventory/${projectId}`);
  return { ok: true, message };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Takes the ticked plots off sale, with one reason for all. One at a time under
 *  the hood: a plot that cannot be blocked (sold, or with a booking waiting) is
 *  reported by name and the others still go through. */
export async function blockPlotsAction(formData: FormData): Promise<ActionResult> {
  const reason = String(formData.get("reason") ?? "");
  return run(formData, async ({ unitIds, audit }) => {
    const db = getPrismaClient();
    const names = new Map(
      (await db.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, unitNumber: true } })).map((u) => [
        u.id,
        u.unitNumber,
      ]),
    );
    let done = 0;
    const refused: string[] = [];
    for (const unitId of unitIds) {
      try {
        await blockUnit(db, { unitId, reason, audit });
        done += 1;
      } catch (error) {
        // A missing reason or permission fails every plot alike: say so once.
        if (done === 0 && refused.length === 0 && unitIds.length === 1) throw error;
        refused.push(`${names.get(unitId) ?? unitId} (${error instanceof Error ? error.message : "refused"})`);
      }
    }
    if (done === 0) throw new Error(`Nothing was blocked: ${refused.join("; ")}`);
    return refused.length
      ? `Blocked ${plural(done, "plot")}. Not blocked: ${refused.join("; ")}`
      : `Blocked ${plural(done, "plot")}.`;
  });
}

export async function unblockPlotsAction(formData: FormData): Promise<ActionResult> {
  return run(formData, async ({ unitIds, audit }) => {
    const db = getPrismaClient();
    let done = 0;
    let skipped = 0;
    for (const unitId of unitIds) {
      try {
        await unblockUnit(db, { unitId, reason: String(formData.get("reason") ?? "").trim() || undefined, audit });
        done += 1;
      } catch (error) {
        // Not blocked any more (someone else got there first) is not worth an error.
        if (error instanceof Error && /not blocked/i.test(error.message)) skipped += 1;
        else throw error;
      }
    }
    return `Unblocked ${plural(done, "plot")}${skipped ? `; ${plural(skipped, "plot")} were not blocked` : ""}.`;
  });
}

async function mark(formData: FormData, present: boolean): Promise<ActionResult> {
  return run(formData, async ({ projectId, unitIds, audit }) => {
    const result = await setUnitPlcTag(getPrismaClient(), { projectId, unitIds, tag: "CORNER", present, audit });
    const verb = present ? "Marked" : "Cleared";
    return `${verb} ${plural(result.changed, "plot")} as corner${result.unchanged ? ` (${result.unchanged} already ${present ? "were" : "were not"})` : ""}.`;
  });
}

export async function markCornerAction(formData: FormData): Promise<ActionResult> {
  return mark(formData, true);
}

export async function clearCornerAction(formData: FormData): Promise<ActionResult> {
  return mark(formData, false);
}

/** Moves the ticked plots to one plot type, with one reason for all. A plot type is
 *  a size with its code, so the plot takes both from it, and a size the plot carried
 *  of its own is dropped so that the type's size is the one it shows. A plot's size
 *  and type are its price, so a held or sold plot is refused by name (see
 *  PRICE_EDITABLE_STATUSES) and the others still go through, one at a time like
 *  blocking. */
export async function changePlotSizeAction(formData: FormData): Promise<ActionResult> {
  return run(formData, async ({ projectId, unitIds, audit }) => {
    const unitTypeId = String(formData.get("unitTypeId") ?? "").trim();
    if (unitTypeId === "") throw new Error("Choose the new size from the list.");
    const reason = String(formData.get("sizeReason") ?? "").trim();
    if (reason === "") throw new Error("Give a reason for the new size.");
    if (reason.length > MAX_SIZE_REASON_LENGTH) {
      throw new Error(`The reason must be at most ${MAX_SIZE_REASON_LENGTH} characters.`);
    }
    if (unitIds.length > MAX_PLOTS_PER_SIZE_CHANGE) {
      throw new Error(
        `Tick at most ${MAX_PLOTS_PER_SIZE_CHANGE} plots at a time. To resize a whole block, use the CSV import with "Update plots that already exist".`,
      );
    }

    const db = getPrismaClient();
    // The service checks the type against each plot's own project; this read gives the
    // person a clear answer for a type that is gone or not a plot type, and its name.
    const plotType = await db.unitType.findFirst({
      where: { id: unitTypeId, projectId, areaBasis: "SQYD", project: { orgId: audit.orgId } },
      select: { code: true, saleableArea: true },
    });
    if (!plotType) throw new Error("That size is not a plot type of this project. Reload the page and choose again.");
    const size = `${plotType.code} (${plotType.saleableArea.toFixed(2)} sq yd)`;

    let done = 0;
    const refused: string[] = [];
    for (const unitId of unitIds) {
      try {
        await updateUnit(db, { unitId, unitTypeId, saleableAreaOverride: null, reason, audit });
        done += 1;
      } catch (error) {
        // No permission fails every plot alike: say so once.
        if (error instanceof ForbiddenError) throw error;
        refused.push(error instanceof Error ? error.message : "A plot was refused.");
      }
    }
    if (done === 0) throw new Error(`Nothing was changed. ${refused.join(" ")}`);
    return `Changed ${plural(done, "plot")} to ${size}.${refused.length ? ` Not changed: ${refused.join(" ")}` : ""}`;
  });
}
