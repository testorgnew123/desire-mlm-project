"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { bookPlot } from "@desire/services/plot-booking";
import { requireSession } from "@/lib/session";

/** The associate's one action: hold the plot (unless they already do), record
 *  the customer, draft the booking. All of the work and every rule is in
 *  bookPlot; this reads the form and says what happened. A refusal -- the plot
 *  was just taken, the quota is used up, the number is not a phone number -- comes
 *  back to the form as a message, not a crash.
 *
 *  redirect() throws, so it is called after the try, never inside it. */
export async function bookPlotAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("projectId") ?? "");
  const unitId = String(formData.get("unitId") ?? "");
  const back = `/inventory/${projectId}/${unitId}/book`;

  let destination: string;
  try {
    const booked = await bookPlot(getPrismaClient(), {
      unitId,
      customer: {
        name: String(formData.get("name") ?? ""),
        phone: String(formData.get("phone") ?? ""),
        email: String(formData.get("email") ?? ""),
      },
      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    });
    destination = `/my-bookings?booked=${encodeURIComponent(booked.bookingNumber)}`;
  } catch (error) {
    if (error instanceof Error) redirect(`${back}?error=${encodeURIComponent(error.message)}`);
    throw error;
  }

  // The plot is HELD now; drop the router's cached copies of the grid and the
  // list so neither shows the old state for up to staleTimes.dynamic seconds.
  revalidatePath(`/inventory/${projectId}`);
  revalidatePath("/my-bookings");
  redirect(destination);
}
