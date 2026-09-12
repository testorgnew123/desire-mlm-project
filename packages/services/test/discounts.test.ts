// Discount request + approval routing. Runs against LOCAL Docker Postgres --
// the maker-checker separation-of-duties and the band-membership check are
// exactly what is under test.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import { acquireHold } from "../src/holds";
import { createDraftBooking } from "../src/bookings";
import {
  BookingNotDraftForDiscountError,
  DiscountRequestNotFoundError,
  DiscountRequestNotPendingError,
  InvalidDiscountBandError,
  SelfApprovalError,
  decideDiscount,
  requestDiscount,
  resolveApproverRoles,
} from "../src/discounts";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_discounts";
const OTHER_ORG = "org_test_discounts_other";
const D = (v: string | number) => new Prisma.Decimal(v);

async function reset() {
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.discountRequest.deleteMany({ where: { booking: { orgId } } });
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
  // here (the parallel-test-file race this project already found and fixed).
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

async function seedFixture(orgId: string = ORG) {
  await db.organization.create({ data: { id: orgId, name: "Discounts Test Org", legalName: "Discounts Test Org Pvt Ltd" } });
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
  await db.chargeHead.create({
    data: { orgId, code: "BSP", name: "Basic Sale Price", category: "BASE_PRICE", isTaxable: true, gstRatePct: "5.00", countsTowardCommission: true, isRefundable: false, displayOrder: 1 },
  });
  const priceList = await db.priceList.create({
    data: {
      orgId, projectId: project.id, version: 1, name: "v1", status: "ACTIVE", validFrom: new Date("2020-01-01"), preparedById: "u_test",
      items: { create: [{ unitTypeId: unitType.id, baseRatePerSqft: "5000.00" }] },
    },
  });
  const customer = await db.customer.create({ data: { orgId, name: "Test Buyer", phone: "9999999999" } });

  const seller = await makeUser(orgId, "seller", ["booking.create", "hold.create", "discount.request"], { associate: true });
  const teamLead = await makeUser(orgId, "teamlead", ["discount.approve"]);
  const salesHead = await makeUser(orgId, "saleshead", ["discount.approve"]);
  const financeAdmin = await makeUser(orgId, "finance", ["discount.approve"]);
  await db.role.update({ where: { id: (await db.role.findFirstOrThrow({ where: { code: "ROLE_teamlead", orgId } })).id }, data: { code: "TEAM_LEAD" } });
  await db.role.update({ where: { id: (await db.role.findFirstOrThrow({ where: { code: "ROLE_saleshead", orgId } })).id }, data: { code: "SALES_HEAD" } });
  await db.role.update({ where: { id: (await db.role.findFirstOrThrow({ where: { code: "ROLE_finance", orgId } })).id }, data: { code: "FINANCE_ADMIN" } });

  return { project, unit, priceList, customer, seller, teamLead, salesHead, financeAdmin };
}

function ctx(orgId: string, userId: string | null, label: string): AuditContext {
  return { orgId, actorId: userId, actorLabel: label };
}

async function draftBooking(orgId: string, unit: { id: string }, priceListId: string, customerId: string, seller: { user: { id: string }; associate: { id: string } | null }) {
  await acquireHold(db, { orgId, unitId: unit.id, associateId: seller.associate!.id, audit: ctx(orgId, seller.user.id, "seller") });
  return createDraftBooking(db, { unitId: unit.id, priceListId, customerId, audit: ctx(orgId, seller.user.id, "seller") });
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("resolveApproverRoles (pure)", () => {
  it("maps the PLACEHOLDER bands exactly", () => {
    expect(resolveApproverRoles(D(0))).toEqual(["TEAM_LEAD"]);
    expect(resolveApproverRoles(D(1))).toEqual(["TEAM_LEAD"]);
    expect(resolveApproverRoles(D(1.5))).toEqual(["SALES_HEAD"]);
    expect(resolveApproverRoles(D(3))).toEqual(["SALES_HEAD"]);
    expect(resolveApproverRoles(D(4))).toEqual(["SALES_HEAD", "FINANCE_ADMIN"]);
    expect(resolveApproverRoles(D(5))).toEqual(["SALES_HEAD", "FINANCE_ADMIN"]);
    expect(resolveApproverRoles(D(5.01))).toEqual(["SUPER_ADMIN"]);
  });

  it("refuses a negative percentage", () => {
    expect(() => resolveApproverRoles(D(-1))).toThrow(InvalidDiscountBandError);
  });
});

describe("requestDiscount", () => {
  it("creates a PENDING request only against a DRAFT booking", async () => {
    const { unit, priceList, customer, seller } = await seedFixture();
    const draft = await draftBooking(ORG, unit, priceList.id, customer.id, seller);

    const request = await requestDiscount(db, {
      bookingId: draft.id, amount: "50000", pctOfBase: "1.00", justification: "loyal customer",
      audit: ctx(ORG, seller.user.id, "seller"),
    });

    expect(request.status).toBe("PENDING");
    expect(request.approverRoleCode).toBe("TEAM_LEAD");
  });

  it("refuses against a non-DRAFT booking", async () => {
    const { unit, priceList, customer, seller, salesHead } = await seedFixture();
    const draft = await draftBooking(ORG, unit, priceList.id, customer.id, seller);
    await db.user.update({ where: { id: salesHead.user.id }, data: {} }); // no-op, keep fixture referenced
    await db.booking.update({ where: { id: draft.id }, data: { status: "CONFIRMED" } });

    await expect(
      requestDiscount(db, { bookingId: draft.id, amount: "1000", pctOfBase: "0.5", justification: "x", audit: ctx(ORG, seller.user.id, "seller") }),
    ).rejects.toThrow(BookingNotDraftForDiscountError);
  });

  it("refuses without discount.request", async () => {
    const { unit, priceList, customer, seller } = await seedFixture();
    const draft = await draftBooking(ORG, unit, priceList.id, customer.id, seller);
    const nobody = await makeUser(ORG, "nobody", []);

    await expect(
      requestDiscount(db, { bookingId: draft.id, amount: "1000", pctOfBase: "0.5", justification: "x", audit: ctx(ORG, nobody.user.id, "nobody") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("decideDiscount: maker-checker and band membership", () => {
  async function seedRequest(pctOfBase: string) {
    const fixture = await seedFixture();
    const draft = await draftBooking(ORG, fixture.unit, fixture.priceList.id, fixture.customer.id, fixture.seller);
    const request = await requestDiscount(db, {
      bookingId: draft.id, amount: "50000", pctOfBase, justification: "test",
      audit: ctx(ORG, fixture.seller.user.id, "seller"),
    });
    return { ...fixture, draft, request };
  }

  it("approves and writes the amount onto the booking", async () => {
    const { draft, request, teamLead } = await seedRequest("1.00");

    const decided = await decideDiscount(db, {
      discountRequestId: request.id, approve: true, audit: ctx(ORG, teamLead.user.id, "teamlead"),
    });

    expect(decided.status).toBe("APPROVED");
    expect(decided.decidedById).toBe(teamLead.user.id);
    const updatedBooking = await db.booking.findUniqueOrThrow({ where: { id: draft.id } });
    expect(updatedBooking.discountAmount.toString()).toBe("50000");
  });

  it("rejects, and does NOT write the amount onto the booking", async () => {
    const { draft, request, teamLead } = await seedRequest("1.00");

    const decided = await decideDiscount(db, {
      discountRequestId: request.id, approve: false, decisionNote: "too generous", audit: ctx(ORG, teamLead.user.id, "teamlead"),
    });

    expect(decided.status).toBe("REJECTED");
    const updatedBooking = await db.booking.findUniqueOrThrow({ where: { id: draft.id } });
    expect(updatedBooking.discountAmount.toString()).toBe("0");
  });

  it("refuses self-approval even for a user holding both permissions", async () => {
    const fixture = await seedFixture();
    // Grant discount.request onto the fixture's existing TEAM_LEAD-coded
    // user directly, rather than minting a second TEAM_LEAD and colliding
    // with Role's @@unique([orgId, code]) -- they now hold both permissions
    // AND an eligible role for the 1% band, so self-approval is the only
    // thing left that can refuse them.
    const requestPerm = await db.permission.upsert({
      where: { code: "discount.request" },
      update: {},
      create: { code: "discount.request", resource: "discount", action: "request" },
    });
    const teamLeadRole = await db.role.findFirstOrThrow({ where: { code: "TEAM_LEAD", orgId: ORG } });
    await db.rolePermission.create({ data: { roleId: teamLeadRole.id, permissionId: requestPerm.id } });

    const draft = await draftBooking(ORG, fixture.unit, fixture.priceList.id, fixture.customer.id, fixture.seller);
    const request = await requestDiscount(db, {
      bookingId: draft.id, amount: "1000", pctOfBase: "1.00", justification: "x",
      audit: ctx(ORG, fixture.teamLead.user.id, "teamlead"),
    });

    await expect(
      decideDiscount(db, { discountRequestId: request.id, approve: true, audit: ctx(ORG, fixture.teamLead.user.id, "teamlead") }),
    ).rejects.toThrow(SelfApprovalError);
  });

  it("refuses a decider whose role is outside the request's band, even holding discount.approve generally", async () => {
    // 4% needs SALES_HEAD or FINANCE_ADMIN -- a TEAM_LEAD holding
    // discount.approve (their own band, <=1%) must not decide this one.
    const { request, teamLead } = await seedRequest("4.00");

    await expect(
      decideDiscount(db, { discountRequestId: request.id, approve: true, audit: ctx(ORG, teamLead.user.id, "teamlead") }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("allows FINANCE_ADMIN to decide a 3-5% request, the band the doc names them for", async () => {
    const { request, financeAdmin } = await seedRequest("4.00");

    const decided = await decideDiscount(db, {
      discountRequestId: request.id, approve: true, audit: ctx(ORG, financeAdmin.user.id, "finance"),
    });
    expect(decided.status).toBe("APPROVED");
  });

  it("refuses a non-PENDING request (already decided)", async () => {
    const { request, teamLead } = await seedRequest("1.00");
    await decideDiscount(db, { discountRequestId: request.id, approve: true, audit: ctx(ORG, teamLead.user.id, "teamlead") });

    // A second decide attempt, even by the same eligible decider, must be
    // refused on status alone -- role codes are unique per org, so the
    // fixture's own teamLead is reused rather than minting a duplicate.
    await expect(
      decideDiscount(db, { discountRequestId: request.id, approve: true, audit: ctx(ORG, teamLead.user.id, "teamlead") }),
    ).rejects.toThrow(DiscountRequestNotPendingError);
  });

  it("throws for a request that does not exist", async () => {
    const { teamLead } = await seedFixture();
    await expect(
      decideDiscount(db, { discountRequestId: "does-not-exist", approve: true, audit: ctx(ORG, teamLead.user.id, "teamlead") }),
    ).rejects.toThrow(DiscountRequestNotFoundError);
  });

  it("refuses a decider from another org", async () => {
    const { request } = await seedRequest("1.00");
    // seedFixture already mints a TEAM_LEAD-coded user for the other org --
    // reused directly, rather than minting a second one and colliding with
    // Role's @@unique([orgId, code]).
    const otherOrgFixture = await seedFixture(OTHER_ORG);

    await expect(
      decideDiscount(db, {
        discountRequestId: request.id, approve: true,
        audit: ctx(OTHER_ORG, otherOrgFixture.teamLead.user.id, "teamlead"),
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("audit: request and decide each write one row", () => {
  it("writes CREATE on request and UPDATE on decide", async () => {
    const { unit, priceList, customer, seller, teamLead } = await seedFixture();
    const draft = await draftBooking(ORG, unit, priceList.id, customer.id, seller);
    const request = await requestDiscount(db, {
      bookingId: draft.id, amount: "1000", pctOfBase: "1.00", justification: "x", audit: ctx(ORG, seller.user.id, "seller"),
    });
    await decideDiscount(db, { discountRequestId: request.id, approve: true, audit: ctx(ORG, teamLead.user.id, "teamlead") });

    const createdRows = await db.auditLog.findMany({ where: { entity: "DiscountRequest", entityId: request.id, action: "CREATE" } });
    const updatedRows = await db.auditLog.findMany({ where: { entity: "DiscountRequest", entityId: request.id, action: "UPDATE" } });
    expect(createdRows).toHaveLength(1);
    expect(updatedRows).toHaveLength(1);
  });
});
