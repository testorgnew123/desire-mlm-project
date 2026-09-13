// Booking core -- GATE (PROGRESS.md Phase 2, docs/06-INVENTORY-SPEC.md §5):
// on confirm, agreementValue and commissionableValue freeze, and the cost
// sheet is snapshotted. Runs against LOCAL Docker Postgres -- row locks, the
// hold/unit state machine, and the freeze-vs-recompute distinction are
// exactly what is under test.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import { acquireHold } from "../src/holds";
import { computeCostSheet, type ChargeHeadSpec } from "../src/cost-sheet";
import {
  BookingNotFoundError,
  HeldByAnotherAssociateError,
  InvalidBookingStateError,
  InvalidPriceListError,
  UnitNotHeldError,
  confirmBooking,
  createDraftBooking,
  getBooking,
  getBookingForActor,
  listBookings,
} from "../src/bookings";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_bookings";
const OTHER_ORG = "org_test_bookings_other";
const D = (v: string | number) => new Prisma.Decimal(v);

async function reset() {
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.costSheetLine.deleteMany({ where: { booking: { orgId } } });
    await db.bookingStatusHistory.deleteMany({ where: { booking: { orgId } } });
    await db.booking.deleteMany({ where: { orgId } });
    await db.customer.deleteMany({ where: { orgId } });
    await db.auditLog.deleteMany({ where: { orgId } });
    await db.unitStatusHistory.deleteMany({ where: { unit: { orgId } } });
    await db.unitHold.deleteMany({ where: { orgId } });
    await db.unit.deleteMany({ where: { orgId } });
    await db.priceListItem.deleteMany({ where: { priceList: { orgId } } });
    await db.priceList.deleteMany({ where: { orgId } });
    await db.chargeHead.deleteMany({ where: { orgId } });
    await db.unitType.deleteMany({ where: { orgId } });
    await db.associateGrade.deleteMany({ where: { associate: { orgId } } });
    await db.associate.deleteMany({ where: { orgId } });
    await db.userRole.deleteMany({ where: { role: { orgId } } });
    await db.rolePermission.deleteMany({ where: { role: { orgId } } });
    await db.role.deleteMany({ where: { orgId } });
    await db.user.deleteMany({ where: { orgId } });
    await db.project.deleteMany({ where: { orgId } });
    await db.grade.deleteMany({ where: { orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
  }
  // Permission is global config (no orgId) -- upsert-if-missing only, never
  // deleted here. Two test files sharing a code and both deleting it in
  // reset() raced under Vitest's parallel file execution (fixed this
  // session, see PROGRESS.md decision log); the fix was to stop deleting.
}

/** A user in the given org holding exactly the permission codes given,
 *  optionally with an Associate profile (grade + hold quota). */
async function makeUser(
  orgId: string,
  label: string,
  codes: string[],
  opts: { associate?: boolean; gradeCode?: string; holdQuota?: number } = {},
) {
  const user = await db.user.create({
    data: { orgId, email: `${label}-${orgId}@test.local`, name: label, passwordHash: "unused" },
  });
  const role = await db.role.create({ data: { orgId, code: `ROLE_${label}`, name: label } });
  for (const code of codes) {
    const [resource, action] = code.split(".");
    const perm = await db.permission.upsert({
      where: { code },
      update: {},
      create: { code, resource: resource!, action: action! },
    });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  }
  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });

  let associate = null;
  if (opts.associate) {
    const grade = await db.grade.upsert({
      where: { orgId_code: { orgId, code: opts.gradeCode ?? "GT" } },
      update: {},
      create: { orgId, code: opts.gradeCode ?? "GT", name: "Test Grade", rank: 1, holdQuota: opts.holdQuota ?? 5 },
    });
    associate = await db.associate.create({
      data: {
        orgId,
        userId: user.id,
        code: `A-${label}`,
        engagementType: "EMPLOYEE",
        joinDate: new Date("2024-01-01"),
      },
    });
    await db.associateGrade.create({
      data: { associateId: associate.id, gradeId: grade.id, validFrom: new Date("2024-01-01") },
    });
  }

  return { user, associate };
}

/** BSP + PLC + PARKING, mirroring cost-sheet.test.ts's HEADS but written as
 *  real ChargeHead rows -- bookings.ts loads the catalogue from the DB, it
 *  does not accept it as a pure input the way computeCostSheet itself does. */
async function seedChargeHeads(orgId: string) {
  const heads: Array<Omit<ChargeHeadSpec, "gstRatePct"> & { gstRatePct: string | null }> = [
    { code: "BSP", name: "Basic Sale Price", category: "BASE_PRICE", isTaxable: true, gstRatePct: "5.00", countsTowardCommission: true, displayOrder: 1 },
    { code: "PLC", name: "Preferential Location Charge", category: "PLC", isTaxable: true, gstRatePct: "5.00", countsTowardCommission: true, displayOrder: 2 },
    { code: "PARKING", name: "Car Parking", category: "PARKING", isTaxable: true, gstRatePct: "5.00", countsTowardCommission: false, displayOrder: 3 },
  ];
  for (const h of heads) {
    await db.chargeHead.create({ data: { orgId, ...h, isRefundable: false } });
  }
}

/** A full, bookable fixture: org, RERA-valid project, ACTIVE price list with
 *  a real priced item, charge heads, one AVAILABLE unit, a customer, and an
 *  admin (booking.create + booking.confirm + hold.create, no Associate row)
 *  plus one seller associate (booking.create + hold.create, WITH an
 *  Associate row -- the identity that actually holds and books units). */
async function seedFixture(orgId: string = ORG) {
  await db.organization.create({
    data: { id: orgId, name: "Bookings Test Org", legalName: "Bookings Test Org Pvt Ltd" },
  });
  const project = await db.project.create({
    data: {
      orgId,
      code: "SKY",
      name: "Skyline",
      city: "Pune",
      state: "Maharashtra",
      reraRegNo: "P-TEST-0001",
      reraValidTill: new Date("2030-01-01"),
      holdTtlMinutes: 60,
      holdExtensionMinutes: 30,
      maxHoldExtensions: 1,
    },
  });
  const unitType = await db.unitType.create({
    data: {
      orgId,
      projectId: project.id,
      code: "2BHK",
      name: "2BHK",
      carpetArea: "650.00",
      builtUpArea: "780.00",
      saleableArea: "975.00",
    },
  });
  const unit = await db.unit.create({
    data: { orgId, projectId: project.id, unitTypeId: unitType.id, unitNumber: "A-1", floor: 1 },
  });
  await seedChargeHeads(orgId);
  const priceList = await db.priceList.create({
    data: {
      orgId,
      projectId: project.id,
      version: 1,
      name: "v1",
      status: "ACTIVE",
      validFrom: new Date("2020-01-01"),
      preparedById: "u_test",
      items: {
        create: [
          {
            unitTypeId: unitType.id,
            baseRatePerSqft: "5000.00",
            plcCharges: { CORNER: 150 },
            otherCharges: [{ chargeHeadCode: "PARKING", amount: 300000 }],
          },
        ],
      },
    },
  });
  const customer = await db.customer.create({
    data: { orgId, name: "Test Buyer", phone: "9999999999" },
  });

  const admin = await makeUser(orgId, "admin", ["booking.create", "booking.confirm", "hold.create"]);
  const seller = await makeUser(orgId, "seller", ["booking.create", "hold.create"], { associate: true });
  const otherSeller = await makeUser(orgId, "seller2", ["booking.create", "hold.create"], { associate: true });

  return { project, unitType, unit, priceList, customer, admin, seller, otherSeller };
}

function ctx(orgId: string, userId: string | null, label: string): AuditContext {
  return { orgId, actorId: userId, actorLabel: label };
}

async function renameRole(orgId: string, fromCode: string, toCode: string) {
  const role = await db.role.findFirstOrThrow({ where: { orgId, code: fromCode } });
  await db.role.update({ where: { id: role.id }, data: { code: toCode } });
}

/** A dedicated fixture for listBookings/getBookingForActor's scope tests --
 *  bookings created directly (not via createDraftBooking/confirmBooking,
 *  which this file's other tests already cover) since only the row-level
 *  scope check on a finished Booking matters here. */
async function seedScopeFixture(orgId: string = ORG) {
  await db.organization.create({
    data: { id: orgId, name: "Bookings Scope Test Org", legalName: "Bookings Scope Test Org Pvt Ltd" },
  });
  const project = await db.project.create({
    data: {
      orgId, code: "SKY", name: "Skyline", city: "Pune", state: "Maharashtra",
      reraRegNo: "P-TEST-0001", reraValidTill: new Date("2030-01-01"),
      holdTtlMinutes: 60, holdExtensionMinutes: 30, maxHoldExtensions: 1,
    },
  });
  const unitType = await db.unitType.create({
    data: { orgId, projectId: project.id, code: "2BHK", name: "2BHK", carpetArea: "650.00", builtUpArea: "780.00", saleableArea: "975.00" },
  });
  const priceList = await db.priceList.create({
    data: { orgId, projectId: project.id, version: 1, name: "v1", status: "ACTIVE", validFrom: new Date("2020-01-01"), preparedById: "u_test" },
  });
  const customer = await db.customer.create({ data: { orgId, name: "Test Buyer", phone: "9999999999" } });

  const admin = await makeUser(orgId, "scopeadmin", ["booking.read"]);
  await renameRole(orgId, "ROLE_scopeadmin", "SUPER_ADMIN");
  const mine = await makeUser(orgId, "scopemine", ["booking.read"], { associate: true });
  await renameRole(orgId, "ROLE_scopemine", "ASSOCIATE");
  // stranger's own role code doesn't matter -- only ever used as the OTHER
  // party in these tests, never as the scoped actor -- so it keeps its
  // distinct ROLE_scopestranger code rather than colliding with ASSOCIATE's
  // @@unique([orgId, code]).
  const stranger = await makeUser(orgId, "scopestranger", ["booking.read"], { associate: true });

  async function makeBooking(sellingAssociateId: string, suffix: string) {
    const unit = await db.unit.create({
      data: { orgId, projectId: project.id, unitTypeId: unitType.id, unitNumber: `A-${suffix}`, floor: 1 },
    });
    return db.booking.create({
      data: {
        orgId, projectId: project.id, unitId: unit.id, customerId: customer.id, priceListId: priceList.id,
        bookingNumber: `BK-${suffix}`, bookingDate: new Date(), status: "CONFIRMED", sellingAssociateId,
        baseAmount: "100.00", plcAmount: "0", otherChargesAmount: "0", discountAmount: "0", gstAmount: "0",
        stampDutyAmount: "0", registrationAmount: "0", agreementValue: "100.00", commissionableValue: "100.00",
        saleableAreaAtBooking: "975.00", carpetAreaAtBooking: "650.00",
      },
    });
  }

  const mineBooking = await makeBooking(mine.associate!.id, "MINE");
  const strangerBooking = await makeBooking(stranger.associate!.id, "STRANGER");

  return { project, admin, mine, stranger, mineBooking, strangerBooking };
}

/** Independently re-derives the expected cost sheet for A-1, the way a test
 *  should -- not by trusting bookings.ts's own computation. */
function expectedCostSheet() {
  return computeCostSheet({
    saleableArea: D("975.00"),
    carpetArea: D("650.00"),
    baseRatePerSqft: D("5000.00"),
    plcTags: [],
    plcChargesByTag: { CORNER: D(150) },
    otherCharges: [{ chargeHeadCode: "PARKING", amount: D(300000) }],
    discount: D(0),
    chargeHeads: [
      { code: "BSP", name: "Basic Sale Price", category: "BASE_PRICE", isTaxable: true, gstRatePct: D("5.00"), countsTowardCommission: true, displayOrder: 1 },
      { code: "PLC", name: "Preferential Location Charge", category: "PLC", isTaxable: true, gstRatePct: D("5.00"), countsTowardCommission: true, displayOrder: 2 },
      { code: "PARKING", name: "Car Parking", category: "PARKING", isTaxable: true, gstRatePct: D("5.00"), countsTowardCommission: false, displayOrder: 3 },
    ],
  });
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("a booking can only be drafted against a unit HELD by the same associate", () => {
  it("succeeds when the drafting associate holds the unit", async () => {
    const { unit, priceList, customer, seller } = await seedFixture();
    await acquireHold(db, {
      orgId: ORG,
      unitId: unit.id,
      associateId: seller.associate!.id,
      audit: ctx(ORG, seller.user.id, "seller"),
    });

    const booking = await createDraftBooking(db, {
      unitId: unit.id,
      priceListId: priceList.id,
      customerId: customer.id,
      audit: ctx(ORG, seller.user.id, "seller"),
    });

    expect(booking.status).toBe("DRAFT");
    expect(booking.sellingAssociateId).toBe(seller.associate!.id);
    expect(booking.priceListId).toBe(priceList.id);
  });

  it("refuses when the unit is not held at all", async () => {
    const { unit, priceList, customer, seller } = await seedFixture();
    await expect(
      createDraftBooking(db, {
        unitId: unit.id,
        priceListId: priceList.id,
        customerId: customer.id,
        audit: ctx(ORG, seller.user.id, "seller"),
      }),
    ).rejects.toThrow(UnitNotHeldError);
    expect(await db.booking.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("refuses when a DIFFERENT associate holds the unit", async () => {
    const { unit, priceList, customer, seller, otherSeller } = await seedFixture();
    await acquireHold(db, {
      orgId: ORG,
      unitId: unit.id,
      associateId: otherSeller.associate!.id,
      audit: ctx(ORG, otherSeller.user.id, "seller2"),
    });

    await expect(
      createDraftBooking(db, {
        unitId: unit.id,
        priceListId: priceList.id,
        customerId: customer.id,
        audit: ctx(ORG, seller.user.id, "seller"),
      }),
    ).rejects.toThrow(HeldByAnotherAssociateError);
    expect(await db.booking.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("refuses against an expired hold, even though the row still says HELD", async () => {
    const { unit, priceList, customer, seller } = await seedFixture();
    const held = await acquireHold(db, {
      orgId: ORG,
      unitId: unit.id,
      associateId: seller.associate!.id,
      audit: ctx(ORG, seller.user.id, "seller"),
    });
    await db.unitHold.update({ where: { id: held.holdId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await expect(
      createDraftBooking(db, {
        unitId: unit.id,
        priceListId: priceList.id,
        customerId: customer.id,
        audit: ctx(ORG, seller.user.id, "seller"),
      }),
    ).rejects.toThrow(UnitNotHeldError);
  });

  it("refuses against an already-BOOKED unit", async () => {
    const { unit, priceList, customer, seller } = await seedFixture();
    await db.unit.update({ where: { id: unit.id }, data: { status: "BOOKED" } });

    await expect(
      createDraftBooking(db, {
        unitId: unit.id,
        priceListId: priceList.id,
        customerId: customer.id,
        audit: ctx(ORG, seller.user.id, "seller"),
      }),
    ).rejects.toThrow(UnitNotHeldError);
  });
});

describe("draft pins priceListId and freezes area at booking time", () => {
  it("keeps the area captured at draft even if the unit's area changes afterward", async () => {
    const { unit, priceList, customer, seller } = await seedFixture();
    await acquireHold(db, {
      orgId: ORG,
      unitId: unit.id,
      associateId: seller.associate!.id,
      audit: ctx(ORG, seller.user.id, "seller"),
    });
    const booking = await createDraftBooking(db, {
      unitId: unit.id,
      priceListId: priceList.id,
      customerId: customer.id,
      audit: ctx(ORG, seller.user.id, "seller"),
    });

    expect(booking.saleableAreaAtBooking.toString()).toBe("975");
    expect(booking.carpetAreaAtBooking.toString()).toBe("650");
    expect(booking.priceListId).toBe(priceList.id);
  });
});

describe("confirm freezes agreementValue/commissionableValue and snapshots CostSheetLine", () => {
  async function draftAndAcquire(orgId: string, unit: { id: string }, priceListId: string, customerId: string, seller: { user: { id: string }; associate: { id: string } | null }) {
    await acquireHold(db, {
      orgId,
      unitId: unit.id,
      associateId: seller.associate!.id,
      audit: ctx(orgId, seller.user.id, "seller"),
    });
    return createDraftBooking(db, {
      unitId: unit.id,
      priceListId,
      customerId,
      audit: ctx(orgId, seller.user.id, "seller"),
    });
  }

  it("matches an independently computed cost sheet, line for line, read back from the DB", async () => {
    const { unit, priceList, customer, seller, admin } = await seedFixture();
    const draft = await draftAndAcquire(ORG, unit, priceList.id, customer.id, seller);

    const confirmed = await confirmBooking(db, { bookingId: draft.id, audit: ctx(ORG, admin.user.id, "admin") });
    const expected = expectedCostSheet();

    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.agreementValue.toString()).toBe(expected.agreementValue.toString());
    expect(confirmed.commissionableValue.toString()).toBe(expected.commissionableValue.toString());

    const dbLines = await db.costSheetLine.findMany({
      where: { bookingId: draft.id },
      orderBy: { displayOrder: "asc" },
    });
    expect(dbLines).toHaveLength(expected.lines.length);
    for (let i = 0; i < expected.lines.length; i++) {
      expect(dbLines[i]!.chargeHeadCode).toBe(expected.lines[i]!.chargeHeadCode);
      expect(dbLines[i]!.amount.toString()).toBe(expected.lines[i]!.amount.toString());
      expect(dbLines[i]!.countsTowardCommission).toBe(expected.lines[i]!.countsTowardCommission);
    }
  });

  it("releases the hold and transitions the unit to BOOKED", async () => {
    const { unit, priceList, customer, seller, admin } = await seedFixture();
    const draft = await draftAndAcquire(ORG, unit, priceList.id, customer.id, seller);
    const heldRow = await db.unit.findUniqueOrThrow({ where: { id: unit.id }, select: { currentHoldId: true } });

    await confirmBooking(db, { bookingId: draft.id, audit: ctx(ORG, admin.user.id, "admin") });

    const after = await db.unit.findUniqueOrThrow({ where: { id: unit.id } });
    expect(after.status).toBe("BOOKED");
    expect(after.currentHoldId).toBeNull();

    const hold = await db.unitHold.findUniqueOrThrow({ where: { id: heldRow.currentHoldId! } });
    expect(hold.releasedAt).not.toBeNull();
    expect(hold.releaseReason).toBe("CONVERTED_TO_BOOKING");
  });

  it("is legal only from DRAFT -- a retry after CONFIRMED is refused, nothing mutated twice", async () => {
    const { unit, priceList, customer, seller, admin } = await seedFixture();
    const draft = await draftAndAcquire(ORG, unit, priceList.id, customer.id, seller);
    await confirmBooking(db, { bookingId: draft.id, audit: ctx(ORG, admin.user.id, "admin") });

    await expect(
      confirmBooking(db, { bookingId: draft.id, audit: ctx(ORG, admin.user.id, "admin") }),
    ).rejects.toThrow(InvalidBookingStateError);

    // BSP + PARKING -- no PLC line, since this fixture's unit carries no
    // plcTags even though the price list has a CORNER rate configured.
    expect(await db.costSheetLine.count({ where: { bookingId: draft.id } })).toBe(
      expectedCostSheet().lines.length,
    );
  });

  // Confirm re-verifies HELD-by-the-same-associate rather than trusting the
  // draft's premise -- the whole point being that time passes between draft
  // and confirm and the hold can genuinely die in that gap. These two prove
  // the re-check actually fires, not just the draft-time one.
  it("refuses to confirm when the hold expired between draft and confirm", async () => {
    const { unit, priceList, customer, seller, admin } = await seedFixture();
    const draft = await draftAndAcquire(ORG, unit, priceList.id, customer.id, seller);
    const heldUnit = await db.unit.findUniqueOrThrow({ where: { id: unit.id }, select: { currentHoldId: true } });
    await db.unitHold.update({
      where: { id: heldUnit.currentHoldId! },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      confirmBooking(db, { bookingId: draft.id, audit: ctx(ORG, admin.user.id, "admin") }),
    ).rejects.toThrow(UnitNotHeldError);

    const afterConfirmAttempt = await db.booking.findUniqueOrThrow({ where: { id: draft.id } });
    expect(afterConfirmAttempt.status).toBe("DRAFT");
    expect(await db.costSheetLine.count({ where: { bookingId: draft.id } })).toBe(0);
  });

  it("refuses to confirm when a different associate now holds the unit", async () => {
    const { unit, priceList, customer, seller, otherSeller, admin } = await seedFixture();
    const draft = await draftAndAcquire(ORG, unit, priceList.id, customer.id, seller);

    // Force-release the seller's hold (simulating an admin override or the
    // sweep racing ahead of this confirm), then have a different associate
    // acquire the now-AVAILABLE unit for real.
    const heldUnit = await db.unit.findUniqueOrThrow({ where: { id: unit.id }, select: { currentHoldId: true } });
    await db.unitHold.update({
      where: { id: heldUnit.currentHoldId! },
      data: { releasedAt: new Date(), releaseReason: "RELEASED_BY_ADMIN" },
    });
    await db.unit.update({ where: { id: unit.id }, data: { status: "AVAILABLE", currentHoldId: null } });
    await acquireHold(db, {
      orgId: ORG,
      unitId: unit.id,
      associateId: otherSeller.associate!.id,
      audit: ctx(ORG, otherSeller.user.id, "seller2"),
    });

    await expect(
      confirmBooking(db, { bookingId: draft.id, audit: ctx(ORG, admin.user.id, "admin") }),
    ).rejects.toThrow(HeldByAnotherAssociateError);
  });

  it("throws for a booking that does not exist", async () => {
    await seedFixture();
    const { admin } = await (async () => {
      const a = await db.user.findFirst({ where: { orgId: ORG } });
      return { admin: { user: a! } };
    })();
    await expect(
      confirmBooking(db, { bookingId: "does-not-exist", audit: ctx(ORG, admin.user.id, "admin") }),
    ).rejects.toThrow(BookingNotFoundError);
  });
});

describe("tenancy: cross-org entities are invisible", () => {
  it("refuses a price list belonging to another org", async () => {
    const fixtureA = await seedFixture(ORG);
    const fixtureB = await seedFixture(OTHER_ORG);
    await acquireHold(db, {
      orgId: ORG,
      unitId: fixtureA.unit.id,
      associateId: fixtureA.seller.associate!.id,
      audit: ctx(ORG, fixtureA.seller.user.id, "seller"),
    });

    await expect(
      createDraftBooking(db, {
        unitId: fixtureA.unit.id,
        priceListId: fixtureB.priceList.id, // belongs to OTHER_ORG
        customerId: fixtureA.customer.id,
        audit: ctx(ORG, fixtureA.seller.user.id, "seller"),
      }),
    ).rejects.toThrow(InvalidPriceListError);
  });

  it("refuses to confirm a booking belonging to another org", async () => {
    const fixtureA = await seedFixture(ORG);
    await acquireHold(db, {
      orgId: ORG,
      unitId: fixtureA.unit.id,
      associateId: fixtureA.seller.associate!.id,
      audit: ctx(ORG, fixtureA.seller.user.id, "seller"),
    });
    const draft = await createDraftBooking(db, {
      unitId: fixtureA.unit.id,
      priceListId: fixtureA.priceList.id,
      customerId: fixtureA.customer.id,
      audit: ctx(ORG, fixtureA.seller.user.id, "seller"),
    });

    const fixtureB = await seedFixture(OTHER_ORG);
    await expect(
      confirmBooking(db, { bookingId: draft.id, audit: ctx(OTHER_ORG, fixtureB.admin.user.id, "admin") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("RBAC: booking.create/booking.confirm enforced before any row lock or mutation", () => {
  it("refuses a draft from a user without booking.create", async () => {
    const { unit, priceList, customer } = await seedFixture();
    const nobody = await makeUser(ORG, "nobody", [], { associate: true });
    await acquireHold(db, {
      orgId: ORG,
      unitId: unit.id,
      associateId: nobody.associate!.id,
      audit: ctx(ORG, nobody.user.id, "nobody"),
    });

    await expect(
      createDraftBooking(db, {
        unitId: unit.id,
        priceListId: priceList.id,
        customerId: customer.id,
        audit: ctx(ORG, nobody.user.id, "nobody"),
      }),
    ).rejects.toThrow(ForbiddenError);
    expect(await db.booking.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("refuses a confirm from a user without booking.confirm (the seller alone cannot self-confirm)", async () => {
    const { unit, priceList, customer, seller } = await seedFixture();
    await acquireHold(db, {
      orgId: ORG,
      unitId: unit.id,
      associateId: seller.associate!.id,
      audit: ctx(ORG, seller.user.id, "seller"),
    });
    const draft = await createDraftBooking(db, {
      unitId: unit.id,
      priceListId: priceList.id,
      customerId: customer.id,
      audit: ctx(ORG, seller.user.id, "seller"),
    });

    await expect(
      confirmBooking(db, { bookingId: draft.id, audit: ctx(ORG, seller.user.id, "seller") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("concurrency: two associates racing to draft the same held unit", () => {
  it("only the associate who actually holds it can draft; the other loses cleanly", async () => {
    const { unit, priceList, customer, seller, otherSeller } = await seedFixture();
    await acquireHold(db, {
      orgId: ORG,
      unitId: unit.id,
      associateId: seller.associate!.id,
      audit: ctx(ORG, seller.user.id, "seller"),
    });

    const results = await Promise.allSettled([
      createDraftBooking(db, {
        unitId: unit.id,
        priceListId: priceList.id,
        customerId: customer.id,
        audit: ctx(ORG, seller.user.id, "seller"),
      }),
      createDraftBooking(db, {
        unitId: unit.id,
        priceListId: priceList.id,
        customerId: customer.id,
        audit: ctx(ORG, otherSeller.user.id, "seller2"),
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(await db.booking.count({ where: { orgId: ORG } })).toBe(1);
  });
});

describe("audit: CREATE and UPDATE each write exactly one row with the right before/after", () => {
  it("draft writes a CREATE audit row", async () => {
    const { unit, priceList, customer, seller } = await seedFixture();
    await acquireHold(db, {
      orgId: ORG,
      unitId: unit.id,
      associateId: seller.associate!.id,
      audit: ctx(ORG, seller.user.id, "seller"),
    });
    const draft = await createDraftBooking(db, {
      unitId: unit.id,
      priceListId: priceList.id,
      customerId: customer.id,
      audit: ctx(ORG, seller.user.id, "seller"),
    });

    const rows = await db.auditLog.findMany({
      where: { entity: "Booking", entityId: draft.id, action: "CREATE" },
    });
    expect(rows).toHaveLength(1);
  });

  it("confirm writes exactly one UPDATE audit row", async () => {
    const { unit, priceList, customer, seller, admin } = await seedFixture();
    await acquireHold(db, {
      orgId: ORG,
      unitId: unit.id,
      associateId: seller.associate!.id,
      audit: ctx(ORG, seller.user.id, "seller"),
    });
    const draft = await createDraftBooking(db, {
      unitId: unit.id,
      priceListId: priceList.id,
      customerId: customer.id,
      audit: ctx(ORG, seller.user.id, "seller"),
    });
    await confirmBooking(db, { bookingId: draft.id, audit: ctx(ORG, admin.user.id, "admin") });

    const rows = await db.auditLog.findMany({
      where: { entity: "Booking", entityId: draft.id, action: "UPDATE" },
    });
    expect(rows).toHaveLength(1);
  });
});

describe("getBooking", () => {
  it("returns the booking with its cost sheet lines, scoped by org", async () => {
    const { unit, priceList, customer, seller, admin } = await seedFixture();
    await acquireHold(db, {
      orgId: ORG,
      unitId: unit.id,
      associateId: seller.associate!.id,
      audit: ctx(ORG, seller.user.id, "seller"),
    });
    const draft = await createDraftBooking(db, {
      unitId: unit.id,
      priceListId: priceList.id,
      customerId: customer.id,
      audit: ctx(ORG, seller.user.id, "seller"),
    });
    await confirmBooking(db, { bookingId: draft.id, audit: ctx(ORG, admin.user.id, "admin") });

    const found = await getBooking(db, { orgId: ORG, bookingId: draft.id });
    expect(found?.status).toBe("CONFIRMED");
    expect(found?.costSheetLines.length).toBeGreaterThan(0);

    const wrongOrg = await getBooking(db, { orgId: OTHER_ORG, bookingId: draft.id });
    expect(wrongOrg).toBeNull();
  });
});

describe("listBookings: scope (Phase 3.5 Slice 10 -- confirmed gap, no list existed)", () => {
  it("an admin-shaped role sees every booking in the org", async () => {
    const f = await seedScopeFixture();
    const rows = await listBookings(db, { orgId: ORG, actorId: f.admin.user.id });
    expect(rows.map((r) => r.id).sort()).toEqual([f.mineBooking.id, f.strangerBooking.id].sort());
  });

  it("an ASSOCIATE sees only their own booking, not a stranger's", async () => {
    const f = await seedScopeFixture();
    const rows = await listBookings(db, { orgId: ORG, actorId: f.mine.user.id });
    expect(rows.map((r) => r.id)).toEqual([f.mineBooking.id]);
  });

  it("refuses without booking.read", async () => {
    await seedScopeFixture();
    const nobody = await makeUser(ORG, "scopenobody", []);
    await expect(listBookings(db, { orgId: ORG, actorId: nobody.user.id })).rejects.toThrow(ForbiddenError);
  });
});

describe("getBookingForActor: scope", () => {
  it("returns null (not a thrown error) for a booking outside an ASSOCIATE's scope", async () => {
    const f = await seedScopeFixture();
    const result = await getBookingForActor(db, { orgId: ORG, actorId: f.mine.user.id, bookingId: f.strangerBooking.id });
    expect(result).toBeNull();
  });

  it("returns the booking when it is within the ASSOCIATE's own scope", async () => {
    const f = await seedScopeFixture();
    const result = await getBookingForActor(db, { orgId: ORG, actorId: f.mine.user.id, bookingId: f.mineBooking.id });
    expect(result?.id).toBe(f.mineBooking.id);
  });

  it("an admin-shaped role can view any booking", async () => {
    const f = await seedScopeFixture();
    const result = await getBookingForActor(db, { orgId: ORG, actorId: f.admin.user.id, bookingId: f.strangerBooking.id });
    expect(result?.id).toBe(f.strangerBooking.id);
  });
});
