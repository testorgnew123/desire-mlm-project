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
  PriceListNotEditableError,
  createDraftPriceList,
  getActivePriceList,
  publishPriceList,
  replacePriceListItems,
} from "../src/price-lists";
import { parsePlcCharges } from "../src/cost-sheet";
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
  { unitTypeId, baseRate: D(rate), plcCharges: { CORNER: D(150) } },
];

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

// Until 2026-10-14 the preparer could never publish their own list. That was
// relaxed at the client's instruction (see the header of price-lists.ts): the
// only role holding both permissions is the admin who runs the project. The
// control that remains is the permission itself, plus a visible audit trail.
describe("who may publish a price list", () => {
  it("lets a user holding both permissions publish the list they prepared, and says so in the audit log", async () => {
    const { project, unitType, both } = await seed();
    const draft = await createDraftPriceList(db, {
      projectId: project.id,
      name: "v1",
      validFrom: new Date("2024-01-01"),
      items: items(unitType.id, 5000),
      audit: ctx(ORG, both.id, "both"),
    });

    await publishPriceList(db, {
      priceListId: draft.priceListId,
      audit: ctx(ORG, both.id, "both"),
    });

    const after = await db.priceList.findUniqueOrThrow({ where: { id: draft.priceListId } });
    expect(after.status).toBe("ACTIVE");
    expect(after.preparedById).toBe(both.id);
    expect(after.approvedById).toBe(both.id);
    expect(after.publishedAt).not.toBeNull();

    // Allowed, but never silent: the approval row carries the fact.
    const approval = await db.auditLog.findFirstOrThrow({
      where: { entity: "PriceList", entityId: draft.priceListId, action: "APPROVE" },
    });
    expect(approval.reason).toContain("approved by the user who prepared it");
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

    // No self-approval note when two different people were involved.
    const approval = await db.auditLog.findFirstOrThrow({
      where: { entity: "PriceList", entityId: draft.priceListId, action: "APPROVE" },
    });
    expect(approval.reason).not.toContain("prepared it");
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

// ── Percentage PLC charges ─────────────────────────────────────────────
//
// A corner plot's DLC uplift is a percentage the developer picks, not rupees
// per square yard (client, 2026-10-13). What matters here is the ROUND TRIP:
// the writer and the cost-sheet reader must agree on the stored shape, and
// the older per-area shape must keep writing byte-identically so that every
// price list already in the database still reads.
describe("PLC charges round-trip through the Json column", () => {
  it("writes a percentage as an object and a per-area rate as a bare string", async () => {
    const { project, unitType, preparer } = await seed();

    const draft = await createDraftPriceList(db, {
      projectId: project.id,
      name: "Plot launch",
      validFrom: new Date("2026-01-01"),
      items: [
        {
          unitTypeId: unitType.id,
          baseRate: D(25_000),
          plcCharges: {
            CORNER: { basis: "PCT_OF_BASE", value: D(10) },
            PARK_FACING: D(150),
          },
        },
      ],
      audit: ctx(ORG, preparer.id, "preparer"),
    });

    const stored = await db.priceListItem.findFirstOrThrow({
      where: { priceListId: draft.priceListId },
      select: { plcCharges: true },
    });

    // Money as strings, never JSON numbers -- a JSON number is an IEEE
    // double. The per-area form is unchanged from before percentages
    // existed, which is what keeps existing lists readable.
    expect(stored.plcCharges).toEqual({
      CORNER: { basis: "PCT_OF_BASE", value: "10" },
      PARK_FACING: "150",
    });

    // And the cost sheet's own reader gets back what the writer meant.
    const parsed = parsePlcCharges(stored.plcCharges);
    expect(parsed.CORNER?.basis).toBe("PCT_OF_BASE");
    expect(parsed.CORNER?.value.toString()).toBe("10");
    expect(parsed.PARK_FACING?.basis).toBe("PER_AREA");
    expect(parsed.PARK_FACING?.value.toString()).toBe("150");
  });

  // The reader rejects a negative charge too, but by then a customer is
  // being quoted. Rejecting at write time puts it in front of the preparer.
  it("refuses a negative charge when the list is prepared, not when it is quoted", async () => {
    const { project, unitType, preparer } = await seed();

    await expect(
      createDraftPriceList(db, {
        projectId: project.id,
        name: "Bad",
        validFrom: new Date("2026-01-01"),
        items: [
          {
            unitTypeId: unitType.id,
            baseRate: D(25_000),
            plcCharges: { CORNER: { basis: "PCT_OF_BASE", value: D(-10) } },
          },
        ],
        audit: ctx(ORG, preparer.id, "preparer"),
      }),
    ).rejects.toThrow(/cannot be negative/);
  });
});
