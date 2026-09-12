// The Invariant Monitor GATE -- Phase 3 Slice 7. runInvariantChecks scans
// the WHOLE database (not scoped to one org, matching a real nightly run),
// so these tests never assert a blanket "ok: true" -- other test files'
// fixtures can be live at the same time under Vitest's parallel file
// execution. Instead: assert a specific violation naming OUR id appears (or
// does not appear) among whatever else the scan finds.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, getPrismaClient } from "@desire/db";
import { runInvariantChecks } from "../src/invariant-monitor";

const db = getPrismaClient();
const ORG = "org_test_invariant_monitor";
const D = (v: string | number) => new Prisma.Decimal(v);

async function reset() {
  await db.payoutBatch.deleteMany({ where: { orgId: ORG } });
  await db.commissionEntry.deleteMany({ where: { orgId: ORG } });
  await db.commissionScheme.deleteMany({ where: { orgId: ORG } });
  await db.receiptAllocation.deleteMany({ where: { demand: { orgId: ORG } } });
  await db.receipt.deleteMany({ where: { orgId: ORG } });
  await db.demand.deleteMany({ where: { orgId: ORG } });
  await db.booking.deleteMany({ where: { orgId: ORG } });
  await db.customer.deleteMany({ where: { orgId: ORG } });
  await db.priceList.deleteMany({ where: { orgId: ORG } });
  await db.unit.deleteMany({ where: { orgId: ORG } });
  await db.unitType.deleteMany({ where: { orgId: ORG } });
  await db.auditLog.deleteMany({ where: { orgId: ORG } });
  await db.associateHierarchy.deleteMany({ where: { associate: { orgId: ORG } } });
  await db.associate.deleteMany({ where: { orgId: ORG } });
  await db.user.deleteMany({ where: { orgId: ORG } });
  await db.project.deleteMany({ where: { orgId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedOrgProjectAndAssociate(label: string) {
  await db.organization.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: "Invariant Monitor Test Org", legalName: "Invariant Monitor Test Org Pvt Ltd" } });
  const project = await db.project.create({
    data: { orgId: ORG, code: `IM${Math.random().toString(36).slice(2, 8)}`, name: "IM Project", city: "Pune", state: "Maharashtra", reraRegNo: `P-IM-${Math.random()}`, reraValidTill: new Date("2030-01-01") },
  });
  const user = await db.user.create({ data: { orgId: ORG, email: `${label}-${Math.random()}@test.local`, name: label, passwordHash: "unused" } });
  const associate = await db.associate.create({
    data: { orgId: ORG, userId: user.id, code: `A-${label}-${Math.random().toString(36).slice(2, 6)}`, engagementType: "EMPLOYEE", joinDate: new Date("2020-01-01"), status: "ACTIVE" },
  });
  return { project, user, associate };
}

async function seedBooking(projectId: string, sellingAssociateId: string, commissionableValue: string) {
  const unitType = await db.unitType.create({
    data: { orgId: ORG, projectId, code: `UT${Math.random().toString(36).slice(2, 6)}`, name: "3BHK", carpetArea: "700.00", builtUpArea: "850.00", saleableArea: "1000.00" },
  });
  const unit = await db.unit.create({ data: { orgId: ORG, projectId, unitTypeId: unitType.id, unitNumber: `U-${Math.random().toString(36).slice(2, 6)}`, floor: 1 } });
  const priceList = await db.priceList.create({
    data: { orgId: ORG, projectId, version: 1, name: "v1", status: "ACTIVE", validFrom: new Date("2020-01-01"), preparedById: "u_test" },
  });
  const customer = await db.customer.create({ data: { orgId: ORG, name: "Test Buyer", phone: "9999999999" } });
  return db.booking.create({
    data: {
      orgId: ORG, projectId, unitId: unit.id, customerId: customer.id, bookingNumber: `BK-${Math.random().toString(36).slice(2, 8)}`, bookingDate: new Date("2026-01-10"),
      status: "CONFIRMED", sellingAssociateId, priceListId: priceList.id,
      baseAmount: commissionableValue, agreementValue: commissionableValue, commissionableValue,
      saleableAreaAtBooking: "1000.00", carpetAreaAtBooking: "700.00",
    },
  });
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("commission invariants", () => {
  it("catches a booking whose entries exceed the scheme's maxTotalPct ceiling", async () => {
    const { project, associate } = await seedOrgProjectAndAssociate("comm");
    const scheme = await db.commissionScheme.create({
      data: { orgId: ORG, projectId: project.id, name: "v1", version: 1, status: "DRAFT", validFrom: new Date("2020-01-01"), baseDefinition: {}, maxTotalPct: "3.0", preparedById: "u_test" },
    });
    const booking = await seedBooking(project.id, associate.id, "1000000"); // ceiling = 30,000
    await db.commissionEntry.create({
      data: {
        orgId: ORG, bookingId: booking.id, schemeId: scheme.id, beneficiaryAssociateId: associate.id, role: "SELF", level: 0,
        baseAmount: D("1000000"), grossAmount: D("50000"), status: "ACCRUED", snapshot: { schemeVersion: 1 },
        idempotencyKey: `${booking.id}:${associate.id}:0:${scheme.id}`,
      },
    });

    const result = await runInvariantChecks(db);
    expect(result.violations.some((v) => v.invariant === "commission.max_total_pct" && v.detail.includes(booking.id))).toBe(true);
  });

  it("does not flag a booking whose entries stay within the ceiling", async () => {
    const { project, associate } = await seedOrgProjectAndAssociate("commok");
    const scheme = await db.commissionScheme.create({
      data: { orgId: ORG, projectId: project.id, name: "v1", version: 1, status: "DRAFT", validFrom: new Date("2020-01-01"), baseDefinition: {}, maxTotalPct: "3.0", preparedById: "u_test" },
    });
    const booking = await seedBooking(project.id, associate.id, "1000000");
    await db.commissionEntry.create({
      data: {
        orgId: ORG, bookingId: booking.id, schemeId: scheme.id, beneficiaryAssociateId: associate.id, role: "SELF", level: 0,
        baseAmount: D("1000000"), grossAmount: D("15000"), status: "ACCRUED", snapshot: { schemeVersion: 1 },
        idempotencyKey: `${booking.id}:${associate.id}:0:${scheme.id}`,
      },
    });

    const result = await runInvariantChecks(db);
    expect(result.violations.some((v) => v.detail.includes(booking.id))).toBe(false);
  });
});

describe("inventory invariants", () => {
  it("catches a BOOKED unit with zero CONFIRMED bookings", async () => {
    const { project } = await seedOrgProjectAndAssociate("inv");
    const unitType = await db.unitType.create({
      data: { orgId: ORG, projectId: project.id, code: "UTINV", name: "3BHK", carpetArea: "700.00", builtUpArea: "850.00", saleableArea: "1000.00" },
    });
    const unit = await db.unit.create({ data: { orgId: ORG, projectId: project.id, unitTypeId: unitType.id, unitNumber: "U-INV", floor: 1, status: "BOOKED" } });

    const result = await runInvariantChecks(db);
    expect(result.violations.some((v) => v.invariant === "inventory.booked_unit_has_one_confirmed_booking" && v.detail.includes(unit.id))).toBe(true);
  });
});

describe("collections invariants", () => {
  it("catches a receipt whose allocations exceed its own amount", async () => {
    const { project, associate } = await seedOrgProjectAndAssociate("coll");
    const booking = await seedBooking(project.id, associate.id, "1000000");
    const receipt = await db.receipt.create({
      data: { orgId: ORG, bookingId: booking.id, receiptNumber: `RCPT-${Math.random()}`, amount: "10000", mode: "NEFT", status: "VERIFIED", receivedOn: new Date(), enteredById: associate.userId },
    });
    const demand = await db.demand.create({
      data: { orgId: ORG, bookingId: booking.id, sequence: 1, description: "On booking", amount: "50000", dueDate: new Date("2026-02-01"), status: "RAISED" },
    });
    await db.receiptAllocation.create({ data: { receiptId: receipt.id, demandId: demand.id, amount: "20000" } }); // over the receipt's own 10,000

    const result = await runInvariantChecks(db);
    expect(result.violations.some((v) => v.invariant === "collections.allocations_not_exceed_receipt" && v.detail.includes(receipt.id))).toBe(true);
  });
});

describe("network & duties invariants: receipt verification separation of duties", () => {
  it("catches a receipt entered and verified by the same person", async () => {
    const { project, associate } = await seedOrgProjectAndAssociate("dup");
    const booking = await seedBooking(project.id, associate.id, "1000000");
    const receipt = await db.receipt.create({
      data: {
        orgId: ORG, bookingId: booking.id, receiptNumber: `RCPT-${Math.random()}`, amount: "10000", mode: "NEFT", status: "VERIFIED",
        receivedOn: new Date(), enteredById: associate.userId, verifiedById: associate.userId, verifiedAt: new Date(),
      },
    });

    const result = await runInvariantChecks(db);
    expect(result.violations.some((v) => v.invariant === "network.receipt_verification_separation_of_duties" && v.detail.includes(receipt.id))).toBe(true);
  });

  it("catches a receipt verified by the booking's own selling associate (different enterer)", async () => {
    const { project, associate: seller } = await seedOrgProjectAndAssociate("sellerverify");
    const enterer = await seedOrgProjectAndAssociate("enterer");
    const booking = await seedBooking(project.id, seller.id, "1000000");
    const receipt = await db.receipt.create({
      data: {
        orgId: ORG, bookingId: booking.id, receiptNumber: `RCPT-${Math.random()}`, amount: "10000", mode: "NEFT", status: "VERIFIED",
        receivedOn: new Date(), enteredById: enterer.user.id, verifiedById: seller.userId, verifiedAt: new Date(),
      },
    });

    const result = await runInvariantChecks(db);
    expect(result.violations.some((v) => v.invariant === "network.receipt_verification_separation_of_duties" && v.detail.includes(receipt.id))).toBe(true);
  });

  it("does not flag a receipt verified by an unrelated associate", async () => {
    const { project, associate: seller } = await seedOrgProjectAndAssociate("sellerok");
    const { user: entererUser } = await seedOrgProjectAndAssociate("entererok");
    const { user: verifierUser } = await seedOrgProjectAndAssociate("verifierok");
    const booking = await seedBooking(project.id, seller.id, "1000000");
    const receipt = await db.receipt.create({
      data: {
        orgId: ORG, bookingId: booking.id, receiptNumber: `RCPT-${Math.random()}`, amount: "10000", mode: "NEFT", status: "VERIFIED",
        receivedOn: new Date(), enteredById: entererUser.id, verifiedById: verifierUser.id, verifiedAt: new Date(),
      },
    });

    const result = await runInvariantChecks(db);
    expect(result.violations.some((v) => v.invariant === "network.receipt_verification_separation_of_duties" && v.detail.includes(receipt.id))).toBe(false);
  });
});

describe("network & duties invariants", () => {
  it("catches a second live AssociateHierarchy row for one associate", async () => {
    const { associate } = await seedOrgProjectAndAssociate("net");
    await db.associateHierarchy.create({ data: { associateId: associate.id, parentId: null, path: "/", depth: 0, validFrom: new Date("2020-01-01") } });
    await db.associateHierarchy.create({ data: { associateId: associate.id, parentId: null, path: "/", depth: 0, validFrom: new Date("2021-01-01") } });

    const result = await runInvariantChecks(db);
    expect(result.violations.some((v) => v.invariant === "network.one_live_hierarchy_row_per_associate" && v.detail.includes(associate.id))).toBe(true);
  });

  it("catches an associate hierarchy row that names them as their own ancestor", async () => {
    const { associate } = await seedOrgProjectAndAssociate("netanc");
    await db.associateHierarchy.create({ data: { associateId: associate.id, parentId: null, path: `/${associate.id}/`, depth: 1, validFrom: new Date("2020-01-01") } });

    const result = await runInvariantChecks(db);
    expect(result.violations.some((v) => v.invariant === "network.not_own_ancestor" && v.detail.includes(associate.id))).toBe(true);
  });

  it("catches a payout batch approved by its own preparer", async () => {
    await seedOrgProjectAndAssociate("payout");
    const preparer = await db.user.findFirstOrThrow({ where: { orgId: ORG } });
    const batch = await db.payoutBatch.create({
      data: { orgId: ORG, batchNumber: `PB-${Math.random()}`, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-02-01"), status: "APPROVED", preparedById: preparer.id, approvedById: preparer.id },
    });

    const result = await runInvariantChecks(db);
    expect(result.violations.some((v) => v.invariant === "network.payout_batch_maker_checker" && v.detail.includes(batch.id))).toBe(true);
  });

  it("does not flag a normally-placed associate (one live row, not their own ancestor)", async () => {
    const { associate } = await seedOrgProjectAndAssociate("netok");
    await db.associateHierarchy.create({ data: { associateId: associate.id, parentId: null, path: "/", depth: 0, validFrom: new Date("2020-01-01") } });

    const result = await runInvariantChecks(db);
    expect(result.violations.some((v) => v.detail.includes(associate.id))).toBe(false);
  });
});
