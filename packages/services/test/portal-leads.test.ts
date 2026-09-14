// Portal lead ingestion webhook mechanism -- Phase 5. Payload shape is
// PLACEHOLDER (no real portal API doc exists), but the mechanism under
// test here is real: LeadSource mapping, idempotent replay, audit with a
// null (system) actor.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { ingestPortalLead, UnknownPortalError } from "../src/portal-leads";

const db = getPrismaClient();
const ORG = "org_test_portal_leads";

async function reset() {
  await db.leadClaim.deleteMany({ where: { lead: { orgId: ORG } } });
  await db.lead.deleteMany({ where: { orgId: ORG } });
  await db.auditLog.deleteMany({ where: { orgId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedOrg() {
  await db.organization.create({ data: { id: ORG, name: "Portal Leads Test Org", legalName: "Portal Leads Test Org Pvt Ltd" } });
}

beforeEach(reset);
afterAll(reset);

describe("ingestPortalLead", () => {
  it("creates an unassigned lead mapped to the correct LeadSource, per portal", async () => {
    await seedOrg();

    const from99acres = await ingestPortalLead(db, {
      orgId: ORG, portal: "99ACRES", externalLeadId: "99A-1", name: "Asha Rao", phone: "9876543210",
    });
    const fromMagicBricks = await ingestPortalLead(db, {
      orgId: ORG, portal: "MAGICBRICKS", externalLeadId: "MB-1", name: "Rohit Shah", phone: "9876543211",
    });
    const fromHousing = await ingestPortalLead(db, {
      orgId: ORG, portal: "HOUSING", externalLeadId: "HS-1", name: "Priya Nair", phone: "9876543212",
    });

    expect(from99acres.source).toBe("PORTAL_99ACRES");
    expect(fromMagicBricks.source).toBe("PORTAL_MAGICBRICKS");
    expect(fromHousing.source).toBe("PORTAL_HOUSING");
    expect(from99acres.assignedAssociateId).toBeNull();

    const claims = await db.leadClaim.findMany({ where: { leadId: from99acres.id } });
    expect(claims).toHaveLength(0);
  });

  it("is idempotent on (orgId, source, externalLeadId) -- a retried webhook delivery does not double-create", async () => {
    await seedOrg();

    const first = await ingestPortalLead(db, {
      orgId: ORG, portal: "99ACRES", externalLeadId: "99A-DUPE", name: "Same Lead", phone: "9876500000",
    });
    const second = await ingestPortalLead(db, {
      orgId: ORG, portal: "99ACRES", externalLeadId: "99A-DUPE", name: "Same Lead", phone: "9876500000",
    });

    expect(second.id).toBe(first.id);
    const count = await db.lead.count({ where: { orgId: ORG, source: "PORTAL_99ACRES", sourceDetail: "99A-DUPE" } });
    expect(count).toBe(1);
  });

  it("refuses an unknown portal", async () => {
    await seedOrg();
    await expect(
      ingestPortalLead(db, { orgId: ORG, portal: "FACEBOOK_MARKETPLACE", externalLeadId: "x", name: "N", phone: "9876543213" }),
    ).rejects.toThrow(UnknownPortalError);
  });

  it("writes an audit row with a null (system) actor, not a fabricated user", async () => {
    await seedOrg();
    const lead = await ingestPortalLead(db, {
      orgId: ORG, portal: "HOUSING", externalLeadId: "HS-AUDIT", name: "Audit Check", phone: "9876543214",
    });

    const entry = await db.auditLog.findFirst({ where: { orgId: ORG, entity: "Lead", entityId: lead.id } });
    expect(entry?.actorId).toBeNull();
    expect(entry?.actorLabel).toContain("Portal webhook");
  });
});
