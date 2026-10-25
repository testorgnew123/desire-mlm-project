"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { cancelBooking, confirmBooking } from "@desire/services/bookings";
import { requireSession } from "@/lib/session";

/** Same try/catch-and-redirect-with-message pattern as projects/[projectId]'s
 *  runAction and crm/[leadId]'s reassignLeadAction -- a real business-rule
 *  refusal (wrong booking status, wrong role, a hold that expired) is expected
 *  here, not a bug, so it is shown inline rather than crashing to Next's
 *  generic error page.
 *
 *  The router caches a page for staleTimes.dynamic seconds, so the list and the
 *  detail are revalidated: otherwise a confirmed booking would keep reading
 *  DRAFT in the list for up to a minute. */
async function runAction(bookingId: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) {
      redirect(`/bookings/${bookingId}?error=${encodeURIComponent(error.message)}`);
    }
    throw error;
  }

  revalidatePath("/bookings");
  revalidatePath(`/bookings/${bookingId}`);
  redirect(`/bookings/${bookingId}`);
}

/** The second half of "associate drafts, admin confirms". The service re-checks
 *  everything -- permission, that it is still a draft, that the associate's hold
 *  is still live -- and does the freeze, so this only carries the request. */
export async function confirmBookingAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const bookingId = String(formData.get("bookingId") ?? "");
  const db = getPrismaClient();

  await runAction(bookingId, () =>
    confirmBooking(db, {
      bookingId,
      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    }).then(() => undefined),
  );
}

export async function cancelBookingAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const bookingId = String(formData.get("bookingId") ?? "");
  const db = getPrismaClient();

  await runAction(bookingId, () =>
    cancelBooking(db, {
      bookingId,
      reason: String(formData.get("reason") ?? ""),
      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    }).then(() => undefined),
  );
}
