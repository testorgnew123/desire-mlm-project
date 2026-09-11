// Charge-head master data. Runs against LOCAL Docker Postgres --
// authorization, the singleton-category lock and the P2002-to-typed-error
// mapping all need a real transaction, not a mock.
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import {
  ChargeHeadNotFoundError,
  ChargeHeadReasonRequiredError,
  DuplicateChargeCategoryError,
  DuplicateChargeHeadCodeError,
  InvalidGstRateError,
  createChargeHead,
  deleteChargeHead,
  setCommissionableFlag,
  updateChargeHead,
} from "../src/charge-heads";
import type { AuditContext } from "../src/audit";

const db = getPrismaClient();
const ORG = "org_test_chargeheads";
const OTHER_ORG = "org_test_chargeheads_other";

async function reset() {
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.auditLog.deleteMany({ where: { orgId } });
    await db.chargeHead.deleteMany({ where: { orgId } });
    await db.userRole.deleteMany({ where: { role: { orgId } } });
    await db.rolePermission.deleteMany({ where: { role: { orgId } } });
    await db.role.deleteMany({ where: { orgId } });
    await db.user.deleteMany({ where: { orgId } });
    await db.organization.deleteMany({ where: { id: orgId } });
  }
  // Permission has no orgId -- it is global seed config, not test data. Not
  // deleted here: charge-heads.test.ts and projects.test.ts both use
  // "project.write" and Vitest runs test FILES in parallel, so each file's
  // reset() deleting a row the other file is mid-upsert on raced into P2002s.
  // upsert-if-missing (in makeUser) is idempotent and race-free; deleting it
  // is not.
}

/** A user in the given org holding exactly the permission codes given. */
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

async function seedOrg(orgId: string, name: string) {
  await db.organization.create({ data: { id: orgId, name, legalName: `${name} Pvt Ltd` } });
}

function ctx(orgId: string, userId: string | null, label: string): AuditContext {
  return { orgId, actorId: userId, actorLabel: label };
}

/** Non-taxable by default -- most tests here are not about GST, and
 *  createChargeHead defaults isTaxable to true, which requires a rate. */
function nonTaxableHead<T extends object>(overrides: T): T & { isTaxable: false } {
  return { isTaxable: false, ...overrides };
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("createChargeHead", () => {
  it("creates a head with defaults applied and an audit row", async () => {
    await seedOrg(ORG, "CH Test Org");
    const writer = await makeUser(ORG, "writer", ["project.write"]);

    const head = await createChargeHead(db, {
      ...nonTaxableHead({
        code: "IFMS",
        name: "Interest-Free Maintenance Security",
        category: "IFMS",
        countsTowardCommission: false,
      }),
      audit: ctx(ORG, writer.id, "writer"),
    });

    expect(head.code).toBe("IFMS");
    expect(head.isRefundable).toBe(false);
    expect(head.displayOrder).toBe(0);

    const auditRow = await db.auditLog.findFirst({
      where: { entity: "ChargeHead", entityId: head.id, action: "CREATE" },
    });
    expect(auditRow).not.toBeNull();
  });

  it("refuses without project.write", async () => {
    await seedOrg(ORG, "CH Test Org");
    const nobody = await makeUser(ORG, "nobody", []);

    await expect(
      createChargeHead(db, {
        ...nonTaxableHead({ code: "PARKING", name: "Car Parking", category: "PARKING" }),
        audit: ctx(ORG, nobody.id, "nobody"),
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses a system actor (no actorId)", async () => {
    await seedOrg(ORG, "CH Test Org");
    await expect(
      createChargeHead(db, {
        ...nonTaxableHead({ code: "PARKING", name: "Car Parking", category: "PARKING" }),
        audit: ctx(ORG, null, "system"),
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("rejects a duplicate code within the same org", async () => {
    await seedOrg(ORG, "CH Test Org");
    const writer = await makeUser(ORG, "writer", ["project.write"]);
    const params = {
      ...nonTaxableHead({ code: "PARKING", name: "Car Parking", category: "PARKING" as const }),
      audit: ctx(ORG, writer.id, "writer"),
    };
    await createChargeHead(db, params);
    await expect(createChargeHead(db, params)).rejects.toThrow(DuplicateChargeHeadCodeError);
  });

  it("allows the same code in a different org", async () => {
    await seedOrg(ORG, "CH Test Org");
    await seedOrg(OTHER_ORG, "Other Org");
    const writer1 = await makeUser(ORG, "writer1", ["project.write"]);
    const writer2 = await makeUser(OTHER_ORG, "writer2", ["project.write"]);

    await createChargeHead(db, {
      ...nonTaxableHead({ code: "PARKING", name: "Car Parking", category: "PARKING" }),
      audit: ctx(ORG, writer1.id, "writer1"),
    });
    const head2 = await createChargeHead(db, {
      ...nonTaxableHead({ code: "PARKING", name: "Car Parking", category: "PARKING" }),
      audit: ctx(OTHER_ORG, writer2.id, "writer2"),
    });
    expect(head2.orgId).toBe(OTHER_ORG);
  });

  describe("singleton categories (BASE_PRICE, PLC)", () => {
    it("refuses a second BASE_PRICE head in the same org, naming the existing code", async () => {
      await seedOrg(ORG, "CH Test Org");
      const writer = await makeUser(ORG, "writer", ["project.write"]);
      await createChargeHead(db, {
        ...nonTaxableHead({ code: "BSP", name: "Basic Sale Price", category: "BASE_PRICE" }),
        audit: ctx(ORG, writer.id, "writer"),
      });

      await expect(
        createChargeHead(db, {
          ...nonTaxableHead({
            code: "BSP2",
            name: "Basic Sale Price (duplicate)",
            category: "BASE_PRICE",
          }),
          audit: ctx(ORG, writer.id, "writer"),
        }),
      ).rejects.toThrow(DuplicateChargeCategoryError);
    });

    it("allows a second PARKING head (non-singleton category)", async () => {
      await seedOrg(ORG, "CH Test Org");
      const writer = await makeUser(ORG, "writer", ["project.write"]);
      await createChargeHead(db, {
        ...nonTaxableHead({ code: "PARKING-COVERED", name: "Covered Parking", category: "PARKING" }),
        audit: ctx(ORG, writer.id, "writer"),
      });
      const second = await createChargeHead(db, {
        ...nonTaxableHead({ code: "PARKING-OPEN", name: "Open Parking", category: "PARKING" }),
        audit: ctx(ORG, writer.id, "writer"),
      });
      expect(second.code).toBe("PARKING-OPEN");
    });
  });

  describe("GST consistency", () => {
    it("refuses a taxable head with no GST rate", async () => {
      await seedOrg(ORG, "CH Test Org");
      const writer = await makeUser(ORG, "writer", ["project.write"]);
      await expect(
        createChargeHead(db, {
          code: "CLUB",
          name: "Club Membership",
          category: "CLUB_MEMBERSHIP",
          isTaxable: true,
          audit: ctx(ORG, writer.id, "writer"),
        }),
      ).rejects.toThrow(InvalidGstRateError);
    });

    it("refuses a non-taxable head carrying a GST rate", async () => {
      await seedOrg(ORG, "CH Test Org");
      const writer = await makeUser(ORG, "writer", ["project.write"]);
      await expect(
        createChargeHead(db, {
          code: "STAMP",
          name: "Stamp Duty",
          category: "STAMP_DUTY",
          isTaxable: false,
          gstRatePct: "5.00",
          audit: ctx(ORG, writer.id, "writer"),
        }),
      ).rejects.toThrow(InvalidGstRateError);
    });

    it("refuses a GST rate outside 0-100", async () => {
      await seedOrg(ORG, "CH Test Org");
      const writer = await makeUser(ORG, "writer", ["project.write"]);
      await expect(
        createChargeHead(db, {
          code: "CLUB",
          name: "Club Membership",
          category: "CLUB_MEMBERSHIP",
          isTaxable: true,
          gstRatePct: "150.00",
          audit: ctx(ORG, writer.id, "writer"),
        }),
      ).rejects.toThrow(InvalidGstRateError);
    });

    it("accepts a taxable head with a valid rate, rounded half-up to 2dp", async () => {
      await seedOrg(ORG, "CH Test Org");
      const writer = await makeUser(ORG, "writer", ["project.write"]);
      const head = await createChargeHead(db, {
        code: "CLUB",
        name: "Club Membership",
        category: "CLUB_MEMBERSHIP",
        isTaxable: true,
        gstRatePct: "18.005",
        audit: ctx(ORG, writer.id, "writer"),
      });
      expect(head.gstRatePct?.toString()).toBe("18.01");
    });
  });
});

describe("updateChargeHead", () => {
  it("updates the given fields and writes a before/after audit row", async () => {
    await seedOrg(ORG, "CH Test Org");
    const writer = await makeUser(ORG, "writer", ["project.write"]);
    const head = await createChargeHead(db, {
      code: "CLUB",
      name: "Club Membership",
      category: "CLUB_MEMBERSHIP",
      isTaxable: true,
      gstRatePct: "18.00",
      audit: ctx(ORG, writer.id, "writer"),
    });

    const updated = await updateChargeHead(db, {
      chargeHeadId: head.id,
      name: "Club Membership Fee",
      reason: "renamed for clarity",
      audit: ctx(ORG, writer.id, "writer"),
    });

    expect(updated.name).toBe("Club Membership Fee");
    const auditRow = await db.auditLog.findFirst({
      where: { entity: "ChargeHead", entityId: head.id, action: "UPDATE" },
    });
    expect(auditRow?.before).toEqual({ name: "Club Membership" });
    expect(auditRow?.after).toEqual({ name: "Club Membership Fee" });
    expect(auditRow?.reason).toBe("renamed for clarity");
  });

  it("returns the row unchanged and writes no audit row when nothing was submitted", async () => {
    await seedOrg(ORG, "CH Test Org");
    const writer = await makeUser(ORG, "writer", ["project.write"]);
    const head = await createChargeHead(db, {
      code: "CLUB",
      name: "Club Membership",
      category: "CLUB_MEMBERSHIP",
      isTaxable: true,
      gstRatePct: "18.00",
      audit: ctx(ORG, writer.id, "writer"),
    });

    await updateChargeHead(db, { chargeHeadId: head.id, audit: ctx(ORG, writer.id, "writer") });

    const auditRows = await db.auditLog.findMany({
      where: { entity: "ChargeHead", entityId: head.id, action: "UPDATE" },
    });
    expect(auditRows).toHaveLength(0);
  });

  it("refuses turning isTaxable off while a GST rate is still set", async () => {
    await seedOrg(ORG, "CH Test Org");
    const writer = await makeUser(ORG, "writer", ["project.write"]);
    const head = await createChargeHead(db, {
      code: "CLUB",
      name: "Club Membership",
      category: "CLUB_MEMBERSHIP",
      isTaxable: true,
      gstRatePct: "18.00",
      audit: ctx(ORG, writer.id, "writer"),
    });

    await expect(
      updateChargeHead(db, {
        chargeHeadId: head.id,
        isTaxable: false,
        audit: ctx(ORG, writer.id, "writer"),
      }),
    ).rejects.toThrow(InvalidGstRateError);
  });

  it("allows turning isTaxable off when the rate is cleared in the same call", async () => {
    await seedOrg(ORG, "CH Test Org");
    const writer = await makeUser(ORG, "writer", ["project.write"]);
    const head = await createChargeHead(db, {
      code: "CLUB",
      name: "Club Membership",
      category: "CLUB_MEMBERSHIP",
      isTaxable: true,
      gstRatePct: "18.00",
      audit: ctx(ORG, writer.id, "writer"),
    });

    const updated = await updateChargeHead(db, {
      chargeHeadId: head.id,
      isTaxable: false,
      gstRatePct: null,
      audit: ctx(ORG, writer.id, "writer"),
    });
    expect(updated.isTaxable).toBe(false);
    expect(updated.gstRatePct).toBeNull();
  });

  it("refuses moving a head into a singleton category already taken", async () => {
    await seedOrg(ORG, "CH Test Org");
    const writer = await makeUser(ORG, "writer", ["project.write"]);
    await createChargeHead(db, {
      ...nonTaxableHead({ code: "BSP", name: "Basic Sale Price", category: "BASE_PRICE" }),
      audit: ctx(ORG, writer.id, "writer"),
    });
    const other = await createChargeHead(db, {
      ...nonTaxableHead({ code: "OTHER", name: "Something Else", category: "OTHER" }),
      audit: ctx(ORG, writer.id, "writer"),
    });

    await expect(
      updateChargeHead(db, {
        chargeHeadId: other.id,
        category: "BASE_PRICE",
        audit: ctx(ORG, writer.id, "writer"),
      }),
    ).rejects.toThrow(DuplicateChargeCategoryError);
  });

  it("allows re-sending the category a head already has, even if another org head duplicates it", async () => {
    await seedOrg(ORG, "CH Test Org");
    const writer = await makeUser(ORG, "writer", ["project.write"]);
    const head = await createChargeHead(db, {
      ...nonTaxableHead({ code: "BSP", name: "Basic Sale Price", category: "BASE_PRICE" }),
      audit: ctx(ORG, writer.id, "writer"),
    });

    const updated = await updateChargeHead(db, {
      chargeHeadId: head.id,
      category: "BASE_PRICE",
      name: "Basic Sale Price v2",
      audit: ctx(ORG, writer.id, "writer"),
    });
    expect(updated.name).toBe("Basic Sale Price v2");
  });

  it("throws for a head that does not exist", async () => {
    await seedOrg(ORG, "CH Test Org");
    const writer = await makeUser(ORG, "writer", ["project.write"]);
    await expect(
      updateChargeHead(db, {
        chargeHeadId: "does-not-exist",
        name: "x",
        audit: ctx(ORG, writer.id, "writer"),
      }),
    ).rejects.toThrow(ChargeHeadNotFoundError);
  });

  it("refuses a head belonging to another org", async () => {
    await seedOrg(ORG, "CH Test Org");
    await seedOrg(OTHER_ORG, "Other Org");
    const writer = await makeUser(ORG, "writer", ["project.write"]);
    const outsider = await makeUser(OTHER_ORG, "outsider", ["project.write"]);
    const head = await createChargeHead(db, {
      ...nonTaxableHead({ code: "PARKING", name: "Car Parking", category: "PARKING" }),
      audit: ctx(ORG, writer.id, "writer"),
    });

    await expect(
      updateChargeHead(db, {
        chargeHeadId: head.id,
        name: "hijacked",
        audit: ctx(OTHER_ORG, outsider.id, "outsider"),
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("setCommissionableFlag", () => {
  it("requires a reason", async () => {
    await seedOrg(ORG, "CH Test Org");
    const approver = await makeUser(ORG, "approver", ["project.write", "scheme.prepare"]);
    const head = await createChargeHead(db, {
      ...nonTaxableHead({
        code: "BSP",
        name: "Basic Sale Price",
        category: "BASE_PRICE",
        countsTowardCommission: false,
      }),
      audit: ctx(ORG, approver.id, "approver"),
    });

    await expect(
      setCommissionableFlag(db, {
        chargeHeadId: head.id,
        countsTowardCommission: true,
        reason: "",
        audit: ctx(ORG, approver.id, "approver"),
      }),
    ).rejects.toThrow(ChargeHeadReasonRequiredError);
  });

  it("requires scheme.prepare -- project.write alone is not enough", async () => {
    await seedOrg(ORG, "CH Test Org");
    const writer = await makeUser(ORG, "writer", ["project.write"]);
    const head = await createChargeHead(db, {
      ...nonTaxableHead({
        code: "BSP",
        name: "Basic Sale Price",
        category: "BASE_PRICE",
        countsTowardCommission: false,
      }),
      audit: ctx(ORG, writer.id, "writer"),
    });

    await expect(
      setCommissionableFlag(db, {
        chargeHeadId: head.id,
        countsTowardCommission: true,
        reason: "should be commissionable",
        audit: ctx(ORG, writer.id, "writer"),
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("flips the flag and writes a dedicated before/after audit row with the reason", async () => {
    await seedOrg(ORG, "CH Test Org");
    const approver = await makeUser(ORG, "approver", ["project.write", "scheme.prepare"]);
    const head = await createChargeHead(db, {
      ...nonTaxableHead({
        code: "PARKING",
        name: "Car Parking",
        category: "PARKING",
        countsTowardCommission: false,
      }),
      audit: ctx(ORG, approver.id, "approver"),
    });

    const result = await setCommissionableFlag(db, {
      chargeHeadId: head.id,
      countsTowardCommission: true,
      reason: "management decision to include parking in payout base",
      audit: ctx(ORG, approver.id, "approver"),
    });

    expect(result.changed).toBe(true);
    expect(result.chargeHead.countsTowardCommission).toBe(true);

    const auditRow = await db.auditLog.findFirst({
      where: { entity: "ChargeHead", entityId: head.id, action: "UPDATE" },
    });
    expect(auditRow?.before).toEqual({ code: "PARKING", countsTowardCommission: false });
    expect(auditRow?.after).toEqual({ code: "PARKING", countsTowardCommission: true });
    expect(auditRow?.reason).toBe("management decision to include parking in payout base");
  });

  it("reports changed=false and writes no audit row when the flag already matches", async () => {
    await seedOrg(ORG, "CH Test Org");
    const approver = await makeUser(ORG, "approver", ["project.write", "scheme.prepare"]);
    const head = await createChargeHead(db, {
      ...nonTaxableHead({
        code: "BSP",
        name: "Basic Sale Price",
        category: "BASE_PRICE",
        countsTowardCommission: true,
      }),
      audit: ctx(ORG, approver.id, "approver"),
    });

    const result = await setCommissionableFlag(db, {
      chargeHeadId: head.id,
      countsTowardCommission: true,
      reason: "no-op check",
      audit: ctx(ORG, approver.id, "approver"),
    });

    expect(result.changed).toBe(false);
    const auditRows = await db.auditLog.findMany({
      where: { entity: "ChargeHead", entityId: head.id, action: "UPDATE" },
    });
    expect(auditRows).toHaveLength(0);
  });
});

describe("deleteChargeHead", () => {
  it("requires a reason", async () => {
    await seedOrg(ORG, "CH Test Org");
    const writer = await makeUser(ORG, "writer", ["project.write"]);
    const head = await createChargeHead(db, {
      ...nonTaxableHead({ code: "PARKING", name: "Car Parking", category: "PARKING" }),
      audit: ctx(ORG, writer.id, "writer"),
    });

    await expect(
      deleteChargeHead(db, { chargeHeadId: head.id, reason: "", audit: ctx(ORG, writer.id, "writer") }),
    ).rejects.toThrow(ChargeHeadReasonRequiredError);
  });

  it("hard-deletes the row and snapshots it fully into the audit log", async () => {
    await seedOrg(ORG, "CH Test Org");
    const writer = await makeUser(ORG, "writer", ["project.write"]);
    const head = await createChargeHead(db, {
      code: "PARKING",
      name: "Car Parking",
      category: "PARKING",
      isTaxable: true,
      gstRatePct: "5.00",
      audit: ctx(ORG, writer.id, "writer"),
    });

    await deleteChargeHead(db, {
      chargeHeadId: head.id,
      reason: "retired charge head",
      audit: ctx(ORG, writer.id, "writer"),
    });

    const gone = await db.chargeHead.findUnique({ where: { id: head.id } });
    expect(gone).toBeNull();

    const auditRow = await db.auditLog.findFirst({
      where: { entity: "ChargeHead", entityId: head.id, action: "DELETE" },
    });
    expect(auditRow?.reason).toBe("retired charge head");
    expect((auditRow?.before as Record<string, unknown> | null)?.code).toBe("PARKING");
    // Decimal(5,2)'s toString() drops trailing zeros -- 5.00 and 5 are the
    // same value, and toAuditValue calls .toString(), not .toFixed(2).
    expect((auditRow?.before as Record<string, unknown> | null)?.gstRatePct).toBe("5");
  });

  it("throws for a head that does not exist", async () => {
    await seedOrg(ORG, "CH Test Org");
    const writer = await makeUser(ORG, "writer", ["project.write"]);
    await expect(
      deleteChargeHead(db, {
        chargeHeadId: "does-not-exist",
        reason: "cleanup",
        audit: ctx(ORG, writer.id, "writer"),
      }),
    ).rejects.toThrow(ChargeHeadNotFoundError);
  });
});
