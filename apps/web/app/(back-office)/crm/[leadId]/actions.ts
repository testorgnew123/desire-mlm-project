"use server";

import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { reassignLead } from "@desire/services/leads";
import { requireSession } from "@/lib/session";

export async function reassignLeadAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const leadId = String(formData.get("leadId") ?? "");
  const toAssociateId = String(formData.get("toAssociateId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  const db = getPrismaClient();

  try {
    await reassignLead(db, {
      leadId,
      toAssociateId,
      reason,
      audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
    });
  } catch (error) {
    if (error instanceof Error) {
      redirect(`/crm/${leadId}?error=${encodeURIComponent(error.message)}`);
    }
    throw error;
  }

  redirect(`/crm/${leadId}`);
}
