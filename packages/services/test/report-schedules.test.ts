// Saved report views + scheduled email sending -- Phase 5's report builder.
// Real SMTP is never configured in this test env (no local mail emulation
// the way there's real Docker Postgres for everything else -- same
// category as Phase 4's Netlify Blobs write), so the sending half is
// verified only up to "EmailConfigError is caught and counted as a failure,
// never thrown" -- the actual mail delivery is verified live after deploy.
import "dotenv/config";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import {
  SavedViewNotFoundError,
  UnknownReportKeyError,
  createSavedView,
  deleteSavedView,
  listSavedViews,
  runScheduledReportEmails,
} from "../src/report-schedules";
import { ForbiddenError } from "../src/rbac";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_report_schedules";

async function reset() {
  await db.savedReportView.deleteMany({ where: { orgId: ORG } });
  await db.auditLog.deleteMany({ where: { orgId: ORG } });
  await db.userRole.deleteMany({ where: { role: { orgId: ORG } } });
  await db.rolePermission.deleteMany({ where: { role: { orgId: ORG } } });
  await db.role.deleteMany({ where: { orgId: ORG } });
  await db.user.deleteMany({ where: { orgId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedUser(label: string, codes: string[] = []) {
  await db.organization.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: "Report Schedules Test Org", legalName: "RS Test Org Pvt Ltd" } });
  const user = await db.user.create({ data: { orgId: ORG, email: `${label}@test.local`, name: label, passwordHash: "unused" } });
  if (codes.length > 0) {
    const role = await db.role.create({ data: { orgId: ORG, code: `ROLE_${label}`, name: label } });
    for (const code of codes) {
      const [resource, action] = code.split(".");
      const perm = await db.permission.upsert({ where: { code }, update: {}, create: { code, resource: resource!, action: action! } });
      await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    }
    await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });
  }
  return user;
}

function ctx(userId: string): AuditContext {
  return { orgId: ORG, actorId: userId, actorLabel: "test" };
}

beforeEach(reset);
afterEach(async () => {
  delete process.env.SMTP_HOST;
  delete process.env.MAIL_FROM;
});
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("createSavedView / listSavedViews / deleteSavedView", () => {
  it("creates, lists (own only), and deletes a saved view", async () => {
    const user = await seedUser("owner1");
    const other = await seedUser("other1");

    const view = await createSavedView(db, { reportKey: "stock-statement", name: "My stock view", audit: ctx(user.id) });
    expect(view.name).toBe("My stock view");

    const ownList = await listSavedViews(db, { audit: ctx(user.id) });
    expect(ownList.map((v) => v.id)).toContain(view.id);

    const otherList = await listSavedViews(db, { audit: ctx(other.id) });
    expect(otherList.map((v) => v.id)).not.toContain(view.id);

    await expect(deleteSavedView(db, { id: view.id, audit: ctx(other.id) })).rejects.toThrow(SavedViewNotFoundError);
    await deleteSavedView(db, { id: view.id, audit: ctx(user.id) });
    expect(await listSavedViews(db, { audit: ctx(user.id) })).toHaveLength(0);
  });

  it("refuses an unknown report key", async () => {
    const user = await seedUser("owner2");
    await expect(createSavedView(db, { reportKey: "not-a-real-report", name: "x", audit: ctx(user.id) })).rejects.toThrow(UnknownReportKeyError);
  });

  it("refuses a malformed cron expression", async () => {
    const user = await seedUser("owner3");
    await expect(
      createSavedView(db, { reportKey: "stock-statement", name: "x", scheduleCron: "not a cron", audit: ctx(user.id) }),
    ).rejects.toThrow();
  });

  it("refuses a system actor (no user)", async () => {
    await expect(
      createSavedView(db, { reportKey: "stock-statement", name: "x", audit: { orgId: ORG, actorId: null, actorLabel: "system" } }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("runScheduledReportEmails", () => {
  it("counts a due view as failed (EmailConfigError), never throws, when SMTP is unconfigured", async () => {
    delete process.env.SMTP_HOST;
    const user = await seedUser("scheduled1", ["report.read"]);
    await createSavedView(db, { reportKey: "stock-statement", name: "Daily", scheduleCron: "0 0 * * *", audit: ctx(user.id) });

    const result = await runScheduledReportEmails(db, new Date("2026-01-02T00:05:00Z"));
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.sent).toBe(0);
  });

  it("does not touch a view with no schedule (on-demand only)", async () => {
    const user = await seedUser("scheduled2");
    const view = await createSavedView(db, { reportKey: "stock-statement", name: "On demand", audit: ctx(user.id) });

    const result = await runScheduledReportEmails(db, new Date());
    expect(result.sent + result.failed).toBe(0);

    const unchanged = await db.savedReportView.findUniqueOrThrow({ where: { id: view.id } });
    expect(unchanged.lastRunAt).toBeNull();
  });

  it("does not re-fire a view whose lastRunAt is already past the most recent scheduled occurrence", async () => {
    const user = await seedUser("scheduled3");
    const view = await createSavedView(db, { reportKey: "stock-statement", name: "Daily", scheduleCron: "0 0 * * *", audit: ctx(user.id) });
    await db.savedReportView.update({ where: { id: view.id }, data: { lastRunAt: new Date("2026-01-02T00:00:00Z") } });

    const result = await runScheduledReportEmails(db, new Date("2026-01-02T12:00:00Z"));
    expect(result.sent + result.failed).toBe(0);
  });
});
