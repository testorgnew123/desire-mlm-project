"use server";

// Discount requests and payment-schedule demands. The booking page no longer
// shows either (discounts and collections are switched off,
// apps/web/lib/features.ts), so no page imports this file -- which also keeps the
// discounts and payment-plans modules out of the booking page's server bundle.
// When those features come back, import these from the page again.
import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { requestDiscount } from "@desire/services/discounts";
import { raiseDemand, waiveDemand } from "@desire/services/payment-plans";
import { requireSession } from "@/lib/session";

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

export async function raiseDemandAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const bookingId = String(formData.get("bookingId") ?? "");
  const demandId = String(formData.get("demandId") ?? "");
  const db = getPrismaClient();

  await runAction(bookingId, () =>
    raiseDemand(db, {
      demandId,
      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    }).then(() => undefined),
  );
}

export async function waiveDemandAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const bookingId = String(formData.get("bookingId") ?? "");
  const demandId = String(formData.get("demandId") ?? "");
  const db = getPrismaClient();

  await runAction(bookingId, () =>
    waiveDemand(db, {
      demandId,
      reason: String(formData.get("reason") ?? ""),
      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    }).then(() => undefined),
  );
}
