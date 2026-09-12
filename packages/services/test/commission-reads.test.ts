// Read-only Phase 3 Slice 5: scheme simulator, explain drill-down, earnings
// screen. No mutation logic here -- reuses Slice 2's buildOrgSnapshot/
// accrue() plumbing and the existing scope resolvers.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import { createScheme } from "../src/schemes";
import {
  CommissionEntryNotFoundError,
  explainEntry,
  getEarnings,
  simulateScheme,
} from "../src/commission";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_commission_reads";
const D = (v: string | number) => new Prisma.Decimal(v);

async function reset() {
  await db.commissionRelease.deleteMany({ where: { entry: { orgId: ORG } } });
  await db.commissionEntry.deleteMany({ where: { orgId: ORG } });
  await db.schemeLevelRate.deleteMany({ where: { scheme: { orgId: ORG } } });
  await db.schemeGradeRate.deleteMany({ where: { scheme: { orgId: ORG } } });
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
  await db.associateGrade.deleteMany({ where: { associate: { orgId: ORG } } });
  await db.associate.deleteMany({ where: { orgId: ORG } });
  await db.userRole.deleteMany({ where: { role: { orgId: ORG } } });
  await db.rolePermission.deleteMany({ where: { role: { orgId: ORG } } });
  await db.role.deleteMany({ where: { orgId: ORG } });
  await db.user.deleteMany({ where: { orgId: ORG } });
  await db.project.deleteMany({ where: { orgId: ORG } });
  await db.grade.deleteMany({ where: { orgId: ORG } });
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

async function renameRole(fromCode: string, toCode: string) {
  const role = await db.role.findFirstOrThrow({ where: { orgId: ORG, code: fromCode } });
  await db.role.update({ where: { id: role.id }, data: { code: toCode } });
}

async function seedFixture() {
  await db.organization.create({ data: { id: ORG, name: "Reads Test Org", legalName: "Reads Test Org Pvt Ltd" } });
  const project = await db.project.create({
    data: { orgId: ORG, code: "READ", name: "Reads Project", city: "Pune", state: "Maharashtra", reraRegNo: "P-READ-1", reraValidTill: new Date("2030-01-01") },
  });
  const grade = await db.grade.create({ data: { orgId: ORG, code: "G4", name: "Manager", rank: 4 } });

  const { user: sellerUser, associate: seller } = await makeAssociate("seller", ["commission.read"]);
  await db.associateGrade.create({ data: { associateId: seller.id, gradeId: grade.id, validFrom: new Date("2020-01-01") } });

  const { user: strangerUser } = await makeAssociate("stranger", ["commission.read"]);

  const preparer = await makeUser("preparer", ["scheme.prepare", "scheme.simulate"]);
  const admin = await makeUser("admin", ["commission.read", "scheme.simulate"]);
  await renameRole("ROLE_admin", "SUPER_ADMIN");

  const unitType = await db.unitType.create({
    data: { orgId: ORG, projectId: project.id, code: "3BHK", name: "3BHK", carpetArea: "700.00", builtUpArea: "850.00", saleableArea: "1000.00" },
  });
  const unit = await db.unit.create({ data: { orgId: ORG, projectId: project.id, unitTypeId: unitType.id, unitNumber: "A-1", floor: 1 } });
  const priceList = await db.priceList.create({
    data: { orgId: ORG, projectId: project.id, version: 1, name: "v1", status: "ACTIVE", validFrom: new Date("2020-01-01"), preparedById: "u_test" },
  });
  const customer = await db.customer.create({ data: { orgId: ORG, name: "Test Buyer", phone: "9999999999" } });
  const booking = await db.booking.create({
    data: {
      orgId: ORG, projectId: project.id, unitId: unit.id, customerId: customer.id, bookingNumber: "BK-READS-1", bookingDate: new Date("2026-01-10"),
      status: "CONFIRMED", sellingAssociateId: seller.id, priceListId: priceList.id,
      baseAmount: "1000000", agreementValue: "1000000", commissionableValue: "1000000",
      saleableAreaAtBooking: "1000.00", carpetAreaAtBooking: "700.00",
    },
  });

  const draft = await createScheme(db, {
    projectId: project.id, name: "v1", validFrom: new Date("2020-01-01"),
    baseDefinition: { chargeHeadCodes: ["BSP"] }, maxTotalPct: "3.0",
    gradeRates: [{ gradeId: grade.id, rateValue: "1.5" }],
    audit: ctx(preparer.id, "preparer"),
  });

  return { project, grade, seller, sellerUser, strangerUser, preparer, admin, booking, schemeId: draft.schemeId };
}

function ctx(userId: string | null, label: string): AuditContext {
  return { orgId: ORG, actorId: userId, actorLabel: label };
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("simulateScheme: no writes", () => {
  it("produces the entries the scheme WOULD create, writing nothing", async () => {
    const f = await seedFixture();
    const before = await db.commissionEntry.count();

    const result = await simulateScheme(db, {
      schemeId: f.schemeId,
      hypotheticalBooking: {
        bookingDate: "2026-03-01", commissionableValue: "5000000", saleableAreaAtBooking: "500", sellerAssociateId: f.seller.id,
      },
      audit: ctx(f.preparer.id, "preparer"),
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.grossAmount.toString()).toBe("75000"); // 1.5% of 5,000,000
    expect(await db.commissionEntry.count()).toBe(before);
  });

  it("refuses without scheme.simulate", async () => {
    const f = await seedFixture();
    const noPerms = await makeUser("noperms", []);
    await expect(
      simulateScheme(db, {
        schemeId: f.schemeId,
        hypotheticalBooking: { bookingDate: "2026-03-01", commissionableValue: "5000000", saleableAreaAtBooking: "500", sellerAssociateId: f.seller.id },
        audit: ctx(noPerms.id, "noperms"),
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("explainEntry: scope enforcement", () => {
  async function seedRealEntry(f: Awaited<ReturnType<typeof seedFixture>>) {
    return db.commissionEntry.create({
      data: {
        orgId: ORG, bookingId: f.booking.id, schemeId: f.schemeId, beneficiaryAssociateId: f.seller.id, role: "SELF", level: 0,
        baseAmount: D("1000000"), grossAmount: D("15000"), status: "ACCRUED",
        snapshot: { gradeCode: "G4", gradeRank: 4 }, idempotencyKey: `${f.booking.id}:${f.seller.id}:0:${f.schemeId}`,
      },
    });
  }

  it("returns the entry with its snapshot expanded, for the entry's own beneficiary", async () => {
    const f = await seedFixture();
    const entry = await seedRealEntry(f);

    const explained = await explainEntry(db, { entryId: entry.id, audit: ctx(f.sellerUser.id, "seller") });
    expect(explained.id).toBe(entry.id);
    expect((explained.snapshot as { gradeCode: string }).gradeCode).toBe("G4");
  });

  it("an admin (unrestricted role) may explain any entry in the org", async () => {
    const f = await seedFixture();
    const entry = await seedRealEntry(f);

    const explained = await explainEntry(db, { entryId: entry.id, audit: ctx(f.admin.id, "admin") });
    expect(explained.id).toBe(entry.id);
  });

  it("refuses a stranger with no relation to the beneficiary", async () => {
    const f = await seedFixture();
    const entry = await seedRealEntry(f);
    await expect(
      explainEntry(db, { entryId: entry.id, audit: ctx(f.strangerUser.id, "stranger") }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("throws for an entry that does not exist", async () => {
    const f = await seedFixture();
    await expect(
      explainEntry(db, { entryId: "does-not-exist", audit: ctx(f.sellerUser.id, "seller") }),
    ).rejects.toThrow(CommissionEntryNotFoundError);
  });
});

describe("getEarnings: real numbers, not a hardcoded string", () => {
  it("sums gross by status and computes blocked / pendingCollections from real releases and demands", async () => {
    const f = await seedFixture();

    const accruedEntry = await db.commissionEntry.create({
      data: {
        orgId: ORG, bookingId: f.booking.id, schemeId: f.schemeId, beneficiaryAssociateId: f.seller.id, role: "SELF", level: 0,
        baseAmount: D("1000000"), grossAmount: D("15000"), status: "ACCRUED", snapshot: {},
        idempotencyKey: `${f.booking.id}:${f.seller.id}:0:e1`,
      },
    });
    // A partial release against it -- 5000 of 15000 is released, 10000 is blocked.
    await db.commissionRelease.create({
      data: { entryId: accruedEntry.id, triggerType: "COLLECTION_PCT", triggerRef: "r1", cumulativePct: "33.33", amount: "5000" },
    });

    const paidEntry = await db.commissionEntry.create({
      data: {
        orgId: ORG, bookingId: f.booking.id, schemeId: f.schemeId, beneficiaryAssociateId: f.seller.id, role: "SELF", level: 0,
        baseAmount: D("1000000"), grossAmount: D("8000"), status: "PAID", snapshot: {},
        idempotencyKey: `${f.booking.id}:${f.seller.id}:0:e2`,
      },
    });
    void paidEntry;

    // A demand behind the blocked entry's booking, partially collected.
    const demand = await db.demand.create({
      data: { orgId: ORG, bookingId: f.booking.id, sequence: 1, description: "On booking", amount: "40000", dueDate: new Date("2026-02-01"), status: "PARTIALLY_PAID" },
    });
    const receipt = await db.receipt.create({
      data: { orgId: ORG, bookingId: f.booking.id, receiptNumber: "RCPT-READS-1", amount: "20000", mode: "NEFT", status: "VERIFIED", receivedOn: new Date(), enteredById: f.admin.id },
    });
    await db.receiptAllocation.create({ data: { receiptId: receipt.id, demandId: demand.id, amount: "20000" } });

    const earnings = await getEarnings(db, { associateId: f.seller.id, audit: ctx(f.admin.id, "admin") });
    expect(earnings.accrued.toString()).toBe("15000");
    expect(earnings.paid.toString()).toBe("8000");
    expect(earnings.payable.toString()).toBe("0");
    expect(earnings.blocked.toString()).toBe("10000"); // 15000 - 5000 released
    expect(earnings.pendingCollections.toString()).toBe("20000"); // 40000 owed - 20000 allocated
  });

  it("refuses a stranger reading another associate's earnings", async () => {
    const f = await seedFixture();
    await expect(
      getEarnings(db, { associateId: f.seller.id, audit: ctx(f.strangerUser.id, "stranger") }),
    ).rejects.toThrow(ForbiddenError);
  });
});
