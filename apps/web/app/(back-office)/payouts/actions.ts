"use server";

import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { approveBatch, exportBatch, prepareBatch, writeOffRecovery } from "@desire/services/payouts";
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

export async function prepareBatchAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const db = getPrismaClient();

  await runAction("/payouts", () =>
    prepareBatch(db, {
      orgId: session.user.orgId,
      periodStart: new Date(String(formData.get("periodStart") ?? "")),
      periodEnd: new Date(String(formData.get("periodEnd") ?? "")),
      audit: auditFor(session),
    }).then(() => undefined),
  );
}

export async function approveBatchAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const batchId = String(formData.get("batchId") ?? "");
  const db = getPrismaClient();

  await runAction(`/payouts/batches/${batchId}`, () =>
    approveBatch(db, { batchId, audit: auditFor(session) }).then(() => undefined),
  );
}

export async function exportBatchAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const batchId = String(formData.get("batchId") ?? "");
  const db = getPrismaClient();

  await runAction(`/payouts/batches/${batchId}`, () =>
    exportBatch(db, { batchId, audit: auditFor(session) }).then(() => undefined),
  );
}

export async function writeOffRecoveryAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const recoveryId = String(formData.get("recoveryId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  const db = getPrismaClient();

  await runAction("/payouts/recoveries", () =>
    writeOffRecovery(db, { recoveryId, reason, audit: auditFor(session) }).then(() => undefined),
  );
}
