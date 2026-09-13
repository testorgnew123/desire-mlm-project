import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import { listAuditLog, writeAuditLog } from "../src/audit";

const db = getPrismaClient();
const TEST_ORG_ID = "org_test_audit";

async function makeUser(label: string, codes: string[]) {
  const user = await db.user.create({
    data: { orgId: TEST_ORG_ID, email: `${label}@test.local`, name: label, passwordHash: "unused" },
  });
  const role = await db.role.create({ data: { orgId: TEST_ORG_ID, code: `ROLE_${label}`, name: label } });
  for (const code of codes) {
    const [resource, action] = code.split(".");
    const perm = await db.permission.upsert({ where: { code }, update: {}, create: { code, resource: resource!, action: action! } });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  }
  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });
  return user;
}

beforeAll(async () => {
  await db.organization.upsert({
    where: { id: TEST_ORG_ID },
    update: {},
    create: { id: TEST_ORG_ID, name: "Audit Test Org", legalName: "Audit Test Org Pvt Ltd" },
  });
});

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { orgId: TEST_ORG_ID } });
  await db.userRole.deleteMany({ where: { role: { orgId: TEST_ORG_ID } } });
  await db.rolePermission.deleteMany({ where: { role: { orgId: TEST_ORG_ID } } });
  await db.role.deleteMany({ where: { orgId: TEST_ORG_ID } });
  await db.user.deleteMany({ where: { orgId: TEST_ORG_ID } });
  await db.organization.deleteMany({ where: { id: TEST_ORG_ID } });
  await db.$disconnect();
});

describe("writeAuditLog", () => {
  it("writes a row with before/after JSON and every context field", async () => {
    await writeAuditLog(
      db,
      {
        orgId: TEST_ORG_ID,
        actorId: "user_123",
        actorLabel: "Test Actor",
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        requestId: "req_abc",
      },
      {
        action: "UPDATE",
        entity: "Booking",
        entityId: "booking_1",
        before: { status: "DRAFT" },
        after: { status: "CONFIRMED" },
        reason: "test",
      },
    );

    const rows = await db.auditLog.findMany({ where: { orgId: TEST_ORG_ID, entity: "Booking" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("UPDATE");
    expect(rows[0]?.before).toEqual({ status: "DRAFT" });
    expect(rows[0]?.after).toEqual({ status: "CONFIRMED" });
    expect(rows[0]?.ipAddress).toBe("127.0.0.1");
  });

  it("handles a CREATE with no `before` state (undefined, not null-shaped JSON)", async () => {
    await writeAuditLog(
      db,
      { orgId: TEST_ORG_ID, actorId: null, actorLabel: "System Job" },
      { action: "CREATE", entity: "Lead", entityId: "lead_1", after: { name: "New Lead" } },
    );

    const row = await db.auditLog.findFirst({
      where: { orgId: TEST_ORG_ID, entity: "Lead" },
    });
    expect(row?.before).toBeNull();
    expect(row?.actorId).toBeNull();
    expect(row?.actorLabel).toBe("System Job");
  });
});

describe("listAuditLog (Phase 3.5 Slice 15 -- confirmed gap, writeAuditLog was never read back)", () => {
  it("returns rows for the org, newest first, and filters by entity/action", async () => {
    await writeAuditLog(db, { orgId: TEST_ORG_ID, actorId: null, actorLabel: "System Job" }, { action: "CREATE", entity: "ListTarget", entityId: "t1" });
    await writeAuditLog(db, { orgId: TEST_ORG_ID, actorId: null, actorLabel: "System Job" }, { action: "UPDATE", entity: "ListTarget", entityId: "t1" });
    await writeAuditLog(db, { orgId: TEST_ORG_ID, actorId: null, actorLabel: "System Job" }, { action: "CREATE", entity: "OtherTarget", entityId: "t2" });

    const reader = await makeUser("auditreader", ["audit.read"]);

    const all = await listAuditLog(db, { orgId: TEST_ORG_ID, actorId: reader.id });
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all[0]!.entity).toBe("OtherTarget");

    const byEntity = await listAuditLog(db, { orgId: TEST_ORG_ID, actorId: reader.id, entity: "ListTarget" });
    expect(byEntity.map((r) => r.action).sort()).toEqual(["CREATE", "UPDATE"]);

    const byAction = await listAuditLog(db, { orgId: TEST_ORG_ID, actorId: reader.id, entity: "ListTarget", action: "UPDATE" });
    expect(byAction).toHaveLength(1);
  });

  it("refuses without audit.read", async () => {
    const noPerms = await makeUser("auditnoperms", []);
    await expect(listAuditLog(db, { orgId: TEST_ORG_ID, actorId: noPerms.id })).rejects.toThrow(ForbiddenError);
  });
});
