import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as draft } from "../app/api/v1/bookings/route";
import { GET as readBooking } from "../app/api/v1/bookings/[bookingId]/route";
import { POST as confirm } from "../app/api/v1/bookings/[bookingId]/confirm/route";
import { POST as cancel } from "../app/api/v1/bookings/[bookingId]/cancel/route";
import { POST as hold } from "../app/api/v1/projects/[projectId]/units/[unitId]/holds/route";
import { body, db, ORG, params, request, resetWorld, seedWorld, unitStatus, type Person, type World } from "./support";

let w: World;
beforeEach(async () => {
  await resetWorld();
  w = await seedWorld();
});
afterAll(async () => {
  await resetWorld();
  await db.$disconnect();
});

const customer = () => db.customer.create({ data: { orgId: ORG, name: "Asha Rao", phone: "+919876543210" } });

async function holdPlot(by: Person, plotIndex = 0) {
  const unitId = w.plots[plotIndex]!.id;
  const response = await hold(
    request(`/api/v1/projects/${w.project.id}/units/${unitId}/holds`, { method: "POST", token: by.token }),
    params({ projectId: w.project.id, unitId }),
  );
  expect(response.status).toBe(201);
  return unitId;
}

const postDraft = (token: string | null, json: unknown) =>
  draft(request("/api/v1/bookings", { method: "POST", token, json }));

async function draftFor(by: Person, plotIndex = 0): Promise<string> {
  const unitId = await holdPlot(by, plotIndex);
  const c = await customer();
  const response = await postDraft(by.token, { unitId, priceListId: w.priceList.id, customerId: c.id });
  expect(response.status).toBe(201);
  return (await body(response)).id as string;
}

const read = (token: string | null, id: string) =>
  readBooking(request(`/api/v1/bookings/${id}`, { token }), params({ bookingId: id }));
const confirmIt = (token: string | null, id: string) =>
  confirm(request(`/api/v1/bookings/${id}/confirm`, { method: "POST", token }), params({ bookingId: id }));
const cancelIt = (token: string | null, id: string, json?: unknown) =>
  cancel(request(`/api/v1/bookings/${id}/cancel`, { method: "POST", token, json }), params({ bookingId: id }));

describe("POST /api/v1/bookings (draft)", () => {
  it("answers 401 without a session", async () => {
    expect((await postDraft(null, {})).status).toBe(401);
  });

  it("answers 400 to a body that is not JSON, and to one missing a field", async () => {
    const notJson = await draft(request("/api/v1/bookings", { method: "POST", token: w.seller.token, body: "nope" }));
    expect(notJson.status).toBe(400);
    expect((await postDraft(w.seller.token, { unitId: w.plots[0]!.id })).status).toBe(400);
  });

  it("lets an associate draft a booking on a plot they hold", async () => {
    const unitId = await holdPlot(w.seller);
    const c = await customer();
    const response = await postDraft(w.seller.token, { unitId, priceListId: w.priceList.id, customerId: c.id });

    expect(response.status).toBe(201);
    const json = await body(response);
    expect(json).toMatchObject({ status: "DRAFT", unitId, customerId: c.id, sellingAssociateId: w.seller.associateId });
    expect(String(json.bookingNumber)).toMatch(/^WEB-\d{4}$/);
    // Money crosses the wire as a string, never a float.
    expect(json.agreementValue).toBe("5250000");
    expect(typeof json.auditId).toBe("string");
  });

  it("answers 403 to an admin and to someone with no role: only associates draft", async () => {
    const unitId = await holdPlot(w.seller);
    const c = await customer();
    const payload = { unitId, priceListId: w.priceList.id, customerId: c.id };
    expect((await postDraft(w.admin.token, payload)).status).toBe(403);
    expect((await postDraft(w.outsider.token, payload)).status).toBe(403);
    expect(await db.booking.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("answers 409 when the associate does not hold the plot, and when someone else does", async () => {
    const c = await customer();
    const free = await postDraft(w.seller.token, { unitId: w.plots[0]!.id, priceListId: w.priceList.id, customerId: c.id });
    expect(free.status).toBe(409);

    const unitId = await holdPlot(w.rival, 1);
    const stolen = await postDraft(w.seller.token, { unitId, priceListId: w.priceList.id, customerId: c.id });
    expect(stolen.status).toBe(409);
  });

  it("answers 422 for a price list that is not this project's active one", async () => {
    const unitId = await holdPlot(w.seller);
    const c = await customer();
    expect((await postDraft(w.seller.token, { unitId, priceListId: "no-such-list", customerId: c.id })).status).toBe(422);
  });

  it("answers 403 when an associate tries to book under another associate's name", async () => {
    const unitId = await holdPlot(w.seller);
    const c = await customer();
    const response = await postDraft(w.seller.token, {
      unitId,
      priceListId: w.priceList.id,
      customerId: c.id,
      sellingAssociateId: w.rival.associateId,
    });
    expect(response.status).toBe(403);
  });
});

describe("GET /api/v1/bookings/[bookingId]", () => {
  it("answers 401 without a session", async () => {
    const id = await draftFor(w.seller);
    expect((await read(null, id)).status).toBe(401);
  });

  it("shows an associate their own booking, an admin and a super admin any booking", async () => {
    const id = await draftFor(w.seller);
    for (const person of [w.seller, w.admin, w.superAdmin]) {
      const response = await read(person.token, id);
      expect(response.status).toBe(200);
      expect((await body(response)).id).toBe(id);
    }
  });

  it("does not reveal another associate's booking: 404, as if it did not exist", async () => {
    const id = await draftFor(w.seller);
    expect((await read(w.rival.token, id)).status).toBe(404);
  });

  it("answers 403 to someone who cannot read bookings, and 404 for an unknown id", async () => {
    const id = await draftFor(w.seller);
    expect((await read(w.outsider.token, id)).status).toBe(403);
    expect((await read(w.admin.token, "no-such-booking")).status).toBe(404);
  });
});

describe("POST /api/v1/bookings/[bookingId]/confirm", () => {
  it("answers 401 without a session", async () => {
    const id = await draftFor(w.seller);
    expect((await confirmIt(null, id)).status).toBe(401);
  });

  it("will not let the seller confirm their own sale, or someone with no role confirm anything", async () => {
    const id = await draftFor(w.seller);
    expect((await confirmIt(w.seller.token, id)).status).toBe(403);
    expect((await confirmIt(w.outsider.token, id)).status).toBe(403);
    expect((await db.booking.findUniqueOrThrow({ where: { id } })).status).toBe("DRAFT");
  });

  it.each([["an admin", () => w.admin], ["a super admin", () => w.superAdmin]])("lets %s confirm: the booking is CONFIRMED and the plot BOOKED", async (_who, who) => {
    const id = await draftFor(w.seller);
    const response = await confirmIt(who().token, id);

    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ id, status: "CONFIRMED" });
    expect(await unitStatus(w.plots[0]!.id)).toBe("BOOKED");
    expect(await db.costSheetLine.count({ where: { bookingId: id } })).toBeGreaterThan(0);
  });

  it("answers 409 to a second confirmation of the same booking", async () => {
    const id = await draftFor(w.seller);
    expect((await confirmIt(w.admin.token, id)).status).toBe(200);
    expect((await confirmIt(w.admin.token, id)).status).toBe(409);
  });

  it("answers 409 when the associate's hold has lapsed, leaving the draft as it was", async () => {
    const id = await draftFor(w.seller);
    await db.unitHold.updateMany({ where: { unitId: w.plots[0]!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect((await confirmIt(w.admin.token, id)).status).toBe(409);
    expect((await db.booking.findUniqueOrThrow({ where: { id } })).status).toBe("DRAFT");
  });

  it("answers 404 for an unknown booking", async () => {
    expect((await confirmIt(w.admin.token, "no-such-booking")).status).toBe(404);
  });
});

describe("POST /api/v1/bookings/[bookingId]/cancel", () => {
  async function confirmed(): Promise<string> {
    const id = await draftFor(w.seller);
    expect((await confirmIt(w.admin.token, id)).status).toBe(200);
    return id;
  }

  it("answers 401 without a session", async () => {
    expect((await cancelIt(null, "x", { reason: "r" })).status).toBe(401);
  });

  it("answers 400 to a body with no reason, and 422 to a blank one", async () => {
    const id = await confirmed();
    expect((await cancelIt(w.admin.token, id, {})).status).toBe(400);
    expect((await cancelIt(w.admin.token, id, { reason: "   " })).status).toBe(422);
    expect((await db.booking.findUniqueOrThrow({ where: { id } })).status).toBe("CONFIRMED");
  });

  it("will not let an associate cancel", async () => {
    const id = await confirmed();
    expect((await cancelIt(w.seller.token, id, { reason: "changed my mind" })).status).toBe(403);
  });

  it("lets an admin cancel a confirmed booking with a reason: CANCELLED, and the plot goes back on sale", async () => {
    const id = await confirmed();
    const response = await cancelIt(w.admin.token, id, { reason: "Customer withdrew" });

    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ id, status: "CANCELLED" });
    expect(await unitStatus(w.plots[0]!.id)).toBe("AVAILABLE");
  });

  it("answers 409 to cancelling a draft, which has nothing to cancel", async () => {
    const id = await draftFor(w.seller);
    expect((await cancelIt(w.admin.token, id, { reason: "r" })).status).toBe(409);
  });

  it("answers 404 for an unknown booking", async () => {
    expect((await cancelIt(w.admin.token, "no-such-booking", { reason: "r" })).status).toBe(404);
  });
});
