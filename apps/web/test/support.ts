// Shared fixtures for the route-handler tests. Every file used to re-implement
// "make an org, make users, make a session"; this is the one copy.
//
// Roles and grants come from the REAL matrix (permissionsForRole), not from
// hand-picked permission lists, so a route test proves what the three roles can
// actually do today and fails if the matrix drifts from what a route expects.
//
// Runs against the LOCAL Postgres only: importing this module refuses any other
// database (apps/web/.env.local is production, and `next build` / `next start`
// read it).
import { randomBytes } from "node:crypto";
import { applyRoleSync, getPrismaClient, planRoleSync } from "@desire/db";
import type { RoleCode } from "@desire/db";
import { createSession } from "@desire/services/auth";
import { assertLocalDatabase } from "../scripts/local-db-guard";

assertLocalDatabase();

// A route that touches the pending-login cookie needs a real 32-byte key; the
// developer's .env key is not guaranteed to be one, so tests use their own.
process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString("base64");
export const JOB_SECRET = "test-job-secret";
process.env.JOB_TRIGGER_SECRET = JOB_SECRET;

export const db = getPrismaClient();
export const ORG = "org_test_web";

export async function resetWorld(): Promise<void> {
  await db.costSheetLine.deleteMany({ where: { booking: { orgId: ORG } } });
  await db.bookingStatusHistory.deleteMany({ where: { booking: { orgId: ORG } } });
  await db.booking.deleteMany({ where: { orgId: ORG } });
  await db.customer.deleteMany({ where: { orgId: ORG } });
  await db.auditLog.deleteMany({ where: { orgId: ORG } });
  await db.unitStatusHistory.deleteMany({ where: { unit: { orgId: ORG } } });
  await db.unitHold.deleteMany({ where: { orgId: ORG } });
  await db.unit.deleteMany({ where: { orgId: ORG } });
  await db.priceListItem.deleteMany({ where: { priceList: { orgId: ORG } } });
  await db.priceList.deleteMany({ where: { orgId: ORG } });
  await db.chargeHead.deleteMany({ where: { orgId: ORG } });
  await db.unitType.deleteMany({ where: { orgId: ORG } });
  await db.tower.deleteMany({ where: { orgId: ORG } });
  await db.associateGrade.deleteMany({ where: { associate: { orgId: ORG } } });
  await db.associate.deleteMany({ where: { orgId: ORG } });
  await db.userRole.deleteMany({ where: { role: { orgId: ORG } } });
  await db.rolePermission.deleteMany({ where: { role: { orgId: ORG } } });
  await db.role.deleteMany({ where: { orgId: ORG } });
  await db.user.deleteMany({ where: { orgId: ORG } }); // sessions cascade
  await db.project.deleteMany({ where: { orgId: ORG } });
  await db.grade.deleteMany({ where: { orgId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

export interface Person {
  id: string;
  /** A real session token, as the sign-in flow would have issued. */
  token: string;
  associateId: string | null;
}

/** A plotted project ready to hold and book, and one person of every kind. */
export async function seedWorld() {
  await db.organization.create({ data: { id: ORG, name: "Web Test Org", legalName: "Web Test Org Pvt Ltd" } });

  // The role sync every deploy runs, so a route test goes through the code that
  // creates roles in a real database, and still gets the three roles holding
  // exactly what the matrix says.
  await applyRoleSync(db, await planRoleSync(db, ORG));
  const roles = await db.role.findMany({ where: { orgId: ORG }, select: { id: true, code: true } });
  const roleId = new Map(roles.map((role) => [role.code as RoleCode, role.id]));

  const grade = await db.grade.create({ data: { orgId: ORG, code: "G1", name: "Executive", rank: 1, holdQuota: 5 } });

  async function person(label: string, role: RoleCode | null, options: { associate?: boolean } = {}): Promise<Person> {
    const user = await db.user.create({
      data: { orgId: ORG, email: `${label}@web.test`, name: label, passwordHash: "unused", status: "ACTIVE" },
    });
    if (role) await db.userRole.create({ data: { userId: user.id, roleId: roleId.get(role)!, projectId: null } });

    let associateId: string | null = null;
    if (options.associate) {
      const associate = await db.associate.create({
        data: { orgId: ORG, userId: user.id, code: `A-${label}`, engagementType: "CHANNEL_PARTNER", status: "ACTIVE", joinDate: new Date() },
      });
      await db.associateGrade.create({ data: { associateId: associate.id, gradeId: grade.id, validFrom: new Date(Date.now() - 86_400_000) } });
      associateId = associate.id;
    }
    const { rawToken } = await createSession(db, user.id, {});
    return { id: user.id, token: rawToken, associateId };
  }

  const superAdmin = await person("superadmin", "SUPER_ADMIN");
  const admin = await person("admin", "ADMIN");
  const seller = await person("seller", "ASSOCIATE", { associate: true });
  const rival = await person("rival", "ASSOCIATE", { associate: true });
  const outsider = await person("outsider", null);

  const project = await db.project.create({
    data: { orgId: ORG, code: "WEB", name: "Web Plots", reraRegNo: "P-WEB-1", reraValidTill: new Date("2030-01-01"), holdTtlMinutes: 60 },
  });
  const block = await db.tower.create({ data: { orgId: ORG, projectId: project.id, code: "A", name: "Block A", kind: "BLOCK" } });
  const plotType = await db.unitType.create({
    data: { orgId: ORG, projectId: project.id, code: "PLOT-200", name: "200 sq yd", areaBasis: "SQYD", saleableArea: "200.00" },
  });
  const plots = [];
  for (const unitNumber of ["A-01", "A-02", "A-03"]) {
    plots.push(await db.unit.create({ data: { orgId: ORG, projectId: project.id, towerId: block.id, unitTypeId: plotType.id, unitNumber } }));
  }
  await db.chargeHead.create({
    data: { orgId: ORG, code: "BSP", name: "Basic Sale Price", category: "BASE_PRICE", isTaxable: true, gstRatePct: "5.00", countsTowardCommission: true, isRefundable: false, displayOrder: 1 },
  });
  const priceList = await db.priceList.create({
    data: {
      orgId: ORG,
      projectId: project.id,
      version: 1,
      name: "v1",
      status: "ACTIVE",
      validFrom: new Date("2020-01-01"),
      preparedById: superAdmin.id,
      items: { create: [{ unitTypeId: plotType.id, baseRate: "25000.00" }] },
    },
  });

  return { project, block, plotType, plots, priceList, superAdmin, admin, seller, rival, outsider };
}

export type World = Awaited<ReturnType<typeof seedWorld>>;

/** A request as a browser or client would send it: a session cookie, or none. */
export function request(
  path: string,
  options: { method?: string; token?: string | null; json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers.cookie = `desire_session=${options.token}`;
  if (options.json !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
  });
}

/** Route params are a promise in Next 15. */
export const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

export async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** Who a hold or booking belongs to, from the database rather than the response. */
export const unitStatus = async (unitId: string) =>
  (await db.unit.findUniqueOrThrow({ where: { id: unitId }, select: { status: true } })).status;
