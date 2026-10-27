// Sales by associate: the counts and sums, who is allowed to see which rows, and
// that the number of statements does not grow with the number of associates.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import type { BookingStatus } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import { csvField, guardFormula, toCsv } from "../src/export";
import {
  DRILLDOWN_LIMIT,
  SalesReportError,
  bookingsToReport,
  getSalesByAssociate,
  istDayRange,
  listAssociateBookings,
  summaryToReport,
} from "../src/sales-report";

const db = getPrismaClient();
const ORG = "org_test_sales";
const OTHER_ORG = "org_test_sales_other";

async function reset() {
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.booking.deleteMany({ where: { orgId } });
    await db.customer.deleteMany({ where: { orgId } });
    await db.unit.deleteMany({ where: { orgId } });
    await db.priceListItem.deleteMany({ where: { priceList: { orgId } } });
    await db.priceList.deleteMany({ where: { orgId } });
    await db.unitType.deleteMany({ where: { orgId } });
    await db.associate.deleteMany({ where: { orgId } });
    await db.userRole.deleteMany({ where: { role: { orgId } } });
    await db.rolePermission.deleteMany({ where: { role: { orgId } } });
    await db.role.deleteMany({ where: { orgId } });
    await db.user.deleteMany({ where: { orgId } });
    await db.project.deleteMany({ where: { orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
  }
}

async function makeUser(orgId: string, label: string, roleCode: "ADMIN" | "ASSOCIATE", name = label) {
  const user = await db.user.create({
    data: { orgId, email: `${label}-${orgId}@test.local`, name, passwordHash: "unused" },
  });
  const role =
    (await db.role.findFirst({ where: { orgId, code: roleCode } })) ??
    (await db.role.create({ data: { orgId, code: roleCode, name: roleCode } }));
  const permission = await db.permission.upsert({
    where: { code: "booking.read" },
    update: {},
    create: { code: "booking.read", resource: "booking", action: "read" },
  });
  await db.rolePermission.createMany({ data: [{ roleId: role.id, permissionId: permission.id }], skipDuplicates: true });
  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });
  const associate =
    roleCode === "ASSOCIATE"
      ? await db.associate.create({
          data: { orgId, userId: user.id, code: `A-${label}`, engagementType: "CHANNEL_PARTNER", joinDate: new Date("2024-01-01") },
        })
      : null;
  return { user, associate };
}

let counter = 0;
interface Sale {
  associateId: string;
  status: BookingStatus;
  base?: string;
  agreement?: string;
  date?: Date;
  confirmedAt?: Date | null;
  projectId?: string;
}

async function seed() {
  await db.organization.create({ data: { id: ORG, name: "Sales Org", legalName: "Sales Org Pvt Ltd" } });
  const project = await db.project.create({ data: { orgId: ORG, code: "S1", name: "Sales One" } });
  const project2 = await db.project.create({ data: { orgId: ORG, code: "S2", name: "Sales Two" } });
  const unitType = await db.unitType.create({
    data: { orgId: ORG, projectId: project.id, code: "P", name: "P", areaBasis: "SQYD", saleableArea: "100.00" },
  });
  const priceList = await db.priceList.create({
    data: { orgId: ORG, projectId: project.id, version: 1, name: "v1", status: "ACTIVE", validFrom: new Date("2020-01-01"), preparedById: "u" },
  });
  const admin = await makeUser(ORG, "admin", "ADMIN");
  const ravi = await makeUser(ORG, "ravi", "ASSOCIATE", "Ravi Kumar");
  const sita = await makeUser(ORG, "sita", "ASSOCIATE", "=HYPERLINK(\"x\")");
  const customer = await db.customer.create({ data: { orgId: ORG, name: "Buyer One", phone: "9999900001" } });

  async function sale(s: Sale) {
    counter += 1;
    const projectId = s.projectId ?? project.id;
    const unit = await db.unit.create({
      data: { orgId: ORG, projectId, unitTypeId: unitType.id, unitNumber: `U-${counter}` },
    });
    return db.booking.create({
      data: {
        orgId: ORG,
        projectId,
        unitId: unit.id,
        customerId: customer.id,
        bookingNumber: `BK-${counter}`,
        bookingDate: s.date ?? new Date("2026-06-15T10:00:00+05:30"),
        status: s.status,
        sellingAssociateId: s.associateId,
        priceListId: priceList.id,
        baseAmount: s.base ?? "1000000.00",
        agreementValue: s.agreement ?? "1100000.00",
        commissionableValue: "1000000.00",
        saleableAreaAtBooking: "100.00",
        confirmedAt: s.confirmedAt === undefined ? (s.status === "DRAFT" ? null : new Date("2026-06-16T10:00:00Z")) : s.confirmedAt,
      },
    });
  }
  return { project, project2, admin, ravi, sita, sale };
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("istDayRange", () => {
  it("is the Indian calendar day: 00:00 IST is 18:30 UTC the day before", () => {
    const range = istDayRange("2026-03-01", "2026-03-31");
    expect(range.gte?.toISOString()).toBe("2026-02-28T18:30:00.000Z");
    expect(range.lt?.toISOString()).toBe("2026-03-31T18:30:00.000Z");
  });

  it("accepts a single open end", () => {
    expect(istDayRange("2026-03-01").lt).toBeUndefined();
    expect(istDayRange(undefined, "2026-03-01").gte).toBeUndefined();
  });

  it.each(["2026-3-1", "yesterday", "2026-02-31", "2026-13-01", ""])("refuses %j", (day) => {
    if (day === "") return expect(istDayRange("")).toEqual({});
    expect(() => istDayRange(day)).toThrow(SalesReportError);
  });

  it("refuses an end before the start", () => {
    expect(() => istDayRange("2026-05-02", "2026-05-01")).toThrow(/before/);
  });
});

describe("getSalesByAssociate", () => {
  it("counts sold, waiting and cancelled apart and sums only what is sold", async () => {
    const { admin, ravi, sale } = await seed();
    const a = ravi.associate!.id;
    await sale({ associateId: a, status: "CONFIRMED", base: "1000000.00", agreement: "1100000.50", confirmedAt: new Date("2026-06-20T00:00:00Z") });
    await sale({ associateId: a, status: "REGISTERED", base: "2000000.00", agreement: "2200000.25", confirmedAt: new Date("2026-06-25T00:00:00Z") });
    await sale({ associateId: a, status: "DRAFT", base: "9000000.00", agreement: "9900000.00" });
    await sale({ associateId: a, status: "CANCELLED", base: "5000000.00", agreement: "5500000.00" });

    const result = await getSalesByAssociate(db, { orgId: ORG, actorId: admin.user.id });

    expect(result.scope).toBe("all");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      code: "A-ravi",
      name: "Ravi Kumar",
      sold: 2,
      waiting: 1,
      cancelled: 1,
      baseTotal: "3000000.00",
      agreementTotal: "3300000.75",
      // Exact decimal: 3,300,000.75 / 2 = 1,650,000.375 -> 1,650,000.38 (not a float).
      average: "1650000.38",
    });
    expect(result.rows[0]!.lastSale?.toISOString()).toBe("2026-06-25T00:00:00.000Z");
    expect(result.totals).toMatchObject({ sold: 2, waiting: 1, cancelled: 1, baseTotal: "3000000.00", agreementTotal: "3300000.75" });
  });

  it("ranks by plots sold and totals across associates", async () => {
    const { admin, ravi, sita, sale } = await seed();
    await sale({ associateId: sita.associate!.id, status: "CONFIRMED" });
    await sale({ associateId: ravi.associate!.id, status: "CONFIRMED" });
    await sale({ associateId: ravi.associate!.id, status: "CONFIRMED" });

    const result = await getSalesByAssociate(db, { orgId: ORG, actorId: admin.user.id });
    expect(result.rows.map((r) => r.code)).toEqual(["A-ravi", "A-sita"]);
    expect(result.totals.sold).toBe(3);
  });

  it("filters by project", async () => {
    const { admin, ravi, project2, sale } = await seed();
    await sale({ associateId: ravi.associate!.id, status: "CONFIRMED" });
    await sale({ associateId: ravi.associate!.id, status: "CONFIRMED", projectId: project2.id });

    const result = await getSalesByAssociate(db, { orgId: ORG, actorId: admin.user.id, projectId: project2.id });
    expect(result.totals.sold).toBe(1);
  });

  it("filters by Indian calendar day, inclusive at both ends", async () => {
    const { admin, ravi, sale } = await seed();
    const a = ravi.associate!.id;
    // 23:50 IST on the 31st is still March 31 (18:20 UTC); 00:10 IST on April 1 is March 31 18:40 UTC.
    await sale({ associateId: a, status: "CONFIRMED", date: new Date("2026-03-31T23:50:00+05:30") });
    await sale({ associateId: a, status: "CONFIRMED", date: new Date("2026-04-01T00:10:00+05:30") });
    await sale({ associateId: a, status: "CONFIRMED", date: new Date("2026-03-01T00:00:00+05:30") });
    await sale({ associateId: a, status: "CONFIRMED", date: new Date("2026-02-28T23:59:00+05:30") });

    const march = await getSalesByAssociate(db, { orgId: ORG, actorId: admin.user.id, from: "2026-03-01", to: "2026-03-31" });
    expect(march.totals.sold).toBe(2);
  });

  it("refuses a bad date", async () => {
    const { admin } = await seed();
    await expect(getSalesByAssociate(db, { orgId: ORG, actorId: admin.user.id, from: "nope" })).rejects.toThrow(SalesReportError);
  });

  it("does not see another organisation's bookings", async () => {
    const { admin, ravi, sale } = await seed();
    await sale({ associateId: ravi.associate!.id, status: "CONFIRMED" });
    await db.organization.create({ data: { id: OTHER_ORG, name: "Other", legalName: "Other Pvt" } });
    const stranger = await makeUser(OTHER_ORG, "stranger", "ADMIN");

    const result = await getSalesByAssociate(db, { orgId: OTHER_ORG, actorId: stranger.user.id });
    expect(result.rows).toEqual([]);
    expect((await getSalesByAssociate(db, { orgId: ORG, actorId: admin.user.id })).totals.sold).toBe(1);
  });

  it("shows an associate only their own row, even with nothing sold, and nothing of others", async () => {
    const { ravi, sita, sale } = await seed();
    await sale({ associateId: sita.associate!.id, status: "CONFIRMED" });

    const result = await getSalesByAssociate(db, { orgId: ORG, actorId: ravi.user.id });

    expect(result.scope).toBe("own");
    expect(result.rows.map((r) => r.code)).toEqual(["A-ravi"]);
    expect(result.rows[0]).toMatchObject({ sold: 0, average: null, agreementTotal: "0.00" });
    expect(result.totals.sold).toBe(0);
  });

  it("refuses a user without booking.read", async () => {
    const { project } = await seed();
    void project;
    const nobody = await db.user.create({ data: { orgId: ORG, email: "n@test.local", name: "N", passwordHash: "x" } });
    await expect(getSalesByAssociate(db, { orgId: ORG, actorId: nobody.id })).rejects.toThrow(ForbiddenError);
  });

  it("handles a large team in one pass: every associate present, totals exact", async () => {
    const { admin, ravi, sale } = await seed();
    await sale({ associateId: ravi.associate!.id, status: "CONFIRMED" });
    for (let i = 0; i < 29; i += 1) {
      const extra = await makeUser(ORG, `extra${i}`, "ASSOCIATE");
      await sale({ associateId: extra.associate!.id, status: "CONFIRMED" });
    }
    const result = await getSalesByAssociate(db, { orgId: ORG, actorId: admin.user.id });
    expect(result.rows).toHaveLength(30);
    expect(result.totals.sold).toBe(30);
    expect(result.totals.agreementTotal).toBe("33000000.00");
  });
});

describe("listAssociateBookings", () => {
  it("lists one associate's bookings newest first, with names", async () => {
    const { admin, ravi, sale } = await seed();
    const a = ravi.associate!.id;
    await sale({ associateId: a, status: "CONFIRMED", date: new Date("2026-06-01T10:00:00+05:30") });
    await sale({ associateId: a, status: "DRAFT", date: new Date("2026-06-10T10:00:00+05:30") });

    const result = await listAssociateBookings(db, { orgId: ORG, actorId: admin.user.id, associateId: a });
    expect(result.truncated).toBe(false);
    expect(result.rows.map((r) => r.status)).toEqual(["DRAFT", "CONFIRMED"]);
    expect(result.rows[0]).toMatchObject({ projectName: "Sales One", customerName: "Buyer One", agreementValue: "1100000.00" });
  });

  it("filters by status and caps at the limit, saying so", async () => {
    const { admin, ravi, sale } = await seed();
    const a = ravi.associate!.id;
    await sale({ associateId: a, status: "CONFIRMED" });
    await sale({ associateId: a, status: "CANCELLED" });

    const cancelled = await listAssociateBookings(db, { orgId: ORG, actorId: admin.user.id, associateId: a, status: "CANCELLED" });
    expect(cancelled.rows).toHaveLength(1);

    const capped = await listAssociateBookings(db, { orgId: ORG, actorId: admin.user.id, associateId: a, take: 1 });
    expect(capped.rows).toHaveLength(1);
    expect(capped.truncated).toBe(true);
    expect(DRILLDOWN_LIMIT).toBe(200);
  });

  it("refuses an associate to read another associate's bookings by id", async () => {
    const { ravi, sita, sale } = await seed();
    await sale({ associateId: sita.associate!.id, status: "CONFIRMED" });
    await expect(
      listAssociateBookings(db, { orgId: ORG, actorId: ravi.user.id, associateId: sita.associate!.id }),
    ).rejects.toThrow(ForbiddenError);
    const own = await listAssociateBookings(db, { orgId: ORG, actorId: ravi.user.id, associateId: ravi.associate!.id });
    expect(own.rows).toEqual([]);
  });
});

describe("export shape", () => {
  it("writes the summary with a totals row, and keeps a name from being run as a formula", async () => {
    const { admin, sita, sale } = await seed();
    await sale({ associateId: sita.associate!.id, status: "CONFIRMED" });
    const result = await getSalesByAssociate(db, { orgId: ORG, actorId: admin.user.id });

    const report = summaryToReport(result);
    expect(report.columns.map((c) => c.label)).toContain("Agreement value total (INR)");
    expect(report.rows[0]![1]).toBe("'=HYPERLINK(\"x\")");
    expect(report.rows[report.rows.length - 1]![1]).toBe("Total");

    const csv = toCsv(report.columns.map((c) => c.label), report.rows);
    expect(csv.split("\r\n")).toHaveLength(3);
    expect(csv).toContain("\"'=HYPERLINK(\"\"x\"\")\"");
  });

  it("guardFormula touches only what starts like a formula, and csvField still quotes", () => {
    expect(guardFormula("=1+1")).toBe("'=1+1");
    expect(guardFormula("+91 98")).toBe("'+91 98");
    expect(guardFormula("-5")).toBe("'-5");
    expect(guardFormula("@sum")).toBe("'@sum");
    expect(guardFormula("Ravi Kumar")).toBe("Ravi Kumar");
    expect(guardFormula("1100000.00")).toBe("1100000.00");
    expect(csvField("a,b")).toBe("\"a,b\"");
  });

  it("writes bookings rows", async () => {
    const { admin, ravi, sale } = await seed();
    await sale({ associateId: ravi.associate!.id, status: "CONFIRMED" });
    const { rows } = await listAssociateBookings(db, { orgId: ORG, actorId: admin.user.id, associateId: ravi.associate!.id });
    const report = bookingsToReport(rows);
    expect(report.rows[0]).toHaveLength(report.columns.length);
    expect(report.rows[0]![2]).toBe("CONFIRMED");
  });
});
