"use server";

import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { moveAssociate } from "@desire/services/associates";
import { assignGrade, createGrade, updateGrade } from "@desire/services/grades";
import { requireSession } from "@/lib/session";

function auditFor(session: { user: { orgId: string; id: string; name: string } }) {
  return { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name };
}

/** Same try/catch-and-redirect-with-message pattern used throughout this
 *  phase (projects/[projectId]'s runAction, crm/[leadId]'s reassignLeadAction). */
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

export async function moveAssociateAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const associateId = String(formData.get("associateId") ?? "");
  const newParentId = String(formData.get("newParentId") ?? "");
  const db = getPrismaClient();

  await runAction(`/network/associates/${associateId}`, () =>
    moveAssociate(db, {
      associateId,
      newParentId: newParentId === "" ? null : newParentId,
      reason: String(formData.get("reason") ?? ""),
      audit: auditFor(session),
    }).then(() => undefined),
  );
}

export async function assignGradeAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const associateId = String(formData.get("associateId") ?? "");
  const db = getPrismaClient();

  await runAction(`/network/associates/${associateId}`, () =>
    assignGrade(db, {
      associateId,
      gradeId: String(formData.get("gradeId") ?? ""),
      reason: String(formData.get("reason") ?? "") || undefined,
      audit: auditFor(session),
    }).then(() => undefined),
  );
}

export async function createGradeAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const db = getPrismaClient();

  await runAction("/network/grades", () =>
    createGrade(db, {
      code: String(formData.get("code") ?? ""),
      name: String(formData.get("name") ?? ""),
      rank: Number(formData.get("rank") ?? 0),
      holdQuota: formData.get("holdQuota") ? Number(formData.get("holdQuota")) : undefined,
      audit: auditFor(session),
    }).then(() => undefined),
  );
}

export async function toggleGradeActiveAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const gradeId = String(formData.get("gradeId") ?? "");
  const isActive = formData.get("isActive") === "true";
  const db = getPrismaClient();

  await runAction("/network/grades", () =>
    updateGrade(db, { gradeId, isActive, audit: auditFor(session) }).then(() => undefined),
  );
}
