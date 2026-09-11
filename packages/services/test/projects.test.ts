// Project/tower/unit-type/unit master data. Runs against LOCAL Docker
// Postgres -- the area-hierarchy guard, tenancy checks and row locks are
// exactly what is under test, so a mock would prove nothing.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import { UnitNotFoundError } from "../src/holds";
import {
  CrossProjectReferenceError,
  DuplicateCodeError,
  InvalidHoldPolicyError,
  InvalidUnitAreasError,
  ProjectNotFoundError,
  TowerNotFoundError,
  UnitTypeNotFoundError,
  createProject,
  createTower,
  createUnit,
  createUnitType,
  resolveUnitAreas,
  updateProject,
  updateUnit,
} from "../src/projects";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_projects";
const OTHER_ORG = "org_test_projects_other";
const D = (v: string | number) => new Prisma.Decimal(v);

async function reset() {
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.auditLog.deleteMany({ where: { orgId } });
    await db.unitStatusHistory.deleteMany({ where: { unit: { orgId } } });
    await db.unit.deleteMany({ where: { orgId } });
    await db.unitType.deleteMany({ where: { orgId } });
    await db.tower.deleteMany({ where: { orgId } });
    await db.userRole.deleteMany({ where: { role: { orgId } } });
    await db.rolePermission.deleteMany({ where: { role: { orgId } } });
    await db.role.deleteMany({ where: { orgId } });
    await db.user.deleteMany({ where: { orgId } });
    await db.project.deleteMany({ where: { orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
  }
  // Permission has no orgId -- it is global seed config, not test data. Not
  // deleted here: charge-heads.test.ts also uses "project.write", and Vitest
  // runs test FILES in parallel, so each file's reset() deleting a row the
  // other file is mid-upsert on raced into P2002s. upsert-if-missing (in
  // makeUser) is idempotent and race-free; deleting it is not.
}

/** A user in the given org holding project.write, either org-wide
 *  (projectId null) or scoped to one project. */
async function makeUser(orgId: string, label: string, projectId: string | null = null) {
  const user = await db.user.create({
    data: { orgId, email: `${label}-${orgId}@test.local`, name: label, passwordHash: "unused" },
  });
  const role = await db.role.create({ data: { orgId, code: `ROLE_${label}`, name: label } });
  const perm = await db.permission.upsert({
    where: { code: "project.write" },
    update: {},
    create: { code: "project.write", resource: "project", action: "write" },
  });
  await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId } });
  return user;
}

async function seedOrg(orgId: string, name: string) {
  await db.organization.create({ data: { id: orgId, name, legalName: `${name} Pvt Ltd` } });
}

function ctx(orgId: string, userId: string | null, label: string): AuditContext {
  return { orgId, actorId: userId, actorLabel: label };
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("resolveUnitAreas (pure)", () => {
  const unitType = { carpetArea: D("650.00"), builtUpArea: D("780.00"), saleableArea: D("975.00") };

  it("inherits from the unit type when both overrides are null", () => {
    const areas = resolveUnitAreas(
      { carpetAreaOverride: null, saleableAreaOverride: null },
      unitType,
    );
    expect(areas).toEqual(unitType);
  });

  it("applies an override for carpet or saleable, but built-up always comes from the type", () => {
    const areas = resolveUnitAreas(
      { carpetAreaOverride: D("700.00"), saleableAreaOverride: D("1000.00") },
      unitType,
    );
    expect(areas.carpetArea.toString()).toBe("700");
    expect(areas.saleableArea.toString()).toBe("1000");
    expect(areas.builtUpArea).toBe(unitType.builtUpArea);
  });
});

describe("createProject", () => {
  it("creates a project and writes a CREATE audit row", async () => {
    await seedOrg(ORG, "Projects Test Org");
    const writer = await makeUser(ORG, "writer");

    const project = await createProject(db, {
      code: "SKY",
      name: "Skyline",
      city: "Pune",
      state: "Maharashtra",
      audit: ctx(ORG, writer.id, "writer"),
    });

    expect(project.code).toBe("SKY");
    expect(project.orgId).toBe(ORG);

    const auditRow = await db.auditLog.findFirst({
      where: { entity: "Project", entityId: project.id, action: "CREATE" },
    });
    expect(auditRow).not.toBeNull();
  });

  it("refuses a system actor", async () => {
    await seedOrg(ORG, "Projects Test Org");
    await expect(
      createProject(db, {
        code: "SKY",
        name: "Skyline",
        city: "Pune",
        state: "Maharashtra",
        audit: ctx(ORG, null, "system"),
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses without an org-wide project.write grant -- a project-scoped grant cannot conjure a new project", async () => {
    await seedOrg(ORG, "Projects Test Org");
    // Grant scoped to an EXISTING but unrelated project: the point is that
    // ANY non-null projectId disqualifies the grant here, since there is no
    // target project to scope against yet during creation of a NEW one.
    const otherProject = await db.project.create({
      data: { orgId: ORG, code: "OTHERPROJ", name: "Other", city: "Pune", state: "Maharashtra" },
    });
    const scoped = await makeUser(ORG, "scoped", otherProject.id);
    await expect(
      createProject(db, {
        code: "SKY",
        name: "Skyline",
        city: "Pune",
        state: "Maharashtra",
        audit: ctx(ORG, scoped.id, "scoped"),
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("rejects a duplicate project code", async () => {
    await seedOrg(ORG, "Projects Test Org");
    const writer = await makeUser(ORG, "writer");
    const params = {
      code: "SKY",
      name: "Skyline",
      city: "Pune",
      state: "Maharashtra",
      audit: ctx(ORG, writer.id, "writer"),
    };
    await createProject(db, params);
    await expect(createProject(db, params)).rejects.toThrow(DuplicateCodeError);
  });

  describe("hold policy validation", () => {
    it("refuses a non-positive holdTtlMinutes", async () => {
      await seedOrg(ORG, "Projects Test Org");
      const writer = await makeUser(ORG, "writer");
      await expect(
        createProject(db, {
          code: "SKY",
          name: "Skyline",
          city: "Pune",
          state: "Maharashtra",
          holdTtlMinutes: 0,
          audit: ctx(ORG, writer.id, "writer"),
        }),
      ).rejects.toThrow(InvalidHoldPolicyError);
    });

    it("refuses a non-positive holdExtensionMinutes", async () => {
      await seedOrg(ORG, "Projects Test Org");
      const writer = await makeUser(ORG, "writer");
      await expect(
        createProject(db, {
          code: "SKY",
          name: "Skyline",
          city: "Pune",
          state: "Maharashtra",
          holdExtensionMinutes: -5,
          audit: ctx(ORG, writer.id, "writer"),
        }),
      ).rejects.toThrow(InvalidHoldPolicyError);
    });

    it("refuses a negative maxHoldExtensions", async () => {
      await seedOrg(ORG, "Projects Test Org");
      const writer = await makeUser(ORG, "writer");
      await expect(
        createProject(db, {
          code: "SKY",
          name: "Skyline",
          city: "Pune",
          state: "Maharashtra",
          maxHoldExtensions: -1,
          audit: ctx(ORG, writer.id, "writer"),
        }),
      ).rejects.toThrow(InvalidHoldPolicyError);
    });

    it("accepts zero maxHoldExtensions (never extendable, but valid)", async () => {
      await seedOrg(ORG, "Projects Test Org");
      const writer = await makeUser(ORG, "writer");
      const project = await createProject(db, {
        code: "SKY",
        name: "Skyline",
        city: "Pune",
        state: "Maharashtra",
        maxHoldExtensions: 0,
        audit: ctx(ORG, writer.id, "writer"),
      });
      expect(project.maxHoldExtensions).toBe(0);
    });
  });
});

describe("updateProject", () => {
  async function seedProject(orgId: string, writerId: string) {
    return createProject(db, {
      code: "SKY",
      name: "Skyline",
      city: "Pune",
      state: "Maharashtra",
      audit: ctx(orgId, writerId, "writer"),
    });
  }

  it("updates the given fields and writes a before/after audit row", async () => {
    await seedOrg(ORG, "Projects Test Org");
    const writer = await makeUser(ORG, "writer");
    const project = await seedProject(ORG, writer.id);

    const updated = await updateProject(db, {
      projectId: project.id,
      name: "Skyline Residency",
      reason: "corrected name",
      audit: ctx(ORG, writer.id, "writer"),
    });

    expect(updated.name).toBe("Skyline Residency");
    const auditRow = await db.auditLog.findFirst({
      where: { entity: "Project", entityId: project.id, action: "UPDATE" },
    });
    expect(auditRow?.before).toEqual({ name: "Skyline" });
    expect(auditRow?.after).toEqual({ name: "Skyline Residency" });
  });

  it("returns unchanged and writes no audit row when nothing was submitted", async () => {
    await seedOrg(ORG, "Projects Test Org");
    const writer = await makeUser(ORG, "writer");
    const project = await seedProject(ORG, writer.id);

    await updateProject(db, { projectId: project.id, audit: ctx(ORG, writer.id, "writer") });

    const auditRows = await db.auditLog.findMany({
      where: { entity: "Project", entityId: project.id, action: "UPDATE" },
    });
    expect(auditRows).toHaveLength(0);
  });

  it("allows a project-scoped grant for THIS project (unlike create)", async () => {
    await seedOrg(ORG, "Projects Test Org");
    const admin = await makeUser(ORG, "admin");
    const project = await seedProject(ORG, admin.id);
    const scoped = await makeUser(ORG, "scoped", project.id);

    const updated = await updateProject(db, {
      projectId: project.id,
      name: "Renamed",
      audit: ctx(ORG, scoped.id, "scoped"),
    });
    expect(updated.name).toBe("Renamed");
  });

  it("refuses a grant scoped to a DIFFERENT project", async () => {
    await seedOrg(ORG, "Projects Test Org");
    const admin = await makeUser(ORG, "admin");
    const project = await seedProject(ORG, admin.id);
    const otherProject = await db.project.create({
      data: { orgId: ORG, code: "OTHERPROJ", name: "Other", city: "Pune", state: "Maharashtra" },
    });
    const scoped = await makeUser(ORG, "scoped", otherProject.id);

    await expect(
      updateProject(db, {
        projectId: project.id,
        name: "Renamed",
        audit: ctx(ORG, scoped.id, "scoped"),
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("throws for a project that does not exist", async () => {
    await seedOrg(ORG, "Projects Test Org");
    const writer = await makeUser(ORG, "writer");
    await expect(
      updateProject(db, {
        projectId: "does-not-exist",
        name: "x",
        audit: ctx(ORG, writer.id, "writer"),
      }),
    ).rejects.toThrow(ProjectNotFoundError);
  });

  it("refuses a project belonging to another org", async () => {
    await seedOrg(ORG, "Projects Test Org");
    await seedOrg(OTHER_ORG, "Other Org");
    const writer = await makeUser(ORG, "writer");
    const outsider = await makeUser(OTHER_ORG, "outsider");
    const project = await seedProject(ORG, writer.id);

    await expect(
      updateProject(db, {
        projectId: project.id,
        name: "hijacked",
        audit: ctx(OTHER_ORG, outsider.id, "outsider"),
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("rejects a hold-policy update that would produce an incoherent policy", async () => {
    await seedOrg(ORG, "Projects Test Org");
    const writer = await makeUser(ORG, "writer");
    const project = await seedProject(ORG, writer.id);

    await expect(
      updateProject(db, {
        projectId: project.id,
        holdTtlMinutes: 0,
        audit: ctx(ORG, writer.id, "writer"),
      }),
    ).rejects.toThrow(InvalidHoldPolicyError);
  });
});

describe("createTower", () => {
  async function seedProject() {
    await seedOrg(ORG, "Projects Test Org");
    const writer = await makeUser(ORG, "writer");
    const project = await createProject(db, {
      code: "SKY",
      name: "Skyline",
      city: "Pune",
      state: "Maharashtra",
      audit: ctx(ORG, writer.id, "writer"),
    });
    return { writer, project };
  }

  it("creates a tower under the project and writes an audit row", async () => {
    const { writer, project } = await seedProject();
    const tower = await createTower(db, {
      projectId: project.id,
      code: "A",
      name: "Tower A",
      totalFloors: 10,
      audit: ctx(ORG, writer.id, "writer"),
    });
    expect(tower.projectId).toBe(project.id);
    expect(tower.orgId).toBe(ORG);

    const auditRow = await db.auditLog.findFirst({
      where: { entity: "Tower", entityId: tower.id, action: "CREATE" },
    });
    expect(auditRow).not.toBeNull();
  });

  it("rejects a duplicate tower code", async () => {
    const { writer, project } = await seedProject();
    const params = {
      projectId: project.id,
      code: "A",
      name: "Tower A",
      totalFloors: 10,
      audit: ctx(ORG, writer.id, "writer"),
    };
    await createTower(db, params);
    await expect(createTower(db, params)).rejects.toThrow(DuplicateCodeError);
  });

  it("throws for a project that does not exist", async () => {
    await seedOrg(ORG, "Projects Test Org");
    const writer = await makeUser(ORG, "writer");
    await expect(
      createTower(db, {
        projectId: "does-not-exist",
        code: "A",
        name: "Tower A",
        totalFloors: 10,
        audit: ctx(ORG, writer.id, "writer"),
      }),
    ).rejects.toThrow(ProjectNotFoundError);
  });

  it("refuses a project belonging to another org", async () => {
    const { project } = await seedProject();
    await seedOrg(OTHER_ORG, "Other Org");
    const outsider = await makeUser(OTHER_ORG, "outsider");

    await expect(
      createTower(db, {
        projectId: project.id,
        code: "A",
        name: "Tower A",
        totalFloors: 10,
        audit: ctx(OTHER_ORG, outsider.id, "outsider"),
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("createUnitType", () => {
  async function seedProject() {
    await seedOrg(ORG, "Projects Test Org");
    const writer = await makeUser(ORG, "writer");
    const project = await createProject(db, {
      code: "SKY",
      name: "Skyline",
      city: "Pune",
      state: "Maharashtra",
      audit: ctx(ORG, writer.id, "writer"),
    });
    return { writer, project };
  }

  it("creates a unit type when carpet < built-up <= saleable", async () => {
    const { writer, project } = await seedProject();
    const unitType = await createUnitType(db, {
      projectId: project.id,
      code: "2BHK",
      name: "2BHK",
      carpetArea: "650.00",
      builtUpArea: "780.00",
      saleableArea: "975.00",
      audit: ctx(ORG, writer.id, "writer"),
    });
    expect(unitType.carpetArea.toString()).toBe("650");
  });

  it("accepts built-up == saleable (zero loading factor)", async () => {
    const { writer, project } = await seedProject();
    const unitType = await createUnitType(db, {
      projectId: project.id,
      code: "2BHK",
      name: "2BHK",
      carpetArea: "650.00",
      builtUpArea: "780.00",
      saleableArea: "780.00",
      audit: ctx(ORG, writer.id, "writer"),
    });
    expect(unitType.saleableArea.toString()).toBe("780");
  });

  it("refuses carpet >= built-up (the ~35% mispricing mistake)", async () => {
    const { writer, project } = await seedProject();
    await expect(
      createUnitType(db, {
        projectId: project.id,
        code: "2BHK",
        name: "2BHK",
        carpetArea: "780.00",
        builtUpArea: "780.00",
        saleableArea: "975.00",
        audit: ctx(ORG, writer.id, "writer"),
      }),
    ).rejects.toThrow(InvalidUnitAreasError);
  });

  it("refuses built-up > saleable", async () => {
    const { writer, project } = await seedProject();
    await expect(
      createUnitType(db, {
        projectId: project.id,
        code: "2BHK",
        name: "2BHK",
        carpetArea: "650.00",
        builtUpArea: "980.00",
        saleableArea: "975.00",
        audit: ctx(ORG, writer.id, "writer"),
      }),
    ).rejects.toThrow(InvalidUnitAreasError);
  });

  it("refuses a non-positive area", async () => {
    const { writer, project } = await seedProject();
    await expect(
      createUnitType(db, {
        projectId: project.id,
        code: "2BHK",
        name: "2BHK",
        carpetArea: "0",
        builtUpArea: "780.00",
        saleableArea: "975.00",
        audit: ctx(ORG, writer.id, "writer"),
      }),
    ).rejects.toThrow(InvalidUnitAreasError);
  });

  it("rejects a duplicate unit type code", async () => {
    const { writer, project } = await seedProject();
    const params = {
      projectId: project.id,
      code: "2BHK",
      name: "2BHK",
      carpetArea: "650.00",
      builtUpArea: "780.00",
      saleableArea: "975.00",
      audit: ctx(ORG, writer.id, "writer"),
    };
    await createUnitType(db, params);
    await expect(createUnitType(db, params)).rejects.toThrow(DuplicateCodeError);
  });
});

describe("createUnit / updateUnit", () => {
  async function seedProjectAndType() {
    await seedOrg(ORG, "Projects Test Org");
    const writer = await makeUser(ORG, "writer");
    const project = await createProject(db, {
      code: "SKY",
      name: "Skyline",
      city: "Pune",
      state: "Maharashtra",
      audit: ctx(ORG, writer.id, "writer"),
    });
    const tower = await createTower(db, {
      projectId: project.id,
      code: "A",
      name: "Tower A",
      totalFloors: 10,
      audit: ctx(ORG, writer.id, "writer"),
    });
    const unitType = await createUnitType(db, {
      projectId: project.id,
      code: "2BHK",
      name: "2BHK",
      carpetArea: "650.00",
      builtUpArea: "780.00",
      saleableArea: "975.00",
      audit: ctx(ORG, writer.id, "writer"),
    });
    return { writer, project, tower, unitType };
  }

  it("creates a unit AVAILABLE, with a genesis UnitStatusHistory row (fromStatus null)", async () => {
    const { writer, project, tower, unitType } = await seedProjectAndType();

    const unit = await createUnit(db, {
      projectId: project.id,
      towerId: tower.id,
      unitTypeId: unitType.id,
      unitNumber: "A-101",
      floor: 1,
      audit: ctx(ORG, writer.id, "writer"),
    });

    expect(unit.status).toBe("AVAILABLE");
    const history = await db.unitStatusHistory.findFirst({ where: { unitId: unit.id } });
    expect(history?.fromStatus).toBeNull();
    expect(history?.toStatus).toBe("AVAILABLE");
  });

  it("rejects a duplicate unit number", async () => {
    const { writer, project, unitType } = await seedProjectAndType();
    const params = {
      projectId: project.id,
      unitTypeId: unitType.id,
      unitNumber: "A-101",
      floor: 1,
      audit: ctx(ORG, writer.id, "writer"),
    };
    await createUnit(db, params);
    await expect(createUnit(db, params)).rejects.toThrow(DuplicateCodeError);
  });

  it("throws when the unit type does not exist", async () => {
    const { writer, project } = await seedProjectAndType();
    await expect(
      createUnit(db, {
        projectId: project.id,
        unitTypeId: "does-not-exist",
        unitNumber: "A-101",
        floor: 1,
        audit: ctx(ORG, writer.id, "writer"),
      }),
    ).rejects.toThrow(UnitTypeNotFoundError);
  });

  it("refuses a unit type from another project", async () => {
    const { writer, unitType } = await seedProjectAndType();
    const otherProject = await createProject(db, {
      code: "OTHER",
      name: "Other Project",
      city: "Pune",
      state: "Maharashtra",
      audit: ctx(ORG, writer.id, "writer"),
    });

    await expect(
      createUnit(db, {
        projectId: otherProject.id,
        unitTypeId: unitType.id,
        unitNumber: "A-101",
        floor: 1,
        audit: ctx(ORG, writer.id, "writer"),
      }),
    ).rejects.toThrow(CrossProjectReferenceError);
  });

  it("throws when the tower does not exist", async () => {
    const { writer, project, unitType } = await seedProjectAndType();
    await expect(
      createUnit(db, {
        projectId: project.id,
        towerId: "does-not-exist",
        unitTypeId: unitType.id,
        unitNumber: "A-101",
        floor: 1,
        audit: ctx(ORG, writer.id, "writer"),
      }),
    ).rejects.toThrow(TowerNotFoundError);
  });

  it("refuses a tower from another project", async () => {
    const { writer, tower } = await seedProjectAndType();
    const otherProject = await createProject(db, {
      code: "OTHER",
      name: "Other Project",
      city: "Pune",
      state: "Maharashtra",
      audit: ctx(ORG, writer.id, "writer"),
    });
    const otherType = await createUnitType(db, {
      projectId: otherProject.id,
      code: "2BHK",
      name: "2BHK",
      carpetArea: "650.00",
      builtUpArea: "780.00",
      saleableArea: "975.00",
      audit: ctx(ORG, writer.id, "writer"),
    });

    await expect(
      createUnit(db, {
        projectId: otherProject.id,
        towerId: tower.id, // belongs to the FIRST project
        unitTypeId: otherType.id,
        unitNumber: "A-101",
        floor: 1,
        audit: ctx(ORG, writer.id, "writer"),
      }),
    ).rejects.toThrow(CrossProjectReferenceError);
  });

  it("rejects an area override that would invert carpet vs saleable", async () => {
    const { writer, project, unitType } = await seedProjectAndType();
    await expect(
      createUnit(db, {
        projectId: project.id,
        unitTypeId: unitType.id,
        unitNumber: "A-101",
        floor: 1,
        carpetAreaOverride: "1000.00", // above the type's saleable area of 975
        audit: ctx(ORG, writer.id, "writer"),
      }),
    ).rejects.toThrow(InvalidUnitAreasError);
  });

  it("accepts a coherent area override", async () => {
    const { writer, project, unitType } = await seedProjectAndType();
    const unit = await createUnit(db, {
      projectId: project.id,
      unitTypeId: unitType.id,
      unitNumber: "A-101",
      floor: 1,
      carpetAreaOverride: "700.00",
      saleableAreaOverride: "1050.00",
      audit: ctx(ORG, writer.id, "writer"),
    });
    expect(unit.carpetAreaOverride?.toString()).toBe("700");
  });

  describe("updateUnit", () => {
    it("updates fields and writes a before/after audit row", async () => {
      const { writer, project, unitType } = await seedProjectAndType();
      const unit = await createUnit(db, {
        projectId: project.id,
        unitTypeId: unitType.id,
        unitNumber: "A-101",
        floor: 1,
        audit: ctx(ORG, writer.id, "writer"),
      });

      const updated = await updateUnit(db, {
        unitId: unit.id,
        facing: "NE",
        reason: "corrected facing",
        audit: ctx(ORG, writer.id, "writer"),
      });
      expect(updated.facing).toBe("NE");

      const auditRow = await db.auditLog.findFirst({
        where: { entity: "Unit", entityId: unit.id, action: "UPDATE" },
      });
      expect(auditRow?.before).toEqual({ facing: null });
      expect(auditRow?.after).toEqual({ facing: "NE" });
    });

    it("returns unchanged and writes no audit row when nothing was submitted", async () => {
      const { writer, project, unitType } = await seedProjectAndType();
      const unit = await createUnit(db, {
        projectId: project.id,
        unitTypeId: unitType.id,
        unitNumber: "A-101",
        floor: 1,
        audit: ctx(ORG, writer.id, "writer"),
      });

      await updateUnit(db, { unitId: unit.id, audit: ctx(ORG, writer.id, "writer") });

      const auditRows = await db.auditLog.findMany({
        where: { entity: "Unit", entityId: unit.id, action: "UPDATE" },
      });
      expect(auditRows).toHaveLength(0);
    });

    it("clears an override back to inheriting from the unit type when explicitly set to null", async () => {
      const { writer, project, unitType } = await seedProjectAndType();
      const unit = await createUnit(db, {
        projectId: project.id,
        unitTypeId: unitType.id,
        unitNumber: "A-101",
        floor: 1,
        carpetAreaOverride: "700.00",
        audit: ctx(ORG, writer.id, "writer"),
      });

      const updated = await updateUnit(db, {
        unitId: unit.id,
        carpetAreaOverride: null,
        audit: ctx(ORG, writer.id, "writer"),
      });
      expect(updated.carpetAreaOverride).toBeNull();
    });

    it("re-validates the area hierarchy against the NEW unit type when unitTypeId is repointed", async () => {
      const { writer, project, unitType } = await seedProjectAndType();
      const smallType = await createUnitType(db, {
        projectId: project.id,
        code: "1BHK",
        name: "1BHK",
        carpetArea: "400.00",
        builtUpArea: "480.00",
        saleableArea: "600.00",
        audit: ctx(ORG, writer.id, "writer"),
      });
      const unit = await createUnit(db, {
        projectId: project.id,
        unitTypeId: unitType.id,
        unitNumber: "A-101",
        floor: 1,
        // Valid against the 2BHK type (built-up 780, so 500 < 780) but
        // inverted against the 1BHK type below (built-up only 480, so
        // carpet 500 would exceed it).
        carpetAreaOverride: "500.00",
        audit: ctx(ORG, writer.id, "writer"),
      });

      await expect(
        updateUnit(db, {
          unitId: unit.id,
          unitTypeId: smallType.id,
          audit: ctx(ORG, writer.id, "writer"),
        }),
      ).rejects.toThrow(InvalidUnitAreasError);
    });

    it("throws when the unit does not exist", async () => {
      await seedOrg(ORG, "Projects Test Org");
      const writer = await makeUser(ORG, "writer");
      await expect(
        updateUnit(db, { unitId: "does-not-exist", facing: "N", audit: ctx(ORG, writer.id, "writer") }),
      ).rejects.toThrow(UnitNotFoundError);
    });

    it("rejects renaming to a unit number already in use", async () => {
      const { writer, project, unitType } = await seedProjectAndType();
      await createUnit(db, {
        projectId: project.id,
        unitTypeId: unitType.id,
        unitNumber: "A-101",
        floor: 1,
        audit: ctx(ORG, writer.id, "writer"),
      });
      const other = await createUnit(db, {
        projectId: project.id,
        unitTypeId: unitType.id,
        unitNumber: "A-102",
        floor: 1,
        audit: ctx(ORG, writer.id, "writer"),
      });

      await expect(
        updateUnit(db, {
          unitId: other.id,
          unitNumber: "A-101",
          audit: ctx(ORG, writer.id, "writer"),
        }),
      ).rejects.toThrow(DuplicateCodeError);
    });
  });
});
