"use server";

import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { requestDiscount } from "@desire/services/discounts";
import { cancelBooking } from "@desire/services/bookings";
import { requireSession } from "@/lib/session";

/** Same try/catch-and-redirect-with-message pattern as projects/[projectId]'s
 *  runAction and crm/[leadId]'s reassignLeadAction -- a real business-rule
 *  refusal (wrong booking status, wrong role, self-approval) is expected
 *  here, not a bug, so it is shown inline rather than crashing to Next's
 *  generic error page. */
async function runAction(bookingId: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) {
      redirect(`/bookings/${bookingId}?error=${encodeURIComponent(error.message)}`);
    }
    throw error;
  }

  redirect(`/bookings/${bookingId}`);
}

export async function requestDiscountAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const bookingId = String(formData.get("bookingId") ?? "");
  const db = getPrismaClient();

  await runAction(bookingId, () =>
    requestDiscount(db, {
      bookingId,
      amount: String(formData.get("amount") ?? "0"),
      pctOfBase: String(formData.get("pctOfBase") ?? "0"),
      justification: String(formData.get("justification") ?? ""),
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
