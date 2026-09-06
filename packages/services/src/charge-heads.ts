// Charge-head master data -- the components a cost sheet is built from
// (docs/06-INVENTORY-SPEC.md section 5, docs/03-DATA-MODEL.md). Small table,
// outsized consequences: `countsTowardCommission` on these rows is what
// defines the commissionable value every associate is paid on, and
// `gstRatePct` is what the tax lines are computed from.
//
// Note on scope: docs/09-RBAC-MATRIX.md has no chargehead.* permission code.
// Charge heads are org-level configuration loaded alongside projects
// (docs/14-DATA-MIGRATION.md step 5), so ordinary CRUD is gated on
// `project.write`. The one exception is setCommissionableFlag, which edits the
// commission base and is therefore gated on `scheme.prepare` -- see the
// comment on that function.
import { Prisma } from "@desire/db";
import type { PrismaClient, ChargeCategory, ChargeHead } from "@desire/db";
import { writeAuditLog, type AuditContext } from "./audit";
import { assertPermission, ForbiddenError } from "./rbac";

const CRUD_PERMISSION = "project.write";
const COMMISSION_FLAG_PERMISSION = "scheme.prepare";

/** The categories a cost sheet resolves by CATEGORY rather than by code, so at
 *  most one head of each may exist per org. Every other category may repeat --
 *  an org can carry a covered and an open PARKING head. */
const SINGLETON_CATEGORIES: readonly ChargeCategory[] = ["BASE_PRICE", "PLC"];

// ── Errors ─────────────────────────────────────────────────────────────

export class ChargeHeadNotFoundError extends Error {
  constructor(chargeHeadId: string) {
    super(`Charge head ${chargeHeadId} not found.`);
    this.name = "ChargeHeadNotFoundError";
  }
}

export class DuplicateChargeHeadCodeError extends Error {
  constructor(public readonly code: string) {
    super(`Charge head code "${code}" is already in use in this organisation.`);
    this.name = "DuplicateChargeHeadCodeError";
  }
}

/** The second BASE_PRICE (or PLC) head in an org breaks pricing org-wide, not
 *  just for whoever created it: computeCostSheet picks those two lines by
 *  category over every head in the org (cost-sheet.ts requireHeadByCategory),
 *  and a second match makes the lookup ambiguous, so every subsequent cost
 *  sheet for that org throws ChargeHeadMisconfiguredError. Carries the code of
 *  the head already holding the category, which is what the operator has to go
 *  and edit. */
export class DuplicateChargeCategoryError extends Error {
  constructor(
    public readonly category: ChargeCategory,
    public readonly existingCode: string,
  ) {
    super(
      `Charge head "${existingCode}" already holds category ${category} in this ` +
        `organisation; only one is allowed.`,
    );
    this.name = "DuplicateChargeCategoryError";
  }
}

/** A taxable head with no rate contributes zero GST silently, and a
 *  non-taxable head carrying a rate is a contradiction a reader of the cost
 *  sheet cannot resolve (docs/06-INVENTORY-SPEC.md section 5:
 *  `gst = Σ(line × line.gstRatePct) for taxable lines`). */
export class InvalidGstRateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGstRateError";
  }
}

export class ChargeHeadReasonRequiredError extends Error {
  constructor(operation: string) {
    super(`${operation} requires a reason.`);
    this.name = "ChargeHeadReasonRequiredError";
  }
}

// ── Shared helpers ─────────────────────────────────────────────────────

/** Master data is only ever changed by a person; AuditContext.actorId is
 *  nullable for job actors, and a job has no roles to check against. */
function requireActor(audit: AuditContext): string {
  if (!audit.actorId) {
    throw new ForbiddenError("Charge-head mutations require a user actor, not a system actor.");
  }
  return audit.actorId;
}

/** Rates arrive as a Decimal or a fixed-point string, never a number -- the
 *  column is Decimal(5,2) and a binary float cannot hold 12.35 exactly.
 *  Rounded half-up to the 2dp actually stored, so the validation below sees
 *  the same value Postgres will. */
function toRate(value: Prisma.Decimal | string): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function assertGstConsistent(isTaxable: boolean, gstRatePct: Prisma.Decimal | null): void {
  if (isTaxable) {
    if (gstRatePct === null) {
      throw new InvalidGstRateError("A taxable charge head must carry a GST rate.");
    }
    if (gstRatePct.lt(0) || gstRatePct.gt(100)) {
      throw new InvalidGstRateError(`GST rate ${gstRatePct.toFixed(2)}% is outside 0-100.`);
    }
    return;
  }
  if (gstRatePct !== null) {
    throw new InvalidGstRateError("A non-taxable charge head must not carry a GST rate.");
  }
}

/** Decimals do not survive a JSON column as themselves; a fixed-point string
 *  matches what the API emits (docs/07-API.md). */
function toAuditValue(value: unknown): unknown {
  if (value instanceof Prisma.Decimal) return value.toString();
  return value ?? null;
}

function auditSnapshot(data: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) out[key] = toAuditValue(value);
  return out;
}

function auditDiff(
  existing: object,
  patch: object,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const current = existing as Record<string, unknown>;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [key, next] of Object.entries(patch)) {
    before[key] = toAuditValue(current[key]);
    after[key] = toAuditValue(next);
  }
  return { before, after };
}

async function loadChargeHeadInOrg(
  tx: Prisma.TransactionClient,
  chargeHeadId: string,
  orgId: string,
): Promise<ChargeHead> {
  const head = await tx.chargeHead.findUnique({ where: { id: chargeHeadId } });
  if (!head) throw new ChargeHeadNotFoundError(chargeHeadId);
  if (head.orgId !== orgId) {
    throw new ForbiddenError(`Charge head ${chargeHeadId} belongs to another organisation.`);
  }
  return head;
}

/** Guards the singleton categories. schema.prisma carries only
 *  @@unique([orgId, code]) on ChargeHead (line 960) -- nothing constrains
 *  category -- so the rule has to be enforced here, in the same transaction as
 *  the write it protects.
 *
 *  The org row is locked first for the reason price-lists.ts locks the parent
 *  project before allocating a version: this is check-then-insert on a row that
 *  does not exist yet, so there is nothing in charge_heads to lock and two
 *  concurrent creates would otherwise both read "no clash" and both commit.
 *  Only the singleton categories pay for that lock. */
async function assertSingletonCategoryFree(
  tx: Prisma.TransactionClient,
  orgId: string,
  category: ChargeCategory,
  excludeChargeHeadId?: string,
): Promise<void> {
  if (!SINGLETON_CATEGORIES.includes(category)) return;

  await tx.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${orgId} FOR UPDATE`;

  const clash = await tx.chargeHead.findFirst({
    where: {
      orgId,
      category,
      ...(excludeChargeHeadId === undefined ? {} : { id: { not: excludeChargeHeadId } }),
    },
    select: { code: true },
  });
  if (clash) throw new DuplicateChargeCategoryError(category, clash.code);
}

// ── Create ─────────────────────────────────────────────────────────────

export interface CreateChargeHeadParams {
  code: string;
  name: string;
  category: ChargeCategory;
  isTaxable?: boolean;
  gstRatePct?: Prisma.Decimal | string | null;
  countsTowardCommission?: boolean;
  isRefundable?: boolean;
  displayOrder?: number;
  audit: AuditContext;
}

export async function createChargeHead(
  db: PrismaClient,
  params: CreateChargeHeadParams,
): Promise<ChargeHead> {
  const actorId = requireActor(params.audit);

  // Schema defaults, restated here because the GST consistency check has to
  // run against the values that will actually be stored, not against the
  // caller's undefineds.
  const isTaxable = params.isTaxable ?? true;
  const gstRatePct =
    params.gstRatePct === null || params.gstRatePct === undefined ? null : toRate(params.gstRatePct);
  assertGstConsistent(isTaxable, gstRatePct);

  try {
    return await db.$transaction(async (tx) => {
      await assertPermission(tx, actorId, CRUD_PERMISSION);
      await assertSingletonCategoryFree(tx, params.audit.orgId, params.category);

      const data = {
        // orgId comes from the audit context, never the caller, so a row
        // cannot be written into one org while being audited under another.
        orgId: params.audit.orgId,
        code: params.code,
        name: params.name,
        category: params.category,
        isTaxable,
        gstRatePct,
        countsTowardCommission: params.countsTowardCommission ?? false,
        isRefundable: params.isRefundable ?? false,
        displayOrder: params.displayOrder ?? 0,
      } satisfies Prisma.ChargeHeadUncheckedCreateInput;

      const head = await tx.chargeHead.create({ data });
      await writeAuditLog(tx, params.audit, {
        action: "CREATE",
        entity: "ChargeHead",
        entityId: head.id,
        after: auditSnapshot(data),
      });
      return head;
    });
  } catch (err) {
    // P2002 on (orgId, code). A typed duplicate is a field-level validation
    // failure, not a 500 (docs/07-API.md error shape).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new DuplicateChargeHeadCodeError(params.code);
    }
    throw err;
  }
}

// ── Update ─────────────────────────────────────────────────────────────

/** `code` and `countsTowardCommission` are deliberately absent.
 *
 *  `code` is the stable identifier snapshotted onto every CostSheetLine as
 *  `chargeHeadCode`; renaming it would orphan the history of every booking
 *  already sold.
 *
 *  `countsTowardCommission` goes through setCommissionableFlag instead -- see
 *  the comment there. */
export interface UpdateChargeHeadParams {
  chargeHeadId: string;
  name?: string;
  category?: ChargeCategory;
  isTaxable?: boolean;
  gstRatePct?: Prisma.Decimal | string | null;
  isRefundable?: boolean;
  displayOrder?: number;
  reason?: string;
  audit: AuditContext;
}

export async function updateChargeHead(
  db: PrismaClient,
  params: UpdateChargeHeadParams,
): Promise<ChargeHead> {
  const actorId = requireActor(params.audit);

  return db.$transaction(async (tx) => {
    const existing = await loadChargeHeadInOrg(tx, params.chargeHeadId, params.audit.orgId);
    await assertPermission(tx, actorId, CRUD_PERMISSION);

    // isTaxable and gstRatePct are only meaningful as a pair, so both are
    // resolved against the stored row before either is checked. Turning
    // isTaxable off without also clearing the rate therefore fails, rather
    // than leaving a non-taxable head carrying a rate nothing will apply.
    const isTaxable = params.isTaxable ?? existing.isTaxable;
    const gstRatePct =
      params.gstRatePct === undefined
        ? existing.gstRatePct
        : params.gstRatePct === null
          ? null
          : toRate(params.gstRatePct);
    assertGstConsistent(isTaxable, gstRatePct);

    // Moving an existing head into BASE_PRICE or PLC breaks pricing exactly as
    // creating a second one does, so the same guard applies on the way in.
    // Re-sending the category a head already has is not a move and is left
    // alone -- it must not fail an org that is already carrying a duplicate
    // and is being edited back into shape.
    if (params.category !== undefined && params.category !== existing.category) {
      await assertSingletonCategoryFree(tx, params.audit.orgId, params.category, existing.id);
    }

    const data: Prisma.ChargeHeadUncheckedUpdateInput = {};
    if (params.name !== undefined) data.name = params.name;
    if (params.category !== undefined) data.category = params.category;
    if (params.isTaxable !== undefined) data.isTaxable = params.isTaxable;
    if (params.gstRatePct !== undefined) data.gstRatePct = gstRatePct;
    if (params.isRefundable !== undefined) data.isRefundable = params.isRefundable;
    if (params.displayOrder !== undefined) data.displayOrder = params.displayOrder;

    // Nothing to write. An audit row here would record "someone opened the
    // form", which is noise in a trail read to answer "who changed this field".
    if (Object.keys(data).length === 0) return existing;

    const head = await tx.chargeHead.update({ where: { id: existing.id }, data });
    const { before, after } = auditDiff(existing, data);
    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "ChargeHead",
      entityId: head.id,
      before,
      after,
      reason: params.reason,
    });
    return head;
  });
}

// ── The commissionable flag ────────────────────────────────────────────

export interface SetCommissionableFlagParams {
  chargeHeadId: string;
  countsTowardCommission: boolean;
  /** Mandatory. This is the field a disputing associate will ask about. */
  reason: string;
  audit: AuditContext;
}

/** Flipping countsTowardCommission changes what every associate is paid on
 *  from the next booking onward (docs/06-INVENTORY-SPEC.md section 5:
 *  `commissionableValue = Σ(lines where chargeHead.countsTowardCommission)`).
 *
 *  It is a separate function from updateChargeHead, rather than one more
 *  optional field on it, for three reasons:
 *
 *    1. The audit trail is unambiguous. A generic update writes one row
 *       containing whatever fields happened to be in the form; this writes a
 *       row whose before/after is exactly the flag, so "when did PARKING stop
 *       counting" is a single-predicate query on the audit log, not a scan
 *       through diffs.
 *    2. The reason is mandatory at the type level. A commission base that
 *       changed for no recorded reason is indefensible in a dispute
 *       (docs/04-COMMISSION-SPEC.md).
 *    3. It can carry a stricter permission than the rest of the row. Renaming
 *       a charge head is project administration; changing the commission base
 *       is a commission-scheme decision, so this is gated on scheme.prepare.
 *
 *  Bookings already confirmed are unaffected: CostSheetLine snapshots
 *  countsTowardCommission per line, and commissionableValue is frozen onto the
 *  booking at confirmation. */
export async function setCommissionableFlag(
  db: PrismaClient,
  params: SetCommissionableFlagParams,
): Promise<{ changed: boolean; chargeHead: ChargeHead }> {
  const actorId = requireActor(params.audit);
  if (!params.reason?.trim()) {
    throw new ChargeHeadReasonRequiredError("Changing the commissionable flag");
  }

  return db.$transaction(async (tx) => {
    const existing = await loadChargeHeadInOrg(tx, params.chargeHeadId, params.audit.orgId);
    await assertPermission(tx, actorId, COMMISSION_FLAG_PERMISSION);

    // Re-setting the flag to what it already is changes nothing, and an audit
    // row reading false -> false would dilute the very trail this function
    // exists to keep clean.
    if (existing.countsTowardCommission === params.countsTowardCommission) {
      return { changed: false, chargeHead: existing };
    }

    const chargeHead = await tx.chargeHead.update({
      where: { id: existing.id },
      data: { countsTowardCommission: params.countsTowardCommission },
    });
    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "ChargeHead",
      entityId: chargeHead.id,
      before: { code: existing.code, countsTowardCommission: existing.countsTowardCommission },
      after: { code: existing.code, countsTowardCommission: params.countsTowardCommission },
      reason: params.reason.trim(),
    });
    return { changed: true, chargeHead };
  });
}

// ── Delete ─────────────────────────────────────────────────────────────

export interface DeleteChargeHeadParams {
  chargeHeadId: string;
  reason: string;
  audit: AuditContext;
}

/** A hard delete, because ChargeHead has no soft-delete column in the migrated
 *  schema -- noted rather than worked around, since adding one is a schema
 *  change, not a service decision.
 *
 *  Sold bookings are safe: CostSheetLine stores `chargeHeadCode` as a string
 *  snapshot with its own gstRatePct and countsTowardCommission, so history
 *  does not read through to this row. Live pricing is NOT protected the same
 *  way -- PriceListItem.otherCharges references heads by code inside a JSON
 *  column, which no foreign key can guard. Callers must confirm no active
 *  price list still names the code. */
export async function deleteChargeHead(
  db: PrismaClient,
  params: DeleteChargeHeadParams,
): Promise<void> {
  const actorId = requireActor(params.audit);
  if (!params.reason?.trim()) {
    throw new ChargeHeadReasonRequiredError("Deleting a charge head");
  }

  await db.$transaction(async (tx) => {
    const existing = await loadChargeHeadInOrg(tx, params.chargeHeadId, params.audit.orgId);
    await assertPermission(tx, actorId, CRUD_PERMISSION);

    await tx.chargeHead.delete({ where: { id: existing.id } });
    await writeAuditLog(tx, params.audit, {
      action: "DELETE",
      entity: "ChargeHead",
      entityId: existing.id,
      // The row is gone, so the audit log is the only remaining record of what
      // it was -- snapshot all of it, not just the identifying fields.
      before: auditSnapshot(existing),
      reason: params.reason.trim(),
    });
  });
}
