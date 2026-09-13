// Grade master + effective-dated grade assignment -- Phase 3 Slice 1. Runs
// against LOCAL Docker Postgres -- the close-and-insert (never update)
// discipline is exactly what is under test.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import {
  AssociateNotFoundError,
  DuplicateGradeCodeError,
  GradeNotFoundError,
  assignGrade,
  createGrade,
  listGradeHistory,
  updateGrade,
} from "../src/grades";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_grades";
const OTHER_ORG = "org_test_grades_other";

async function reset() {
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.auditLog.deleteMany({ where: { orgId } });
    await db.associateGrade.deleteMany({ where: { associate: { orgId } } });
    await db.associateHierarchy.deleteMany({ where: { associate: { orgId } } });
    await db.associate.deleteMany({ where: { orgId } });
    await db.userRole.deleteMany({ where: { role: { orgId } } });
    await db.rolePermission.deleteMany({ where: { role: { orgId } } });
    await db.role.deleteMany({ where: { orgId } });
    await db.user.deleteMany({ where: { orgId } });
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
  }
  return { user, associate };
}

async function seedFixture(orgId: string = ORG) {
  await db.organization.create({ data: { id: orgId, name: "Grades Test Org", legalName: "Grades Test Org Pvt Ltd" } });
  const admin = await makeUser(orgId, "admin", ["project.write", "grade.change"]);
  const noPerms = await makeUser(orgId, "noperms", []);
  const associate = await makeUser(orgId, "assoc", [], { associate: true });
  return { admin, noPerms, associate };
}

function ctx(orgId: string, userId: string | null, label: string): AuditContext {
  return { orgId, actorId: userId, actorLabel: label };
}

async function renameRole(orgId: string, fromCode: string, toCode: string) {
  const role = await db.role.findFirstOrThrow({ where: { orgId, code: fromCode } });
  await db.role.update({ where: { id: role.id }, data: { code: toCode } });
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("createGrade", () => {
  it("creates a grade", async () => {
    const f = await seedFixture();
    const grade = await createGrade(db, { code: "G4", name: "Senior Executive", rank: 4, audit: ctx(ORG, f.admin.user.id, "admin") });
    expect(grade.code).toBe("G4");
    expect(grade.rank).toBe(4);
    expect(grade.isActive).toBe(true);
  });

  it("rejects a duplicate code", async () => {
    const f = await seedFixture();
    await createGrade(db, { code: "G4", name: "x", rank: 4, audit: ctx(ORG, f.admin.user.id, "admin") });
    await expect(
      createGrade(db, { code: "G4", name: "y", rank: 5, audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(DuplicateGradeCodeError);
  });

  it("refuses without project.write", async () => {
    const f = await seedFixture();
    await expect(
      createGrade(db, { code: "G4", name: "x", rank: 4, audit: ctx(ORG, f.noPerms.user.id, "noperms") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("updateGrade", () => {
  it("updates the given fields and writes a before/after audit row", async () => {
    const f = await seedFixture();
    const grade = await createGrade(db, { code: "G4", name: "Senior Executive", rank: 4, audit: ctx(ORG, f.admin.user.id, "admin") });
    const updated = await updateGrade(db, { gradeId: grade.id, minCumulativeSalesValue: "5000000", audit: ctx(ORG, f.admin.user.id, "admin") });
    expect(updated.minCumulativeSalesValue?.toString()).toBe("5000000");

    const auditRow = await db.auditLog.findFirstOrThrow({ where: { entity: "Grade", entityId: grade.id, action: "UPDATE" } });
    expect((auditRow.after as { minCumulativeSalesValue?: string }).minCumulativeSalesValue).toBe("5000000");
  });

  it("returns unchanged and writes no audit row when nothing was submitted", async () => {
    const f = await seedFixture();
    const grade = await createGrade(db, { code: "G4", name: "x", rank: 4, audit: ctx(ORG, f.admin.user.id, "admin") });
    const countBefore = await db.auditLog.count({ where: { entity: "Grade", entityId: grade.id } });
    const result = await updateGrade(db, { gradeId: grade.id, audit: ctx(ORG, f.admin.user.id, "admin") });
    expect(result).toEqual(grade);
    expect(await db.auditLog.count({ where: { entity: "Grade", entityId: grade.id } })).toBe(countBefore);
  });

  it("throws for a grade that does not exist", async () => {
    const f = await seedFixture();
    await expect(updateGrade(db, { gradeId: "nope", audit: ctx(ORG, f.admin.user.id, "admin") })).rejects.toThrow(GradeNotFoundError);
  });

  it("refuses a grade belonging to another organisation", async () => {
    const f = await seedFixture(ORG);
    const other = await seedFixture(OTHER_ORG);
    const grade = await createGrade(db, { code: "G4", name: "x", rank: 4, audit: ctx(OTHER_ORG, other.admin.user.id, "admin") });
    await expect(
      updateGrade(db, { gradeId: grade.id, name: "Hijacked", audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("assignGrade: close-and-insert, never update", () => {
  it("creates the first assignment with no prior row to close", async () => {
    const f = await seedFixture();
    const grade = await createGrade(db, { code: "G4", name: "x", rank: 4, audit: ctx(ORG, f.admin.user.id, "admin") });
    const assignment = await assignGrade(db, { associateId: f.associate.associate!.id, gradeId: grade.id, reason: "Initial grade", audit: ctx(ORG, f.admin.user.id, "admin") });
    expect(assignment.validTo).toBeNull();
    expect(assignment.gradeId).toBe(grade.id);
  });

  it("closes the current row and inserts a new one on reassignment", async () => {
    const f = await seedFixture();
    const gradeLow = await createGrade(db, { code: "G3", name: "x", rank: 3, audit: ctx(ORG, f.admin.user.id, "admin") });
    const gradeHigh = await createGrade(db, { code: "G4", name: "y", rank: 4, audit: ctx(ORG, f.admin.user.id, "admin") });

    const first = await assignGrade(db, { associateId: f.associate.associate!.id, gradeId: gradeLow.id, audit: ctx(ORG, f.admin.user.id, "admin") });
    const second = await assignGrade(db, { associateId: f.associate.associate!.id, gradeId: gradeHigh.id, reason: "Promotion", audit: ctx(ORG, f.admin.user.id, "admin") });

    const refreshedFirst = await db.associateGrade.findUniqueOrThrow({ where: { id: first.id } });
    expect(refreshedFirst.validTo).not.toBeNull();
    expect(second.validTo).toBeNull();
    expect(second.gradeId).toBe(gradeHigh.id);

    // Exactly one row with validTo: null -- never two current assignments.
    const current = await db.associateGrade.findMany({ where: { associateId: f.associate.associate!.id, validTo: null } });
    expect(current).toHaveLength(1);
  });

  it("refuses without grade.change", async () => {
    const f = await seedFixture();
    const grade = await createGrade(db, { code: "G4", name: "x", rank: 4, audit: ctx(ORG, f.admin.user.id, "admin") });
    await expect(
      assignGrade(db, { associateId: f.associate.associate!.id, gradeId: grade.id, audit: ctx(ORG, f.noPerms.user.id, "noperms") }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("throws for an associate that does not exist", async () => {
    const f = await seedFixture();
    const grade = await createGrade(db, { code: "G4", name: "x", rank: 4, audit: ctx(ORG, f.admin.user.id, "admin") });
    await expect(
      assignGrade(db, { associateId: "nope", gradeId: grade.id, audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(AssociateNotFoundError);
  });

  it("throws for a grade that does not exist", async () => {
    const f = await seedFixture();
    await expect(
      assignGrade(db, { associateId: f.associate.associate!.id, gradeId: "nope", audit: ctx(ORG, f.admin.user.id, "admin") }),
    ).rejects.toThrow(GradeNotFoundError);
  });
});

describe("listGradeHistory (Phase 3.5 Slice 12 -- 'Promotions', backed by AssociateGrade not HierarchyChangeLog)", () => {
  async function seedHistoryFixture(orgId: string = ORG) {
    await db.organization.create({ data: { id: orgId, name: "Grade History Test Org", legalName: "Grade History Test Org Pvt Ltd" } });
    const admin = await makeUser(orgId, "histadmin", ["project.write", "grade.change", "associate.read"]);
    await renameRole(orgId, "ROLE_histadmin", "SUPER_ADMIN");
    const mine = await makeUser(orgId, "histmine", ["associate.read"], { associate: true });
    await renameRole(orgId, "ROLE_histmine", "ASSOCIATE");
    const stranger = await makeUser(orgId, "histstranger", ["associate.read"], { associate: true });

    const gradeLow = await createGrade(db, { code: "HG1", name: "Low", rank: 1, audit: ctx(orgId, admin.user.id, "admin") });
    const gradeHigh = await createGrade(db, { code: "HG2", name: "High", rank: 2, audit: ctx(orgId, admin.user.id, "admin") });

    const mineFirst = await assignGrade(db, { associateId: mine.associate!.id, gradeId: gradeLow.id, reason: "Initial", audit: ctx(orgId, admin.user.id, "admin") });
    const minePromo = await assignGrade(db, { associateId: mine.associate!.id, gradeId: gradeHigh.id, reason: "Promotion", audit: ctx(orgId, admin.user.id, "admin") });
    const strangerGrade = await assignGrade(db, { associateId: stranger.associate!.id, gradeId: gradeLow.id, reason: "Initial", audit: ctx(orgId, admin.user.id, "admin") });

    return { admin, mine, stranger, gradeLow, gradeHigh, mineFirst, minePromo, strangerGrade };
  }

  it("an admin-shaped role sees every associate's grade history, newest first", async () => {
    const f = await seedHistoryFixture();
    const rows = await listGradeHistory(db, { orgId: ORG, actorId: f.admin.user.id });
    expect(rows.map((r) => r.id).sort()).toEqual([f.mineFirst.id, f.minePromo.id, f.strangerGrade.id].sort());
    // Within "mine"'s own two rows, the later promotion sorts before the
    // earlier initial assignment.
    const mineRows = rows.filter((r) => r.associateId === f.mine.associate!.id);
    expect(mineRows.map((r) => r.id)).toEqual([f.minePromo.id, f.mineFirst.id]);
  });

  it("an ASSOCIATE sees only their own grade history, not a stranger's", async () => {
    const f = await seedHistoryFixture();
    const rows = await listGradeHistory(db, { orgId: ORG, actorId: f.mine.user.id });
    expect(rows.map((r) => r.id).sort()).toEqual([f.mineFirst.id, f.minePromo.id].sort());
  });

  it("an explicit associateId filter outside the caller's scope returns nothing", async () => {
    const f = await seedHistoryFixture();
    const rows = await listGradeHistory(db, { orgId: ORG, actorId: f.mine.user.id, associateId: f.stranger.associate!.id });
    expect(rows).toHaveLength(0);
  });

  it("refuses without associate.read", async () => {
    await seedHistoryFixture();
    const nobody = await makeUser(ORG, "histnobody", []);
    await expect(listGradeHistory(db, { orgId: ORG, actorId: nobody.user.id })).rejects.toThrow(ForbiddenError);
  });
});
