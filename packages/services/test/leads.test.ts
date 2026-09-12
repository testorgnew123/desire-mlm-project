// CRM: Lead, LeadClaim, LeadActivity, SiteVisit -- Phase 2 Slice 3. Runs
// against LOCAL Docker Postgres -- dedup-by-live-claim, the O/T scope split,
// and the reassign claim-release/reclaim are exactly what is under test.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import {
  LeadNotFoundError,
  LiveClaimConflictError,
  ReassignReasonRequiredError,
  SiteVisitNotFoundError,
  StageChangeRequiresToStageError,
  completeSiteVisit,
  createLead,
  hashForDedup,
  listLeads,
  logActivity,
  reassignLead,
  scheduleSiteVisit,
  updateLead,
} from "../src/leads";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_leads";
const OTHER_ORG = "org_test_leads_other";

const LEAD_PERMS = ["lead.write", "lead.activity", "lead.reassign", "sitevisit.create", "lead.read"];

async function reset() {
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.siteVisit.deleteMany({ where: { orgId } });
    await db.leadActivity.deleteMany({ where: { lead: { orgId } } });
    await db.leadClaim.deleteMany({ where: { lead: { orgId } } });
    await db.lead.deleteMany({ where: { orgId } });
    await db.auditLog.deleteMany({ where: { orgId } });
    await db.associateHierarchy.deleteMany({ where: { associate: { orgId } } });
    await db.associateGrade.deleteMany({ where: { associate: { orgId } } });
    await db.associate.deleteMany({ where: { orgId } });
    await db.userRole.deleteMany({ where: { role: { orgId } } });
    await db.rolePermission.deleteMany({ where: { role: { orgId } } });
    await db.role.deleteMany({ where: { orgId } });
    await db.user.deleteMany({ where: { orgId } });
    await db.project.deleteMany({ where: { orgId } });
    await db.grade.deleteMany({ where: { orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
  }
  // Permission is global config -- upsert-if-missing only, never deleted
  // here (the parallel-test-file race this project already found and fixed).
}

async function makeUser(orgId: string, label: string, codes: string[], opts: { associate?: boolean } = {}) {
  const user = await db.user.create({
    data: { orgId, email: `${label}-${orgId}@test.local`, name: label, passwordHash: "unused" },
  });
  const role = await db.role.create({ data: { orgId, code: `ROLE_${label}`, name: label } });
  for (const code of codes) {
    const [resource, action] = code.split(".");
    const perm = await db.permission.upsert({
      where: { code },
      update: {},
      create: { code, resource: resource!, action: action! },
    });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  }
  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });

  let associate = null;
  if (opts.associate) {
    associate = await db.associate.create({
      data: { orgId, userId: user.id, code: `A-${label}`, engagementType: "EMPLOYEE", joinDate: new Date("2024-01-01") },
    });
    await db.associateHierarchy.create({
      data: { associateId: associate.id, parentId: null, path: "/", depth: 0, validFrom: new Date("2024-01-01") },
    });
  }
  return { user, role, associate };
}

async function renameRole(orgId: string, fromCode: string, toCode: string) {
  const role = await db.role.findFirstOrThrow({ where: { orgId, code: fromCode } });
  await db.role.update({ where: { id: role.id }, data: { code: toCode } });
}

/** admin (no Associate profile), a TEAM_LEAD with one downline ASSOCIATE,
 *  and an unrelated top-level ASSOCIATE ("stranger") outside that team. */
async function seedFixture(orgId: string = ORG) {
  await db.organization.create({ data: { id: orgId, name: "Leads Test Org", legalName: "Leads Test Org Pvt Ltd" } });
  const project = await db.project.create({
    data: {
      orgId, code: "SKY", name: "Skyline", city: "Pune", state: "Maharashtra",
      reraRegNo: "P-TEST-0001", reraValidTill: new Date("2030-01-01"),
      holdTtlMinutes: 60, holdExtensionMinutes: 30, maxHoldExtensions: 1,
    },
  });

  const admin = await makeUser(orgId, "admin", LEAD_PERMS);
  await renameRole(orgId, "ROLE_admin", "SUPER_ADMIN");

  const teamLead = await makeUser(orgId, "teamlead", LEAD_PERMS, { associate: true });
  await renameRole(orgId, "ROLE_teamlead", "TEAM_LEAD");

  const report = await makeUser(orgId, "report", LEAD_PERMS, { associate: true });
  await db.associateHierarchy.updateMany({
    where: { associateId: report.associate!.id },
    data: { parentId: teamLead.associate!.id, path: `/${teamLead.associate!.id}/`, depth: 1 },
  });

  const stranger = await makeUser(orgId, "stranger", LEAD_PERMS, { associate: true });
  const noPerms = await makeUser(orgId, "noperms", [], { associate: true });

  return { project, admin, teamLead, report, stranger, noPerms };
}

function ctx(orgId: string, userId: string | null, label: string): AuditContext {
  return { orgId, actorId: userId, actorLabel: label };
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("createLead: dedup by phoneHash against a LIVE claim", () => {
  it("creates a lead and claims it for the creating associate", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, {
      name: "Asha Rao", phone: "9876543210", source: "WALK_IN",
      audit: ctx(ORG, f.report.user.id, "report"),
    });

    expect(lead.assignedAssociateId).toBe(f.report.associate!.id);
    const claim = await db.leadClaim.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(claim.associateId).toBe(f.report.associate!.id);
    expect(claim.releasedAt).toBeNull();
  });

  it("refuses a second lead on the same phone while a live claim exists, naming the claimant", async () => {
    const f = await seedFixture();
    await createLead(db, { name: "Asha Rao", phone: "9876543210", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });

    await expect(
      createLead(db, { name: "Asha (dup)", phone: "9876543210", source: "REFERRAL", audit: ctx(ORG, f.stranger.user.id, "stranger") }),
    ).rejects.toThrow(LiveClaimConflictError);

    try {
      await createLead(db, { name: "Asha (dup)", phone: "9876543210", source: "REFERRAL", audit: ctx(ORG, f.stranger.user.id, "stranger") });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LiveClaimConflictError);
      expect((e as LiveClaimConflictError).claimingAssociateId).toBe(f.report.associate!.id);
    }
  });

  it("treats differently-formatted phone numbers as the same number", async () => {
    const f = await seedFixture();
    await createLead(db, { name: "Asha Rao", phone: "98765 43210", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });

    await expect(
      createLead(db, { name: "Dup", phone: "+91-9876543210", source: "REFERRAL", audit: ctx(ORG, f.stranger.user.id, "stranger") }),
    ).rejects.toThrow(LiveClaimConflictError);
  });

  it("allows a fresh claim once the prior claim has expired -- the lead returns to the pool", async () => {
    const f = await seedFixture();
    const first = await createLead(db, { name: "Asha Rao", phone: "9876543210", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });
    await db.leadClaim.updateMany({ where: { leadId: first.id }, data: { expiresAt: new Date("2020-01-01") } });

    const second = await createLead(db, { name: "Asha (re-claimed)", phone: "9876543210", source: "REFERRAL", audit: ctx(ORG, f.stranger.user.id, "stranger") });
    expect(second.assignedAssociateId).toBe(f.stranger.associate!.id);
  });

  it("a different phone number never conflicts", async () => {
    const f = await seedFixture();
    await createLead(db, { name: "Asha Rao", phone: "9876543210", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });
    const other = await createLead(db, { name: "Bala Krishnan", phone: "9123456780", source: "WALK_IN", audit: ctx(ORG, f.stranger.user.id, "stranger") });
    expect(other.id).toBeDefined();
  });

  it("refuses without lead.write", async () => {
    const f = await seedFixture();
    await expect(
      createLead(db, { name: "Asha Rao", phone: "9876543210", source: "WALK_IN", audit: ctx(ORG, f.noPerms.user.id, "noperms") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("hashForDedup", () => {
  it("is deterministic and distinguishes different input", () => {
    expect(hashForDedup("+919876543210")).toBe(hashForDedup("+919876543210"));
    expect(hashForDedup("+919876543210")).not.toBe(hashForDedup("+919876543211"));
  });
});

describe("createLead: who may be assigned (resolveAssigneeId)", () => {
  it("defaults to the caller's own associate", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, { name: "X", phone: "9111111111", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });
    expect(lead.assignedAssociateId).toBe(f.report.associate!.id);
  });

  it("an admin with no Associate profile may assign to anyone", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, {
      name: "X", phone: "9111111112", source: "WALK_IN",
      assignToAssociateId: f.stranger.associate!.id,
      audit: ctx(ORG, f.admin.user.id, "admin"),
    });
    expect(lead.assignedAssociateId).toBe(f.stranger.associate!.id);
  });

  it("a TEAM_LEAD may assign to their own downline", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, {
      name: "X", phone: "9111111113", source: "WALK_IN",
      assignToAssociateId: f.report.associate!.id,
      audit: ctx(ORG, f.teamLead.user.id, "teamlead"),
    });
    expect(lead.assignedAssociateId).toBe(f.report.associate!.id);
  });

  it("a TEAM_LEAD is refused assigning to a stranger outside their downline", async () => {
    const f = await seedFixture();
    await expect(
      createLead(db, {
        name: "X", phone: "9111111114", source: "WALK_IN",
        assignToAssociateId: f.stranger.associate!.id,
        audit: ctx(ORG, f.teamLead.user.id, "teamlead"),
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("a plain associate is refused naming anyone but themselves", async () => {
    const f = await seedFixture();
    await expect(
      createLead(db, {
        name: "X", phone: "9111111115", source: "WALK_IN",
        assignToAssociateId: f.stranger.associate!.id,
        audit: ctx(ORG, f.report.user.id, "report"),
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("updateLead", () => {
  it("updates the given fields and writes a before/after audit row", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, { name: "Asha", phone: "9222222220", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });

    const updated = await updateLead(db, {
      leadId: lead.id, requirementNote: "Wants a corner unit", budgetMax: "9000000",
      audit: ctx(ORG, f.report.user.id, "report"),
    });
    expect(updated.requirementNote).toBe("Wants a corner unit");
    expect(updated.budgetMax?.toString()).toBe("9000000");

    const auditRow = await db.auditLog.findFirstOrThrow({ where: { entity: "Lead", entityId: lead.id, action: "UPDATE" } });
    expect((auditRow.after as { requirementNote?: string }).requirementNote).toBe("Wants a corner unit");
  });

  it("returns unchanged and writes no audit row when nothing was submitted", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, { name: "Asha", phone: "9222222221", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });
    const countBefore = await db.auditLog.count({ where: { entity: "Lead", entityId: lead.id } });

    const result = await updateLead(db, { leadId: lead.id, audit: ctx(ORG, f.report.user.id, "report") });
    expect(result).toEqual(lead);
    expect(await db.auditLog.count({ where: { entity: "Lead", entityId: lead.id } })).toBe(countBefore);
  });

  it("a TEAM_LEAD may update a downline associate's lead", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, { name: "Asha", phone: "9222222222", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });
    const updated = await updateLead(db, { leadId: lead.id, name: "Asha R.", audit: ctx(ORG, f.teamLead.user.id, "teamlead") });
    expect(updated.name).toBe("Asha R.");
  });

  it("refuses an associate updating a lead outside their scope", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, { name: "Asha", phone: "9222222223", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });
    await expect(
      updateLead(db, { leadId: lead.id, name: "Hijacked", audit: ctx(ORG, f.stranger.user.id, "stranger") }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("throws for a lead that does not exist", async () => {
    const f = await seedFixture();
    await expect(updateLead(db, { leadId: "nope", audit: ctx(ORG, f.admin.user.id, "admin") })).rejects.toThrow(LeadNotFoundError);
  });

  it("refuses a lead belonging to another organisation", async () => {
    const f = await seedFixture(ORG);
    const other = await seedFixture(OTHER_ORG);
    const lead = await createLead(db, { name: "Other Org Lead", phone: "9333333330", source: "WALK_IN", audit: ctx(OTHER_ORG, other.report.user.id, "report") });
    await expect(
      updateLead(db, { leadId: lead.id, name: "Hijacked", audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("logActivity", () => {
  it("logs a plain activity and stamps lastContactAt without touching stage", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, { name: "Asha", phone: "9444444440", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });

    const activity = await logActivity(db, { leadId: lead.id, type: "CALL", notes: "Left voicemail", audit: ctx(ORG, f.report.user.id, "report") });
    expect(activity.fromStage).toBeNull();
    expect(activity.toStage).toBeNull();

    const refreshed = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(refreshed.stage).toBe("NEW");
    expect(refreshed.lastContactAt).not.toBeNull();
  });

  it("STAGE_CHANGE updates Lead.stage and stamps fromStage/toStage", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, { name: "Asha", phone: "9444444441", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });

    const activity = await logActivity(db, { leadId: lead.id, type: "STAGE_CHANGE", toStage: "QUALIFIED", audit: ctx(ORG, f.report.user.id, "report") });
    expect(activity.fromStage).toBe("NEW");
    expect(activity.toStage).toBe("QUALIFIED");

    const refreshed = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(refreshed.stage).toBe("QUALIFIED");
  });

  it("refuses STAGE_CHANGE without toStage", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, { name: "Asha", phone: "9444444442", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });
    await expect(
      logActivity(db, { leadId: lead.id, type: "STAGE_CHANGE", audit: ctx(ORG, f.report.user.id, "report") }),
    ).rejects.toThrow(StageChangeRequiresToStageError);
  });

  it("refuses an associate logging activity on a lead outside their scope", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, { name: "Asha", phone: "9444444443", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });
    await expect(
      logActivity(db, { leadId: lead.id, type: "CALL", audit: ctx(ORG, f.stranger.user.id, "stranger") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("reassignLead", () => {
  it("releases the current claim and creates a new one for the target, updating assignedAssociateId", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, { name: "Asha", phone: "9555555550", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });
    const oldClaim = await db.leadClaim.findFirstOrThrow({ where: { leadId: lead.id } });

    const updated = await reassignLead(db, {
      leadId: lead.id, toAssociateId: f.stranger.associate!.id, reason: "Report went on leave",
      audit: ctx(ORG, f.admin.user.id, "admin"),
    });
    expect(updated.assignedAssociateId).toBe(f.stranger.associate!.id);

    const refreshedOld = await db.leadClaim.findUniqueOrThrow({ where: { id: oldClaim.id } });
    expect(refreshedOld.releasedAt).not.toBeNull();

    const newClaim = await db.leadClaim.findFirstOrThrow({ where: { leadId: lead.id, associateId: f.stranger.associate!.id } });
    expect(newClaim.releasedAt).toBeNull();
  });

  it("requires a reason", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, { name: "Asha", phone: "9555555551", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });
    await expect(
      reassignLead(db, { leadId: lead.id, toAssociateId: f.stranger.associate!.id, reason: "  ", audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(ReassignReasonRequiredError);
  });

  it("refuses a TEAM_LEAD reassigning TO a target outside their downline", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, { name: "Asha", phone: "9555555552", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });
    await expect(
      reassignLead(db, { leadId: lead.id, toAssociateId: f.stranger.associate!.id, reason: "test", audit: ctx(ORG, f.teamLead.user.id, "teamlead") }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses a caller without lead.reassign", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, { name: "Asha", phone: "9555555553", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });
    await expect(
      reassignLead(db, { leadId: lead.id, toAssociateId: f.stranger.associate!.id, reason: "test", audit: ctx(ORG, f.noPerms.user.id, "noperms") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("site visits", () => {
  it("schedules a visit, defaulting the associate to the caller", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, { name: "Asha", phone: "9666666660", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });
    const visit = await scheduleSiteVisit(db, {
      leadId: lead.id, projectId: f.project.id, scheduledAt: new Date("2026-10-01T10:00:00Z"),
      audit: ctx(ORG, f.report.user.id, "report"),
    });
    expect(visit.associateId).toBe(f.report.associate!.id);
    expect(visit.completedAt).toBeNull();
  });

  it("completes a visit with feedback and interest level", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, { name: "Asha", phone: "9666666661", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });
    const visit = await scheduleSiteVisit(db, {
      leadId: lead.id, projectId: f.project.id, scheduledAt: new Date("2026-10-01T10:00:00Z"),
      audit: ctx(ORG, f.report.user.id, "report"),
    });

    const completed = await completeSiteVisit(db, {
      siteVisitId: visit.id, feedback: "Loved the view", interestLevel: 5, unitsShown: ["A-101"],
      audit: ctx(ORG, f.report.user.id, "report"),
    });
    expect(completed.completedAt).not.toBeNull();
    expect(completed.feedback).toBe("Loved the view");
    expect(completed.interestLevel).toBe(5);
    expect(completed.unitsShown).toEqual(["A-101"]);
  });

  it("throws for a site visit that does not exist", async () => {
    const f = await seedFixture();
    await expect(
      completeSiteVisit(db, { siteVisitId: "nope", audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(SiteVisitNotFoundError);
  });

  it("refuses scheduling on a lead outside the caller's scope", async () => {
    const f = await seedFixture();
    const lead = await createLead(db, { name: "Asha", phone: "9666666662", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });
    await expect(
      scheduleSiteVisit(db, { leadId: lead.id, projectId: f.project.id, scheduledAt: new Date(), audit: ctx(ORG, f.stranger.user.id, "stranger") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("listLeads: ASSOCIATE sees own, TEAM_LEAD sees own + downline", () => {
  it("an ASSOCIATE sees only their own leads", async () => {
    const f = await seedFixture();
    const own = await createLead(db, { name: "Own", phone: "9777777770", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });
    await createLead(db, { name: "Someone Else's", phone: "9777777771", source: "WALK_IN", audit: ctx(ORG, f.stranger.user.id, "stranger") });

    const leads = await listLeads(db, { orgId: ORG, actorId: f.report.user.id });
    expect(leads.map((l) => l.id)).toEqual([own.id]);
  });

  it("a TEAM_LEAD sees their own + downline leads, not a stranger's", async () => {
    const f = await seedFixture();
    const downline = await createLead(db, { name: "Downline", phone: "9777777772", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });
    await createLead(db, { name: "Stranger's", phone: "9777777773", source: "WALK_IN", audit: ctx(ORG, f.stranger.user.id, "stranger") });

    const leads = await listLeads(db, { orgId: ORG, actorId: f.teamLead.user.id });
    expect(leads.map((l) => l.id)).toEqual([downline.id]);
  });

  it("an admin sees every lead in the org", async () => {
    const f = await seedFixture();
    await createLead(db, { name: "A", phone: "9777777774", source: "WALK_IN", audit: ctx(ORG, f.report.user.id, "report") });
    await createLead(db, { name: "B", phone: "9777777775", source: "WALK_IN", audit: ctx(ORG, f.stranger.user.id, "stranger") });

    const leads = await listLeads(db, { orgId: ORG, actorId: f.admin.user.id });
    expect(leads.length).toBe(2);
  });

  it("refuses a caller without lead.read", async () => {
    const f = await seedFixture();
    await expect(listLeads(db, { orgId: ORG, actorId: f.noPerms.user.id })).rejects.toThrow(ForbiddenError);
  });
});
