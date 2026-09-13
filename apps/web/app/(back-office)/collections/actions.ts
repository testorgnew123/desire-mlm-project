"use server";

import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import type { FollowUpOutcome, ReceiptMode } from "@desire/db";
import { promiseToPay } from "@desire/services/collections-sweep";
import { enterReceipt, verifyReceipt, clearReceipt, bounceReceipt } from "@desire/services/receipts";
import { requireSession } from "@/lib/session";

/** Same try/catch-and-redirect-with-message pattern used throughout this
 *  phase (projects/[projectId]'s runAction, crm/[leadId]'s reassignLeadAction,
 *  bookings/[bookingId]'s runAction) -- a real business-rule refusal (wrong
 *  role, wrong receipt state, self-verification) is expected here, not a
 *  bug. */
async function runAction(path: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) {
      redirect(`${path}?error=${encodeURIComponent(error.message)}`);
    }
    throw error;
  }

  redirect(path);
}

function auditFor(session: { user: { orgId: string; id: string; name: string } }) {
  return { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name };
}

export async function promiseToPayAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const demandId = String(formData.get("demandId") ?? "");
  const promiseToPayDate = String(formData.get("promiseToPayDate") ?? "");
  const notes = String(formData.get("notes") ?? "");
  const db = getPrismaClient();

  await runAction("/collections", () =>
    promiseToPay(db, {
      demandId,
      contactedOn: new Date(),
      outcome: String(formData.get("outcome") ?? "CONTACTED_WILL_PAY") as FollowUpOutcome,
      promiseToPayDate: promiseToPayDate ? new Date(promiseToPayDate) : undefined,
      notes: notes || undefined,
      audit: auditFor(session),
    }).then(() => undefined),
  );
}

export async function enterReceiptAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const bookingNumber = String(formData.get("bookingNumber") ?? "").trim();
  const db = getPrismaClient();

  await runAction("/collections/receipts", async () => {
    const booking = await db.booking.findFirst({
      where: { orgId: session.user.orgId, bookingNumber },
      select: { id: true },
    });
    if (!booking) throw new Error(`No booking found with number "${bookingNumber}".`);

    await enterReceipt(db, {
      bookingId: booking.id,
      amount: String(formData.get("amount") ?? "0"),
      mode: String(formData.get("mode") ?? "CASH") as ReceiptMode,
      receivedOn: new Date(String(formData.get("receivedOn") ?? new Date().toISOString())),
      remarks: String(formData.get("remarks") ?? "") || undefined,
      audit: auditFor(session),
    });
  });
}

export async function verifyReceiptAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const receiptId = String(formData.get("receiptId") ?? "");
  const returnPath = String(formData.get("returnPath") ?? "/collections/receipts");
  const db = getPrismaClient();

  await runAction(returnPath, () =>
    verifyReceipt(db, { receiptId, audit: auditFor(session) }).then(() => undefined),
  );
}

export async function clearReceiptAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const receiptId = String(formData.get("receiptId") ?? "");
  const clearedOn = String(formData.get("clearedOn") ?? "");
  const db = getPrismaClient();

  await runAction("/collections/receipts", () =>
    clearReceipt(db, {
      receiptId,
      clearedOn: clearedOn ? new Date(clearedOn) : new Date(),
      audit: auditFor(session),
    }).then(() => undefined),
  );
}

export async function bounceReceiptAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const receiptId = String(formData.get("receiptId") ?? "");
  const bounceReason = String(formData.get("bounceReason") ?? "");
  const db = getPrismaClient();

  await runAction("/collections/receipts", () =>
    bounceReceipt(db, { receiptId, bounceReason, audit: auditFor(session) }).then(() => undefined),
  );
}
