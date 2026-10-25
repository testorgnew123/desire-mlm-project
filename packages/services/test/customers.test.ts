import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { ForbiddenError } from "../src/rbac";
import {
  InvalidCustomerError,
  createCustomer,
  normaliseCustomerPhone,
  parseCustomerInput,
} from "../src/customers";
import type { AuditContext } from "../src/audit";

describe("normaliseCustomerPhone", () => {
  it.each([
    ["98765 43210", "+919876543210"],
    ["9876543210", "+919876543210"],
    ["+91 98765-43210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["  (987) 654 3210 ", "+919876543210"],
    ["+971 50 123 4567", "+971501234567"],
  ])("%s -> %s", (raw, expected) => {
    expect(normaliseCustomerPhone(raw)).toBe(expected);
  });

  it.each([
    ["empty", ""],
    ["too short", "12345"],
    ["an Indian number that cannot start with 1", "1234567890"],
    ["letters", "call me"],
    ["too long for E.164", "+1234567890123456"],
    ["a 10-digit number with a leading zero", "0123456789"],
  ])("refuses %s", (_label, raw) => {
    expect(() => normaliseCustomerPhone(raw)).toThrow(InvalidCustomerError);
  });
});

describe("parseCustomerInput", () => {
  it("tidies the name, normalises the phone and lower-cases a blank-or-valid email", () => {
    expect(parseCustomerInput({ name: "  Asha   Rao ", phone: "98765 43210", email: " Asha@Example.COM " })).toEqual({
      name: "Asha Rao",
      phone: "+919876543210",
      email: "asha@example.com",
    });
  });

  it("treats a missing or blank email as none", () => {
    expect(parseCustomerInput({ name: "A", phone: "9876543210" }).email).toBeNull();
    expect(parseCustomerInput({ name: "A", phone: "9876543210", email: "  " }).email).toBeNull();
    expect(parseCustomerInput({ name: "A", phone: "9876543210", email: null }).email).toBeNull();
  });

  it("refuses an empty name, a name that is too long, and a malformed email", () => {
    expect(() => parseCustomerInput({ name: "   ", phone: "9876543210" })).toThrow(/name/i);
    expect(() => parseCustomerInput({ name: "x".repeat(121), phone: "9876543210" })).toThrow(/too long/);
    expect(() => parseCustomerInput({ name: "A", phone: "9876543210", email: "not-an-email" })).toThrow(/valid email/);
  });
});

const db = getPrismaClient();
const ORG = "org_test_customers";

async function reset() {
  await db.auditLog.deleteMany({ where: { orgId: ORG } });
  await db.customer.deleteMany({ where: { orgId: ORG } });
  await db.userRole.deleteMany({ where: { role: { orgId: ORG } } });
  await db.rolePermission.deleteMany({ where: { role: { orgId: ORG } } });
  await db.role.deleteMany({ where: { orgId: ORG } });
  await db.user.deleteMany({ where: { orgId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function makeUser(label: string, codes: string[]) {
  const user = await db.user.create({
    data: { orgId: ORG, email: `${label}-${ORG}@test.local`, name: label, passwordHash: "unused" },
  });
  const role = await db.role.create({ data: { orgId: ORG, code: `ROLE_${label}`, name: label } });
  for (const code of codes) {
    const [resource, action] = code.split(".");
    const permission = await db.permission.upsert({
      where: { code },
      update: {},
      create: { code, resource: resource!, action: action! },
    });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  }
  await db.userRole.create({ data: { userId: user.id, roleId: role.id, projectId: null } });
  return user;
}

const ctx = (user: { id: string } | null, label = "actor"): AuditContext => ({
  orgId: ORG,
  actorId: user?.id ?? null,
  actorLabel: label,
});

beforeEach(async () => {
  await reset();
  await db.organization.create({ data: { id: ORG, name: "Customers Org", legalName: "Customers Org Pvt Ltd" } });
});
afterAll(async () => {
  await reset();
  await db.$disconnect();
});

describe("createCustomer", () => {
  it("stores the tidied customer and audits it", async () => {
    const seller = await makeUser("seller", ["booking.create"]);
    const customer = await createCustomer(db, {
      name: " Asha  Rao ",
      phone: "98765 43210",
      email: "ASHA@example.com",
      audit: ctx(seller, "seller"),
    });

    expect(customer).toMatchObject({ orgId: ORG, name: "Asha Rao", phone: "+919876543210", email: "asha@example.com" });
    const audit = await db.auditLog.findFirstOrThrow({ where: { entity: "Customer", entityId: customer.id } });
    expect(audit).toMatchObject({ action: "CREATE", actorId: seller.id });
  });

  it("makes a new row every time, even for the same phone", async () => {
    const seller = await makeUser("seller", ["booking.create"]);
    const first = await createCustomer(db, { name: "A", phone: "9876543210", audit: ctx(seller) });
    const second = await createCustomer(db, { name: "A", phone: "9876543210", audit: ctx(seller) });
    expect(second.id).not.toBe(first.id);
    expect(await db.customer.count({ where: { orgId: ORG } })).toBe(2);
  });

  it("refuses someone who cannot create bookings, and a system actor", async () => {
    const reader = await makeUser("reader", []);
    await expect(createCustomer(db, { name: "A", phone: "9876543210", audit: ctx(reader) })).rejects.toThrow(ForbiddenError);
    await expect(createCustomer(db, { name: "A", phone: "9876543210", audit: ctx(null, "system") })).rejects.toThrow(ForbiddenError);
    expect(await db.customer.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("refuses bad input before touching the database", async () => {
    const seller = await makeUser("seller", ["booking.create"]);
    await expect(createCustomer(db, { name: "", phone: "9876543210", audit: ctx(seller) })).rejects.toThrow(InvalidCustomerError);
    await expect(createCustomer(db, { name: "A", phone: "nope", audit: ctx(seller) })).rejects.toThrow(InvalidCustomerError);
    expect(await db.customer.count({ where: { orgId: ORG } })).toBe(0);
  });
});
