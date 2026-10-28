"use server";

import { revalidatePath } from "next/cache";
import { getPrismaClient } from "@desire/db";
import { holdPlot, releasePlotHold } from "@desire/services/plot-booking";
import { describeHoldFailure } from "@/lib/hold-messages";
import { requireSession } from "@/lib/session";

/** The answer to a hold or release. Never a redirect and never a throw: the plot
 *  sheet stays open and shows `message`, so "just taken by Ravi" is read where the
 *  tap happened instead of on an error page. */
export interface HoldActionResult {
  ok: boolean;
  message: string;
}

async function run(
  projectId: string,
  action: (audit: { orgId: string; actorId: string; actorLabel: string }) => Promise<string>,
): Promise<HoldActionResult> {
  const session = await requireSession();
  try {
    const message = await action({ orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name });
    // The plot's state changed. revalidatePath refreshes the grid in this same
    // response, with a new server time, which also drops the delta overlay that
    // would otherwise show your own fresh hold as "taken by someone".
    revalidatePath(`/inventory/${projectId}`);
    revalidatePath(`/board/${projectId}`);
    revalidatePath("/my-bookings");
    return { ok: true, message };
  } catch (error) {
    const message = describeHoldFailure(error);
    if (message.startsWith("Something went wrong")) console.error("hold action failed", error);
    return { ok: false, message };
  }
}

/** Reserves a free plot for the signed-in associate. Booking it afterwards uses
 *  this hold (bookPlot); holding it again is not an error. */
export async function holdPlotAction(projectId: string, unitId: string): Promise<HoldActionResult> {
  return run(projectId, async (audit) => {
    const held = await holdPlot(getPrismaClient(), { unitId, audit });
    return held.tookHold ? "Plot held for you." : "You already hold this plot.";
  });
}

/** Gives a plot back. Only its holder can, and not while a draft booking waits for an admin. */
export async function releaseHoldAction(projectId: string, unitId: string): Promise<HoldActionResult> {
  return run(projectId, async (audit) => {
    await releasePlotHold(getPrismaClient(), { unitId, audit });
    return "Hold released.";
  });
}
