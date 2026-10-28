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
import {
  HoldHasDraftError,
  NoActivePriceListError,
  PlotNotHeldError,
  PlotNotPricedError,
  bookPlot,
  getMyHolds,
  holdPlot,
  releasePlotHold,
} from "../src/plot-booking";
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
    data: { orgId, code: "BSP", name: "Basic Sale Price", category: "BASE_PRICE", countsTowardCommission: true, isRefundable: false, displayOrder: 1 },
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

describe("holdPlot", () => {
  const asSeller = (f: Awaited<ReturnType<typeof seedFixture>>) => ctx(ORG, f.seller.user, "seller");

  it("holds the plot for the project's hold window and says it took the hold", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    const now = new Date("2026-10-27T10:00:00Z");

    const held = await holdPlot(db, { unitId: plot.id, audit: asSeller(f), now });

    expect(held.tookHold).toBe(true);
    expect(held.expiresAt.getTime()).toBe(now.getTime() + 60 * 60_000); // the fixture's holdTtlMinutes
    const state = await unitState(plot.id);
    expect(state.status).toBe("HELD");
    const hold = await db.unitHold.findUniqueOrThrow({ where: { id: state.currentHoldId! } });
    expect(hold.associateId).toBe(f.seller.associate!.id);
    expect(await db.customer.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("is not an error to hold a plot you already hold, and takes no second hold", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    const first = await holdPlot(db, { unitId: plot.id, audit: asSeller(f) });
    const again = await holdPlot(db, { unitId: plot.id, audit: asSeller(f) });

    expect(again).toMatchObject({ tookHold: false, holdId: first.holdId });
    expect(await db.unitHold.count({ where: { unitId: plot.id } })).toBe(1);
  });

  it("tells a rival who holds the plot, and leaves it alone", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    await holdPlot(db, { unitId: plot.id, audit: asSeller(f) });

    const attempt = () => holdPlot(db, { unitId: plot.id, audit: ctx(ORG, f.rival.user, "rival") });
    await expect(attempt()).rejects.toThrow(UnitNotAvailableError);
    await expect(attempt()).rejects.toThrow(/seller/);
    expect(await db.unitHold.count({ where: { unitId: plot.id, releasedAt: null } })).toBe(1);
  });

  it("takes over a plot whose hold has lapsed", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    const past = new Date(Date.now() - 3 * 3_600_000);
    await holdPlot(db, { unitId: plot.id, audit: ctx(ORG, f.rival.user, "rival"), now: past });

    const held = await holdPlot(db, { unitId: plot.id, audit: asSeller(f) });

    expect(held.tookHold).toBe(true);
    expect((await db.unitHold.findUniqueOrThrow({ where: { id: held.holdId } })).associateId).toBe(f.seller.associate!.id);
  });

  it("refuses when the hold allowance is used up, and writes nothing more", async () => {
    const f = await seedFixture();
    const tiny = await makeUser(ORG, "tiny", ["booking.create", "hold.create"], { associate: true, holdQuota: 1, gradeCode: "G2" });
    const asTiny = ctx(ORG, tiny.user, "tiny");
    await holdPlot(db, { unitId: f.plots[0]!.id, audit: asTiny });

    await expect(holdPlot(db, { unitId: f.plots[1]!.id, audit: asTiny })).rejects.toThrow(HoldQuotaExceededError);
    expect((await unitState(f.plots[1]!.id)).status).toBe("AVAILABLE");
    expect(await db.unitHold.count({ where: { associateId: tiny.associate!.id } })).toBe(1);
  });

  it("refuses an admin (no associate profile), someone without hold.create, and a system actor", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    const noPerm = await makeUser(ORG, "noperm", ["booking.create"], { associate: true });

    await expect(holdPlot(db, { unitId: plot.id, audit: ctx(ORG, f.admin.user, "admin") })).rejects.toThrow(ForbiddenError);
    await expect(holdPlot(db, { unitId: plot.id, audit: ctx(ORG, noPerm.user, "noperm") })).rejects.toThrow(ForbiddenError);
    await expect(holdPlot(db, { unitId: plot.id, audit: ctx(ORG, null, "job") })).rejects.toThrow(ForbiddenError);
    expect((await unitState(plot.id)).status).toBe("AVAILABLE");
  });

  it("refuses a plot that could not then be booked: no price, no active list, another org, no such plot", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;

    await db.priceListItem.deleteMany({ where: { priceListId: f.priceList.id } });
    await expect(holdPlot(db, { unitId: plot.id, audit: asSeller(f) })).rejects.toThrow(PlotNotPricedError);
    await db.priceList.update({ where: { id: f.priceList.id }, data: { status: "ARCHIVED" } });
    await expect(holdPlot(db, { unitId: plot.id, audit: asSeller(f) })).rejects.toThrow(NoActivePriceListError);
    await expectNothingWritten(f, plot.id);

    const other = await seedFixture(OTHER_ORG);
    await expect(holdPlot(db, { unitId: other.plots[0]!.id, audit: asSeller(f) })).rejects.toThrow(ForbiddenError);
    await expect(holdPlot(db, { unitId: "no-such-plot", audit: asSeller(f) })).rejects.toThrow(UnitNotFoundError);
  });

  it("lets the associate book from the hold they took: one hold, no second", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    await holdPlot(db, { unitId: plot.id, audit: asSeller(f) });

    const booked = await bookPlot(db, { unitId: plot.id, customer, audit: asSeller(f) });

    expect(booked.tookHold).toBe(false);
    expect(await db.unitHold.count({ where: { unitId: plot.id } })).toBe(1);
    expect((await db.booking.findUniqueOrThrow({ where: { id: booked.bookingId } })).status).toBe("DRAFT");
  });
});

describe("releasePlotHold", () => {
  const asSeller = (f: Awaited<ReturnType<typeof seedFixture>>) => ctx(ORG, f.seller.user, "seller");

  it("frees the plot for everyone, and records who released it and why", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    const held = await holdPlot(db, { unitId: plot.id, audit: asSeller(f) });

    await releasePlotHold(db, { unitId: plot.id, audit: asSeller(f) });

    expect((await unitState(plot.id)).status).toBe("AVAILABLE");
    const hold = await db.unitHold.findUniqueOrThrow({ where: { id: held.holdId } });
    expect(hold).toMatchObject({ releaseReason: "RELEASED_BY_ASSOCIATE", releasedById: f.seller.user.id });
    expect(hold.releasedAt).not.toBeNull();
    // The rival can now take it.
    expect((await holdPlot(db, { unitId: plot.id, audit: ctx(ORG, f.rival.user, "rival") })).tookHold).toBe(true);
  });

  it("refuses anyone but the holder, an admin, and a plot nobody holds", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    await expect(releasePlotHold(db, { unitId: plot.id, audit: asSeller(f) })).rejects.toThrow(PlotNotHeldError);

    await holdPlot(db, { unitId: plot.id, audit: asSeller(f) });
    await expect(releasePlotHold(db, { unitId: plot.id, audit: ctx(ORG, f.rival.user, "rival") })).rejects.toThrow(ForbiddenError);
    await expect(releasePlotHold(db, { unitId: plot.id, audit: ctx(ORG, f.admin.user, "admin") })).rejects.toThrow(ForbiddenError);
    expect((await unitState(plot.id)).status).toBe("HELD");

    await releasePlotHold(db, { unitId: plot.id, audit: asSeller(f) });
    await expect(releasePlotHold(db, { unitId: plot.id, audit: asSeller(f) })).rejects.toThrow(PlotNotHeldError);
  });

  it("will not drop a hold while a draft booking made from it waits for an admin", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    const booked = await bookPlot(db, { unitId: plot.id, customer, audit: asSeller(f) });

    await expect(releasePlotHold(db, { unitId: plot.id, audit: asSeller(f) })).rejects.toThrow(HoldHasDraftError);
    await expect(releasePlotHold(db, { unitId: plot.id, audit: asSeller(f) })).rejects.toThrow(new RegExp(booked.bookingNumber));
    expect((await unitState(plot.id)).status).toBe("HELD");
  });

  it("refuses a plot of another organisation", async () => {
    const f = await seedFixture();
    const other = await seedFixture(OTHER_ORG);
    await expect(releasePlotHold(db, { unitId: other.plots[0]!.id, audit: asSeller(f) })).rejects.toThrow(ForbiddenError);
  });
});

describe("getMyHolds", () => {
  const asSeller = (f: Awaited<ReturnType<typeof seedFixture>>) => ctx(ORG, f.seller.user, "seller");

  it("is null for an account with no associate profile", async () => {
    const f = await seedFixture();
    expect(await getMyHolds(db, { actorId: f.admin.user.id })).toBeNull();
  });

  it("lists the live holds with the quota, and marks the one that has a draft", async () => {
    const f = await seedFixture();
    await holdPlot(db, { unitId: f.plots[0]!.id, audit: asSeller(f) });
    const booked = await bookPlot(db, { unitId: f.plots[1]!.id, customer, audit: asSeller(f) });

    const summary = (await getMyHolds(db, { actorId: f.seller.user.id }))!;

    expect(summary).toMatchObject({ quota: 5, live: 2 });
    expect(summary.holds.map((hold) => hold.unitNumber).sort()).toEqual(["A-01", "A-02"]);
    const withDraft = summary.holds.find((hold) => hold.unitNumber === "A-02")!;
    expect(withDraft).toMatchObject({ draftBookingId: booked.bookingId, draftBookingNumber: booked.bookingNumber });
    expect(summary.holds.find((hold) => hold.unitNumber === "A-01")).toMatchObject({ draftBookingId: null });
    expect(summary.holds[0]).toMatchObject({ projectName: "Plots", projectId: f.project.id });
  });

  it("has no quota without a grade, and leaves out released and lapsed holds", async () => {
    const f = await seedFixture();
    const user = await db.user.create({
      data: { orgId: ORG, email: `nograde-${ORG}@test.local`, name: "nograde", passwordHash: "unused" },
    });
    await db.associate.create({
      data: { orgId: ORG, userId: user.id, code: "A-nograde", engagementType: "CHANNEL_PARTNER", joinDate: new Date("2024-01-01") },
    });
    expect(await getMyHolds(db, { actorId: user.id })).toEqual({ quota: 0, live: 0, holds: [] });

    await holdPlot(db, { unitId: f.plots[0]!.id, audit: asSeller(f) });
    await holdPlot(db, { unitId: f.plots[1]!.id, audit: asSeller(f) });
    await holdPlot(db, { unitId: f.plots[2]!.id, audit: asSeller(f) });
    await releasePlotHold(db, { unitId: f.plots[1]!.id, audit: asSeller(f) });
    await db.unitHold.updateMany({ where: { unitId: f.plots[2]!.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });

    const summary = (await getMyHolds(db, { actorId: f.seller.user.id }))!;
    expect(summary.live).toBe(1);
    expect(summary.holds.map((hold) => hold.unitNumber)).toEqual(["A-01"]);
  });
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

  it("books and confirms a plot on a project with no RERA registration, which is not required", async () => {
    const f = await seedFixture();
    const plot = f.plots[0]!;
    await db.project.update({ where: { id: f.project.id }, data: { reraRegNo: null, reraValidTill: null } });

    const booked = await bookPlot(db, { unitId: plot.id, customer, audit: ctx(ORG, f.seller.user, "seller") });
    const confirmed = await confirmBooking(db, { bookingId: booked.bookingId, audit: ctx(ORG, f.admin.user, "admin") });

    expect(confirmed.status).toBe("CONFIRMED");
    expect((await unitState(plot.id)).status).toBe("BOOKED");
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

describe("an admin with an associate profile", () => {
  // What the Admin role holds once it is given hold.create and booking.create, and
  // what ensureAdminAssociateProfile gives the account: the same path an associate
  // takes, under the admin's own profile and grade.
  async function makeSellingAdmin(_f: Awaited<ReturnType<typeof seedFixture>>) {
    return makeUser(ORG, "bossadmin", ["booking.create", "hold.create", "booking.confirm", "booking.read"], { associate: true });
  }

  it("holds and books a plot as themselves, counted against their own quota", async () => {
    const f = await seedFixture();
    const boss = await makeSellingAdmin(f);

    const held = await holdPlot(db, { unitId: f.plots[0]!.id, audit: ctx(ORG, boss.user, "boss") });
    expect(held.tookHold).toBe(true);

    const booked = await bookPlot(db, { unitId: f.plots[0]!.id, customer, audit: ctx(ORG, boss.user, "boss") });
    expect(booked.tookHold).toBe(false);
    const booking = await db.booking.findUniqueOrThrow({ where: { id: booked.bookingId } });
    expect(booking.sellingAssociateId).toBe(boss.associate!.id);

    const mine = await getMyHolds(db, { actorId: boss.user.id });
    expect(mine).toMatchObject({ quota: 5, live: 1 });
    // ...and not against anyone else's.
    expect((await getMyHolds(db, { actorId: f.seller.user.id }))?.live).toBe(0);
  });

  it("is refused a plot another associate holds, like anyone else", async () => {
    const f = await seedFixture();
    const boss = await makeSellingAdmin(f);
    await holdPlot(db, { unitId: f.plots[0]!.id, audit: ctx(ORG, f.seller.user, "seller") });

    await expect(holdPlot(db, { unitId: f.plots[0]!.id, audit: ctx(ORG, boss.user, "boss") })).rejects.toThrow(
      UnitNotAvailableError,
    );
  });

  it("can confirm the booking they made: the seller-never-confirms rule is the associate's, not the admin's", async () => {
    const f = await seedFixture();
    const boss = await makeSellingAdmin(f);
    const booked = await bookPlot(db, { unitId: f.plots[0]!.id, customer, audit: ctx(ORG, boss.user, "boss") });

    const confirmed = await confirmBooking(db, { bookingId: booked.bookingId, audit: ctx(ORG, boss.user, "boss") });
    expect(confirmed.status).toBe("CONFIRMED");
  });
});
