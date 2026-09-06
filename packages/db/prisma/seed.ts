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

// Charge heads + an ACTIVE price list. Without these the demo is a display
// case: holds.ts refuses to hold a unit when the project has no active price
// list, so every unit on the board would be unholdable and the primary action
// dead. Charge heads were in the Phase 0 plan and never landed; the price list
// is a Phase 1 requirement that postdates the original seed.
//
// Written with plain Prisma rather than through packages/services: that package
// already depends on @desire/db, so importing it here would be a dependency
// cycle Turbo rejects. The seed is a state constructor -- it builds roles and
// permissions directly too. The service remains the enforcement point for real
// callers; the two invariants it guards are upheld by hand below (exactly one
// ACTIVE list, and preparer != approver).
async function seedPricing() {
  // PLACEHOLDER amounts and GST rates -- plan.md Open Item 6. Codes match the
  // catalogue in docs/06-INVENTORY-SPEC.md section 5.
  const chargeHeads = [
    { code: "BSP", name: "Basic Sale Price", category: "BASE_PRICE", isTaxable: true, gstRatePct: "5.00", countsTowardCommission: true, isRefundable: false, displayOrder: 1 },
    { code: "PLC", name: "Preferential Location Charge", category: "PLC", isTaxable: true, gstRatePct: "5.00", countsTowardCommission: true, isRefundable: false, displayOrder: 2 },
    { code: "PARKING", name: "Car Parking", category: "PARKING", isTaxable: true, gstRatePct: "5.00", countsTowardCommission: false, isRefundable: false, displayOrder: 3 },
    { code: "CLUB", name: "Club Membership", category: "CLUB_MEMBERSHIP", isTaxable: true, gstRatePct: "18.00", countsTowardCommission: false, isRefundable: false, displayOrder: 4 },
    // Refundable, so it must never reach the commissionable base.
    { code: "IFMS", name: "Interest-Free Maintenance Security", category: "IFMS", isTaxable: false, gstRatePct: null, countsTowardCommission: false, isRefundable: true, displayOrder: 5 },
    { code: "STAMP", name: "Stamp Duty", category: "STAMP_DUTY", isTaxable: false, gstRatePct: null, countsTowardCommission: false, isRefundable: false, displayOrder: 6 },
    { code: "REG", name: "Registration", category: "REGISTRATION", isTaxable: false, gstRatePct: null, countsTowardCommission: false, isRefundable: false, displayOrder: 7 },
  ] as const;

  for (const h of chargeHeads) {
    await prisma.chargeHead.upsert({
      where: { orgId_code: { orgId: ORG_ID, code: h.code } },
      update: {},
      create: { orgId: ORG_ID, ...h },
    });
  }

  // Re-running the seed must not publish v2, v3, v4... Skip if one is live.
  const existing = await prisma.priceList.findFirst({
    where: { projectId: PROJECT_ID, status: "ACTIVE" },
  });
  if (existing) {
    console.log(`  ${chargeHeads.length} charge heads, price list v${existing.version} already ACTIVE`);
    return;
  }

  // Maker-checker (docs/09-RBAC-MATRIX.md): pricelist.prepare belongs to
  // PROJECT_MANAGER, pricelist.approve to SALES_HEAD. Two distinct seeded
  // users, so the row asserts an approval that genuinely happened.
  const preparer = await prisma.user.findUniqueOrThrow({
    where: { orgId_email: { orgId: ORG_ID, email: "project_manager@demo.test" } },
  });
  const approver = await prisma.user.findUniqueOrThrow({
    where: { orgId_email: { orgId: ORG_ID, email: "sales_head@demo.test" } },
  });

  const publishedAt = new Date("2024-01-01");
  await prisma.priceList.create({
    data: {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      version: 1,
      name: "Launch pricing v1",
      status: "ACTIVE",
      validFrom: publishedAt,
      preparedById: preparer.id,
      approvedById: approver.id,
      publishedAt,
      items: {
        create: [
          {
            unitTypeId: UNIT_TYPE_ID,
            // PLACEHOLDER rate -- 975 sqft saleable x 5000 = Rs 48.75L base.
            baseRatePerSqft: "5000.00",
            plcCharges: { CORNER: 150, PARK_FACING: 200 },
            otherCharges: [
              { chargeHeadCode: "PARKING", amount: 300000 },
              { chargeHeadCode: "CLUB", amount: 100000 },
              { chargeHeadCode: "IFMS", amount: 50000 },
              { chargeHeadCode: "STAMP", amount: 350000 },
              { chargeHeadCode: "REG", amount: 30000 },
            ],
          },
        ],
      },
    },
  });

  console.log(`  ${chargeHeads.length} charge heads, price list v1 ACTIVE (prepared ${preparer.email}, approved ${approver.email})`);
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

  // After the users: the price list records who prepared and who approved it.
  console.log("Seeding charge heads + price list...");
  await seedPricing();

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
