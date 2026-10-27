"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { blockUnit, unblockUnit } from "@desire/services/units";
import { setUnitPlcTag } from "@desire/services/unit-tags";
import { requireSession } from "@/lib/session";

/** The ids ticked on the plots table. Duplicates dropped; the services cap the
 *  count and check every id belongs to this project, so nothing is trusted here. */
function pickedUnitIds(formData: FormData): string[] {
  return [...new Set(formData.getAll("unitId").map(String).filter(Boolean))];
}

function backTo(projectId: string, towerId: string, params: Record<string, string>): string {
  const query = new URLSearchParams({ ...(towerId ? { block: towerId } : {}), ...params });
  return `/projects/${projectId}/plots?${query.toString()}`;
}

/** Runs one change and comes back to the same block with a message. A refusal is
 *  an expected business answer (held plot, no permission), so it is shown inline,
 *  never a crash. redirect() throws, hence it is called after the try. */
async function run(
  formData: FormData,
  change: (ctx: { projectId: string; unitIds: string[]; audit: { orgId: string; actorId: string; actorLabel: string } }) => Promise<string>,
): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("projectId") ?? "");
  const towerId = String(formData.get("towerId") ?? "");
  const unitIds = pickedUnitIds(formData);

  let destination: string;
  try {
    if (unitIds.length === 0) throw new Error("Tick at least one plot first.");
    const notice = await change({
      projectId,
      unitIds,
      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    });
    destination = backTo(projectId, towerId, { notice });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    destination = backTo(projectId, towerId, { error: error.message });
  }

  // The board and the phone grid read these plots too.
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/board/${projectId}`);
  revalidatePath(`/inventory/${projectId}`);
  redirect(destination);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Takes the ticked plots off sale, with one reason for all. One at a time under
 *  the hood: a plot that cannot be blocked (sold, or with a booking waiting) is
 *  reported by name and the others still go through. */
export async function blockPlotsAction(formData: FormData): Promise<void> {
  const reason = String(formData.get("reason") ?? "");
  await run(formData, async ({ unitIds, audit }) => {
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

export async function unblockPlotsAction(formData: FormData): Promise<void> {
  await run(formData, async ({ unitIds, audit }) => {
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

async function mark(formData: FormData, present: boolean): Promise<void> {
  await run(formData, async ({ projectId, unitIds, audit }) => {
    const result = await setUnitPlcTag(getPrismaClient(), { projectId, unitIds, tag: "CORNER", present, audit });
    const verb = present ? "Marked" : "Cleared";
    return `${verb} ${plural(result.changed, "plot")} as corner${result.unchanged ? ` (${result.unchanged} already ${present ? "were" : "were not"})` : ""}.`;
  });
}

export async function markCornerAction(formData: FormData): Promise<void> {
  await mark(formData, true);
}

export async function clearCornerAction(formData: FormData): Promise<void> {
  await mark(formData, false);
}
