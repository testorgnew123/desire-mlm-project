"use server";

import { revalidatePath } from "next/cache";
import { getPrismaClient } from "@desire/db";
import { bookPlot, releasePlotHold } from "@desire/services/plot-booking";
import { describeHoldFailure } from "@/lib/hold-messages";
import { requireSession } from "@/lib/session";
import type { ActionResult } from "@/lib/action-result";

/** The associate's one action: hold the plot (unless they already do), record
 *  the customer, draft the booking. All of the work and every rule is in
 *  bookPlot; this reads the form and says what happened. A refusal -- the plot
 *  was just taken, the quota is used up, the number is not a phone number -- comes
 *  back to the form as a message, not a crash. Success sends the associate on to
 *  My bookings (`redirectTo`, followed by the form). */
export async function bookPlotAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const projectId = String(formData.get("projectId") ?? "");
  const unitId = String(formData.get("unitId") ?? "");

  let destination: string;
  try {
    const booked = await bookPlot(getPrismaClient(), {
      unitId,
      customer: {
        name: String(formData.get("name") ?? ""),
        phone: String(formData.get("phone") ?? ""),
        email: String(formData.get("email") ?? ""),
      },
      // Only an admin has the permission; the service refuses anyone else who sends one.
      priceOverride: String(formData.get("priceOverride") ?? ""),
      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    });
    destination = `/my-bookings?booked=${encodeURIComponent(booked.bookingNumber)}`;
  } catch (error) {
    if (error instanceof Error) return { ok: false, error: error.message };
    throw error;
  }

  // The plot is HELD now; drop the router's cached copies of the grid and the
  // list so neither shows the old state for up to staleTimes.dynamic seconds.
  revalidatePath(`/inventory/${projectId}`);
  revalidatePath("/my-bookings");
  return { ok: true, redirectTo: destination };
}

/** Gives a held plot back, from the book page or from My bookings. From the book
 *  page it goes back to the plot grid; from My bookings it stays there and the
 *  list refreshes. A refusal (someone else's hold, a draft is waiting for an admin)
 *  comes back as a message under the button. */
export async function releaseHoldFormAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const projectId = String(formData.get("projectId") ?? "");
  const unitId = String(formData.get("unitId") ?? "");
  // Only the two known places, never a posted address: no open redirect.
  const fromMyBookings = formData.get("next") === "/my-bookings";

  try {
    await releasePlotHold(getPrismaClient(), {
      unitId,
      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    });
  } catch (error) {
    return { ok: false, error: describeHoldFailure(error) };
  }

  revalidatePath(`/inventory/${projectId}`);
  revalidatePath("/my-bookings");
  return fromMyBookings ? { ok: true } : { ok: true, redirectTo: `/inventory/${projectId}` };
}
