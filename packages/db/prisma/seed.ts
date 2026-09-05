// Phase 0 seed. PLACEHOLDER values throughout -- grade ladder, rates, and
// hold quotas are all unconfirmed by the client (see plan.md Open Items 4-8,
// 9). Nothing here should be mistaken for a real figure.
//
// Demo login: every seeded user shares DEMO_PASSWORD below, email pattern
// "<role-code-lowercase>@demo.test" (e.g. super_admin@demo.test). Local
// development and manual testing only -- never seed this into anything
// resembling production data.
import "dotenv/config";
import { hash as argon2Hash } from "@node-rs/argon2";
import { getPrismaClient, PERMISSION_CODES, ROLE_CODES, ROLE_NAMES, MFA_REQUIRED_ROLES, permissionsForRole } from "../src/index";

const prisma = getPrismaClient();

const DEMO_PASSWORD = "Demo@12345";
const ORG_ID = "org_demo";
const PROJECT_ID = "project_demo_skyline";
const TOWER_ID = "tower_demo_a";
const UNIT_TYPE_ID = "unittype_demo_2bhk";

async function seedOrgAndGrades() {
  const org = await prisma.organization.upsert({
    where: { id: ORG_ID },
    update: {},
    create: {
      id: ORG_ID,
      name: "Demo Developer Pvt Ltd",
      legalName: "Demo Developer Private Limited",
      timezone: "Asia/Kolkata",
      currency: "INR",
    },
  });

  // PLACEHOLDER grade ladder -- see docs/19-GLOSSARY.md and plan.md Open Item 4.
  const gradeDefs = [
    { code: "G1", name: "Associate Executive", rank: 1 },
    { code: "G2", name: "Senior Executive", rank: 2 },
    { code: "G3", name: "Team Lead", rank: 3 },
    { code: "G4", name: "Manager", rank: 4 },
    { code: "G5", name: "Senior Manager", rank: 5 },
    { code: "G6", name: "Vice President", rank: 6 },
  ];

  for (const g of gradeDefs) {
    await prisma.grade.upsert({
      where: { orgId_code: { orgId: org.id, code: g.code } },
      update: {},
      create: { orgId: org.id, ...g, holdQuota: 3 },
    });
  }

  console.log(`  org ${org.id}, ${gradeDefs.length} PLACEHOLDER grades`);
  return org;
}

async function seedRbac() {
  const permissionRows = await Promise.all(
    PERMISSION_CODES.map((code) => {
      const [resource, action] = code.split(".");
      return prisma.permission.upsert({
        where: { code },
        update: {},
        create: { code, resource: resource!, action: action! },
      });
    }),
  );
  const permissionIdByCode = new Map(permissionRows.map((p) => [p.code, p.id]));

  for (const roleCode of ROLE_CODES) {
    const role = await prisma.role.upsert({
      where: { orgId_code: { orgId: ORG_ID, code: roleCode } },
      update: {},
      create: {
        orgId: ORG_ID,
        code: roleCode,
        name: ROLE_NAMES[roleCode],
        isSystem: true,
        requiresMfa: (MFA_REQUIRED_ROLES as string[]).includes(roleCode),
      },
    });

    for (const permissionCode of permissionsForRole(roleCode)) {
      const permissionId = permissionIdByCode.get(permissionCode)!;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        update: {},
        create: { roleId: role.id, permissionId },
      });
    }
  }

  console.log(`  ${permissionRows.length} permissions, ${ROLE_CODES.length} roles, matrix applied`);
}

async function seedDemoProject() {
  const project = await prisma.project.upsert({
    where: { id: PROJECT_ID },
    update: {},
    create: {
      id: PROJECT_ID,
      orgId: ORG_ID,
      code: "SKYLINE",
      name: "Skyline Residency", // PLACEHOLDER -- fictional demo project
      status: "SELLING",
      city: "Pune",
      state: "Maharashtra",
      // PLACEHOLDER RERA number -- not a real registration.
      reraRegNo: "P00000000000-DEMO",
      reraValidTill: new Date("2030-01-01"),
    },
  });

  await prisma.tower.upsert({
    where: { id: TOWER_ID },
    update: {},
    create: { id: TOWER_ID, orgId: ORG_ID, projectId: project.id, code: "A", name: "Tower A", totalFloors: 10 },
  });

  await prisma.unitType.upsert({
    where: { id: UNIT_TYPE_ID },
    update: {},
    create: {
      id: UNIT_TYPE_ID,
      orgId: ORG_ID,
      projectId: project.id,
      code: "2BHK",
      name: "2BHK",
      bedrooms: 2,
      bathrooms: 2,
      // PLACEHOLDER areas -- see docs/19-GLOSSARY.md, three different numbers.
      carpetArea: "650.00",
      builtUpArea: "780.00",
      saleableArea: "975.00",
    },
  });

  // 10 floors x 10 units/floor = 100 units, satisfying the Phase 0 seed target.
  let created = 0;
  for (let floor = 1; floor <= 10; floor++) {
    for (let unitOnFloor = 1; unitOnFloor <= 10; unitOnFloor++) {
      const unitNumber = `${floor}${String(unitOnFloor).padStart(2, "0")}`;
      await prisma.unit.upsert({
        where: { projectId_unitNumber: { projectId: project.id, unitNumber } },
        update: {},
        create: {
          orgId: ORG_ID,
          projectId: project.id,
          towerId: TOWER_ID,
          unitTypeId: UNIT_TYPE_ID,
          unitNumber,
          floor,
          status: "AVAILABLE",
        },
      });
      created++;
    }
  }

  console.log(`  project ${project.code}, 1 tower, 1 unit type, ${created} units`);
}

async function seedTestUsers() {
  const passwordHash = await argon2Hash(DEMO_PASSWORD);
  let created = 0;

  for (const roleCode of ROLE_CODES) {
    const email = `${roleCode.toLowerCase()}@demo.test`;
    const user = await prisma.user.upsert({
      where: { orgId_email: { orgId: ORG_ID, email } },
      update: {},
      create: {
        orgId: ORG_ID,
        email,
        name: `Demo ${ROLE_NAMES[roleCode]}`,
        passwordHash,
        status: "ACTIVE",
      },
    });

    const role = await prisma.role.findUniqueOrThrow({
      where: { orgId_code: { orgId: ORG_ID, code: roleCode } },
    });

    const existingGrant = await prisma.userRole.findFirst({
      where: { userId: user.id, roleId: role.id, projectId: null },
    });
    if (!existingGrant) {
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });
    }

    // ASSOCIATE and TEAM_LEAD map to real sales associates -- give them an
    // Associate record so hold/booking/commission flows have something to
    // reference. The admin-shaped roles (finance, project manager, etc.)
    // deliberately do not get one -- they are not sellers.
    if (roleCode === "ASSOCIATE" || roleCode === "TEAM_LEAD") {
      const associate = await prisma.associate.upsert({
        where: { userId: user.id },
        update: {},
        create: {
          orgId: ORG_ID,
          userId: user.id,
          code: `A-DEMO-${roleCode}`,
          engagementType: "EMPLOYEE",
          status: "ACTIVE",
          joinDate: new Date("2024-01-01"),
        },
      });

      const gradeCode = roleCode === "TEAM_LEAD" ? "G3" : "G1";
      const grade = await prisma.grade.findUniqueOrThrow({
        where: { orgId_code: { orgId: ORG_ID, code: gradeCode } },
      });

      const hasGrade = await prisma.associateGrade.findFirst({ where: { associateId: associate.id } });
      if (!hasGrade) {
        await prisma.associateGrade.create({
          data: { associateId: associate.id, gradeId: grade.id, validFrom: new Date("2024-01-01") },
        });
      }

      const hasPlacement = await prisma.associateHierarchy.findFirst({
        where: { associateId: associate.id },
      });
      if (!hasPlacement) {
        await prisma.associateHierarchy.create({
          data: { associateId: associate.id, parentId: null, path: "/", depth: 0, validFrom: new Date("2024-01-01") },
        });
      }
    }

    created++;
  }

  console.log(`  ${created} test users, password "${DEMO_PASSWORD}" for all`);
}

async function main() {
  console.log("Seeding org + grades...");
  await seedOrgAndGrades();

  console.log("Seeding RBAC (roles, permissions, matrix)...");
  await seedRbac();

  console.log("Seeding demo project + units...");
  await seedDemoProject();

  console.log("Seeding test users...");
  await seedTestUsers();

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
