// Cost sheet computation -- docs/06-INVENTORY-SPEC.md section 5.
//
// The core is a PURE function: no db, no clock, no I/O. Same reasoning as
// packages/commission -- the arithmetic that decides what a customer owes and
// what an associate earns has to be exhaustively testable from a table of
// inputs, without a database. buildCostSheetForUnit below is a thin wrapper
// that only gathers those inputs.
//
// Area discipline (docs/19-GLOSSARY.md): everything is priced on SALEABLE area.
// Carpet area is carried through because RERA requires it on the customer-facing
// sheet -- it is never a multiplier here. The loading factor is 1.3-1.5x, so
// pricing a saleable-area rate against carpet area misprices a unit by ~35%.
//
// Commission discipline (docs/19-GLOSSARY.md): commissionableValue is almost
// never the agreement value. It is the sum of line AMOUNTS whose ChargeHead
// says countsTowardCommission -- GST never counts, and refundable heads such as
// IFMS normally do not either, but that is read off the flag rather than
// hardcoded, so an org that decides otherwise changes a row, not this file.
import { Prisma } from "@desire/db";
import type { ChargeCategory, PrismaClient } from "@desire/db";
import {
  getActivePriceList,
  PriceListNotFoundError,
  type ActivePriceList,
} from "./price-lists";

// ── Errors ─────────────────────────────────────────────────────────────

export class CostSheetInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostSheetInputError";
  }
}

/** A charge head the cost sheet needs is missing from the org's catalogue, or a
 *  line references a code that does not exist. */
export class ChargeHeadNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChargeHeadNotConfiguredError";
  }
}

/** The head exists but its configuration cannot produce a correct line -- e.g.
 *  taxable with no GST rate, or a computed category supplied as a fixed charge. */
export class ChargeHeadMisconfiguredError extends Error {
  constructor(
    public readonly chargeHeadCode: string,
    message: string,
  ) {
    super(message);
    this.name = "ChargeHeadMisconfiguredError";
  }
}

/** The unit carries a PLC tag the price list does not price. Silently charging
 *  zero would hand the buyer a free corner/park-facing premium. */
export class UnpricedPlcTagError extends Error {
  constructor(public readonly tag: string) {
    super(`PLC tag "${tag}" is not priced by this price list.`);
    this.name = "UnpricedPlcTagError";
  }
}

export class NoActivePriceListError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly asOf: Date,
  ) {
    super(`No ACTIVE price list for project ${projectId} as of ${asOf.toISOString()}.`);
    this.name = "NoActivePriceListError";
  }
}

export class PriceListItemNotFoundError extends Error {
  constructor(
    public readonly priceListId: string,
    public readonly unitId: string,
  ) {
    super(`Price list ${priceListId} prices neither unit ${unitId} nor its unit type.`);
    this.name = "PriceListItemNotFoundError";
  }
}

export class PriceListItemMalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceListItemMalformedError";
  }
}

// ── Pure core ──────────────────────────────────────────────────────────

/** The subset of ChargeHead the computation reads. A plain shape, not the ORM
 *  row, so the core stays callable from a test table. */
export interface ChargeHeadSpec {
  code: string;
  name: string;
  category: ChargeCategory;
  isTaxable: boolean;
  gstRatePct: Prisma.Decimal | null;
  countsTowardCommission: boolean;
  displayOrder: number;
}

export interface FixedChargeInput {
  chargeHeadCode: string;
  amount: Prisma.Decimal;
}

export interface CostSheetInput {
  saleableArea: Prisma.Decimal;
  carpetArea: Prisma.Decimal;
  baseRatePerSqft: Prisma.Decimal;
  /** From Unit.plcTags. */
  plcTags: readonly string[];
  /** Rupees per sqft keyed by PLC tag, from PriceListItem.plcCharges. */
  plcChargesByTag: Readonly<Record<string, Prisma.Decimal>>;
  /** Fixed charges: parking, club, IFMS, stamp duty, registration, ... */
  otherCharges: readonly FixedChargeInput[];
  /** Approved discount as a positive amount; it is subtracted here. */
  discount: Prisma.Decimal;
  /** The org's charge head catalogue. */
  chargeHeads: readonly ChargeHeadSpec[];
}

/** Shaped for a CostSheetLine row (packages/db schema) so the caller that
 *  freezes the sheet onto a booking can persist these directly. */
export interface CostSheetLineResult {
  chargeHeadCode: string;
  description: string;
  quantity: Prisma.Decimal | null;
  rate: Prisma.Decimal | null;
  amount: Prisma.Decimal;
  gstRatePct: Prisma.Decimal | null;
  gstAmount: Prisma.Decimal;
  countsTowardCommission: boolean;
  displayOrder: number;
}

export interface CostSheetResult {
  lines: CostSheetLineResult[];
  saleableArea: Prisma.Decimal;
  carpetArea: Prisma.Decimal;
  baseAmount: Prisma.Decimal;
  plcAmount: Prisma.Decimal;
  otherChargesAmount: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  gstAmount: Prisma.Decimal;
  stampDutyAmount: Prisma.Decimal;
  registrationAmount: Prisma.Decimal;
  agreementValue: Prisma.Decimal;
  commissionableValue: Prisma.Decimal;
}

/** The discount is not a ChargeHead -- it is a deduction. It still appears as a
 *  line because the customer signs a sheet that shows it. */
const DISCOUNT_LINE_CODE = "DISCOUNT";

/** Categories the computation derives itself. Accepting one as a fixed charge
 *  would double-count it. */
const COMPUTED_CATEGORIES: ReadonlySet<ChargeCategory> = new Set<ChargeCategory>([
  "BASE_PRICE",
  "PLC",
  "GST",
]);

/**
 * Computes a cost sheet from docs/06-INVENTORY-SPEC.md section 5:
 *
 *   baseAmount     = saleableArea x baseRatePerSqft
 *   plcAmount      = saleableArea x sum(plcCharges[tag] for tag in plcTags)
 *   otherCharges   = sum of fixed charges (parking, club, IFMS, ...)
 *   gross          = baseAmount + plcAmount + otherCharges - discount
 *   gst            = sum over taxable lines of (amount x gstRatePct)
 *   agreementValue = gross + gst + stampDuty + registration
 *
 * Stamp duty and registration are pulled out of the supplied fixed charges by
 * ChargeHead category and reported separately: they sit OUTSIDE gross in the
 * formula above, and Booking carries stampDutyAmount / registrationAmount as
 * their own columns. Folding them into otherChargesAmount would count them
 * twice in agreementValue.
 *
 * Every amount is rounded ROUND_HALF_UP to 2dp at the point of multiplication.
 * Sums of already-rounded components are exact, so they are not re-rounded.
 */
export function computeCostSheet(input: CostSheetInput): CostSheetResult {
  assertAreasAndRate(input);

  const headsByCode = new Map(input.chargeHeads.map((h) => [h.code, h]));
  const lines: CostSheetLineResult[] = [];

  // ── Base (BSP). Saleable area, never carpet (docs/19-GLOSSARY.md).
  const baseHead = requireHeadByCategory(input.chargeHeads, "BASE_PRICE");
  const baseAmount = round2(input.saleableArea.mul(input.baseRatePerSqft));
  lines.push(
    buildLine(baseHead, {
      description: baseHead.name,
      quantity: input.saleableArea,
      rate: input.baseRatePerSqft,
      amount: baseAmount,
    }),
  );

  // ── PLC: one line per tag rather than a single lumped line, so the sheet
  // shows the buyer what they are paying the corner premium for. The lines are
  // the customer-facing record, so plcAmount is the sum of the rounded lines --
  // the header always reconciles with what is printed under it, which the
  // lumped saleableArea x sum(rates) form would not guarantee to the paisa.
  let plcAmount = zero();
  if (input.plcTags.length > 0) {
    const plcHead = requireHeadByCategory(input.chargeHeads, "PLC");
    for (const tag of input.plcTags) {
      const rate = input.plcChargesByTag[tag];
      if (rate === undefined) throw new UnpricedPlcTagError(tag);
      const amount = round2(input.saleableArea.mul(rate));
      plcAmount = plcAmount.plus(amount);
      lines.push(
        buildLine(plcHead, {
          description: `${plcHead.name} - ${tag}`,
          quantity: input.saleableArea,
          rate,
          amount,
        }),
      );
    }
  }

  // ── Fixed charges.
  let otherChargesAmount = zero();
  let stampDutyAmount = zero();
  let registrationAmount = zero();
  for (const charge of input.otherCharges) {
    const head = headsByCode.get(charge.chargeHeadCode);
    if (!head) {
      throw new ChargeHeadNotConfiguredError(
        `Charge head "${charge.chargeHeadCode}" is not in the org's charge head catalogue.`,
      );
    }
    if (COMPUTED_CATEGORIES.has(head.category)) {
      throw new ChargeHeadMisconfiguredError(
        head.code,
        `Charge head "${head.code}" is category ${head.category}, which the cost sheet computes ` +
          `itself. Supplying it as a fixed charge would double-count it.`,
      );
    }
    const amount = round2(charge.amount);
    lines.push(buildLine(head, { description: head.name, quantity: null, rate: null, amount }));

    if (head.category === "STAMP_DUTY") {
      stampDutyAmount = stampDutyAmount.plus(amount);
    } else if (head.category === "REGISTRATION") {
      registrationAmount = registrationAmount.plus(amount);
    } else {
      otherChargesAmount = otherChargesAmount.plus(amount);
    }
  }

  // ── Discount.
  const discountAmount = round2(input.discount);
  if (discountAmount.isNegative()) {
    throw new CostSheetInputError(
      `Discount must be a positive amount to subtract, got ${discountAmount.toString()}.`,
    );
  }
  if (!discountAmount.isZero()) {
    // Carries no GST: the spec's formula computes GST per taxable line and the
    // discount is a deduction from gross, not a taxable line. That means GST
    // here is charged on the pre-discount amounts -- a deliberate reading of
    // docs/06-INVENTORY-SPEC.md section 5, flagged because it is a tax
    // treatment worth confirming with the client rather than assuming.
    //
    // Never commissionable either: whether commission is computed before or
    // after a discount is CommissionScheme.baseDefinition's decision
    // (netOfDiscount), not this function's.
    lines.push({
      chargeHeadCode: DISCOUNT_LINE_CODE,
      description: "Discount",
      quantity: null,
      rate: null,
      amount: discountAmount.negated(),
      gstRatePct: null,
      gstAmount: zero(),
      countsTowardCommission: false,
      displayOrder: maxDisplayOrder(lines) + 1,
    });
  }

  lines.sort((a, b) => a.displayOrder - b.displayOrder);

  const gstAmount = lines.reduce((sum, line) => sum.plus(line.gstAmount), zero());
  const gross = baseAmount.plus(plcAmount).plus(otherChargesAmount).minus(discountAmount);
  const agreementValue = gross.plus(gstAmount).plus(stampDutyAmount).plus(registrationAmount);

  // Sums line.amount and NEVER line.gstAmount: GST is never commissionable
  // (docs/19-GLOSSARY.md). Refundable heads like IFMS are excluded by their
  // countsTowardCommission flag being false, not by a hardcoded category list.
  const commissionableValue = lines
    .filter((line) => line.countsTowardCommission)
    .reduce((sum, line) => sum.plus(line.amount), zero());

  return {
    lines,
    saleableArea: input.saleableArea,
    carpetArea: input.carpetArea,
    baseAmount,
    plcAmount,
    otherChargesAmount,
    discountAmount,
    gstAmount,
    stampDutyAmount,
    registrationAmount,
    agreementValue,
    commissionableValue,
  };
}

// ── DB-backed wrapper ──────────────────────────────────────────────────

export interface BuildCostSheetParams {
  unitId: string;
  /** Pin an explicit version -- e.g. re-rendering the sheet a booking was sold
   *  on. Omitted, the list ACTIVE as of `asOf` is used. */
  priceListId?: string;
  /** Approved discount, positive. Defaults to zero. */
  discount?: Prisma.Decimal;
  asOf?: Date;
}

export interface BuiltCostSheet extends CostSheetResult {
  unitId: string;
  priceListId: string;
  priceListVersion: number;
}

/**
 * Gathers the inputs computeCostSheet needs for one unit and calls it. Read
 * only -- nothing here mutates, so there is no audit row. The caller that
 * freezes the result onto a booking writes the CostSheetLine rows and the audit
 * entry in its own transaction (docs/06-INVENTORY-SPEC.md section 5: both
 * agreementValue and commissionableValue are frozen at confirmation, because
 * regenerating from the price list later would not reproduce what the customer
 * signed).
 */
export async function buildCostSheetForUnit(
  db: PrismaClient | Prisma.TransactionClient,
  params: BuildCostSheetParams,
): Promise<BuiltCostSheet> {
  const asOf = params.asOf ?? new Date();

  const unit = await db.unit.findUniqueOrThrow({
    where: { id: params.unitId },
    select: {
      id: true,
      orgId: true,
      projectId: true,
      unitTypeId: true,
      plcTags: true,
      carpetAreaOverride: true,
      saleableAreaOverride: true,
      unitType: { select: { carpetArea: true, saleableArea: true } },
    },
  });

  // An explicitly pinned list is loaded whatever its status: re-rendering the
  // sheet a booking was sold on must still work once that version is ARCHIVED.
  const priceList: ActivePriceList | null = params.priceListId
    ? await db.priceList.findUnique({
        where: { id: params.priceListId },
        include: { items: true },
      })
    : await getActivePriceList(db, { projectId: unit.projectId, asOf });
  if (!priceList) {
    if (params.priceListId) throw new PriceListNotFoundError(params.priceListId);
    throw new NoActivePriceListError(unit.projectId, asOf);
  }

  // A per-unit row overrides the unit-type rate (schema comment on
  // PriceListItem: "Either a unit-type-wide rate or a per-unit override").
  const item =
    priceList.items.find((i) => i.unitId === unit.id) ??
    priceList.items.find((i) => i.unitTypeId === unit.unitTypeId);
  if (!item) {
    throw new PriceListItemNotFoundError(priceList.id, unit.id);
  }

  const chargeHeads = await db.chargeHead.findMany({
    where: { orgId: unit.orgId },
    select: {
      code: true,
      name: true,
      category: true,
      isTaxable: true,
      gstRatePct: true,
      countsTowardCommission: true,
      displayOrder: true,
    },
  });

  const result = computeCostSheet({
    saleableArea: unit.saleableAreaOverride ?? unit.unitType.saleableArea,
    carpetArea: unit.carpetAreaOverride ?? unit.unitType.carpetArea,
    baseRatePerSqft: item.baseRatePerSqft,
    plcTags: unit.plcTags,
    plcChargesByTag: parseRates(item.plcCharges),
    otherCharges: parseCharges(item.otherCharges),
    discount: params.discount ?? zero(),
    chargeHeads,
  });

  return {
    ...result,
    unitId: unit.id,
    priceListId: priceList.id,
    priceListVersion: priceList.version,
  };
}

// ── Internals ──────────────────────────────────────────────────────────

/** The one rounding rule, matching packages/commission's round2: half up at 2dp.
 *  Nothing in this file rounds any other way; the residual belongs to the
 *  company, never to a buyer or an associate. */
function round2(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function zero(): Prisma.Decimal {
  return new Prisma.Decimal(0);
}

function assertAreasAndRate(input: CostSheetInput): void {
  if (input.saleableArea.lessThanOrEqualTo(0)) {
    throw new CostSheetInputError(
      `Saleable area must be positive, got ${input.saleableArea.toString()}.`,
    );
  }
  if (input.carpetArea.lessThanOrEqualTo(0)) {
    throw new CostSheetInputError(
      `Carpet area must be positive, got ${input.carpetArea.toString()}.`,
    );
  }
  // Carpet is always smaller than saleable -- saleable is built-up plus a share
  // of common areas (docs/19-GLOSSARY.md). If it is not, the two have been
  // swapped somewhere upstream, which misprices the unit by roughly 35%. Fail
  // loudly rather than quote it.
  if (input.carpetArea.greaterThan(input.saleableArea)) {
    throw new CostSheetInputError(
      `Carpet area ${input.carpetArea.toString()} exceeds saleable area ` +
        `${input.saleableArea.toString()}; the two areas look swapped.`,
    );
  }
  if (input.baseRatePerSqft.isNegative()) {
    throw new CostSheetInputError(
      `Base rate per sqft cannot be negative, got ${input.baseRatePerSqft.toString()}.`,
    );
  }
}

function requireHeadByCategory(
  heads: readonly ChargeHeadSpec[],
  category: ChargeCategory,
): ChargeHeadSpec {
  const matches = heads.filter((h) => h.category === category);
  const head = matches[0];
  if (!head) {
    throw new ChargeHeadNotConfiguredError(
      `No charge head of category ${category} is configured for this org.`,
    );
  }
  if (matches.length > 1) {
    throw new ChargeHeadMisconfiguredError(
      head.code,
      `${matches.length} charge heads share category ${category}; the line's head is ambiguous.`,
    );
  }
  return head;
}

function buildLine(
  head: ChargeHeadSpec,
  parts: {
    description: string;
    quantity: Prisma.Decimal | null;
    rate: Prisma.Decimal | null;
    amount: Prisma.Decimal;
  },
): CostSheetLineResult {
  if (head.isTaxable && head.gstRatePct === null) {
    throw new ChargeHeadMisconfiguredError(
      head.code,
      `Charge head "${head.code}" is taxable but has no gstRatePct; it would silently charge no GST.`,
    );
  }
  const gstRatePct = head.isTaxable ? head.gstRatePct : null;
  const gstAmount =
    gstRatePct === null ? zero() : round2(parts.amount.mul(gstRatePct).div(100));

  return {
    chargeHeadCode: head.code,
    description: parts.description,
    quantity: parts.quantity,
    rate: parts.rate,
    amount: parts.amount,
    gstRatePct,
    gstAmount,
    countsTowardCommission: head.countsTowardCommission,
    displayOrder: head.displayOrder,
  };
}

function maxDisplayOrder(lines: readonly CostSheetLineResult[]): number {
  return lines.reduce((max, line) => Math.max(max, line.displayOrder), 0);
}

// PriceListItem.plcCharges / otherCharges are Json columns. price-lists.ts
// writes the amounts as strings so nothing passes through a float, but the
// schema's own example shape uses JSON numbers -- both are accepted here, and
// numbers go through their string form so the Decimal is the exact value the
// JSON text meant.

function parseRates(value: Prisma.JsonValue | null): Record<string, Prisma.Decimal> {
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new PriceListItemMalformedError(
      "PriceListItem.plcCharges must be an object keyed by PLC tag.",
    );
  }
  const out: Record<string, Prisma.Decimal> = {};
  for (const [tag, raw] of Object.entries(value)) {
    out[tag] = toDecimal(raw, `plcCharges.${tag}`);
  }
  return out;
}

function parseCharges(value: Prisma.JsonValue | null): FixedChargeInput[] {
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new PriceListItemMalformedError(
      "PriceListItem.otherCharges must be an array of { chargeHeadCode, amount }.",
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new PriceListItemMalformedError(`otherCharges[${index}] is not an object.`);
    }
    const record = entry as Record<string, unknown>;
    const chargeHeadCode = record["chargeHeadCode"];
    if (typeof chargeHeadCode !== "string" || chargeHeadCode.length === 0) {
      throw new PriceListItemMalformedError(
        `otherCharges[${index}].chargeHeadCode is missing or not a string.`,
      );
    }
    return {
      chargeHeadCode,
      amount: toDecimal(record["amount"], `otherCharges[${index}].amount`),
    };
  });
}

function toDecimal(raw: unknown, path: string): Prisma.Decimal {
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new PriceListItemMalformedError(`${path} must be a number or a numeric string.`);
  }
  try {
    return new Prisma.Decimal(String(raw));
  } catch {
    throw new PriceListItemMalformedError(`${path} is not a valid decimal: ${String(raw)}.`);
  }
}
