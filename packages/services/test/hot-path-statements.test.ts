// Every authenticated request validates a session and loads the actor's
// permissions, and every transaction that asserts a permission loads them again.
// Prisma's relationJoins is off, so a nested read is one round trip per level;
// these two lookups are single SQL joins on purpose. This file pins that: if
// someone "tidies" either back into a nested findMany, the request path quietly
// gains four statements and nothing fails -- except here.
//
// "Statements" are counted as the client calls that reach the database: a raw
// query is one; a model delegate (db.userRole, db.session, ...) is at least one,
// and with nested selects several.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import type { PrismaClient } from "@desire/db";
import { SessionInvalidError, createSession, revokeSession, validateSession } from "../src/auth";
import { assertPermission, getSessionPermissions, ForbiddenError } from "../src/rbac";

const db = getPrismaClient();
const ORG = "org_test_hotpath";

async function reset() {
  await db.userRole.deleteMany({ where: { role: { orgId: ORG } } });
  await db.rolePermission.deleteMany({ where: { role: { orgId: ORG } } });
  await db.role.deleteMany({ where: { orgId: ORG } });
  await db.project.deleteMany({ where: { orgId: ORG } });
  await db.user.deleteMany({ where: { orgId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  await db.organization.create({ data: { id: ORG, name: "Hot Path Org", legalName: "Hot Path Org Pvt Ltd" } });
  const user = await db.user.create({
    data: { orgId: ORG, email: `u-${ORG}@test.local`, name: "Hot Path", passwordHash: "unused", status: "ACTIVE" },
  });
  const projectA = await db.project.create({ data: { orgId: ORG, code: "HPA", name: "A" } });
  const projectB = await db.project.create({ data: { orgId: ORG, code: "HPB", name: "B" } });

  const grant = async (roleCode: string, codes: string[], projectId: string | null) => {
    const role = await db.role.create({ data: { orgId: ORG, code: roleCode, name: roleCode } });
    for (const code of codes) {
      const [resource, action] = code.split(".");
      const permission = await db.permission.upsert({
        where: { code },
        update: {},
        create: { code, resource: resource!, action: action! },
      });
      await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    }
    await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId } });
  };
  await grant("ORGWIDE", ["unit.read", "booking.read"], null);
  await grant("ONLY_A", ["project.write"], projectA.id);
  // The same permission through two roles must still read once.
  await grant("DUPLICATE", ["unit.read"], null);
  return { user, projectA, projectB };
}

/** Records which top-level members of the client were touched. */
function watched(client: PrismaClient): { client: PrismaClient; touched: Set<string> } {
  const touched = new Set<string>();
  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && (prop.startsWith("$") || /^[a-z]/.test(prop))) touched.add(prop);
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { client: proxy, touched };
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("getSessionPermissions", () => {
  it("is one raw statement, not a walk down four relations", async () => {
    const { user } = await seed();
    const { client, touched } = watched(db);
    await getSessionPermissions(client, user.id);
    expect([...touched]).toEqual(["$queryRaw"]);
  });

  it("returns org-wide grants once each, even when two roles carry the same permission", async () => {
    const { user } = await seed();
    const codes = await getSessionPermissions(db, user.id);
    expect([...codes].sort()).toEqual(["booking.read", "unit.read"]);
  });

  it("adds a project-scoped grant only for that project", async () => {
    const { user, projectA, projectB } = await seed();
    expect([...(await getSessionPermissions(db, user.id, { projectId: projectA.id }))].sort()).toEqual([
      "booking.read",
      "project.write",
      "unit.read",
    ]);
    expect([...(await getSessionPermissions(db, user.id, { projectId: projectB.id }))].sort()).toEqual([
      "booking.read",
      "unit.read",
    ]);
  });

  it("gives a user with no roles an empty set", async () => {
    await seed();
    const stranger = await db.user.create({
      data: { orgId: ORG, email: `s-${ORG}@test.local`, name: "S", passwordHash: "unused" },
    });
    expect((await getSessionPermissions(db, stranger.id)).size).toBe(0);
  });

  it("works inside a transaction, where assertPermission runs most", async () => {
    const { user, projectA } = await seed();
    await db.$transaction(async (tx) => {
      await expect(assertPermission(tx, user.id, "project.write", { projectId: projectA.id })).resolves.toBeUndefined();
      await expect(assertPermission(tx, user.id, "project.write")).rejects.toThrow(ForbiddenError);
    });
  });
});

describe("validateSession", () => {
  it("is one raw statement for a fresh session: lookup and user together, no write", async () => {
    const { user } = await seed();
    const { rawToken } = await createSession(db, user.id, {});
    const { client, touched } = watched(db);

    const session = await validateSession(client, rawToken);

    expect([...touched]).toEqual(["$queryRaw"]);
    expect(session.userId).toBe(user.id);
    expect(session.user).toEqual({ id: user.id, orgId: ORG, name: "Hot Path", email: `u-${ORG}@test.local` });
  });

  it("carries the whole session row, with real Dates, and no password hash or MFA secret", async () => {
    const { user } = await seed();
    const { rawToken, expiresAt } = await createSession(db, user.id, {});
    const session = await validateSession(db, rawToken);

    expect(session.expiresAt).toBeInstanceOf(Date);
    expect(session.expiresAt.getTime()).toBe(expiresAt.getTime());
    expect(session.lastActiveAt).toBeInstanceOf(Date);
    expect(session.revokedAt).toBeNull();
    expect(Object.keys(session.user).sort()).toEqual(["email", "id", "name", "orgId"]);
    expect(JSON.stringify(session)).not.toMatch(/passwordHash|mfaSecret/);
  });

  it("writes lastActiveAt only once it is stale, and then only that", async () => {
    const { user } = await seed();
    const { rawToken } = await createSession(db, user.id, {});
    await db.session.updateMany({ where: { userId: user.id }, data: { lastActiveAt: new Date(Date.now() - 30 * 60_000) } });
    const { client, touched } = watched(db);

    await validateSession(client, rawToken);

    expect([...touched].sort()).toEqual(["$queryRaw", "session"]);
    const row = await db.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(Date.now() - row.lastActiveAt.getTime()).toBeLessThan(5_000);
  });

  it("still refuses an unknown token, a revoked session and an expired one", async () => {
    const { user } = await seed();
    await expect(validateSession(db, "no-such-token")).rejects.toThrow(SessionInvalidError);

    const revoked = await createSession(db, user.id, {});
    await revokeSession(db, revoked.rawToken);
    await expect(validateSession(db, revoked.rawToken)).rejects.toThrow("revoked");

    const expired = await createSession(db, user.id, {});
    await db.session.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(validateSession(db, expired.rawToken)).rejects.toThrow(SessionInvalidError);
  });
});
