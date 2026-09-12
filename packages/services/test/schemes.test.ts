// Commission schemes against real Postgres. Publish lifecycle mirrors
// price-lists.test.ts exactly (docs/09-RBAC-MATRIX.md's separation of
// duties, "never two ACTIVE at once") -- CommissionScheme's publish shape is
// IDENTICAL to PriceList's, by design (see schemes.ts's file header).
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import {
  DuplicateGradeRateError,
  EmptySchemeError,
  SchemeMakerCheckerViolationError,
  createScheme,
  getActiveScheme,
  publishScheme,
} from "../src/schemes";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_schemes";
const OTHER_ORG = "org_test_schemes_other";

async function reset() {
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.auditLog.deleteMany({ where: { orgId } });
    await db.schemeLevelRate.deleteMany({ where: { scheme: { orgId } } });
    await db.schemeGradeRate.deleteMany({ where: { scheme: { orgId } } });
    await db.commissionScheme.deleteMany({ where: { orgId } });
    await db.project.deleteMany({ where: { orgId } });
    await db.userRole.deleteMany({ where: { role: { orgId } } });
    await db.rolePermission.deleteMany({ where: { role: { orgId } } });
    await db.role.deleteMany({ where: { orgId } });
    await db.user.deleteMany({ where: { orgId } });
    await db.grade.deleteMany({ where: { orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
  }
}

async function makeUser(orgId: string, label: string, codes: string[]) {
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
  return user;
}

async function seed(orgId: string = ORG) {
  await db.organization.create({ data: { id: orgId, name: "Schemes Test Org", legalName: "Schemes Test Org Pvt Ltd" } });
  const project = await db.project.create({
    data: {
      orgId, code: "SCHPROJ", name: "Scheme Project", city: "Pune", state: "Maharashtra",
      reraRegNo: `P-SCH-${orgId}`, reraValidTill: new Date("2030-01-01"),
    },
  });
  const grade = await db.grade.create({ data: { orgId, code: "G4", name: "Manager", rank: 4 } });

  const preparer = await makeUser(orgId, "preparer", ["scheme.prepare"]);
  const approver = await makeUser(orgId, "approver", ["scheme.approve"]);
  const both = await makeUser(orgId, "both", ["scheme.prepare", "scheme.approve"]);

  return { project, grade, preparer, approver, both };
}

function ctx(orgId: string, userId: string, label: string): AuditContext {
  return { orgId, actorId: userId, actorLabel: label };
}

const BASE_DEFINITION = { chargeHeadCodes: ["BSP"], netOfDiscount: true, netOfGst: true };

function gradeRates(gradeId: string) {
  return [{ gradeId, rateValue: "1.5" }];
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("createScheme", () => {
  it("creates a DRAFT scheme with grade and level rates", async () => {
    const { project, grade, preparer } = await seed();
    const draft = await createScheme(db, {
      projectId: project.id, name: "v1", validFrom: new Date("2024-01-01"),
      baseDefinition: BASE_DEFINITION, maxTotalPct: "3.0",
      gradeRates: gradeRates(grade.id),
      levelRates: [{ level: 1, pctOfSellerCommission: "10" }],
      audit: ctx(ORG, preparer.id, "preparer"),
    });
    expect(draft.version).toBe(1);

    const scheme = await db.commissionScheme.findUniqueOrThrow({ where: { id: draft.schemeId } });
    expect(scheme.status).toBe("DRAFT");
    expect(scheme.maxTotalPct.toString()).toBe("3");
  });

  it("rejects duplicate grade rates for the same grade", async () => {
    const { project, grade, preparer } = await seed();
    await expect(
      createScheme(db, {
        projectId: project.id, name: "v1", validFrom: new Date("2024-01-01"),
        baseDefinition: BASE_DEFINITION, maxTotalPct: "3.0",
        gradeRates: [{ gradeId: grade.id, rateValue: "1.5" }, { gradeId: grade.id, rateValue: "2.0" }],
        audit: ctx(ORG, preparer.id, "preparer"),
      }),
    ).rejects.toThrow(DuplicateGradeRateError);
  });

  it("refuses without scheme.prepare", async () => {
    const { project, grade, approver } = await seed();
    await expect(
      createScheme(db, {
        projectId: project.id, name: "v1", validFrom: new Date("2024-01-01"),
        baseDefinition: BASE_DEFINITION, maxTotalPct: "3.0", gradeRates: gradeRates(grade.id),
        audit: ctx(ORG, approver.id, "approver"),
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("maker-checker on publish", () => {
  it("REFUSES to let the preparer publish their own scheme, even holding both permissions", async () => {
    const { project, grade, both } = await seed();
    const draft = await createScheme(db, {
      projectId: project.id, name: "v1", validFrom: new Date("2024-01-01"),
      baseDefinition: BASE_DEFINITION, maxTotalPct: "3.0", gradeRates: gradeRates(grade.id),
      audit: ctx(ORG, both.id, "both"),
    });

    await expect(
      publishScheme(db, { schemeId: draft.schemeId, audit: ctx(ORG, both.id, "both") }),
    ).rejects.toThrow(SchemeMakerCheckerViolationError);

    const after = await db.commissionScheme.findUniqueOrThrow({ where: { id: draft.schemeId } });
    expect(after.status).toBe("DRAFT");
  });

  it("allows a DIFFERENT approver to publish", async () => {
    const { project, grade, preparer, approver } = await seed();
    const draft = await createScheme(db, {
      projectId: project.id, name: "v1", validFrom: new Date("2024-01-01"),
      baseDefinition: BASE_DEFINITION, maxTotalPct: "3.0", gradeRates: gradeRates(grade.id),
      audit: ctx(ORG, preparer.id, "preparer"),
    });

    const published = await publishScheme(db, { schemeId: draft.schemeId, audit: ctx(ORG, approver.id, "approver") });
    expect(published.schemeId).toBe(draft.schemeId);

    const after = await db.commissionScheme.findUniqueOrThrow({ where: { id: draft.schemeId } });
    expect(after.status).toBe("ACTIVE");
    expect(after.approvedById).toBe(approver.id);
  });

  it("refuses to publish an empty scheme (no grade rates)", async () => {
    const { project, preparer, approver } = await seed();
    const draft = await createScheme(db, {
      projectId: project.id, name: "v1", validFrom: new Date("2024-01-01"),
      baseDefinition: BASE_DEFINITION, maxTotalPct: "3.0", gradeRates: [],
      audit: ctx(ORG, preparer.id, "preparer"),
    });
    await expect(
      publishScheme(db, { schemeId: draft.schemeId, audit: ctx(ORG, approver.id, "approver") }),
    ).rejects.toThrow(EmptySchemeError);
  });
});

describe("never two ACTIVE schemes at once", () => {
  it("publishing archives the incumbent and sets its validTo", async () => {
    const { project, grade, preparer, approver } = await seed();
    const v1 = await createScheme(db, {
      projectId: project.id, name: "v1", validFrom: new Date("2024-01-01"),
      baseDefinition: BASE_DEFINITION, maxTotalPct: "3.0", gradeRates: gradeRates(grade.id),
      audit: ctx(ORG, preparer.id, "preparer"),
    });
    await publishScheme(db, { schemeId: v1.schemeId, audit: ctx(ORG, approver.id, "approver") });

    const v2 = await createScheme(db, {
      projectId: project.id, name: "v2", validFrom: new Date("2024-06-01"),
      baseDefinition: BASE_DEFINITION, maxTotalPct: "3.0", gradeRates: gradeRates(grade.id),
      audit: ctx(ORG, preparer.id, "preparer"),
    });
    await publishScheme(db, { schemeId: v2.schemeId, audit: ctx(ORG, approver.id, "approver") });

    const active = await db.commissionScheme.findMany({ where: { projectId: project.id, status: "ACTIVE" } });
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(v2.schemeId);

    const archived = await db.commissionScheme.findUniqueOrThrow({ where: { id: v1.schemeId } });
    expect(archived.status).toBe("ARCHIVED");
    expect(archived.validTo).not.toBeNull();
  });

  it("getActiveScheme resolves by date window, not just status", async () => {
    const { project, grade, preparer, approver } = await seed();
    const v1 = await createScheme(db, {
      projectId: project.id, name: "v1", validFrom: new Date("2024-01-01"),
      baseDefinition: BASE_DEFINITION, maxTotalPct: "3.0", gradeRates: gradeRates(grade.id),
      audit: ctx(ORG, preparer.id, "preparer"),
    });
    await publishScheme(db, { schemeId: v1.schemeId, audit: ctx(ORG, approver.id, "approver"), now: new Date("2024-01-01") });

    const resolved = await getActiveScheme(db, { projectId: project.id, asOf: new Date("2024-06-01") });
    expect(resolved?.id).toBe(v1.schemeId);

    const before = await getActiveScheme(db, { projectId: project.id, asOf: new Date("2023-01-01") });
    expect(before).toBeNull();
  });
});
