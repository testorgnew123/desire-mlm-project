// An associate books a plot (hold + customer + draft in one call) and an admin
// confirms it. Runs against LOCAL Postgres: the point is the order of the writes,
// the undo when the last step fails, and who is allowed to do which half.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import { HoldQuotaExceededError, UnitNotAvailableError, UnitNotFoundError, acquireHold } from "../src/holds";
import { confirmBooking } from "../src/bookings";
import { InvalidCustomerError } from "../src/customers";
import { NoActivePriceListError, PlotNotPricedError, bookPlot } from "../src/plot-booking";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_plotbooking";
const OTHER_ORG = "org_test_plotbooking_other";

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
    await db.tower.deleteMany({ where: { orgId } });
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
}

async function makeUser(
  orgId: string,
  label: string,
  codes: string[],
  opts: { associate?: boolean; holdQuota?: number; gradeCode?: string } = {},
) {
  const user = await db.user.create({
    data: { orgId, email: `${label}-${orgId}@test.local`, name: label, passwordHash: "unused" },
  });
  const role = await db.role.create({ data: { orgId, code: `ROLE_${label}`, name: label } });
  for (const code of codes) {
    const [resource, action] = code.split(".");
    const permission = await db.permission.upsert({
      where: { code },
      update: {},
      create: { code, resource: resource!, action: action! },
    });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  }
  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });

  let associate = null;
  if (opts.associate) {
    // A grade per (code, quota): upsert keeps the first one made, so a test
    // that wants a different quota must also ask for a different grade code.
    const gradeCode = opts.gradeCode ?? "GT";
    const grade = await db.grade.upsert({
      where: { orgId_code: { orgId, code: gradeCode } },
      update: {},
      create: { orgId, code: gradeCode, name: "Test", rank: gradeCode === "GT" ? 1 : 2, holdQuota: opts.holdQuota ?? 5 },
    });
    associate = await db.associate.create({
      data: { orgId, userId: user.id, code: `A-${label}`, engagementType: "CHANNEL_PARTNER", joinDate: new Date("2024-01-01") },
    });
    await db.associateGrade.create({
      data: { associateId: associate.id, gradeId: grade.id, validFrom: new Date("2024-01-01") },
    });
  }
  return { user, associate };
}

/** A plotted project ready to book: RERA, a block of three plots, a plot type,
 *  the charge heads the cost sheet needs, an ACTIVE price list that prices the
 *  type, an associate (hold + draft permissions, quota 5), a rival associate and
 *  an admin who can confirm but holds no Associate profile. */
async function seedFixture(orgId: string = ORG) {
  await db.organization.create({ data: { id: orgId, name: "Plot Booking Org", legalName: "Plot Booking Org Pvt Ltd" } });
  const project = await db.project.create({
    data: {
      orgId,
      code: "PLT",
      name: "Plots",
      reraRegNo: "P-PLT-1",
      reraValidTill: new Date("2030-01-01"),
      holdTtlMinutes: 60,
    },
  });
  const block = await db.tower.create({ data: { orgId, projectId: project.id, code: "A", name: "Block A", kind: "BLOCK" } });
  const plotType = await db.unitType.create({
    data: { orgId, projectId: project.id, code: "PLOT-200", name: "200 sq yd", areaBasis: "SQYD", saleableArea: "200.00" },
  });
  const plots = [];
  for (const n of ["A-01", "A-02", "A-03"]) {
    plots.push(await db.unit.create({ data: { orgId, projectId: project.id, towerId: block.id, unitTypeId: plotType.id, unitNumber: n } }));
  }
  await db.chargeHead.create({
    data: { orgId, code: "BSP", name: "Basic Sale Price", category: "BASE_PRICE", isTaxable: true, gstRatePct: "5.00", countsTowardCommission: true, isRefundable: false, displayOrder: 1 },
  });
  const priceList = await db.priceList.create({
    data: {
      orgId,
      projectId: project.id,
      version: 1,
      name: "v1",
      status: "ACTIVE",
      validFrom: new Date("2020-01-01"),
      preparedById: "u_test",
      items: { create: [{ unitTypeId: plotType.id, baseRate: "25000.00" }] },
    },
  });
  const seller = await makeUser(orgId, "seller", ["booking.create", "hold.create"], { associate: true });
  const rival = await makeUser(orgId, "rival", ["booking.create", "hold.create"], { associate: true });
  const admin = await makeUser(orgId, "admin", ["booking.confirm", "booking.read"]);
  return { project, block, plotType, plots, priceList, seller, rival, admin };
}

const ctx = (orgId: string, user: { id: string } | null, label: string): AuditContext => ({
  orgId,
  actorId: user?.id ?? null,
  actorLabel: label,
});

const customer = { name: "Asha Rao", phone: "98765 43210", email: "asha@example.com" };

const unitState = (unitId: string) =>
  db.unit.findUniqueOrThrow({ where: { id: unitId }, select: { status: true, currentHoldId: true } });

async function expectNothingWritten(f: Awaited<ReturnType<typeof seedFixture>>, unitId: string) {
  expect(await db.customer.count({ where: { orgId: ORG } })).toBe(0);
  expect(await db.booking.count({ where: { orgId: ORG } })).toBe(0);
  expect(await db.unitHold.count({ where: { unitId, releasedAt: null } })).toBe(0);
  expect((await unitState(unitId)).status).toBe("AVAILABLE");
  void f;
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("bookPlot", () => {
  it("holds the plot, records the customer and drafts the booking, all as the associate", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;

    const booked = await bookPlot(db, { unitId: plot.id, customer, audit: ctx(ORG, f.seller.user, "seller") });

    expect(booked.tookHold).toBe(true);
    expect(booked.bookingNumber).toMatch(/^PLT-\d{4}$/);

    const booking = await db.booking.findUniqueOrThrow({ where: { id: booked.bookingId } });
    expect(booking).toMatchObject({
      status: "DRAFT",
      unitId: plot.id,
      customerId: booked.customerId,
      sellingAssociateId: f.seller.associate!.id,
      priceListId: f.priceList.id,
    });
    // 200 sq yd at Rs 25,000: a plot prices on its single area, no carpet.
    expect(booking.baseAmount.toString()).toBe("5000000");
    expect(booking.carpetAreaAtBooking).toBeNull();

    const stored = await db.customer.findUniqueOrThrow({ where: { id: booked.customerId } });
    expect(stored).toMatchObject({ name: "Asha Rao", phone: "+919876543210", email: "asha@example.com" });

    const state = await unitState(plot.id);
    expect(state.status).toBe("HELD");
    const hold = await db.unitHold.findUniqueOrThrow({ where: { id: state.currentHoldId! } });
    expect(hold.associateId).toBe(f.seller.associate!.id);
  });

  it("does not take a second hold when the associate already holds the plot", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    await acquireHold(db, { orgId: ORG, unitId: plot.id, associateId: f.seller.associate!.id, audit: ctx(ORG, f.seller.user, "seller") });

    const booked = await bookPlot(db, { unitId: plot.id, customer, audit: ctx(ORG, f.seller.user, "seller") });

    expect(booked.tookHold).toBe(false);
    expect(await db.unitHold.count({ where: { unitId: plot.id } })).toBe(1);
  });

  it("takes a fresh hold when the associate's own hold has lapsed", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    const past = new Date(Date.now() - 3 * 3_600_000);
    await acquireHold(db, { orgId: ORG, unitId: plot.id, associateId: f.seller.associate!.id, audit: ctx(ORG, f.seller.user, "seller"), now: past });

    const booked = await bookPlot(db, { unitId: plot.id, customer, audit: ctx(ORG, f.seller.user, "seller") });

    expect(booked.tookHold).toBe(true);
    expect((await unitState(plot.id)).status).toBe("HELD");
  });

  it("leaves a plot another associate holds alone, and writes nothing", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    await acquireHold(db, { orgId: ORG, unitId: plot.id, associateId: f.rival.associate!.id, audit: ctx(ORG, f.rival.user, "rival") });

    await expect(bookPlot(db, { unitId: plot.id, customer, audit: ctx(ORG, f.seller.user, "seller") })).rejects.toThrow(
      UnitNotAvailableError,
    );
    expect(await db.customer.count({ where: { orgId: ORG } })).toBe(0);
    expect(await db.booking.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("checks the customer before taking the hold, so a typo never costs a plot", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    await expect(
      bookPlot(db, { unitId: plot.id, customer: { name: "Asha", phone: "12" }, audit: ctx(ORG, f.seller.user, "seller") }),
    ).rejects.toThrow(InvalidCustomerError);
    await expectNothingWritten(f, plot.id);
  });

  it("refuses a project with no active price list, and one that does not price the plot's type", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;

    await db.priceListItem.deleteMany({ where: { priceListId: f.priceList.id } });
    await expect(bookPlot(db, { unitId: plot.id, customer, audit: ctx(ORG, f.seller.user, "seller") })).rejects.toThrow(PlotNotPricedError);
    await expectNothingWritten(f, plot.id);

    await db.priceList.update({ where: { id: f.priceList.id }, data: { status: "ARCHIVED" } });
    await expect(bookPlot(db, { unitId: plot.id, customer, audit: ctx(ORG, f.seller.user, "seller") })).rejects.toThrow(NoActivePriceListError);
    await expectNothingWritten(f, plot.id);
  });

  it("undoes the hold and the customer when the draft fails after both were made", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    // Every pre-check passes, then the draft's cost sheet cannot be built.
    await db.chargeHead.deleteMany({ where: { orgId: ORG } });

    await expect(bookPlot(db, { unitId: plot.id, customer, audit: ctx(ORG, f.seller.user, "seller") })).rejects.toThrow();

    await expectNothingWritten(f, plot.id);
    const holds = await db.unitHold.findMany({ where: { unitId: plot.id } });
    expect(holds).toHaveLength(1);
    expect(holds[0]!.releaseReason).toBe("RELEASED_BY_ASSOCIATE");
  });

  it("does not release a hold the associate already had when the draft fails", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    await acquireHold(db, { orgId: ORG, unitId: plot.id, associateId: f.seller.associate!.id, audit: ctx(ORG, f.seller.user, "seller") });
    await db.chargeHead.deleteMany({ where: { orgId: ORG } });

    await expect(bookPlot(db, { unitId: plot.id, customer, audit: ctx(ORG, f.seller.user, "seller") })).rejects.toThrow();

    expect((await unitState(plot.id)).status).toBe("HELD");
    expect(await db.customer.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("refuses an account with no associate profile, however much it is allowed", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    const noProfile = await makeUser(ORG, "noprofile", ["booking.create", "hold.create"]);
    await expect(bookPlot(db, { unitId: plot.id, customer, audit: ctx(ORG, noProfile.user, "noprofile") })).rejects.toThrow(
      /no associate profile/,
    );
    await expectNothingWritten(f, plot.id);
  });

  it("refuses without booking.create, and without hold.create when a hold is needed", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    const viewer = await makeUser(ORG, "viewer", [], { associate: true });
    const draftOnly = await makeUser(ORG, "draftonly", ["booking.create"], { associate: true });

    await expect(bookPlot(db, { unitId: plot.id, customer, audit: ctx(ORG, viewer.user, "viewer") })).rejects.toThrow(ForbiddenError);
    await expect(bookPlot(db, { unitId: plot.id, customer, audit: ctx(ORG, draftOnly.user, "draftonly") })).rejects.toThrow(ForbiddenError);
    await expectNothingWritten(f, plot.id);
  });

  it("stops at the associate's hold quota, writing nothing", async () => {
    const f = await seedFixture();
    const tight = await makeUser(ORG, "tight", ["booking.create", "hold.create"], {
      associate: true,
      holdQuota: 1,
      gradeCode: "G-TIGHT",
    });
    await acquireHold(db, { orgId: ORG, unitId: f.plots[0]!.id, associateId: tight.associate!.id, audit: ctx(ORG, tight.user, "tight") });

    await expect(
      bookPlot(db, { unitId: f.plots[1]!.id, customer, audit: ctx(ORG, tight.user, "tight") }),
    ).rejects.toThrow(HoldQuotaExceededError);
    expect(await db.customer.count({ where: { orgId: ORG } })).toBe(0);
    expect(await db.booking.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("refuses an unknown plot, another organisation's plot and a system actor", async () => {
    const f = await seedFixture();
    const other = await seedFixture(OTHER_ORG);

    await expect(bookPlot(db, { unitId: "nope", customer, audit: ctx(ORG, f.seller.user, "seller") })).rejects.toThrow(UnitNotFoundError);
    await expect(
      bookPlot(db, { unitId: other.plots[0]!.id, customer, audit: ctx(ORG, f.seller.user, "seller") }),
    ).rejects.toThrow(ForbiddenError);
    await expect(bookPlot(db, { unitId: f.plots[0]!.id, customer, audit: ctx(ORG, null, "system") })).rejects.toThrow(ForbiddenError);
  });

  it("books two different plots for the same associate, each with its own customer", async () => {
    const f = await seedFixture();
    const first = await bookPlot(db, { unitId: f.plots[0]!.id, customer, audit: ctx(ORG, f.seller.user, "seller") });
    const second = await bookPlot(db, { unitId: f.plots[1]!.id, customer, audit: ctx(ORG, f.seller.user, "seller") });

    expect(first.customerId).not.toBe(second.customerId);
    expect(first.bookingNumber).not.toBe(second.bookingNumber);
  });
});

describe("the associate drafts, an admin confirms", () => {
  it("the admin confirms the draft and the plot becomes BOOKED", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    const booked = await bookPlot(db, { unitId: plot.id, customer, audit: ctx(ORG, f.seller.user, "seller") });

    const confirmed = await confirmBooking(db, { bookingId: booked.bookingId, audit: ctx(ORG, f.admin.user, "admin") });

    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.confirmedById).toBe(f.admin.user.id);
    expect((await unitState(plot.id)).status).toBe("BOOKED");
    expect(await db.unitHold.count({ where: { unitId: plot.id, releaseReason: "CONVERTED_TO_BOOKING" } })).toBe(1);
  });

  it("the seller cannot confirm their own sale", async () => {
    const f = await seedFixture();
    const booked = await bookPlot(db, { unitId: f.plots[0]!.id, customer, audit: ctx(ORG, f.seller.user, "seller") });

    await expect(
      confirmBooking(db, { bookingId: booked.bookingId, audit: ctx(ORG, f.seller.user, "seller") }),
    ).rejects.toThrow(ForbiddenError);
    expect((await db.booking.findUniqueOrThrow({ where: { id: booked.bookingId } })).status).toBe("DRAFT");
  });
});
