import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as deltas } from "../app/api/v1/projects/[projectId]/units/deltas/route";
import { POST as hold } from "../app/api/v1/projects/[projectId]/units/[unitId]/holds/route";
import { body, db, ORG, params, request, resetWorld, seedWorld, unitStatus, type World } from "./support";

let w: World;
beforeEach(async () => {
  await resetWorld();
  w = await seedWorld();
});
afterAll(async () => {
  await resetWorld();
  await db.$disconnect();
});

const getDeltas = (token: string | null, query = "") =>
  deltas(request(`/api/v1/projects/${w.project.id}/units/deltas${query}`, { token }), params({ projectId: w.project.id }));

const takeHold = (token: string | null, unitId: string, projectId = w.project.id) =>
  hold(
    request(`/api/v1/projects/${projectId}/units/${unitId}/holds`, { method: "POST", token }),
    params({ projectId, unitId }),
  );

describe("GET /api/v1/projects/[projectId]/units/deltas", () => {
  it("answers 401 without a session", async () => {
    expect((await getDeltas(null)).status).toBe(401);
  });

  it("answers 401 for a token that is not a session", async () => {
    expect((await getDeltas("not-a-real-token")).status).toBe(401);
  });

  it("answers 403 to someone who cannot read inventory", async () => {
    expect((await getDeltas(w.outsider.token)).status).toBe(403);
  });

  it.each([["an associate", () => w.seller.token], ["an admin", () => w.admin.token], ["a super admin", () => w.superAdmin.token]])(
    "gives %s the full snapshot when no since is sent",
    async (_who, token) => {
      const response = await getDeltas(token());
      expect(response.status).toBe(200);
      const json = (await body(response)) as { units: { id: string; unitNumber: string }[]; serverTime: string };
      expect(json.units.map((u) => u.unitNumber).sort()).toEqual(["A-01", "A-02", "A-03"]);
      expect(Number.isNaN(Date.parse(json.serverTime))).toBe(false);
    },
  );

  it("accepts the token as a bearer header as well as the cookie", async () => {
    const response = await deltas(
      request(`/api/v1/projects/${w.project.id}/units/deltas`, { headers: { authorization: `Bearer ${w.seller.token}` } }),
      params({ projectId: w.project.id }),
    );
    expect(response.status).toBe(200);
  });

  it("sends only what changed since the serverTime it was given back", async () => {
    const first = (await body(await getDeltas(w.seller.token))) as { serverTime: string };
    await new Promise((resolve) => setTimeout(resolve, 20));
    await db.unit.update({ where: { id: w.plots[1]!.id }, data: { blockReason: "touched" } });

    const second = (await body(await getDeltas(w.seller.token, `?since=${encodeURIComponent(first.serverTime)}`))) as {
      units: { unitNumber: string }[];
    };
    expect(second.units.map((u) => u.unitNumber)).toEqual(["A-02"]);
  });

  it("answers 400 to a since that is not a timestamp, rather than quietly sending everything", async () => {
    expect((await getDeltas(w.seller.token, "?since=yesterday")).status).toBe(400);
    expect((await getDeltas(w.seller.token, "?since=")).status).toBe(400);
  });

  it("carries only the lightweight fields a poll needs", async () => {
    const json = (await body(await getDeltas(w.seller.token))) as { units: Record<string, unknown>[] };
    expect(Object.keys(json.units[0]!).sort()).toEqual(["currentHoldExpiresAt", "floor", "id", "status", "unitNumber", "updatedAt"]);
  });
});

describe("POST /api/v1/projects/[projectId]/units/[unitId]/holds", () => {
  it("answers 401 without a session", async () => {
    expect((await takeHold(null, w.plots[0]!.id)).status).toBe(401);
  });

  it("lets an associate hold a plot, for the project's hold window", async () => {
    const before = Date.now();
    const response = await takeHold(w.seller.token, w.plots[0]!.id);

    expect(response.status).toBe(201);
    const json = await body(response);
    expect(json).toMatchObject({ unitId: w.plots[0]!.id });
    expect(typeof json.holdId).toBe("string");
    const window = Date.parse(json.expiresAt as string) - before;
    expect(window).toBeGreaterThan(59 * 60_000);
    expect(window).toBeLessThan(61 * 60_000);
    expect(await unitStatus(w.plots[0]!.id)).toBe("HELD");
  });

  it("answers an associate's retry with the hold they already have, not an error and not a second hold", async () => {
    const first = await body(await takeHold(w.seller.token, w.plots[0]!.id));
    const retry = await takeHold(w.seller.token, w.plots[0]!.id);

    expect(retry.status).toBe(200);
    expect((await body(retry)).holdId).toBe(first.holdId);
    expect(await db.unitHold.count({ where: { unitId: w.plots[0]!.id } })).toBe(1);
  });

  it("answers 409, naming the holder, when another associate holds the plot", async () => {
    await takeHold(w.seller.token, w.plots[0]!.id);
    const response = await takeHold(w.rival.token, w.plots[0]!.id);

    expect(response.status).toBe(409);
    expect(String((await body(response)).detail)).toContain("seller");
  });

  it("answers 403 to an admin, who is not a seller: no hold permission and no associate profile", async () => {
    expect((await takeHold(w.admin.token, w.plots[0]!.id)).status).toBe(403);
    expect(await unitStatus(w.plots[0]!.id)).toBe("AVAILABLE");
  });

  it("answers 403 to a super admin with no associate profile, saying why", async () => {
    const response = await takeHold(w.superAdmin.token, w.plots[0]!.id);
    expect(response.status).toBe(403);
    expect(String((await body(response)).detail)).toMatch(/no associate profile/);
  });

  it("answers 403 to someone with no role at all", async () => {
    expect((await takeHold(w.outsider.token, w.plots[0]!.id)).status).toBe(403);
  });

  it("answers 404 for a plot that does not exist, and for a plot named under the wrong project", async () => {
    expect((await takeHold(w.seller.token, "no-such-plot")).status).toBe(404);
    expect((await takeHold(w.seller.token, w.plots[0]!.id, "no-such-project")).status).toBe(404);
  });

  it("answers 422 once the associate's hold quota is used", async () => {
    await db.grade.update({ where: { orgId_code: { orgId: ORG, code: "G1" } }, data: { holdQuota: 1 } });
    expect((await takeHold(w.seller.token, w.plots[0]!.id)).status).toBe(201);

    const response = await takeHold(w.seller.token, w.plots[1]!.id);
    expect(response.status).toBe(422);
    expect(await unitStatus(w.plots[1]!.id)).toBe("AVAILABLE");
  });

  it("takes the hold while the project has no RERA registration, which is not required", async () => {
    await db.project.update({ where: { id: w.project.id }, data: { reraRegNo: null, reraValidTill: null } });
    const response = await takeHold(w.seller.token, w.plots[0]!.id);
    expect(response.status).toBe(201);
    expect(await unitStatus(w.plots[0]!.id)).toBe("HELD");
  });

  it("answers 422 while the project has no active price list", async () => {
    await db.priceList.update({ where: { id: w.priceList.id }, data: { status: "ARCHIVED" } });
    expect((await takeHold(w.seller.token, w.plots[0]!.id)).status).toBe(422);
  });

  it("lets exactly one of several simultaneous holders win a plot", async () => {
    const contenders = [w.seller, w.rival];
    const results = await Promise.all(contenders.map((p) => takeHold(p.token, w.plots[0]!.id)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db.unitHold.count({ where: { unitId: w.plots[0]!.id, releasedAt: null } })).toBe(1);
  });
});
