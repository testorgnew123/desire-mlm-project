"use server";

import { revalidatePath } from "next/cache";
import { getPrismaClient } from "@desire/db";
import { cancelBooking, confirmBooking, setBookingPriceOverride } from "@desire/services/bookings";
import { requireSession } from "@/lib/session";
import type { ActionResult } from "@/lib/action-result";

/** Same shape as projects/[projectId]'s runAction -- a real business-rule
 *  refusal (wrong booking status, wrong role, a hold that expired) is expected
 *  here, not a bug, so it is returned for the ActionForm to show under the form
 *  rather than crashing to Next's generic error page. No redirect: see
 *  lib/action-result.ts.
 *
 *  The router caches a page for staleTimes.dynamic seconds, so the list and the
 *  detail are revalidated: otherwise a confirmed booking would keep reading
 *  DRAFT in the list for up to a minute. */
async function runAction(bookingId: string, run: () => Promise<void>): Promise<ActionResult> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return { ok: false, error: error.message };
    throw error;
  }

  revalidatePath("/bookings");
  revalidatePath(`/bookings/${bookingId}`);
  return { ok: true };
}

/** The second half of "associate drafts, admin confirms". The service re-checks
 *  everything -- permission, that it is still a draft, that the associate's hold
 *  is still live -- and does the freeze, so this only carries the request. */
export async function confirmBookingAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const bookingId = String(formData.get("bookingId") ?? "");
  const db = getPrismaClient();

  return runAction(bookingId, () =>
    confirmBooking(db, {
      bookingId,
      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    }).then(() => undefined),
  );
}

export async function cancelBookingAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const bookingId = String(formData.get("bookingId") ?? "");
  const db = getPrismaClient();

  return runAction(bookingId, () =>
    cancelBooking(db, {
      bookingId,
      reason: String(formData.get("reason") ?? ""),
      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    }).then(() => undefined),
  );
}

/** Sets the agreed final price on a draft. Blank is refused here rather than read
 *  as "clear": clearing is its own button, so an empty box cannot silently
 *  undo an agreed price. */
export async function setPriceOverrideAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const bookingId = String(formData.get("bookingId") ?? "");
  const price = String(formData.get("price") ?? "").trim();
  const db = getPrismaClient();

  return runAction(bookingId, async () => {
    if (price === "") throw new Error("Enter the agreed price, or use the list price.");
    await setBookingPriceOverride(db, {
      bookingId,
      price,
      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    });
  });
}

/** Goes back to the price list's price. */
export async function clearPriceOverrideAction(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const bookingId = String(formData.get("bookingId") ?? "");
  const db = getPrismaClient();

  return runAction(bookingId, () =>
    setBookingPriceOverride(db, {
      bookingId,
      price: null,
      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    }).then(() => undefined),
  );
}
