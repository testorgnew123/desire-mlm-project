"use server";

import { redirect } from "next/navigation";
import type { ActivityType, LeadStage } from "@desire/db";
import { getPrismaClient } from "@desire/db";
import { logActivity, scheduleSiteVisit } from "@desire/services/leads";
import { requireSession } from "@/lib/session";

export async function logActivityAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const leadId = String(formData.get("leadId") ?? "");
  const type = String(formData.get("type") ?? "") as ActivityType;
  const notes = String(formData.get("notes") ?? "").trim();
  const toStage = String(formData.get("toStage") ?? "") as LeadStage | "";

  if (type === "STAGE_CHANGE" && !toStage) {
    redirect(`/leads/${leadId}?error=stage_required`);
  }

  const db = getPrismaClient();
  await logActivity(db, {
    leadId,
    type,
    notes: notes || null,
    toStage: toStage || undefined,
    audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
  });

  redirect(`/leads/${leadId}`);
}

export async function scheduleSiteVisitAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const leadId = String(formData.get("leadId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const scheduledAtRaw = String(formData.get("scheduledAt") ?? "");

  const scheduledAt = new Date(scheduledAtRaw);
  if (!projectId || Number.isNaN(scheduledAt.getTime())) {
    redirect(`/leads/${leadId}?error=invalid_visit`);
  }

  const db = getPrismaClient();
  await scheduleSiteVisit(db, {
    leadId,
    projectId,
    scheduledAt,
    audit: { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name },
  });

  redirect(`/leads/${leadId}`);
}
