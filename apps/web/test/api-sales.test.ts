import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as report } from "../app/api/v1/bookings/by-associate/route";
import { body, db, ORG, request, resetWorld, seedWorld, type World } from "./support";

let w: World;
beforeEach(async () => {
  await resetWorld();
  w = await seedWorld();
});
afterAll(async () => {
  await resetWorld();
  await db.$disconnect();
});

async function sell(associateId: string, plotIndex: number, status: "CONFIRMED" | "DRAFT", agreement: string) {
  const customer = await db.customer.create({ data: { orgId: ORG, name: "Asha Rao", phone: "+919876543210" } });
  return db.booking.create({
    data: {
      orgId: ORG,
      projectId: w.project.id,
      unitId: w.plots[plotIndex]!.id,
      customerId: customer.id,
      bookingNumber: `WEB-${plotIndex}-${status}`,
      bookingDate: new Date(),
      status,
      sellingAssociateId: associateId,
      priceListId: w.priceList.id,
      baseAmount: "5000000.00",
      agreementValue: agreement,
      commissionableValue: "5000000.00",
      saleableAreaAtBooking: "200.00",
      confirmedAt: status === "CONFIRMED" ? new Date() : null,
    },
  });
}

const get = (token: string | null, query = "") => report(request(`/api/v1/bookings/by-associate${query}`, { token }));

describe("GET /api/v1/bookings/by-associate", () => {
  it("answers 401 without a session", async () => {
    expect((await get(null)).status).toBe(401);
  });

  it("answers 403 to someone without booking.read", async () => {
    expect((await get(w.outsider.token)).status).toBe(403);
  });

  it("gives an admin every associate, as CSV, with a totals row", async () => {
    await sell(w.seller.associateId!, 0, "CONFIRMED", "5500000.00");
    await sell(w.rival.associateId!, 1, "CONFIRMED", "5600000.00");

    const response = await get(w.admin.token);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv");
    const lines = (await response.text()).split("\r\n");
    expect(lines[0]).toContain("Agreement value total (INR)");
    expect(lines.some((line) => line.includes("A-seller"))).toBe(true);
    expect(lines.some((line) => line.includes("A-rival"))).toBe(true);
    expect(lines.some((line) => line.startsWith(",Total,2,"))).toBe(true);
  });

  it("gives an associate only their own row", async () => {
    await sell(w.seller.associateId!, 0, "CONFIRMED", "5500000.00");
    await sell(w.rival.associateId!, 1, "CONFIRMED", "5600000.00");

    const text = await (await get(w.seller.token)).text();

    expect(text).toContain("A-seller");
    expect(text).not.toContain("A-rival");
    expect(text).not.toContain("5600000.00");
  });

  it("refuses an associate asking for another's bookings by id", async () => {
    await sell(w.rival.associateId!, 1, "CONFIRMED", "5600000.00");
    const response = await get(w.seller.token, `?view=bookings&associate=${w.rival.associateId}`);
    expect(response.status).toBe(403);
    expect((await body(response)).title).toBe("Forbidden");
  });

  it("lists one associate's bookings for an admin, and needs the associate id", async () => {
    await sell(w.seller.associateId!, 0, "DRAFT", "5500000.00");

    const missing = await get(w.admin.token, "?view=bookings");
    expect(missing.status).toBe(400);

    const response = await get(w.admin.token, `?view=bookings&associate=${w.seller.associateId}&status=DRAFT`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("WEB-0-DRAFT");
  });

  it("serves a workbook for format=xlsx", async () => {
    await sell(w.seller.associateId!, 0, "CONFIRMED", "5500000.00");
    const response = await get(w.admin.token, "?format=xlsx");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  it("answers 400 to a bad date", async () => {
    expect((await get(w.admin.token, "?from=31-03-2026")).status).toBe(400);
  });

  it("writes an EXPORT audit row for each file", async () => {
    await get(w.admin.token);
    const rows = await db.auditLog.findMany({ where: { orgId: ORG, action: "EXPORT" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity: "Report", entityId: "sales-by-associate" });
  });
});
