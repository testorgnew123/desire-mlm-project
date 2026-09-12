// Hierarchy moves -- Phase 3 Slice 1. Runs against LOCAL Docker Postgres --
// the cycle-detection GATE, self-referral block, subtree path recompute,
// and payout-period-open rejection are exactly what is under test.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import { AssociateNotFoundError } from "../src/grades";
import {
  CycleDetectedError,
  MoveReasonRequiredError,
  PayoutPeriodOpenError,
  SelfReferralError,
  getAssociateTree,
  listAssociates,
  moveAssociate,
} from "../src/associates";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_associates";
const OTHER_ORG = "org_test_associates_other";

async function reset() {
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.hierarchyChangeLog.deleteMany({ where: { orgId } });
    await db.payoutBatch.deleteMany({ where: { orgId } });
    await db.associateGrade.deleteMany({ where: { associate: { orgId } } });
    await db.associateHierarchy.deleteMany({ where: { associate: { orgId } } });
    await db.auditLog.deleteMany({ where: { orgId } });
    await db.associate.deleteMany({ where: { orgId } });
    await db.userRole.deleteMany({ where: { role: { orgId } } });
    await db.rolePermission.deleteMany({ where: { role: { orgId } } });
    await db.role.deleteMany({ where: { orgId } });
    await db.user.deleteMany({ where: { orgId } });
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
  }
  return { user, associate };
}

async function renameRole(orgId: string, fromCode: string, toCode: string) {
  const role = await db.role.findFirstOrThrow({ where: { orgId, code: fromCode } });
  await db.role.update({ where: { id: role.id }, data: { code: toCode } });
}

async function place(associateId: string, parentId: string | null, path: string, depth: number) {
  return db.associateHierarchy.create({ data: { associateId, parentId, path, depth, validFrom: new Date("2024-01-01") } });
}

/** top -> mid -> leaf, plus an unrelated top-level stranger and a
 *  TEAM_LEAD (mirroring `mid`'s role) for scope tests. */
async function seedFixture(orgId: string = ORG) {
  await db.organization.create({ data: { id: orgId, name: "Associates Test Org", legalName: "Associates Test Org Pvt Ltd" } });

  const admin = await makeUser(orgId, "admin", ["associate.move", "associate.read"]);
  await renameRole(orgId, "ROLE_admin", "SUPER_ADMIN");

  const top = await makeUser(orgId, "top", ["associate.read"], { associate: true });
  const mid = await makeUser(orgId, "mid", ["associate.read"], { associate: true });
  await renameRole(orgId, "ROLE_mid", "TEAM_LEAD");
  const leaf = await makeUser(orgId, "leaf", ["associate.read"], { associate: true });
  const stranger = await makeUser(orgId, "stranger", ["associate.read"], { associate: true });
  const noPerms = await makeUser(orgId, "noperms", [], { associate: true });

  await place(top.associate!.id, null, "/", 0);
  await place(mid.associate!.id, top.associate!.id, `/${top.associate!.id}/`, 1);
  await place(leaf.associate!.id, mid.associate!.id, `/${top.associate!.id}/${mid.associate!.id}/`, 2);
  await place(stranger.associate!.id, null, "/", 0);

  return { admin, top, mid, leaf, stranger, noPerms };
}

function ctx(orgId: string, userId: string | null, label: string): AuditContext {
  return { orgId, actorId: userId, actorLabel: label };
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("moveAssociate: the cycle-detection GATE", () => {
  it("moves a leaf associate under a new parent, updating its own path/depth", async () => {
    const f = await seedFixture();
    const updated = await moveAssociate(db, {
      associateId: f.leaf.associate!.id, newParentId: f.stranger.associate!.id, reason: "Team restructure",
      audit: ctx(ORG, f.admin.user.id, "admin"),
    });
    expect(updated.parentId).toBe(f.stranger.associate!.id);
    expect(updated.path).toBe(`/${f.stranger.associate!.id}/`);
    expect(updated.depth).toBe(1);

    const oldPlacement = await db.associateHierarchy.findFirst({ where: { associateId: f.leaf.associate!.id, parentId: f.mid.associate!.id } });
    expect(oldPlacement!.validTo).not.toBeNull();
  });

  it("moving an associate with descendants recomputes the WHOLE SUBTREE's path/depth", async () => {
    const f = await seedFixture();
    await moveAssociate(db, {
      associateId: f.mid.associate!.id, newParentId: f.stranger.associate!.id, reason: "Team restructure",
      audit: ctx(ORG, f.admin.user.id, "admin"),
    });

    const midPlacement = await db.associateHierarchy.findFirstOrThrow({ where: { associateId: f.mid.associate!.id, validTo: null } });
    expect(midPlacement.path).toBe(`/${f.stranger.associate!.id}/`);
    expect(midPlacement.depth).toBe(1);

    // leaf is mid's descendant -- its path must now route through stranger -> mid, not top -> mid.
    const leafPlacement = await db.associateHierarchy.findFirstOrThrow({ where: { associateId: f.leaf.associate!.id, validTo: null } });
    expect(leafPlacement.path).toBe(`/${f.stranger.associate!.id}/${f.mid.associate!.id}/`);
    expect(leafPlacement.depth).toBe(2);

    const changeLog = await db.hierarchyChangeLog.findFirstOrThrow({ where: { associateId: f.mid.associate!.id } });
    expect(changeLog.subtreeSize).toBe(1); // leaf
  });

  it("moving to the top of the tree clears parentId and resets path/depth", async () => {
    const f = await seedFixture();
    const updated = await moveAssociate(db, {
      associateId: f.leaf.associate!.id, newParentId: null, reason: "Promoted to top",
      audit: ctx(ORG, f.admin.user.id, "admin"),
    });
    expect(updated.parentId).toBeNull();
    expect(updated.path).toBe("/");
    expect(updated.depth).toBe(0);
  });

  it("rejects self-referral", async () => {
    const f = await seedFixture();
    await expect(
      moveAssociate(db, { associateId: f.leaf.associate!.id, newParentId: f.leaf.associate!.id, reason: "test", audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(SelfReferralError);
  });

  it("rejects a move that would make the associate its own ancestor", async () => {
    const f = await seedFixture();
    // mid is leaf's ancestor -- moving mid UNDER leaf would create a cycle.
    await expect(
      moveAssociate(db, { associateId: f.mid.associate!.id, newParentId: f.leaf.associate!.id, reason: "test", audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(CycleDetectedError);
  });

  it("rejects a move while a payout batch for the org is open", async () => {
    const f = await seedFixture();
    await db.payoutBatch.create({
      data: {
        orgId: ORG, batchNumber: "PB-0001", periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-01-31"),
        status: "DRAFT", preparedById: f.admin.user.id,
      },
    });
    await expect(
      moveAssociate(db, { associateId: f.leaf.associate!.id, newParentId: f.stranger.associate!.id, reason: "test", audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(PayoutPeriodOpenError);
  });

  it("allows a move once the payout batch is PAID (no longer open)", async () => {
    const f = await seedFixture();
    await db.payoutBatch.create({
      data: {
        orgId: ORG, batchNumber: "PB-0002", periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-01-31"),
        status: "PAID", preparedById: f.admin.user.id,
      },
    });
    const updated = await moveAssociate(db, {
      associateId: f.leaf.associate!.id, newParentId: f.stranger.associate!.id, reason: "test", audit: ctx(ORG, f.admin.user.id, "admin"),
    });
    expect(updated.parentId).toBe(f.stranger.associate!.id);
  });

  it("requires a reason", async () => {
    const f = await seedFixture();
    await expect(
      moveAssociate(db, { associateId: f.leaf.associate!.id, newParentId: f.stranger.associate!.id, reason: "  ", audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(MoveReasonRequiredError);
  });

  it("refuses without associate.move", async () => {
    const f = await seedFixture();
    await expect(
      moveAssociate(db, { associateId: f.leaf.associate!.id, newParentId: f.stranger.associate!.id, reason: "test", audit: ctx(ORG, f.noPerms.user.id, "noperms") }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("throws for an associate that does not exist", async () => {
    const f = await seedFixture();
    await expect(
      moveAssociate(db, { associateId: "nope", newParentId: f.stranger.associate!.id, reason: "test", audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(AssociateNotFoundError);
  });

  it("refuses an associate belonging to another organisation", async () => {
    const f = await seedFixture(ORG);
    const other = await seedFixture(OTHER_ORG);
    await expect(
      moveAssociate(db, { associateId: other.leaf.associate!.id, newParentId: f.stranger.associate!.id, reason: "test", audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("listAssociates / getAssociateTree: O/T/admin scoping", () => {
  it("an ASSOCIATE (O) sees only themselves", async () => {
    const f = await seedFixture();
    const rows = await listAssociates(db, { orgId: ORG, actorId: f.leaf.user.id });
    expect(rows.map((r) => r.associateId)).toEqual([f.leaf.associate!.id]);
  });

  it("a TEAM_LEAD (T) sees themselves + downline", async () => {
    const f = await seedFixture();
    const rows = await listAssociates(db, { orgId: ORG, actorId: f.mid.user.id });
    expect(rows.map((r) => r.associateId).sort()).toEqual([f.mid.associate!.id, f.leaf.associate!.id].sort());
  });

  it("an admin sees every associate in the org", async () => {
    const f = await seedFixture();
    const rows = await listAssociates(db, { orgId: ORG, actorId: f.admin.user.id });
    expect(rows.map((r) => r.associateId).sort()).toEqual(
      [f.top.associate!.id, f.mid.associate!.id, f.leaf.associate!.id, f.stranger.associate!.id, f.noPerms.associate!.id].sort(),
    );
  });

  it("getAssociateTree returns the associate plus their downline", async () => {
    const f = await seedFixture();
    const tree = await getAssociateTree(db, { associateId: f.mid.associate!.id, orgId: ORG, actorId: f.mid.user.id });
    expect(tree.associate.associateId).toBe(f.mid.associate!.id);
    expect(tree.downline.map((d) => d.associateId)).toEqual([f.leaf.associate!.id]);
  });

  it("refuses viewing a tree outside the caller's scope", async () => {
    const f = await seedFixture();
    await expect(
      getAssociateTree(db, { associateId: f.mid.associate!.id, orgId: ORG, actorId: f.stranger.user.id }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses without associate.read", async () => {
    const f = await seedFixture();
    await expect(listAssociates(db, { orgId: ORG, actorId: f.noPerms.user.id })).rejects.toThrow(ForbiddenError);
  });
});

describe("audit: a move writes one UPDATE row", () => {
  it("records the reason", async () => {
    const f = await seedFixture();
    await moveAssociate(db, { associateId: f.leaf.associate!.id, newParentId: f.stranger.associate!.id, reason: "Team restructure", audit: ctx(ORG, f.admin.user.id, "admin") });
    const auditRow = await db.auditLog.findFirstOrThrow({ where: { entity: "AssociateHierarchy", action: "UPDATE" } });
    expect(auditRow.reason).toBe("Team restructure");
  });
});
