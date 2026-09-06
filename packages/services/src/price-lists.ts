// Versioned price lists -- docs/06-INVENTORY-SPEC.md section 5. A list is never
// edited once it is live: a change publishes a NEW version and archives the old
// one, so "why was this unit cheaper in January" is answered by a row rather
// than by memory.
//
// Two rules here carry real money risk, so they live in the service and not in
// a handler (docs/07-API.md: no business logic in route handlers or actions):
//
//   1. Maker-checker -- the preparer may not approve their own list
//      (docs/09-RBAC-MATRIX.md, separation of duties: "Publish a price list /
//      may not be performed by the requester"). One person repricing an entire
//      project unilaterally is exactly what this stops. It is a hard assertion,
//      not a UI convention. Both identities come from the audit context and
//      never from a parameter: a caller-supplied approver id would let the
//      preparer publish their own list by naming a colleague, and the row
//      would then assert an approval that never happened.
//   2. Exactly one ACTIVE list per project. Publishing archives the incumbent
//      inside the SAME transaction, so no reader can ever observe two -- and
//      holds.ts refuses to hold a unit when there is no active list at all.
import { Prisma } from "@desire/db";
import type { PriceList, PriceListItem, PrismaClient, PublishStatus } from "@desire/db";
import { writeAuditLog, type AuditContext } from "./audit";
import { assertPermission, ForbiddenError } from "./rbac";

// ── Errors ─────────────────────────────────────────────────────────────

export class PriceListNotFoundError extends Error {
  constructor(priceListId: string) {
    super(`Price list ${priceListId} not found.`);
    this.name = "PriceListNotFoundError";
  }
}

export class PriceListProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} not found.`);
    this.name = "PriceListProjectNotFoundError";
  }
}

/** The separation-of-duties rejection. Carries both ids so the API can say who
 *  prepared it rather than a bare 403 (docs/09-RBAC-MATRIX.md). */
export class MakerCheckerViolationError extends Error {
  constructor(
    public readonly priceListId: string,
    public readonly preparedById: string,
  ) {
    super(
      `Price list ${priceListId} was prepared by ${preparedById}; the same user cannot approve it. ` +
        `A second person must publish it.`,
    );
    this.name = "MakerCheckerViolationError";
  }
}

export class PriceListNotPublishableError extends Error {
  constructor(
    public readonly priceListId: string,
    public readonly status: PublishStatus,
  ) {
    super(`Price list ${priceListId} cannot be published from status ${status}.`);
    this.name = "PriceListNotPublishableError";
  }
}

/** Publishing a list with no items would satisfy the "an ACTIVE price list
 *  exists" hold guard in holds.ts while leaving every unit unpriceable. */
export class EmptyPriceListError extends Error {
  constructor(public readonly priceListId: string) {
    super(`Price list ${priceListId} has no items; there is nothing to publish.`);
    this.name = "EmptyPriceListError";
  }
}

export class PriceListNotEditableError extends Error {
  constructor(
    public readonly priceListId: string,
    public readonly status: PublishStatus,
  ) {
    super(
      `Price list ${priceListId} is ${status}, not DRAFT. Published price lists are immutable ` +
        `(docs/06-INVENTORY-SPEC.md section 5) -- create a new version instead.`,
    );
    this.name = "PriceListNotEditableError";
  }
}

export class PriceListItemTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceListItemTargetError";
  }
}

export class DuplicatePriceListItemError extends Error {
  constructor(public readonly target: string) {
    super(`More than one price list item targets ${target}; the rate would be ambiguous.`);
    this.name = "DuplicatePriceListItemError";
  }
}

/** Backstop for the @@unique([projectId, version]) index. Only reachable if the
 *  project row lock in createDraftPriceList was somehow bypassed. */
export class PriceListVersionConflictError extends Error {
  constructor(public readonly projectId: string) {
    super(`Another price list version was created for project ${projectId} concurrently. Retry.`);
    this.name = "PriceListVersionConflictError";
  }
}

// ── Shared helpers ─────────────────────────────────────────────────────

/** A price list is only ever prepared or approved by a person, and both roles
 *  are checked against the actor rather than an argument. AuditContext.actorId
 *  is nullable for job actors, and a job has neither roles to check nor a
 *  signature to put on an approval. */
function requireActor(audit: AuditContext): string {
  if (!audit.actorId) {
    throw new ForbiddenError("Price list mutations require a user actor, not a system actor.");
  }
  return audit.actorId;
}

/** Every mutation in this file serialises on the PROJECT row, not on a price
 *  list row: version allocation inserts a row that does not exist yet (nothing
 *  to lock), and publishing has to exclude a concurrent draft edit of the list
 *  it is about to freeze. Locking a different resource in either would leave
 *  the two free to interleave. */
async function lockProject(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "projects" WHERE "id" = ${projectId} FOR UPDATE
  `;
  if (!locked[0]) throw new PriceListProjectNotFoundError(projectId);
}

// ── Input shapes ───────────────────────────────────────────────────────

export interface PriceListItemInput {
  /** Rate for a whole unit type. Mutually exclusive with unitId. */
  unitTypeId?: string;
  /** Per-unit override, which wins over the unit-type rate at read time. */
  unitId?: string;
  baseRatePerSqft: Prisma.Decimal;
  /** Rupees per sqft keyed by PLC tag, e.g. { CORNER: 150 }. Keys must match
   *  the tags on Unit.plcTags. */
  plcCharges?: Readonly<Record<string, Prisma.Decimal>>;
  /** Fixed charges: parking, club, IFMS, stamp duty, registration, ... */
  otherCharges?: readonly { chargeHeadCode: string; amount: Prisma.Decimal }[];
}

export type ActivePriceList = PriceList & { items: PriceListItem[] };

// ── Create a draft ─────────────────────────────────────────────────────

/** No orgId and no preparedById: both are read off the audit context, so a
 *  caller cannot write into one org while being audited under another, nor put
 *  someone else's name on the prepared-by side of the maker-checker pair. */
export interface CreateDraftPriceListParams {
  projectId: string;
  name: string;
  validFrom: Date;
  items: readonly PriceListItemInput[];
  audit: AuditContext;
}

/**
 * Creates the next DRAFT version for a project.
 *
 * The version number is allocated inside the transaction under a lock on the
 * PROJECT row, not on the price_lists rows. Two concurrent drafts would
 * otherwise both read max(version) = N and both insert N+1, and a row lock on
 * existing price lists cannot prevent an insert of a row that does not exist
 * yet -- there is no gap to lock. Locking the parent serialises read-then-insert.
 * The @@unique([projectId, version]) index is the structural backstop, and a
 * P2002 from it is converted to a named retryable error rather than a 500.
 */
export async function createDraftPriceList(
  db: PrismaClient,
  params: CreateDraftPriceListParams,
): Promise<{ priceListId: string; version: number }> {
  const preparedById = requireActor(params.audit);
  assertItemsValid(params.items);

  try {
    return await db.$transaction(
      async (tx) => {
        await lockProject(tx, params.projectId);

        // Tenancy before any of the work: the row is written under
        // params.audit.orgId, so the project it hangs off has to be that org's
        // project. Reading the org off the caller instead would let a list be
        // created in org A while the audit trail records it under org B.
        const project = await tx.project.findUniqueOrThrow({
          where: { id: params.projectId },
          select: { orgId: true },
        });
        if (project.orgId !== params.audit.orgId) {
          throw new ForbiddenError(`Project ${params.projectId} belongs to another organisation.`);
        }

        // Scoped to the project: a Project Manager holding pricelist.prepare
        // for one project must not be able to reprice another
        // (rbac.ts PermissionCheckOptions, docs/09-RBAC-MATRIX.md).
        await assertPermission(tx, preparedById, "pricelist.prepare", {
          projectId: params.projectId,
        });

        const latest = await tx.priceList.findFirst({
          where: { projectId: params.projectId },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        const version = (latest?.version ?? 0) + 1;

        const created = await tx.priceList.create({
          data: {
            orgId: params.audit.orgId,
            projectId: params.projectId,
            version,
            name: params.name,
            status: "DRAFT",
            validFrom: params.validFrom,
            preparedById,
            items: { create: params.items.map(toItemCreateData) },
          },
          select: { id: true, version: true },
        });

        await writeAuditLog(tx, params.audit, {
          action: "CREATE",
          entity: "PriceList",
          entityId: created.id,
          after: {
            projectId: params.projectId,
            version,
            name: params.name,
            status: "DRAFT",
            validFrom: params.validFrom,
            preparedById,
            itemCount: params.items.length,
          },
        });

        return { priceListId: created.id, version: created.version };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new PriceListVersionConflictError(params.projectId);
    }
    throw err;
  }
}

// ── Edit a draft ───────────────────────────────────────────────────────

/** The immutability guard. Exported so any future price-list mutation has one
 *  place to call rather than re-deriving the rule. */
export function assertPriceListEditable(list: { id: string; status: PublishStatus }): void {
  if (list.status !== "DRAFT") {
    throw new PriceListNotEditableError(list.id, list.status);
  }
}

/**
 * Replaces a DRAFT's items wholesale. Throws on anything that is not DRAFT:
 * once a list is PENDING_APPROVAL the approver is looking at fixed numbers, and
 * once it is ACTIVE a booking may already have been priced from it
 * (docs/06-INVENTORY-SPEC.md section 5 -- price lists are immutable, a change
 * is a new version).
 */
export async function replacePriceListItems(
  db: PrismaClient,
  params: { priceListId: string; items: readonly PriceListItemInput[]; audit: AuditContext },
): Promise<void> {
  const actorId = requireActor(params.audit);
  assertItemsValid(params.items);

  await db.$transaction(async (tx) => {
    // Read the owning project, lock it, then re-read the list under that lock
    // -- the same sequence publishPriceList uses, on the same row. Checking the
    // status without the lock would let a publish commit in between: the list
    // goes ACTIVE on the items the approver saw, and the delete/insert below
    // then swaps them out underneath it.
    const target = await tx.priceList.findUnique({
      where: { id: params.priceListId },
      select: { orgId: true, projectId: true },
    });
    if (!target) throw new PriceListNotFoundError(params.priceListId);
    if (target.orgId !== params.audit.orgId) {
      throw new ForbiddenError(
        `Price list ${params.priceListId} belongs to another organisation.`,
      );
    }

    await lockProject(tx, target.projectId);

    await assertPermission(tx, actorId, "pricelist.prepare", { projectId: target.projectId });

    const list = await tx.priceList.findUniqueOrThrow({
      where: { id: params.priceListId },
      select: { id: true, status: true, _count: { select: { items: true } } },
    });
    assertPriceListEditable(list);

    await tx.priceListItem.deleteMany({ where: { priceListId: list.id } });
    await tx.priceListItem.createMany({
      data: params.items.map((item) => ({ priceListId: list.id, ...toItemCreateData(item) })),
    });

    await writeAuditLog(tx, params.audit, {
      action: "UPDATE",
      entity: "PriceList",
      entityId: list.id,
      before: { itemCount: list._count.items },
      after: { itemCount: params.items.length },
      reason: "draft price list items replaced",
    });
  });
}

// ── Publish (maker-checker) ────────────────────────────────────────────

/** No approvedById: the approver IS the actor. Taking it as a parameter is what
 *  makes the maker-checker rule below bypassable -- see the file header. */
export interface PublishPriceListParams {
  priceListId: string;
  audit: AuditContext;
  now?: Date;
}

export interface PublishedPriceList {
  priceListId: string;
  version: number;
  publishedAt: Date;
  archivedPriceListIds: string[];
}

/**
 * Publishes a DRAFT (or PENDING_APPROVAL) list: archives whatever is currently
 * ACTIVE for the project, sets its validTo, and flips this list to ACTIVE --
 * all in one transaction, so a project never has two ACTIVE lists at once.
 *
 * The outgoing list's validTo is the moment it was superseded (the publish
 * instant), clamped so it can never land before its own validFrom.
 *
 * Caveat worth knowing: publishing a list whose validFrom is in the FUTURE
 * archives the incumbent immediately, which leaves the project with no list
 * matching getActivePriceList until that date -- and holds.ts refuses to hold a
 * unit in that window. Publish when the list is meant to take effect; a
 * scheduled cut-over would need a job, which docs/06-INVENTORY-SPEC.md does not
 * currently specify.
 */
export async function publishPriceList(
  db: PrismaClient,
  params: PublishPriceListParams,
): Promise<PublishedPriceList> {
  const approvedById = requireActor(params.audit);
  const now = params.now ?? new Date();

  return db.$transaction(
    async (tx) => {
      // Read just enough to know which project to lock, then lock, then read
      // the list again under that lock. Two concurrent publishes on the same
      // project would otherwise both see the same incumbent and both go ACTIVE.
      const target = await tx.priceList.findUnique({
        where: { id: params.priceListId },
        select: { orgId: true, projectId: true },
      });
      if (!target) throw new PriceListNotFoundError(params.priceListId);

      // Tenancy first, before the lock and before any write. Publishing
      // archives the project's incumbent list, so a foreign price-list id
      // reaching this far would reprice another tenant's project -- and leave
      // it with no ACTIVE list, which holds.ts treats as "no unit may be held".
      if (target.orgId !== params.audit.orgId) {
        throw new ForbiddenError(
          `Price list ${params.priceListId} belongs to another organisation.`,
        );
      }

      await lockProject(tx, target.projectId);

      const list = await tx.priceList.findUniqueOrThrow({
        where: { id: params.priceListId },
        select: {
          id: true,
          projectId: true,
          version: true,
          status: true,
          preparedById: true,
          _count: { select: { items: true } },
        },
      });

      // Authorization first: an actor who is not allowed to approve this list
      // should be told that, not told it is in the wrong state. "May you
      // approve price lists for this project at all" (the matrix grants
      // pricelist.approve to SUPER_ADMIN and SALES_HEAD), then "may you
      // approve THIS one" (the separation-of-duties rule).
      await assertPermission(tx, approvedById, "pricelist.approve", {
        projectId: list.projectId,
      });
      if (list.preparedById === approvedById) {
        throw new MakerCheckerViolationError(list.id, list.preparedById);
      }
      if (list.status !== "DRAFT" && list.status !== "PENDING_APPROVAL") {
        throw new PriceListNotPublishableError(list.id, list.status);
      }
      if (list._count.items === 0) {
        throw new EmptyPriceListError(list.id);
      }

      const incumbents = await tx.priceList.findMany({
        where: { projectId: list.projectId, status: "ACTIVE" },
        select: { id: true, version: true, validFrom: true, validTo: true },
      });

      const archivedPriceListIds: string[] = [];
      for (const incumbent of incumbents) {
        const validTo = laterOf(now, incumbent.validFrom);
        await tx.priceList.update({
          where: { id: incumbent.id },
          data: { status: "ARCHIVED", validTo },
        });
        await writeAuditLog(tx, params.audit, {
          action: "UPDATE",
          entity: "PriceList",
          entityId: incumbent.id,
          before: { status: "ACTIVE", validTo: incumbent.validTo },
          after: { status: "ARCHIVED", validTo },
          reason: `superseded by price list version ${list.version}`,
        });
        archivedPriceListIds.push(incumbent.id);
      }

      await tx.priceList.update({
        where: { id: list.id },
        data: { status: "ACTIVE", approvedById, publishedAt: now },
      });
      await writeAuditLog(tx, params.audit, {
        action: "APPROVE",
        entity: "PriceList",
        entityId: list.id,
        before: { status: list.status, approvedById: null, publishedAt: null },
        after: { status: "ACTIVE", approvedById, publishedAt: now },
        reason: `published version ${list.version}`,
      });

      return {
        priceListId: list.id,
        version: list.version,
        publishedAt: now,
        archivedPriceListIds,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}

// ── Read ───────────────────────────────────────────────────────────────

/** The list a booking made on `asOf` must be priced from. Ordered by version
 *  descending so that even if the one-ACTIVE-list invariant were ever violated
 *  the newest version wins deterministically rather than by insertion order. */
export async function getActivePriceList(
  db: PrismaClient | Prisma.TransactionClient,
  params: { projectId: string; asOf?: Date },
): Promise<ActivePriceList | null> {
  const asOf = params.asOf ?? new Date();
  return db.priceList.findFirst({
    where: {
      projectId: params.projectId,
      status: "ACTIVE",
      validFrom: { lte: asOf },
      OR: [{ validTo: null }, { validTo: { gt: asOf } }],
    },
    include: { items: true },
    orderBy: { version: "desc" },
  });
}

// ── Internals ──────────────────────────────────────────────────────────

function laterOf(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

function assertItemsValid(items: readonly PriceListItemInput[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    const hasType = item.unitTypeId !== undefined;
    const hasUnit = item.unitId !== undefined;
    // The schema comment on PriceListItem says exactly one is set. Neither set
    // means a rate nothing can resolve to; both set means the row claims to be
    // a type rate and a unit override at the same time.
    if (hasType === hasUnit) {
      throw new PriceListItemTargetError(
        "A price list item must set exactly one of unitTypeId or unitId.",
      );
    }
    const target = hasUnit ? `unit ${item.unitId}` : `unit type ${item.unitTypeId}`;
    if (seen.has(target)) throw new DuplicatePriceListItemError(target);
    seen.add(target);
  }
}

function toItemCreateData(item: PriceListItemInput) {
  return {
    unitTypeId: item.unitTypeId,
    unitId: item.unitId,
    baseRatePerSqft: item.baseRatePerSqft,
    plcCharges: serializeRates(item.plcCharges),
    otherCharges: serializeCharges(item.otherCharges),
  };
}

// Money and rates go into the Json columns as STRINGS, not numbers. The schema
// comments show the shape with JSON numbers ({ "CORNER": 150 }) but a JSON
// number is an IEEE double, and this codebase does not put money through a
// float (house rule; docs/07-API.md says the same for the wire format:
// "Strings in JSON, never floats"). The readers in cost-sheet.ts accept both
// forms so data written from the schema's example shape still parses.

function serializeRates(
  rates: Readonly<Record<string, Prisma.Decimal>> | undefined,
): Prisma.InputJsonValue | undefined {
  if (!rates) return undefined;
  const out: Record<string, string> = {};
  for (const [tag, rate] of Object.entries(rates)) {
    out[tag] = rate.toString();
  }
  return out;
}

function serializeCharges(
  charges: readonly { chargeHeadCode: string; amount: Prisma.Decimal }[] | undefined,
): Prisma.InputJsonValue | undefined {
  if (!charges) return undefined;
  return charges.map((c) => ({ chargeHeadCode: c.chargeHeadCode, amount: c.amount.toString() }));
}
