"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma, getPrismaClient } from "@desire/db";
import { createTower, createUnit, createUnitType } from "@desire/services/projects";
import type { UnitGroupKind } from "@desire/db";
import { createDraftPriceList, publishPriceList } from "@desire/services/price-lists";
import type { PlcCharge } from "@desire/services/price-lists";
import type { AreaBasis } from "@desire/db";
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
  const kind: UnitGroupKind = formData.get("kind") === "BLOCK" ? "BLOCK" : "TOWER";

  await runAction(projectId, () =>
    createTower(db, {
      projectId,
      code: String(formData.get("code") ?? ""),
      name: String(formData.get("name") ?? ""),
      kind,
      // A block must send NOTHING here, not 0 -- createTower rejects a block
      // that declares floors, which is the point of the rule.
      totalFloors: kind === "TOWER" ? Number(formData.get("totalFloors") ?? 0) : undefined,
      audit: auditFor(session.user.orgId, session.user.id, session.user.name),
    }).then(() => undefined),
  );
}

/** Single-unit entry. The bulk CSV import is the realistic path for a
 *  township of 300 plots; this exists for the correction afterwards. */
export async function createUnitAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("projectId") ?? "");
  const db = getPrismaClient();

  const towerId = String(formData.get("towerId") ?? "") || null;
  const rawFloor = String(formData.get("floor") ?? "").trim();

  await runAction(projectId, () =>
    createUnit(db, {
      projectId,
      towerId,
      unitTypeId: String(formData.get("unitTypeId") ?? ""),
      unitNumber: String(formData.get("unitNumber") ?? "").trim(),
      // Empty means "no floor", which is what a plot in a block needs. Sending
      // 0 instead would be rejected by assertUnitFloor -- correctly.
      floor: rawFloor === "" ? null : Number(rawFloor),
      audit: auditFor(session.user.orgId, session.user.id, session.user.name),
    }).then(() => undefined),
  );
}

/** A blank area field means "this type has none", not zero. Zero carpet would
 *  sail past a `> 0` check and then fail the carpet < built-up rule with a
 *  baffling "0.00 must be less than 0.00"; null is the honest value for a plot,
 *  and createUnitType decides which basis may carry which areas. */
function optionalArea(formData: FormData, field: string): string | null {
  const raw = String(formData.get(field) ?? "").trim();
  return raw === "" ? null : raw;
}

export async function createUnitTypeAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("projectId") ?? "");
  const db = getPrismaClient();
  const areaBasis: AreaBasis = formData.get("areaBasis") === "SQYD" ? "SQYD" : "SQFT";

  await runAction(projectId, () =>
    createUnitType(db, {
      projectId,
      code: String(formData.get("code") ?? ""),
      name: String(formData.get("name") ?? ""),
      bedrooms: formData.get("bedrooms") ? Number(formData.get("bedrooms")) : undefined,
      areaBasis,
      carpetArea: optionalArea(formData, "carpetArea"),
      builtUpArea: optionalArea(formData, "builtUpArea"),
      saleableArea: String(formData.get("saleableArea") ?? "0"),
      audit: auditFor(session.user.orgId, session.user.id, session.user.name),
    }).then(() => undefined),
  );
}

/** PLC charges arrive as three parallel arrays per unit type, zipped by
 *  position: the tag (hidden, from the tags the project's units actually
 *  carry), the basis, and the value. Parallel arrays rather than a
 *  `plc_<id>_<tag>` field name because a tag is free text on Unit.plcTags --
 *  it may contain a space or an underscore, and a name built by concatenation
 *  could not be taken apart again unambiguously.
 *
 *  A blank value means "this type pays nothing for this tag", which is not the
 *  same as zero: an omitted tag is simply absent from the JSON, and the cost
 *  sheet raises UnpricedPlcTagError if a unit carries a tag the list does not
 *  price. Writing an explicit 0 would silence that guard. */
function readPlcCharges(
  formData: FormData,
  unitTypeId: string,
): Record<string, PlcCharge> | undefined {
  const tags = formData.getAll(`plcTag_${unitTypeId}`).map(String);
  const bases = formData.getAll(`plcBasis_${unitTypeId}`).map(String);
  const values = formData.getAll(`plcValue_${unitTypeId}`).map((v) => String(v).trim());

  const charges: Record<string, PlcCharge> = {};
  tags.forEach((tag, index) => {
    const raw = values[index] ?? "";
    if (raw === "") return;
    charges[tag] = {
      basis: bases[index] === "PCT_OF_BASE" ? "PCT_OF_BASE" : "PER_AREA",
      value: toDecimal(raw, `PLC charge for '${tag}'`),
    };
  });
  return Object.keys(charges).length === 0 ? undefined : charges;
}

/** Prisma.Decimal throws a bare "[DecimalError] Invalid argument" on anything
 *  it cannot parse, which reaches Next's generic error page. A percentage
 *  field practically invites "10%" to be typed into it, so the message says
 *  which field and what was in it. */
function toDecimal(raw: string, label: string): Prisma.Decimal {
  try {
    return new Prisma.Decimal(raw);
  } catch {
    throw new Error(`${label} must be a number; got "${raw}".`);
  }
}

export async function createDraftPriceListAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("projectId") ?? "");
  const db = getPrismaClient();

  const unitTypeIds = formData.getAll("unitTypeId").map(String);

  // Parsing happens INSIDE runAction so a malformed number lands on the same
  // inline error banner as a rejected business rule, rather than on Next's
  // generic error page.
  await runAction(projectId, async () => {
    const items = unitTypeIds
      .map((unitTypeId) => ({
        unitTypeId,
        rawRate: String(formData.get(`rate_${unitTypeId}`) ?? "").trim(),
      }))
      .filter((item) => item.rawRate !== "")
      .map((item) => ({
        unitTypeId: item.unitTypeId,
        baseRate: toDecimal(item.rawRate, `Base rate for unit type ${item.unitTypeId}`),
        plcCharges: readPlcCharges(formData, item.unitTypeId),
      }));

    if (items.length === 0) throw new Error("Enter at least one unit type's rate.");

    await createDraftPriceList(db, {
      projectId,
      name: String(formData.get("name") ?? ""),
      validFrom: new Date(),
      items,
      audit: auditFor(session.user.orgId, session.user.id, session.user.name),
    });
  });
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
