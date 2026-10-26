#!/usr/bin/env tsx
// Local-only performance fixture: one plotted project at realistic volume.
//
//   20 blocks x 100 plots = 2,000 plots, an ACTIVE price list, 50 associates
//   with a grade, and 200 bookings (half CONFIRMED, half DRAFT with a live hold).
//
// Idempotent: every step looks for what it would create first. Refuses to run
// against anything but a local database (see local-db-guard.ts) -- it writes
// thousands of rows and must never reach the hosted Neon project.
//
// Usage (from the repo root, DATABASE_URL exported to the LOCAL Postgres):
//   pnpm --filter @desire/db exec tsx ../../apps/web/scripts/perf-seed.ts
import { Prisma, getPrismaClient } from "@desire/db";
import { confirmBooking, createDraftBooking } from "@desire/services/bookings";
import { createBlockWithPlots } from "@desire/services/blocks";
import { acquireHold } from "@desire/services/holds";
import { hashPassword } from "@desire/services/password";
import { createDraftPriceList, publishPriceList } from "@desire/services/price-lists";
import { createProject, createUnitType } from "@desire/services/projects";
import { assertLocalDatabase } from "./local-db-guard";

const ORG_ID = "org_demo";
const PROJECT_CODE = "PERF-PLOTS";
const PLOT_TYPE_CODE = "PLOT-200";
const BLOCKS = 20;
const PLOTS_PER_BLOCK = 100;
const ASSOCIATES = 50;
const BOOKINGS = 200;
const PASSWORD = "Perf@12345";

const pad = (n: number, width: number) => String(n).padStart(width, "0");

async function main(): Promise<void> {
  assertLocalDatabase();
  const db = getPrismaClient();

  const superAdmin = await db.user.findUniqueOrThrow({
    where: { orgId_email: { orgId: ORG_ID, email: "super_admin@demo.test" } },
  });
  const adminAudit = { orgId: ORG_ID, actorId: superAdmin.id, actorLabel: "perf-seed" };

  let project = await db.project.findFirst({ where: { orgId: ORG_ID, code: PROJECT_CODE } });
  if (!project) {
    project = await createProject(db, {
      code: PROJECT_CODE,
      name: "Perf Plots",
      audit: adminAudit,
    });
  }
  console.log(`project ${project.code} (${project.id})`);

  let unitType = await db.unitType.findFirst({ where: { projectId: project.id, code: PLOT_TYPE_CODE } });
  if (!unitType) {
    unitType = await createUnitType(db, {
      projectId: project.id,
      code: PLOT_TYPE_CODE,
      name: "Plot 200 sq yd",
      areaBasis: "SQYD",
      saleableArea: "200",
      audit: adminAudit,
    });
  }

  for (let b = 1; b <= BLOCKS; b++) {
    const code = `B${pad(b, 2)}`;
    if (await db.tower.findFirst({ where: { projectId: project.id, code }, select: { id: true } })) continue;
    await createBlockWithPlots(db, {
      projectId: project.id,
      code,
      name: `Block ${code}`,
      plotCount: PLOTS_PER_BLOCK,
      plotUnitTypeCode: PLOT_TYPE_CODE,
      audit: adminAudit,
    });
  }
  console.log(`plots: ${await db.unit.count({ where: { projectId: project.id } })}`);

  let priceList = await db.priceList.findFirst({ where: { projectId: project.id, status: "ACTIVE" } });
  if (!priceList) {
    const draft = await createDraftPriceList(db, {
      projectId: project.id,
      name: "Perf v1",
      validFrom: new Date(Date.now() - 86_400_000),
      items: [{ unitTypeId: unitType.id, baseRate: new Prisma.Decimal(25000) }],
      audit: adminAudit,
    });
    await publishPriceList(db, { priceListId: draft.priceListId, audit: adminAudit });
    priceList = await db.priceList.findUniqueOrThrow({ where: { id: draft.priceListId } });
  }

  const role = await db.role.findUniqueOrThrow({ where: { orgId_code: { orgId: ORG_ID, code: "ASSOCIATE" } } });
  const grade = await db.grade.findFirstOrThrow({
    where: { orgId: ORG_ID, isActive: true },
    orderBy: { rank: "asc" },
  });
  const passwordHash = await hashPassword(PASSWORD);

  const associates: { id: string; userId: string; name: string }[] = [];
  for (let i = 1; i <= ASSOCIATES; i++) {
    const n = pad(i, 2);
    const email = `perf_assoc_${n}@perf.test`;
    const name = `Perf Associate ${n}`;
    let user = await db.user.findUnique({
      where: { orgId_email: { orgId: ORG_ID, email } },
      include: { associate: true },
    });
    if (!user) {
      user = await db.user.create({
        data: {
          orgId: ORG_ID,
          email,
          name,
          passwordHash,
          status: "ACTIVE",
          userRoles: { create: { roleId: role.id } },
          associate: {
            create: {
              orgId: ORG_ID,
              code: `A-PERF-${n}`,
              engagementType: "CHANNEL_PARTNER",
              status: "ACTIVE",
              joinDate: new Date(),
            },
          },
        },
        include: { associate: true },
      });
    }
    const associate = user.associate;
    if (!associate) throw new Error(`${email} exists without an Associate row; remove it and re-run.`);
    const hasGrade = await db.associateGrade.findFirst({
      where: { associateId: associate.id, validTo: null },
      select: { id: true },
    });
    if (!hasGrade) {
      await db.associateGrade.create({
        data: { associateId: associate.id, gradeId: grade.id, validFrom: new Date(Date.now() - 86_400_000) },
      });
    }
    associates.push({ id: associate.id, userId: user.id, name });
  }
  console.log(`associates: ${associates.length}`);

  const existing = await db.booking.count({ where: { projectId: project.id } });
  for (let i = existing; i < BOOKINGS; i++) {
    const associate = associates[i % ASSOCIATES];
    if (!associate) throw new Error("no associates");
    const unit = await db.unit.findFirst({
      where: { projectId: project.id, status: "AVAILABLE" },
      orderBy: { unitNumber: "asc" },
      select: { id: true },
    });
    if (!unit) throw new Error("ran out of available plots");

    const audit = { orgId: ORG_ID, actorId: associate.userId, actorLabel: associate.name };
    await acquireHold(db, { orgId: ORG_ID, unitId: unit.id, associateId: associate.id, audit });
    const customer = await db.customer.create({
      data: { orgId: ORG_ID, name: `Perf Customer ${i + 1}`, phone: `+9190000${pad(i + 1, 5)}` },
    });
    const draft = await createDraftBooking(db, {
      unitId: unit.id,
      priceListId: priceList.id,
      customerId: customer.id,
      audit,
    });
    // Alternate by blocks of ASSOCIATES so each associate ends with two
    // confirmed bookings and two live-hold drafts (quota is 3).
    if (Math.floor(i / ASSOCIATES) % 2 === 0) {
      await confirmBooking(db, { bookingId: draft.id, audit: adminAudit });
    }
  }
  console.log(`bookings: ${await db.booking.count({ where: { projectId: project.id } })}`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
