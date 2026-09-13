"use server";

import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { raiseDispute, resolveDispute } from "@desire/services/commission";
import { requireSession } from "@/lib/session";

function auditFor(session: { user: { orgId: string; id: string; name: string } }) {
  return { orgId: session.user.orgId, actorId: session.user.id, actorLabel: session.user.name };
}

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

export async function raiseDisputeAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const entryId = String(formData.get("entryId") ?? "");
  const db = getPrismaClient();

  await runAction("/commission", () =>
    raiseDispute(db, {
      entryId,
      description: String(formData.get("description") ?? ""),
      audit: auditFor(session),
    }).then(() => undefined),
  );
}

export async function resolveDisputeAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const disputeId = String(formData.get("disputeId") ?? "");
  const resolution = formData.get("resolution") === "APPROVED" ? "APPROVED" : "REJECTED";
  const adjustmentAmount = String(formData.get("adjustmentAmount") ?? "").trim();
  const db = getPrismaClient();

  await runAction("/commission/disputes", () =>
    resolveDispute(db, {
      disputeId,
      resolution,
      resolutionNote: String(formData.get("resolutionNote") ?? "") || undefined,
      adjustmentAmount: adjustmentAmount || undefined,
      audit: auditFor(session),
    }).then(() => undefined),
  );
}
