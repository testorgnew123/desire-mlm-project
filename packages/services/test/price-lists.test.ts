// Price lists against real Postgres. Two things here are security rules, not
// features: maker-checker (docs/09-RBAC-MATRIX.md separation of duties) and
// "a project never has two ACTIVE price lists at once" -- the second because
// holds.ts and the cost sheet both resolve THE active list, and two would make
// which one you get a race.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import {
  MakerCheckerViolationError,
  PriceListNotEditableError,
  createDraftPriceList,
  getActivePriceList,
  publishPriceList,
  replacePriceListItems,
} from "../src/price-lists";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_pricelists";
const OTHER_ORG = "org_test_pricelists_other";
const D = (v: string | number) => new Prisma.Decimal(v);

async function reset() {
  for (const org of [ORG, OTHER_ORG]) {
    await db.auditLog.deleteMany({ where: { orgId: org } });
    await db.priceListItem.deleteMany({ where: { priceList: { orgId: org } } });
    await db.priceList.deleteMany({ where: { orgId: org } });
    await db.unitType.deleteMany({ where: { orgId: org } });
    await db.project.deleteMany({ where: { orgId: org } });
    await db.userRole.deleteMany({ where: { role: { orgId: org } } });
    await db.rolePermission.deleteMany({ where: { role: { orgId: org } } });
    await db.role.deleteMany({ where: { orgId: org } });
    await db.user.deleteMany({ where: { orgId: org } });
    await db.organization.deleteMany({ where: { id: org } });
  }
  await db.permission.deleteMany({ where: { code: { in: ["pricelist.prepare", "pricelist.approve"] } } });
}

/** A user holding exactly the permission codes given. */
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

async function seed() {
  await db.organization.create({
    data: { id: ORG, name: "PL Test Org", legalName: "PL Test Org Pvt Ltd" },
  });
  await db.organization.create({
    data: { id: OTHER_ORG, name: "Other Org", legalName: "Other Org Pvt Ltd" },
  });

  const project = await db.project.create({
    data: {
      orgId: ORG,
      code: "PLPROJ",
      name: "PL Project",
      city: "Pune",
      state: "Maharashtra",
      reraRegNo: "P-PL-1",
      reraValidTill: new Date("2030-01-01"),
    },
  });
  const unitType = await db.unitType.create({
    data: {
      orgId: ORG,
      projectId: project.id,
      code: "2BHK",
      name: "2BHK",
      carpetArea: "650.00",
      builtUpArea: "780.00",
      saleableArea: "975.00",
    },
  });

  const preparer = await makeUser(ORG, "preparer", ["pricelist.prepare"]);
  const approver = await makeUser(ORG, "approver", ["pricelist.approve"]);
  // Holds BOTH codes -- the interesting case: permission alone must not let
  // one person do both halves on the SAME list.
  const both = await makeUser(ORG, "both", ["pricelist.prepare", "pricelist.approve"]);

  return { project, unitType, preparer, approver, both };
}

function ctx(orgId: string, userId: string, label: string): AuditContext {
  return { orgId, actorId: userId, actorLabel: label };
}

const items = (unitTypeId: string, rate: number) => [
  { unitTypeId, baseRatePerSqft: D(rate), plcCharges: { CORNER: D(150) } },
];

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("maker-checker on publish", () => {
  it("REFUSES to let the preparer publish their own list, even holding both permissions", async () => {
    const { project, unitType, both } = await seed();
    const draft = await createDraftPriceList(db, {
      projectId: project.id,
      name: "v1",
      validFrom: new Date("2024-01-01"),
      items: items(unitType.id, 5000),
      audit: ctx(ORG, both.id, "both"),
    });

    // Same human, and they DO hold pricelist.approve. Permission is not the
    // control here -- separation of duties is.
    await expect(
      publishPriceList(db, { priceListId: draft.priceListId, audit: ctx(ORG, both.id, "both") }),
    ).rejects.toThrow(MakerCheckerViolationError);

    const after = await db.priceList.findUniqueOrThrow({ where: { id: draft.priceListId } });
    expect(after.status).toBe("DRAFT");
    expect(after.publishedAt).toBeNull();
  });

  it("allows a DIFFERENT approver to publish", async () => {
    const { project, unitType, preparer, approver } = await seed();
    const draft = await createDraftPriceList(db, {
      projectId: project.id,
      name: "v1",
      validFrom: new Date("2024-01-01"),
      items: items(unitType.id, 5000),
      audit: ctx(ORG, preparer.id, "preparer"),
    });

    const published = await publishPriceList(db, {
      priceListId: draft.priceListId,
      audit: ctx(ORG, approver.id, "approver"),
    });

    expect(published.version).toBe(1);
    const after = await db.priceList.findUniqueOrThrow({ where: { id: draft.priceListId } });
    expect(after.status).toBe("ACTIVE");
    expect(after.approvedById).toBe(approver.id);
    expect(after.preparedById).toBe(preparer.id);
    expect(after.approvedById).not.toBe(after.preparedById);
  });

  it("refuses an approver who lacks pricelist.approve", async () => {
    const { project, unitType, preparer } = await seed();
    const draft = await createDraftPriceList(db, {
      projectId: project.id,
      name: "v1",
      validFrom: new Date("2024-01-01"),
      items: items(unitType.id, 5000),
      audit: ctx(ORG, preparer.id, "preparer"),
    });
    const nobody = await makeUser(ORG, "nobody", []);

    await expect(
      publishPriceList(db, { priceListId: draft.priceListId, audit: ctx(ORG, nobody.id, "nobody") }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("never two ACTIVE lists at once", () => {
  it("publishing archives the incumbent and sets its validTo", async () => {
    const { project, unitType, preparer, approver } = await seed();

    const v1 = await createDraftPriceList(db, {
      projectId: project.id,
      name: "v1",
      validFrom: new Date("2024-01-01"),
      items: items(unitType.id, 5000),
      audit: ctx(ORG, preparer.id, "preparer"),
    });
    await publishPriceList(db, {
      priceListId: v1.priceListId,
      audit: ctx(ORG, approver.id, "approver"),
    });

    const v2 = await createDraftPriceList(db, {
      projectId: project.id,
      name: "v2",
      validFrom: new Date("2024-06-01"),
      items: items(unitType.id, 5500),
      audit: ctx(ORG, preparer.id, "preparer"),
    });
    const published2 = await publishPriceList(db, {
      priceListId: v2.priceListId,
      audit: ctx(ORG, approver.id, "approver"),
      now: new Date("2024-06-01"),
    });

    expect(published2.archivedPriceListIds).toContain(v1.priceListId);

    const active = await db.priceList.findMany({
      where: { projectId: project.id, status: "ACTIVE" },
    });
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(v2.priceListId);

    const old = await db.priceList.findUniqueOrThrow({ where: { id: v1.priceListId } });
    expect(old.status).toBe("ARCHIVED");
    expect(old.validTo).not.toBeNull();
  });

  it("getActivePriceList resolves by date window, not just status", async () => {
    const { project, unitType, preparer, approver } = await seed();
    const v1 = await createDraftPriceList(db, {
      projectId: project.id,
      name: "v1",
      validFrom: new Date("2024-01-01"),
      items: items(unitType.id, 5000),
      audit: ctx(ORG, preparer.id, "preparer"),
    });
    await publishPriceList(db, {
      priceListId: v1.priceListId,
      audit: ctx(ORG, approver.id, "approver"),
    });

    // Before validFrom -> nothing active yet.
    expect(await getActivePriceList(db, { projectId: project.id, asOf: new Date("2023-06-01") })).toBeNull();
    // After -> found, with its items.
    const active = await getActivePriceList(db, { projectId: project.id, asOf: new Date("2024-03-01") });
    expect(active?.id).toBe(v1.priceListId);
    expect(active?.items.length).toBeGreaterThan(0);
  });
});

describe("version allocation under concurrency", () => {
  it("10 concurrent drafts get 10 distinct versions, no collisions", async () => {
    const { project, unitType, preparer } = await seed();

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        createDraftPriceList(db, {
          projectId: project.id,
          name: `concurrent-${i}`,
          validFrom: new Date("2024-01-01"),
          items: items(unitType.id, 5000 + i),
          audit: ctx(ORG, preparer.id, "preparer"),
        }),
      ),
    );

    const ok = results.filter((r) => r.status === "fulfilled");
    // Every one should succeed -- the project-row lock serialises them rather
    // than letting them collide and fail.
    expect(ok).toHaveLength(10);

    const versions = ok.map((r) => (r as PromiseFulfilledResult<{ version: number }>).value.version);
    expect(new Set(versions).size).toBe(10);
    expect([...versions].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("immutability once published", () => {
  it("refuses to replace items on an ACTIVE list", async () => {
    const { project, unitType, preparer, approver } = await seed();
    const draft = await createDraftPriceList(db, {
      projectId: project.id,
      name: "v1",
      validFrom: new Date("2024-01-01"),
      items: items(unitType.id, 5000),
      audit: ctx(ORG, preparer.id, "preparer"),
    });
    await publishPriceList(db, {
      priceListId: draft.priceListId,
      audit: ctx(ORG, approver.id, "approver"),
    });

    // A booking pins its price list version. Editing a published list would
    // silently rewrite what a customer already signed.
    await expect(
      replacePriceListItems(db, {
        priceListId: draft.priceListId,
        items: items(unitType.id, 9999),
        audit: ctx(ORG, preparer.id, "preparer"),
      }),
    ).rejects.toThrow(PriceListNotEditableError);
  });
});

describe("tenancy", () => {
  it("refuses to create a list against another org's project", async () => {
    const { project, unitType } = await seed();
    const outsider = await makeUser(OTHER_ORG, "outsider", ["pricelist.prepare"]);

    await expect(
      createDraftPriceList(db, {
        projectId: project.id, // belongs to ORG
        name: "sneaky",
        validFrom: new Date("2024-01-01"),
        items: items(unitType.id, 5000),
        audit: ctx(OTHER_ORG, outsider.id, "outsider"),
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});
