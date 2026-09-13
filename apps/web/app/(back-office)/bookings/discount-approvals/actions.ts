"use server";

import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { decideDiscount } from "@desire/services/discounts";
import { requireSession } from "@/lib/session";

export async function decideDiscountAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const discountRequestId = String(formData.get("discountRequestId") ?? "");
  const approve = formData.get("approve") === "true";
  const decisionNote = String(formData.get("decisionNote") ?? "");
  const db = getPrismaClient();

  try {
    await decideDiscount(db, {
      discountRequestId,
      approve,
      decisionNote: decisionNote || undefined,
      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    });
  } catch (error) {
    if (error instanceof Error) {
      redirect(`/bookings/discount-approvals?error=${encodeURIComponent(error.message)}`);
    }
    throw error;
  }

  redirect("/bookings/discount-approvals");
}
