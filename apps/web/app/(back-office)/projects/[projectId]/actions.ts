"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma, getPrismaClient } from "@desire/db";
import { ProjectReraInvalidError, createUnit, createUnitType } from "@desire/services/projects";
import { createBlockWithPlots } from "@desire/services/blocks";
import { UnitImportRejectedError } from "@desire/services/unit-import";
import { createDraftPriceList, publishPriceList } from "@desire/services/price-lists";
import type { PlcCharge } from "@desire/services/price-lists";
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

/** The service errors are accurate but written for logs. This says what happened
 *  in terms of what the person did -- and, since a block and its plots are
 *  created in one transaction, that nothing was created. */
function describePlotFailure(error: unknown): unknown {
  if (error instanceof ProjectReraInvalidError) {
    return new Error(
      "Plots can't be created until the project has a live RERA registration. Nothing was " +
        "created. Add the block without a plot count to create it on its own.",
    );
  }
  if (error instanceof UnitImportRejectedError) {
    const shown = error.report.errors.slice(0, 3).map((problem) => problem.message);
    const more = error.report.errors.length - shown.length;
    return new Error(
      `The block was not created, because its plots could not be: ${shown.join("; ")}` +
        `${more > 0 ? ` (and ${more} more)` : ""}.`,
    );
  }
  return error;
}

/** Adds a plotted block, with its plots when a count is given. Only blocks can be
 *  created (SCOPE.plotsOnly): createBlockWithPlots always makes a BLOCK, so there
 *  is no kind to read from the form and nothing a hand-made POST could change. */
export async function createTowerAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("projectId") ?? "");
  const db = getPrismaClient();
  const audit = auditFor(session.user.orgId, session.user.id, session.user.name);
  // Trimmed: a block's plots are numbered from its code, and "A " would give
  // "A -01".
  const code = String(formData.get("code") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();

  await runAction(projectId, async () => {
    // A block sends NO floor count -- createTower rejects a block that declares
    // floors, which is the point of the rule. It sends a plot count instead.
    const rawCount = String(formData.get("plotCount") ?? "").trim();
    let plotUnitTypeCode: string | undefined;
    if (rawCount !== "") {
      const plotType = await db.unitType.findFirst({
        where: { id: String(formData.get("plotUnitTypeId") ?? ""), projectId },
        select: { code: true },
      });
      if (!plotType) throw new Error("Choose a plot type for the plots.");
      plotUnitTypeCode = plotType.code;
    }

    try {
      await createBlockWithPlots(db, {
        projectId,
        code,
        name,
        plotCount: rawCount === "" ? undefined : Number(rawCount),
        plotUnitTypeCode,
        audit,
      });
    } catch (error) {
      throw describePlotFailure(error);
    }
  });
}

/** Single-unit entry. The bulk CSV import is the realistic path for a
 *  township of 300 plots; this exists for the correction afterwards. */
export async function createUnitAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("projectId") ?? "");
  const db = getPrismaClient();

  const towerId = String(formData.get("towerId") ?? "") || null;

  await runAction(projectId, () =>
    createUnit(db, {
      projectId,
      towerId,
      unitTypeId: String(formData.get("unitTypeId") ?? ""),
      unitNumber: String(formData.get("unitNumber") ?? "").trim(),
      // A plot has no floor; the form no longer offers one.
      floor: null,
      audit: auditFor(session.user.orgId, session.user.id, session.user.name),
    }).then(() => undefined),
  );
}

/** Adds a plot type. The basis is fixed to square yards here rather than read
 *  from the form: only plot types can be created (SCOPE.plotsOnly), and a plot
 *  has one area -- no bedrooms, carpet or built-up. */
export async function createUnitTypeAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const projectId = String(formData.get("projectId") ?? "");
  const db = getPrismaClient();

  await runAction(projectId, () =>
    createUnitType(db, {
      projectId,
      code: String(formData.get("code") ?? ""),
      name: String(formData.get("name") ?? ""),
      areaBasis: "SQYD",
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
