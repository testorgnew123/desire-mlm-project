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
