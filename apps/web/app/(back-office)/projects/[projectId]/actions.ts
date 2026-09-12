"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma, getPrismaClient } from "@desire/db";
import { createTower, createUnitType } from "@desire/services/projects";
import { createDraftPriceList, publishPriceList } from "@desire/services/price-lists";
import { createPaymentPlan } from "@desire/services/payment-plans";
import { createScheme, publishScheme } from "@desire/services/schemes";
import { requireSession } from "@/lib/session";

function auditFor(orgId: string, actorId: string, actorLabel: string) {
  return { orgId, actorId, actorLabel };
}

/** Every mutation below can genuinely fail on a real, expected business
 *  rule -- wrong role (permission), maker-checker (can't publish your own
 *  scheme/price list), a duplicate code -- and a caller who lacks
 *  pricelist.approve or scheme.approve is not a hypothetical, it is any
 *  role this page's own sidebar link is reachable from that isn't also
 *  the approver. Letting that throw uncaught crashes to Next's generic
 *  error page; caught here and shown inline instead, same discipline as
 *  the login flow. These are internal back-office actors, so the real
 *  service error message is safe (and useful) to show verbatim. */
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

export async function createTowerAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("projectId") ?? "");
  const db = getPrismaClient();

  await runAction(projectId, () =>
    createTower(db, {
      projectId,
      code: String(formData.get("code") ?? ""),
      name: String(formData.get("name") ?? ""),
      totalFloors: Number(formData.get("totalFloors") ?? 0),
      audit: auditFor(session.user.orgId, session.user.id, session.user.name),
    }).then(() => undefined),
  );
}

export async function createUnitTypeAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("projectId") ?? "");
  const db = getPrismaClient();

  await runAction(projectId, () =>
    createUnitType(db, {
      projectId,
      code: String(formData.get("code") ?? ""),
      name: String(formData.get("name") ?? ""),
      bedrooms: formData.get("bedrooms") ? Number(formData.get("bedrooms")) : undefined,
      carpetArea: String(formData.get("carpetArea") ?? "0"),
      builtUpArea: String(formData.get("builtUpArea") ?? "0"),
      saleableArea: String(formData.get("saleableArea") ?? "0"),
      audit: auditFor(session.user.orgId, session.user.id, session.user.name),
    }).then(() => undefined),
  );
}

export async function createDraftPriceListAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("projectId") ?? "");
  const db = getPrismaClient();

  const unitTypeIds = formData.getAll("unitTypeId").map(String);
  const items = unitTypeIds
    .map((unitTypeId) => ({ unitTypeId, rawRate: String(formData.get(`rate_${unitTypeId}`) ?? "") }))
    .filter((item) => item.rawRate !== "")
    .map((item) => ({ unitTypeId: item.unitTypeId, baseRatePerSqft: new Prisma.Decimal(item.rawRate) }));

  if (items.length === 0) {
    redirect(`/projects/${projectId}?error=${encodeURIComponent("Enter at least one unit type's rate.")}`);
  }

  await runAction(projectId, () =>
    createDraftPriceList(db, {
      projectId,
      name: String(formData.get("name") ?? ""),
      validFrom: new Date(),
      items,
      audit: auditFor(session.user.orgId, session.user.id, session.user.name),
    }).then(() => undefined),
  );
}

export async function publishPriceListAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("projectId") ?? "");
  const priceListId = String(formData.get("priceListId") ?? "");
  const db = getPrismaClient();

  await runAction(projectId, () =>
    publishPriceList(db, {
      priceListId,
      audit: auditFor(session.user.orgId, session.user.id, session.user.name),
    }).then(() => undefined),
  );
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
