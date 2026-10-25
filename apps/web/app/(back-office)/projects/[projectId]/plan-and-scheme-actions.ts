"use server";

// Payment plans and commission schemes. The project page no longer shows either
// (collections and commission are switched off, apps/web/lib/features.ts), so no
// page imports this file -- which also keeps the schemes, payment-plan and
// commission modules out of the project page's server bundle. When those
// features come back, import these from the page again.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPrismaClient } from "@desire/db";
import { createPaymentPlan } from "@desire/services/payment-plans";
import { createScheme, publishScheme } from "@desire/services/schemes";
import { requireSession } from "@/lib/session";

function auditFor(orgId: string, actorId: string, actorLabel: string) {
  return { orgId, actorId, actorLabel };
}

/** Same discipline as actions.ts: a business-rule failure is shown inline rather
 *  than crashing to the generic error page. */
async function runAction(projectId: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) {
      redirect(`/projects/${projectId}?error=${encodeURIComponent(error.message)}`);
    }
    throw error;
  }

  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${projectId}`);
}

export async function createPaymentPlanAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("projectId") ?? "");
  const db = getPrismaClient();

  await runAction(projectId, () =>
    createPaymentPlan(db, {
      code: String(formData.get("code") ?? ""),
      name: String(formData.get("name") ?? ""),
      projectId,
      milestones: [{ sequence: 1, label: "On booking", pctOfAgreementValue: "100", dueDaysOffset: 0 }],
      audit: auditFor(session.user.orgId, session.user.id, session.user.name),
    }).then(() => undefined),
  );
}

export async function createSchemeAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("projectId") ?? "");
  const db = getPrismaClient();

  const gradeIds = formData.getAll("gradeId").map(String);
  const gradeRates = gradeIds
    .map((gradeId) => ({ gradeId, rateValue: String(formData.get(`gradeRate_${gradeId}`) ?? "") }))
    .filter((rate) => rate.rateValue !== "");

  if (gradeRates.length === 0) {
    redirect(`/projects/${projectId}?error=${encodeURIComponent("Enter at least one grade's rate.")}`);
  }

  const levelRates = [1, 2, 3]
    .map((level) => ({ level, pctOfSellerCommission: String(formData.get(`levelRate_${level}`) ?? "") }))
    .filter((rate) => rate.pctOfSellerCommission !== "");

  await runAction(projectId, () =>
    createScheme(db, {
      projectId,
      name: String(formData.get("name") ?? ""),
      validFrom: new Date(),
      baseDefinition: { chargeHeadCodes: ["BSP"], netOfDiscount: true, netOfGst: true },
      maxTotalPct: String(formData.get("maxTotalPct") ?? "3"),
      gradeRates,
      levelRates,
      audit: auditFor(session.user.orgId, session.user.id, session.user.name),
    }).then(() => undefined),
  );
}

export async function publishSchemeAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("projectId") ?? "");
  const schemeId = String(formData.get("schemeId") ?? "");
  const db = getPrismaClient();

  await runAction(projectId, () =>
    publishScheme(db, {
      schemeId,
      audit: auditFor(session.user.orgId, session.user.id, session.user.name),
    }).then(() => undefined),
  );
}
