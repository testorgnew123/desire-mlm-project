import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { writeAuditLog } from "../src/audit";

const db = getPrismaClient();
const TEST_ORG_ID = "org_test_audit";

describe("writeAuditLog", () => {
  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { orgId: TEST_ORG_ID } });
    await db.organization.deleteMany({ where: { id: TEST_ORG_ID } });
    await db.$disconnect();
  });

  it("writes a row with before/after JSON and every context field", async () => {
    await db.organization.upsert({
      where: { id: TEST_ORG_ID },
      update: {},
      create: { id: TEST_ORG_ID, name: "Audit Test Org", legalName: "Audit Test Org Pvt Ltd" },
    });

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

    const rows = await db.auditLog.findMany({ where: { orgId: TEST_ORG_ID } });
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
