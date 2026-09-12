// Cancellation + clawback preview -- Phase 2 Slice 2 (PROGRESS.md,
// docs/06-INVENTORY-SPEC.md, docs/08-SCREENS.md). Runs against LOCAL Docker
// Postgres. No commission-accrual service exists yet (Phase 3, not this
// slice) -- CommissionEntry/CommissionRelease rows are seeded directly here
// to exercise computeClawback's real caller, exactly as previewCancellation
// and cancelBooking will read them once accrual is wired.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import { acquireHold } from "../src/holds";
import { type ChargeHeadSpec } from "../src/cost-sheet";
import {
  BookingNotCancellableError,
  BookingNotFoundError,
  CancellationReasonRequiredError,
  cancelBooking,
  confirmBooking,
  createDraftBooking,
  previewCancellation,
} from "../src/bookings";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_cancellation";
const OTHER_ORG = "org_test_cancellation_other";
const D = (v: string | number) => new Prisma.Decimal(v);

async function reset() {
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.recovery.deleteMany({ where: { orgId } });
    await db.commissionRelease.deleteMany({ where: { entry: { orgId } } });
    await db.commissionEntry.deleteMany({ where: { orgId } });
    await db.commissionScheme.deleteMany({ where: { orgId } });
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
  // Permission is global config -- upsert-if-missing only, never deleted
  // here (the parallel-test-file race this project already fixed once).
}

async function makeUser(
  orgId: string,
  label: string,
  codes: string[],
  opts: { associate?: boolean } = {},
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
      where: { orgId_code: { orgId, code: "GT" } },
      update: {},
      create: { orgId, code: "GT", name: "Test Grade", rank: 1, holdQuota: 5 },
    });
    associate = await db.associate.create({
      data: { orgId, userId: user.id, code: `A-${label}`, engagementType: "EMPLOYEE", joinDate: new Date("2024-01-01") },
    });
    await db.associateGrade.create({
      data: { associateId: associate.id, gradeId: grade.id, validFrom: new Date("2024-01-01") },
    });
  }
  return { user, associate };
}

async function seedChargeHeads(orgId: string) {
  const heads: Array<Omit<ChargeHeadSpec, "gstRatePct"> & { gstRatePct: string | null }> = [
    { code: "BSP", name: "Basic Sale Price", category: "BASE_PRICE", isTaxable: true, gstRatePct: "5.00", countsTowardCommission: true, displayOrder: 1 },
  ];
  for (const h of heads) {
    await db.chargeHead.create({ data: { orgId, ...h, isRefundable: false } });
  }
}

async function seedFixture(orgId: string = ORG) {
  await db.organization.create({ data: { id: orgId, name: "Cancellation Test Org", legalName: "Cancellation Test Org Pvt Ltd" } });
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
  const unit = await db.unit.create({
    data: { orgId, projectId: project.id, unitTypeId: unitType.id, unitNumber: "A-1", floor: 1 },
  });
  await seedChargeHeads(orgId);
  const priceList = await db.priceList.create({
    data: {
      orgId, projectId: project.id, version: 1, name: "v1", status: "ACTIVE",
      validFrom: new Date("2020-01-01"), preparedById: "u_test",
      items: { create: [{ unitTypeId: unitType.id, baseRatePerSqft: "5000.00", plcCharges: {}, otherCharges: [] }] },
    },
  });
  const customer = await db.customer.create({ data: { orgId, name: "Test Buyer", phone: "9999999999" } });

  // Deliberately NOT status: ACTIVE -- this scheme exists only as a foreign
  // key for seedEntry's manually-controlled CommissionEntry rows (this
  // file's own comment: "no accrual service exists yet -- Phase 3"). Now
  // that confirmBooking's own accrueCommission (Phase 3 Slice 2) genuinely
  // resolves and runs accrue() against whichever scheme IS active, keeping
  // this one DRAFT means confirmBooking accrues nothing on its own, leaving
  // seedEntry's manually-seeded entries as the only ones -- exactly what
  // every assertion in this file already expects.
  const scheme = await db.commissionScheme.create({
    data: {
      orgId, projectId: project.id, name: "Standard", version: 1, status: "DRAFT",
      validFrom: new Date("2020-01-01"), baseDefinition: { chargeHeadCodes: ["BSP"] },
      preparedById: "u_test",
    },
  });

  const admin = await makeUser(orgId, "admin", ["booking.create", "booking.confirm", "booking.cancel", "hold.create"]);
  const seller = await makeUser(orgId, "seller", ["booking.create", "hold.create"], { associate: true });
  const upline = await makeUser(orgId, "upline", [], { associate: true });

  return { project, unitType, unit, priceList, customer, scheme, admin, seller, upline };
}

function ctx(orgId: string, userId: string | null, label: string): AuditContext {
  return { orgId, actorId: userId, actorLabel: label };
}

/** Drafts and confirms a real booking, returning it CONFIRMED with the unit
 *  BOOKED -- the one state cancelBooking accepts. Pass unitId to book a
 *  second, separate unit (each unit can only be booked once). */
async function confirmedBooking(f: Awaited<ReturnType<typeof seedFixture>>, orgId: string = ORG, unitId?: string) {
  const targetUnitId = unitId ?? f.unit.id;
  await acquireHold(db, { orgId, unitId: targetUnitId, associateId: f.seller.associate!.id, audit: ctx(orgId, f.seller.user.id, "seller") });
  const draft = await createDraftBooking(db, {
    unitId: targetUnitId, priceListId: f.priceList.id, customerId: f.customer.id,
    audit: ctx(orgId, f.seller.user.id, "seller"),
  });
  return confirmBooking(db, { bookingId: draft.id, audit: ctx(orgId, f.admin.user.id, "admin") });
}

/** Seeds one CommissionEntry directly (no accrual service exists yet --
 *  Phase 3) plus optional non-reversed CommissionRelease rows against it. */
async function seedEntry(
  f: Awaited<ReturnType<typeof seedFixture>>,
  booking: { id: string; orgId: string },
  params: { beneficiaryAssociateId: string; grossAmount: string; releases?: string[] },
) {
  const entry = await db.commissionEntry.create({
    data: {
      orgId: booking.orgId,
      bookingId: booking.id,
      schemeId: f.scheme.id,
      beneficiaryAssociateId: params.beneficiaryAssociateId,
      role: "SELF",
      level: 0,
      baseAmount: D(params.grossAmount),
      grossAmount: D(params.grossAmount),
      status: "PAYABLE",
      snapshot: {},
      idempotencyKey: `${booking.id}:${params.beneficiaryAssociateId}:0:${f.scheme.id}`,
    },
  });
  for (const [i, amount] of (params.releases ?? []).entries()) {
    await db.commissionRelease.create({
      data: { entryId: entry.id, triggerType: "COLLECTION_PCT", triggerRef: `receipt-${i}`, cumulativePct: D("100"), amount: D(amount) },
    });
  }
  return entry;
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("cancelBooking only accepts a CONFIRMED booking", () => {
  it("succeeds against a CONFIRMED booking, moving the unit back to AVAILABLE", async () => {
    const f = await seedFixture();
    const confirmed = await confirmedBooking(f);

    const cancelled = await cancelBooking(db, {
      bookingId: confirmed.id,
      reason: "Buyer backed out",
      audit: ctx(ORG, f.admin.user.id, "admin"),
    });

    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancellationReason).toBe("Buyer backed out");
    expect(cancelled.cancelledById).toBe(f.admin.user.id);

    const unit = await db.unit.findUniqueOrThrow({ where: { id: f.unit.id } });
    expect(unit.status).toBe("AVAILABLE");
    expect(unit.currentHoldId).toBeNull();

    const history = await db.bookingStatusHistory.findMany({ where: { bookingId: confirmed.id }, orderBy: { id: "asc" } });
    expect(history.map((h) => h.toStatus)).toEqual(["DRAFT", "CONFIRMED", "CANCELLED"]);
  });

  it("refuses a DRAFT booking", async () => {
    const f = await seedFixture();
    await acquireHold(db, { orgId: ORG, unitId: f.unit.id, associateId: f.seller.associate!.id, audit: ctx(ORG, f.seller.user.id, "seller") });
    const draft = await createDraftBooking(db, {
      unitId: f.unit.id, priceListId: f.priceList.id, customerId: f.customer.id,
      audit: ctx(ORG, f.seller.user.id, "seller"),
    });

    await expect(
      cancelBooking(db, { bookingId: draft.id, reason: "test", audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(BookingNotCancellableError);
  });

  it("refuses an already-CANCELLED booking (no double cancel)", async () => {
    const f = await seedFixture();
    const confirmed = await confirmedBooking(f);
    await cancelBooking(db, { bookingId: confirmed.id, reason: "first", audit: ctx(ORG, f.admin.user.id, "admin") });

    await expect(
      cancelBooking(db, { bookingId: confirmed.id, reason: "second", audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(BookingNotCancellableError);
  });

  it("refuses a non-existent booking", async () => {
    const f = await seedFixture();
    await expect(
      cancelBooking(db, { bookingId: "does-not-exist", reason: "test", audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(BookingNotFoundError);
  });

  it("refuses a booking belonging to another organisation", async () => {
    const f = await seedFixture(ORG);
    const otherFixture = await seedFixture(OTHER_ORG);
    const confirmed = await confirmedBooking(otherFixture, OTHER_ORG);

    await expect(
      cancelBooking(db, { bookingId: confirmed.id, reason: "test", audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("cancelBooking requires permission and a reason", () => {
  it("refuses a caller without booking.cancel", async () => {
    const f = await seedFixture();
    const confirmed = await confirmedBooking(f);

    await expect(
      cancelBooking(db, { bookingId: confirmed.id, reason: "test", audit: ctx(ORG, f.seller.user.id, "seller") }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses an empty reason", async () => {
    const f = await seedFixture();
    const confirmed = await confirmedBooking(f);

    await expect(
      cancelBooking(db, { bookingId: confirmed.id, reason: "   ", audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(CancellationReasonRequiredError);
  });
});

describe("clawback preview and cancellation agree on the same computation", () => {
  it("with no commission entries, both report an empty clawback", async () => {
    const f = await seedFixture();
    const confirmed = await confirmedBooking(f);

    const preview = await previewCancellation(db, { bookingId: confirmed.id, orgId: ORG });
    expect(preview).toEqual([]);

    const cancelled = await cancelBooking(db, { bookingId: confirmed.id, reason: "test", audit: ctx(ORG, f.admin.user.id, "admin") });
    expect(cancelled.clawback).toEqual([]);
  });

  it("fully released with no other pending payable: entire amount becomes a Recovery", async () => {
    const f = await seedFixture();
    const confirmed = await confirmedBooking(f);
    const entry = await seedEntry(f, confirmed, { beneficiaryAssociateId: f.seller.associate!.id, grossAmount: "50000", releases: ["50000"] });

    const preview = await previewCancellation(db, { bookingId: confirmed.id, orgId: ORG });
    expect(preview).toHaveLength(1);
    expect(preview[0]!.commissionEntryId).toBe(entry.id);
    expect(preview[0]!.releasedTotal).toBe("50000.00");
    expect(preview[0]!.contraAmount).toBe("-50000.00");
    expect(preview[0]!.nettedAgainstPending).toBe("0.00");
    expect(preview[0]!.recoveryAmount).toBe("50000.00");

    const cancelled = await cancelBooking(db, { bookingId: confirmed.id, reason: "test", audit: ctx(ORG, f.admin.user.id, "admin") });
    expect(cancelled.clawback).toEqual(preview);

    const original = await db.commissionEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(original.status).toBe("REVERSED");

    const contra = await db.commissionEntry.findFirstOrThrow({ where: { sourceEntryId: entry.id } });
    expect(contra.grossAmount.toString()).toBe("-50000");
    expect(contra.status).toBe("REVERSED");

    const recovery = await db.recovery.findFirstOrThrow({ where: { sourceEntryId: entry.id } });
    expect(recovery.associateId).toBe(f.seller.associate!.id);
    expect(recovery.amount.toString()).toBe("50000");
    expect(recovery.outstandingAmount.toString()).toBe("50000");
    expect(recovery.status).toBe("OUTSTANDING");
  });

  it("fully released but netted entirely against the beneficiary's other pending payable: no Recovery", async () => {
    const f = await seedFixture();
    const confirmed = await confirmedBooking(f);
    // A second, unrelated booking (its own unit -- a unit can only be
    // booked once) whose PAYABLE entry for the same beneficiary is the
    // "other pending payable" computeClawback nets against first.
    const secondUnit = await db.unit.create({
      data: { orgId: ORG, projectId: f.project.id, unitTypeId: f.unitType.id, unitNumber: "A-2", floor: 1 },
    });
    const otherBooking = await confirmedBooking(f, ORG, secondUnit.id);
    await seedEntry(f, otherBooking, { beneficiaryAssociateId: f.seller.associate!.id, grossAmount: "80000" });
    const entry = await seedEntry(f, confirmed, { beneficiaryAssociateId: f.seller.associate!.id, grossAmount: "50000", releases: ["50000"] });

    const preview = await previewCancellation(db, { bookingId: confirmed.id, orgId: ORG });
    expect(preview).toHaveLength(1);
    expect(preview[0]!.commissionEntryId).toBe(entry.id);
    expect(preview[0]!.nettedAgainstPending).toBe("50000.00"); // capped at releasedTotal, not the full 80000 pending
    expect(preview[0]!.recoveryAmount).toBe("0.00");

    await cancelBooking(db, { bookingId: confirmed.id, reason: "test", audit: ctx(ORG, f.admin.user.id, "admin") });
    expect(await db.recovery.count({ where: { sourceEntryId: entry.id } })).toBe(0);
  });

  it("partially released: only the released portion is clawed back", async () => {
    const f = await seedFixture();
    const confirmed = await confirmedBooking(f);
    await seedEntry(f, confirmed, { beneficiaryAssociateId: f.seller.associate!.id, grossAmount: "100000", releases: ["30000"] });

    const preview = await previewCancellation(db, { bookingId: confirmed.id, orgId: ORG });
    expect(preview[0]!.releasedTotal).toBe("30000.00");
    expect(preview[0]!.contraAmount).toBe("-30000.00");
    expect(preview[0]!.recoveryAmount).toBe("30000.00");

    const cancelled = await cancelBooking(db, { bookingId: confirmed.id, reason: "test", audit: ctx(ORG, f.admin.user.id, "admin") });
    const contra = cancelled.clawback[0]!;
    expect(contra.grossAmount).toBe("100000"); // the ORIGINAL entry's gross, untouched (ADR-0006) -- not clawed-back amount
  });

  it("ignores a reversed CommissionRelease when summing releasedTotal", async () => {
    const f = await seedFixture();
    const confirmed = await confirmedBooking(f);
    const entry = await seedEntry(f, confirmed, { beneficiaryAssociateId: f.seller.associate!.id, grossAmount: "50000", releases: ["50000"] });
    await db.commissionRelease.updateMany({ where: { entryId: entry.id }, data: { reversedAt: new Date("2026-01-01"), reversalReason: "bounced" } });

    const preview = await previewCancellation(db, { bookingId: confirmed.id, orgId: ORG });
    expect(preview[0]!.releasedTotal).toBe("0.00");
    expect(preview[0]!.recoveryAmount).toBe("0.00");
  });

  it("handles multiple entries (SELF + OVERRIDE) independently", async () => {
    const f = await seedFixture();
    const confirmed = await confirmedBooking(f);
    const selfEntry = await seedEntry(f, confirmed, { beneficiaryAssociateId: f.seller.associate!.id, grossAmount: "40000", releases: ["40000"] });
    const overrideEntry = await seedEntry(f, confirmed, { beneficiaryAssociateId: f.upline.associate!.id, grossAmount: "10000", releases: ["10000"] });

    const preview = await previewCancellation(db, { bookingId: confirmed.id, orgId: ORG });
    expect(preview).toHaveLength(2);
    const byId = new Map(preview.map((l) => [l.commissionEntryId, l]));
    expect(byId.get(selfEntry.id)!.recoveryAmount).toBe("40000.00");
    expect(byId.get(overrideEntry.id)!.recoveryAmount).toBe("10000.00");
  });

  it("previewCancellation throws for a non-existent booking and never mutates", async () => {
    await seedFixture();
    await expect(previewCancellation(db, { bookingId: "nope", orgId: ORG })).rejects.toThrow(BookingNotFoundError);
  });
});

describe("audit: cancellation writes one UPDATE audit row on the booking", () => {
  it("records before/after status and the reason", async () => {
    const f = await seedFixture();
    const confirmed = await confirmedBooking(f);

    await cancelBooking(db, { bookingId: confirmed.id, reason: "Buyer requested refund", audit: ctx(ORG, f.admin.user.id, "admin") });

    const auditRow = await db.auditLog.findFirstOrThrow({
      where: { entity: "Booking", entityId: confirmed.id, action: "UPDATE" },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow.reason).toBe("Buyer requested refund");
    expect((auditRow.before as { status?: string })?.status).toBe("CONFIRMED");
    expect((auditRow.after as { status?: string })?.status).toBe("CANCELLED");
  });
});
