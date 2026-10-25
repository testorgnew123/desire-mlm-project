// Booking a plot, as one action an associate takes: hold it (unless they already
// hold it), record the customer, and draft the booking. An admin then confirms.
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

  const unit = await db.unit.findUnique({
    where: { id: params.unitId },
    select: { id: true, orgId: true, projectId: true, unitTypeId: true, currentHoldId: true },
  });
  if (!unit) throw new UnitNotFoundError(params.unitId);
  if (unit.orgId !== orgId) throw new ForbiddenError(`Unit ${params.unitId} belongs to another organisation.`);

  const priceList = await db.priceList.findFirst({
    where: {
      projectId: unit.projectId,
      orgId,
      status: "ACTIVE",
      validFrom: { lte: now },
      OR: [{ validTo: null }, { validTo: { gt: now } }],
    },
    select: { id: true },
  });
  if (!priceList) throw new NoActivePriceListError(unit.projectId);

  const priced = await db.priceListItem.findFirst({
    where: { priceListId: priceList.id, OR: [{ unitId: unit.id }, { unitTypeId: unit.unitTypeId }] },
    select: { id: true },
  });
  if (!priced) throw new PlotNotPricedError(unit.id);

  // Already held, live, by this associate? Then there is nothing to acquire.
  const existingHold = unit.currentHoldId
    ? await db.unitHold.findUnique({
        where: { id: unit.currentHoldId },
        select: { associateId: true, expiresAt: true, releasedAt: true },
      })
    : null;
  const alreadyMine = !!existingHold && existingHold.associateId === associate.id && isHoldLive(existingHold, now);

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
      priceListId: priceList.id,
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
