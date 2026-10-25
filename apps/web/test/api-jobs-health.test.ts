import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as health } from "../app/api/health/route";
import { POST as expireHolds } from "../app/api/jobs/holds/expire/route";
import { POST as backupDump } from "../app/api/jobs/backup/dump/route";
import { __written } from "./stubs/netlify-blobs";
import { JOB_SECRET, body, db, request, resetWorld, seedWorld, unitStatus, type World } from "./support";

// The backup job writes its dump to Netlify Blobs, which exists only on Netlify;
// vitest.config.ts aliases the package to a stub, and __written is what it kept.

let w: World;
beforeEach(async () => {
  await resetWorld();
  w = await seedWorld();
  process.env.JOB_TRIGGER_SECRET = JOB_SECRET;
});
afterAll(async () => {
  await resetWorld();
  await db.$disconnect();
});

describe("GET /api/health", () => {
  it("answers 200 with a real database check, no session needed", async () => {
    const response = await health();
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ status: "ok", db: { ok: true } });
  });
});

describe.each([
  ["holds/expire", expireHolds, "/api/jobs/holds/expire"],
  ["backup/dump", backupDump, "/api/jobs/backup/dump"],
] as const)("POST /api/jobs/%s: the shared secret gate", (_name, handler, path) => {
  it("refuses a request with no secret", async () => {
    expect((await handler(request(path, { method: "POST" }))).status).toBe(401);
  });

  it("refuses a wrong secret, however close", async () => {
    expect((await handler(request(path, { method: "POST", headers: { "x-job-secret": `${JOB_SECRET}x` } }))).status).toBe(401);
    expect((await handler(request(path, { method: "POST", headers: { "x-job-secret": JOB_SECRET.slice(1) } }))).status).toBe(401);
  });

  it("is not opened by a session cookie, even a super admin's", async () => {
    expect((await handler(request(path, { method: "POST", token: w.superAdmin.token }))).status).toBe(401);
  });

  it("fails closed when the server has no secret configured at all", async () => {
    delete process.env.JOB_TRIGGER_SECRET;
    expect((await handler(request(path, { method: "POST", headers: { "x-job-secret": "" } }))).status).toBe(401);
    expect((await handler(request(path, { method: "POST", headers: { "x-job-secret": JOB_SECRET } }))).status).toBe(401);
  });

  it("runs with the right secret", async () => {
    const response = await handler(request(path, { method: "POST", headers: { "x-job-secret": JOB_SECRET } }));
    expect(response.status).toBe(200);
  });
});

describe("POST /api/jobs/backup/dump", () => {
  it("dumps the tables to the store, and the dump holds this org's rows", async () => {
    __written.clear();
    const response = await backupDump(request("/api/jobs/backup/dump", { method: "POST", headers: { "x-job-secret": JOB_SECRET } }));

    expect(response.status).toBe(200);
    expect(__written.size).toBe(1);
    const [[key, dump]] = [...__written.entries()] as [[string, { tables: Record<string, unknown[]> }]];
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}\.json$/);
    expect(Object.keys(dump.tables).length).toBeGreaterThan(20);
    expect(dump.tables.users?.length).toBeGreaterThanOrEqual(5);
  });
});

describe("POST /api/jobs/holds/expire", () => {
  it("frees a plot whose hold has lapsed, and leaves a live hold alone", async () => {
    const [lapsed, live] = w.plots;
    const past = new Date(Date.now() - 2 * 3_600_000);
    const lapsedHold = await db.unitHold.create({
      data: { orgId: "org_test_web", unitId: lapsed!.id, associateId: w.seller.associateId!, expiresAt: past },
    });
    await db.unit.update({ where: { id: lapsed!.id }, data: { status: "HELD", currentHoldId: lapsedHold.id } });
    const liveHold = await db.unitHold.create({
      data: { orgId: "org_test_web", unitId: live!.id, associateId: w.rival.associateId!, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    await db.unit.update({ where: { id: live!.id }, data: { status: "HELD", currentHoldId: liveHold.id } });

    const response = await expireHolds(request("/api/jobs/holds/expire", { method: "POST", headers: { "x-job-secret": JOB_SECRET } }));

    expect(response.status).toBe(200);
    expect(await unitStatus(lapsed!.id)).toBe("AVAILABLE");
    expect(await unitStatus(live!.id)).toBe("HELD");
    expect((await db.unitHold.findUniqueOrThrow({ where: { id: lapsedHold.id } })).releaseReason).toBe("EXPIRED");
  });
});
