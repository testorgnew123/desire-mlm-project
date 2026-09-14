"use server";

import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { createSavedView, deleteSavedView } from "@desire/services/report-schedules";
import { requireSession } from "@/lib/session";

function auditFor(session: { user: { orgId: string; id: string; name: string } }) {
  return { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name };
}

async function runAction(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) {
      redirect(`/reports?error=${encodeURIComponent(error.message)}`);
    }
    throw error;
  }
  redirect("/reports");
}

export async function createSavedViewAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const db = getPrismaClient();

  const reportKey = String(formData.get("reportKey") ?? "");
  const name = String(formData.get("name") ?? "");
  const scheduleCron = String(formData.get("scheduleCron") ?? "").trim();

  await runAction(() =>
    createSavedView(db, {
      reportKey,
      name,
      scheduleCron: scheduleCron === "" ? null : scheduleCron,
      audit: auditFor(session),
    }).then(() => undefined),
  );
}

export async function deleteSavedViewAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const db = getPrismaClient();
  const id = String(formData.get("id") ?? "");

  await runAction(() => deleteSavedView(db, { id, audit: auditFor(session) }).then(() => undefined));
}
