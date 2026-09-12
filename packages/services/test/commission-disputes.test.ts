// Dispute workflow -- Phase 3 Slice 6. Runs against real Postgres.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import {
  CommissionDisputeNotFoundError,
  DisputeAlreadyResolvedError,
  DuplicateDisputeError,
  raiseDispute,
  resolveDispute,
} from "../src/commission";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_disputes";
const D = (v: string | number) => new Prisma.Decimal(v);

async function reset() {
  await db.commissionDispute.deleteMany({ where: { orgId: ORG } });
  await db.adjustment.deleteMany({ where: { orgId: ORG } });
  await db.commissionRelease.deleteMany({ where: { entry: { orgId: ORG } } });
  await db.commissionEntry.deleteMany({ where: { orgId: ORG } });
  await db.commissionScheme.deleteMany({ where: { orgId: ORG } });
  await db.booking.deleteMany({ where: { orgId: ORG } });
  await db.customer.deleteMany({ where: { orgId: ORG } });
  await db.priceList.deleteMany({ where: { orgId: ORG } });
  await db.unit.deleteMany({ where: { orgId: ORG } });
  await db.unitType.deleteMany({ where: { orgId: ORG } });
  await db.auditLog.deleteMany({ where: { orgId: ORG } });
  await db.associate.deleteMany({ where: { orgId: ORG } });
  await db.userRole.deleteMany({ where: { role: { orgId: ORG } } });
  await db.rolePermission.deleteMany({ where: { role: { orgId: ORG } } });
  await db.role.deleteMany({ where: { orgId: ORG } });
  await db.user.deleteMany({ where: { orgId: ORG } });
  await db.project.deleteMany({ where: { orgId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function makeUser(label: string, codes: string[]) {
  const user = await db.user.create({ data: { orgId: ORG, email: `${label}@test.local`, name: label, passwordHash: "unused" } });
  const role = await db.role.create({ data: { orgId: ORG, code: `ROLE_${label}`, name: label } });
  for (const code of codes) {
    const [resource, action] = code.split(".");
    const perm = await db.permission.upsert({ where: { code }, update: {}, create: { code, resource: resource!, action: action! } });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  }
  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });
  return user;
}

async function makeAssociate(label: string, codes: string[] = []) {
  const user = await makeUser(label, codes);
  const associate = await db.associate.create({
    data: { orgId: ORG, userId: user.id, code: `A-${label}`, engagementType: "EMPLOYEE", joinDate: new Date("2020-01-01"), status: "ACTIVE" },
  });
  return { user, associate };
}

async function seedFixture() {
  await db.organization.create({ data: { id: ORG, name: "Disputes Test Org", legalName: "Disputes Test Org Pvt Ltd" } });
  const project = await db.project.create({
    data: { orgId: ORG, code: "DISP", name: "Disputes Project", city: "Pune", state: "Maharashtra", reraRegNo: "P-DISP-1", reraValidTill: new Date("2030-01-01") },
  });
  const unitType = await db.unitType.create({
    data: { orgId: ORG, projectId: project.id, code: "3BHK", name: "3BHK", carpetArea: "700.00", builtUpArea: "850.00", saleableArea: "1000.00" },
  });
  const unit = await db.unit.create({ data: { orgId: ORG, projectId: project.id, unitTypeId: unitType.id, unitNumber: "A-1", floor: 1 } });
  const priceList = await db.priceList.create({
    data: { orgId: ORG, projectId: project.id, version: 1, name: "v1", status: "ACTIVE", validFrom: new Date("2020-01-01"), preparedById: "u_test" },
  });
  const customer = await db.customer.create({ data: { orgId: ORG, name: "Test Buyer", phone: "9999999999" } });
  const scheme = await db.commissionScheme.create({
    data: { orgId: ORG, projectId: project.id, name: "v1", version: 1, status: "DRAFT", validFrom: new Date("2020-01-01"), baseDefinition: { chargeHeadCodes: ["BSP"] }, preparedById: "u_test" },
  });
  const booking = await db.booking.create({
    data: {
      orgId: ORG, projectId: project.id, unitId: unit.id, customerId: customer.id, bookingNumber: "BK-DISP-1", bookingDate: new Date("2026-01-10"),
      status: "CONFIRMED", sellingAssociateId: (await makeAssociate("bookingseller")).associate.id, priceListId: priceList.id,
      baseAmount: "1000000", agreementValue: "1000000", commissionableValue: "1000000",
      saleableAreaAtBooking: "1000.00", carpetAreaAtBooking: "700.00",
    },
  });

  const { user: sellerUser, associate: seller } = await makeAssociate("seller", ["commission.read"]);
  const { user: strangerUser } = await makeAssociate("stranger", ["commission.read"]);
  const resolver = await makeUser("resolver", ["commission.dispute_resolve"]);

  return { project, booking, scheme, sellerUser, seller, strangerUser, resolver };
}

async function seedEntry(f: Awaited<ReturnType<typeof seedFixture>>, status: "ACCRUED" | "PAYABLE" = "ACCRUED") {
  return db.commissionEntry.create({
    data: {
      orgId: ORG, bookingId: f.booking.id, schemeId: f.scheme.id, beneficiaryAssociateId: f.seller.id, role: "SELF", level: 0,
      baseAmount: D("1000000"), grossAmount: D("15000"), status, snapshot: {},
      idempotencyKey: `${f.booking.id}:${f.seller.id}:0:${f.scheme.id}:${Math.random()}`,
    },
  });
}

function ctx(userId: string | null, label: string): AuditContext {
  return { orgId: ORG, actorId: userId, actorLabel: label };
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("raiseDispute", () => {
  it("creates a PENDING dispute and moves the entry to ON_HOLD", async () => {
    const f = await seedFixture();
    const entry = await seedEntry(f);

    const result = await raiseDispute(db, { entryId: entry.id, description: "Wrong grade applied", audit: ctx(f.sellerUser.id, "seller") });

    const dispute = await db.commissionDispute.findUniqueOrThrow({ where: { id: result.disputeId } });
    expect(dispute.status).toBe("PENDING");
    expect(dispute.raisedById).toBe(f.sellerUser.id);

    const refreshedEntry = await db.commissionEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(refreshedEntry.status).toBe("ON_HOLD");
  });

  it("refuses a stranger with no relation to the beneficiary", async () => {
    const f = await seedFixture();
    const entry = await seedEntry(f);
    await expect(
      raiseDispute(db, { entryId: entry.id, description: "test", audit: ctx(f.strangerUser.id, "stranger") }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses a second PENDING dispute on the same entry", async () => {
    const f = await seedFixture();
    const entry = await seedEntry(f);
    await raiseDispute(db, { entryId: entry.id, description: "first", audit: ctx(f.sellerUser.id, "seller") });
    await expect(
      raiseDispute(db, { entryId: entry.id, description: "second", audit: ctx(f.sellerUser.id, "seller") }),
    ).rejects.toThrow(DuplicateDisputeError);
  });
});

describe("resolveDispute", () => {
  it("REJECTED restores the entry to ACCRUED (no prior releases) with no adjustment", async () => {
    const f = await seedFixture();
    const entry = await seedEntry(f, "ACCRUED");
    const { disputeId } = await raiseDispute(db, { entryId: entry.id, description: "test", audit: ctx(f.sellerUser.id, "seller") });

    const result = await resolveDispute(db, { disputeId, resolution: "REJECTED", audit: ctx(f.resolver.id, "resolver") });
    expect(result.adjustmentId).toBeNull();

    const refreshedEntry = await db.commissionEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(refreshedEntry.status).toBe("ACCRUED");
    const dispute = await db.commissionDispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(dispute.status).toBe("REJECTED");
    expect(dispute.resolvedById).toBe(f.resolver.id);
  });

  it("restores a PAYABLE entry to PAYABLE (had a non-reversed release), not ACCRUED", async () => {
    const f = await seedFixture();
    const entry = await seedEntry(f, "PAYABLE");
    await db.commissionRelease.create({
      data: { entryId: entry.id, triggerType: "COLLECTION_PCT", triggerRef: "r1", cumulativePct: "50", amount: "7500" },
    });
    const { disputeId } = await raiseDispute(db, { entryId: entry.id, description: "test", audit: ctx(f.sellerUser.id, "seller") });

    await resolveDispute(db, { disputeId, resolution: "REJECTED", audit: ctx(f.resolver.id, "resolver") });
    const refreshedEntry = await db.commissionEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(refreshedEntry.status).toBe("PAYABLE");
  });

  it("APPROVED with an adjustmentAmount creates an Adjustment row and restores the entry", async () => {
    const f = await seedFixture();
    const entry = await seedEntry(f, "ACCRUED");
    const { disputeId } = await raiseDispute(db, { entryId: entry.id, description: "underpaid", audit: ctx(f.sellerUser.id, "seller") });

    const result = await resolveDispute(db, {
      disputeId, resolution: "APPROVED", resolutionNote: "Grade was wrong, crediting the difference",
      adjustmentAmount: "2000", audit: ctx(f.resolver.id, "resolver"),
    });
    expect(result.adjustmentId).not.toBeNull();

    const adjustment = await db.adjustment.findUniqueOrThrow({ where: { id: result.adjustmentId! } });
    expect(adjustment.type).toBe("CREDIT");
    expect(adjustment.amount.toString()).toBe("2000");
    expect(adjustment.associateId).toBe(f.seller.id);

    const refreshedEntry = await db.commissionEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(refreshedEntry.status).toBe("ACCRUED");
    const dispute = await db.commissionDispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(dispute.status).toBe("APPROVED");
    expect(dispute.adjustmentId).toBe(result.adjustmentId);
  });

  it("a negative adjustmentAmount creates a DEBIT", async () => {
    const f = await seedFixture();
    const entry = await seedEntry(f, "ACCRUED");
    const { disputeId } = await raiseDispute(db, { entryId: entry.id, description: "overpaid", audit: ctx(f.sellerUser.id, "seller") });

    const result = await resolveDispute(db, { disputeId, resolution: "APPROVED", adjustmentAmount: "-500", audit: ctx(f.resolver.id, "resolver") });
    const adjustment = await db.adjustment.findUniqueOrThrow({ where: { id: result.adjustmentId! } });
    expect(adjustment.type).toBe("DEBIT");
    expect(adjustment.amount.toString()).toBe("500");
  });

  it("refuses without commission.dispute_resolve", async () => {
    const f = await seedFixture();
    const entry = await seedEntry(f);
    const { disputeId } = await raiseDispute(db, { entryId: entry.id, description: "test", audit: ctx(f.sellerUser.id, "seller") });
    await expect(
      resolveDispute(db, { disputeId, resolution: "REJECTED", audit: ctx(f.sellerUser.id, "seller") }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses to resolve an already-resolved dispute", async () => {
    const f = await seedFixture();
    const entry = await seedEntry(f);
    const { disputeId } = await raiseDispute(db, { entryId: entry.id, description: "test", audit: ctx(f.sellerUser.id, "seller") });
    await resolveDispute(db, { disputeId, resolution: "REJECTED", audit: ctx(f.resolver.id, "resolver") });

    await expect(
      resolveDispute(db, { disputeId, resolution: "APPROVED", audit: ctx(f.resolver.id, "resolver") }),
    ).rejects.toThrow(DisputeAlreadyResolvedError);
  });

  it("throws for a dispute that does not exist", async () => {
    const f = await seedFixture();
    await expect(
      resolveDispute(db, { disputeId: "does-not-exist", resolution: "REJECTED", audit: ctx(f.resolver.id, "resolver") }),
    ).rejects.toThrow(CommissionDisputeNotFoundError);
  });
});
