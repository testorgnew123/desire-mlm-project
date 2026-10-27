// Holding and booking a plot, the two things an associate does with a free plot.
//
// BOOK is one action: hold it (unless they already hold it), record the customer,
// and draft the booking. An admin then confirms.
//
// The three steps each exist already (acquireHold, createCustomer,
// createDraftBooking) and each opens its own transaction, so they cannot be
// wrapped in one. What this adds is the ORDER and the UNDO: everything that can be
// checked without writing is checked first, and if the draft still fails after
// this call took the hold and made the customer, both are taken back, so a failed
// attempt does not leave a plot held for a day with nothing booked against it.
import type { PrismaClient } from "@desire/db";
import type { AuditContext } from "./audit";
import { createDraftBooking } from "./bookings";
import { createCustomer, parseCustomerInput, type CustomerInput } from "./customers";
import { UnitNotFoundError, acquireHold, isHoldLive, releaseHold } from "./holds";
import { assertPermission, ForbiddenError } from "./rbac";
import { unpricedTags } from "./unit-tags";

export class NoActivePriceListError extends Error {
  constructor(public readonly projectId: string) {
    super("This project has no active price list yet, so a plot cannot be booked.");
    this.name = "NoActivePriceListError";
  }
}

export class PlotNotPricedError extends Error {
  constructor(public readonly unitId: string) {
    super("The project's price list has no rate for this plot's type, so it cannot be booked yet.");
    this.name = "PlotNotPricedError";
  }
}

/** A plot marked corner (or another PLC tag) whose rate the price list does not
 *  have: quoting it would fail, and charging nothing would give the premium away.
 *  Caught here, before a hold or a customer exists, with something an associate
 *  can pass on. */
export class PlotTagNotPricedError extends Error {
  constructor(
    public readonly unitId: string,
    public readonly tags: readonly string[],
  ) {
    super(
      `This plot is marked ${tags.map((tag) => tag.toLowerCase().replaceAll("_", " ")).join(" and ")}, but the price list has no rate for that yet. Ask an admin to add it.`,
    );
    this.name = "PlotTagNotPricedError";
  }
}

export class PlotNotHeldError extends Error {
  constructor(public readonly unitId: string) {
    super("This plot is not held.");
    this.name = "PlotNotHeldError";
  }
}

/** An admin has not confirmed a draft yet; letting the associate drop the hold
 *  underneath it would leave a draft nobody can ever confirm. */
export class HoldHasDraftError extends Error {
  constructor(
    public readonly unitId: string,
    public readonly bookingNumber: string,
  ) {
    super(`Booking ${bookingNumber} is waiting for an admin to confirm it, so this hold cannot be released.`);
    this.name = "HoldHasDraftError";
  }
}

interface BookableUnit {
  id: string;
  orgId: string;
  projectId: string;
  unitTypeId: string;
  currentHoldId: string | null;
  plcTags: string[];
}

/** Everything that must be true of a plot before it is held or booked and can be
 *  checked without writing: it exists in this org, its project has an ACTIVE price
 *  list, and that list prices this plot's type. Shared by holdPlot and bookPlot so a
 *  plot an associate can hold is one they can then book. */
async function assertPlotBookable(
  db: PrismaClient,
  params: { unitId: string; orgId: string; now: Date },
): Promise<{ unit: BookableUnit; priceListId: string }> {
  const unit = await db.unit.findUnique({
    where: { id: params.unitId },
    select: { id: true, orgId: true, projectId: true, unitTypeId: true, currentHoldId: true, plcTags: true },
  });
  if (!unit) throw new UnitNotFoundError(params.unitId);
  if (unit.orgId !== params.orgId) throw new ForbiddenError(`Unit ${params.unitId} belongs to another organisation.`);

  const priceList = await db.priceList.findFirst({
    where: {
      projectId: unit.projectId,
      orgId: params.orgId,
      status: "ACTIVE",
      validFrom: { lte: params.now },
      OR: [{ validTo: null }, { validTo: { gt: params.now } }],
    },
    select: { id: true },
  });
  if (!priceList) throw new NoActivePriceListError(unit.projectId);

  const items = await db.priceListItem.findMany({
    where: { priceListId: priceList.id, OR: [{ unitId: unit.id }, { unitTypeId: unit.unitTypeId }] },
    select: { unitId: true, unitTypeId: true, plcCharges: true },
  });
  if (items.length === 0) throw new PlotNotPricedError(unit.id);
  const missing = unpricedTags(items, unit);
  if (missing.length > 0) throw new PlotTagNotPricedError(unit.id, missing);

  return { unit, priceListId: priceList.id };
}

/** The live hold on the unit, if it is this associate's. */
async function ownLiveHold(
  db: PrismaClient,
  currentHoldId: string | null,
  associateId: string,
  now: Date,
): Promise<{ id: string; associateId: string; expiresAt: Date; releasedAt: Date | null } | null> {
  if (!currentHoldId) return null;
  const hold = await db.unitHold.findUnique({
    where: { id: currentHoldId },
    select: { id: true, associateId: true, expiresAt: true, releasedAt: true },
  });
  return hold && hold.associateId === associateId && isHoldLive(hold, now) ? hold : null;
}

export interface BookPlotParams {
  unitId: string;
  customer: CustomerInput;
  audit: AuditContext;
  now?: Date;
}

export interface BookedPlot {
  bookingId: string;
  bookingNumber: string;
  customerId: string;
  /** True when this call took the hold; false when the associate already held the plot. */
  tookHold: boolean;
}

export async function bookPlot(db: PrismaClient, params: BookPlotParams): Promise<BookedPlot> {
  const actorId = params.audit.actorId;
  if (!actorId) throw new ForbiddenError("Booking a plot requires a user actor, not a system actor.");
  const orgId = params.audit.orgId;
  const now = params.now ?? new Date();

  // Checked before anything is written, so a typo never costs a plot.
  parseCustomerInput(params.customer);

  await assertPermission(db, actorId, "booking.create");

  const associate = await db.associate.findUnique({ where: { userId: actorId }, select: { id: true } });
  if (!associate) {
    throw new ForbiddenError("This account has no associate profile; only associates can book a plot.");
  }

  const { unit, priceListId } = await assertPlotBookable(db, { unitId: params.unitId, orgId, now });

  // Already held, live, by this associate? Then there is nothing to acquire.
  const alreadyMine = (await ownLiveHold(db, unit.currentHoldId, associate.id, now)) !== null;

  let newHoldId: string | null = null;
  if (!alreadyMine) {
    await assertPermission(db, actorId, "hold.create", { projectId: unit.projectId });
    newHoldId = (await acquireHold(db, { orgId, unitId: unit.id, associateId: associate.id, audit: params.audit, now })).holdId;
  }

  let customerId: string | null = null;
  try {
    const customer = await createCustomer(db, { ...params.customer, audit: params.audit });
    customerId = customer.id;
    const booking = await createDraftBooking(db, {
      unitId: unit.id,
      priceListId,
      customerId: customer.id,
      audit: params.audit,
      bookingDate: now,
    });
    return {
      bookingId: booking.id,
      bookingNumber: booking.bookingNumber,
      customerId: customer.id,
      tookHold: newHoldId !== null,
    };
  } catch (error) {
    // Undo exactly what this call did, best effort: the original error is the one
    // worth reporting, so a failure to clean up must not replace it.
    if (customerId) await db.customer.delete({ where: { id: customerId } }).catch(() => undefined);
    if (newHoldId) {
      await releaseHold(db, { holdId: newHoldId, reason: "RELEASED_BY_ASSOCIATE", audit: params.audit, now }).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

// ── Hold and release ───────────────────────────────────────────────────
//
// HOLD is the other thing an associate does with a free plot: reserve it for the
// project's hold window (a day unless the project says otherwise) without a
// customer yet, then book it from the hold. holdPlot checks exactly what bookPlot
// checks, so a plot that can be held can be booked.

async function currentAssociate(db: PrismaClient, userId: string, verb: string): Promise<{ id: string }> {
  const associate = await db.associate.findUnique({ where: { userId }, select: { id: true } });
  if (!associate) {
    throw new ForbiddenError(`This account has no associate profile; only associates can ${verb} a plot.`);
  }
  return associate;
}

export interface HoldPlotParams {
  unitId: string;
  audit: AuditContext;
  now?: Date;
}

export interface HeldPlot {
  holdId: string;
  unitId: string;
  expiresAt: Date;
  /** True when this call took the hold; false when the associate already held the plot. */
  tookHold: boolean;
}

export async function holdPlot(db: PrismaClient, params: HoldPlotParams): Promise<HeldPlot> {
  const actorId = params.audit.actorId;
  if (!actorId) throw new ForbiddenError("Holding a plot requires a user actor, not a system actor.");
  const orgId = params.audit.orgId;
  const now = params.now ?? new Date();

  const associate = await currentAssociate(db, actorId, "hold");
  const { unit } = await assertPlotBookable(db, { unitId: params.unitId, orgId, now });
  await assertPermission(db, actorId, "hold.create", { projectId: unit.projectId });

  // Tapping Hold twice, or on a plot already held by you, is not an error.
  const mine = await ownLiveHold(db, unit.currentHoldId, associate.id, now);
  if (mine) return { holdId: mine.id, unitId: unit.id, expiresAt: mine.expiresAt, tookHold: false };

  const acquired = await acquireHold(db, { orgId, unitId: unit.id, associateId: associate.id, audit: params.audit, now });
  return { holdId: acquired.holdId, unitId: acquired.unitId, expiresAt: acquired.expiresAt, tookHold: true };
}

export interface ReleasePlotHoldParams {
  unitId: string;
  audit: AuditContext;
  now?: Date;
}

/** Gives a plot back. Only the associate who holds it can, and not while a draft
 *  booking made from that hold is waiting for an admin: releasing it would strand
 *  the draft. (An admin's force-release is a separate, noted act: holds.ts.) */
export async function releasePlotHold(db: PrismaClient, params: ReleasePlotHoldParams): Promise<void> {
  const actorId = params.audit.actorId;
  if (!actorId) throw new ForbiddenError("Releasing a hold requires a user actor, not a system actor.");
  const now = params.now ?? new Date();

  const associate = await currentAssociate(db, actorId, "release a hold on");
  const unit = await db.unit.findUnique({
    where: { id: params.unitId },
    select: { id: true, orgId: true, projectId: true, currentHoldId: true },
  });
  if (!unit) throw new UnitNotFoundError(params.unitId);
  if (unit.orgId !== params.audit.orgId) {
    throw new ForbiddenError(`Unit ${params.unitId} belongs to another organisation.`);
  }
  await assertPermission(db, actorId, "hold.create", { projectId: unit.projectId });

  const hold = unit.currentHoldId
    ? await db.unitHold.findUnique({
        where: { id: unit.currentHoldId },
        select: { id: true, associateId: true, expiresAt: true, releasedAt: true },
      })
    : null;
  if (!hold || !isHoldLive(hold, now)) throw new PlotNotHeldError(unit.id);
  if (hold.associateId !== associate.id) {
    throw new ForbiddenError("This plot is held by someone else; only they can release it.");
  }

  const draft = await db.booking.findFirst({
    where: { unitId: unit.id, status: "DRAFT" },
    select: { bookingNumber: true },
  });
  if (draft) throw new HoldHasDraftError(unit.id, draft.bookingNumber);

  await releaseHold(db, { holdId: hold.id, reason: "RELEASED_BY_ASSOCIATE", audit: params.audit, now });
}

export interface MyHold {
  holdId: string;
  unitId: string;
  unitNumber: string;
  projectId: string;
  projectName: string;
  expiresAt: Date;
  /** The draft booking waiting for an admin on this plot, if the hold was booked. */
  draftBookingId: string | null;
  draftBookingNumber: string | null;
}

export interface HoldSummary {
  /** How many live holds the associate's grade allows (0 with no grade). */
  quota: number;
  /** How many live holds they have right now, in every project. */
  live: number;
  holds: MyHold[];
}

/** The caller's own live holds and what they may still take, or null when the
 *  account has no associate profile (an admin has no holds to show). Three
 *  statements however many holds there are. */
export async function getMyHolds(
  db: PrismaClient,
  params: { actorId: string; now?: Date },
): Promise<HoldSummary | null> {
  const now = params.now ?? new Date();
  const associate = await db.associate.findUnique({ where: { userId: params.actorId }, select: { id: true } });
  if (!associate) return null;

  const [grade, holds] = await Promise.all([
    // Same lookup as the quota check in holds.ts: no grade means no quota.
    db.grade.findFirst({
      where: { associateGrades: { some: { associateId: associate.id, validTo: null } } },
      select: { holdQuota: true },
    }),
    db.unitHold.findMany({
      where: { associateId: associate.id, releasedAt: null, expiresAt: { gt: now } },
      select: {
        id: true,
        expiresAt: true,
        unit: { select: { id: true, unitNumber: true, projectId: true, project: { select: { name: true } } } },
      },
      orderBy: { expiresAt: "asc" },
    }),
  ]);

  const drafts = holds.length
    ? await db.booking.findMany({
        where: { unitId: { in: holds.map((hold) => hold.unit.id) }, status: "DRAFT" },
        select: { id: true, bookingNumber: true, unitId: true },
      })
    : [];
  const draftByUnit = new Map(drafts.map((draft) => [draft.unitId, draft]));

  return {
    quota: grade?.holdQuota ?? 0,
    live: holds.length,
    holds: holds.map((hold) => ({
      holdId: hold.id,
      unitId: hold.unit.id,
      unitNumber: hold.unit.unitNumber,
      projectId: hold.unit.projectId,
      projectName: hold.unit.project.name,
      expiresAt: hold.expiresAt,
      draftBookingId: draftByUnit.get(hold.unit.id)?.id ?? null,
      draftBookingNumber: draftByUnit.get(hold.unit.id)?.bookingNumber ?? null,
    })),
  };
}
