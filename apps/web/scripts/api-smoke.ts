#!/usr/bin/env tsx
// Smoke-checks a RUNNING build, as each of the three roles and as nobody: every
// kept page and API answers the way it should, and every switched-off prefix
// answers 404 no matter who asks. The route tests exercise the handlers in
// process; this exists for what only a running server can show -- the rewrites in
// next.config.ts, the redirects to /login, and the middleware-free routing that
// connects them.
//
// Local only (it signs in by writing sessions into the database it is pointed at,
// and refuses anything but a local one).
//
//   pnpm --filter @desire/db exec tsx ../../apps/web/scripts/api-smoke.ts
//   Env: BASE_URL (default http://localhost:3011), DATABASE_URL (local), JOB_TRIGGER_SECRET.
// Needs perf-seed.ts to have run (it uses that project and its bookings).
import { getPrismaClient } from "@desire/db";
import { createSession } from "@desire/services/auth";
import { hashPassword } from "@desire/services/password";
import { assertLocalDatabase } from "./local-db-guard";

const ORG_ID = "org_demo";
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3011";
const JOB_SECRET = process.env.JOB_TRIGGER_SECRET;

type Actor = "none" | "superadmin" | "admin" | "associate";

interface Check {
  method: "GET" | "POST";
  path: string;
  actor: Actor;
  /** Any of these passes. A page that needs a session answers 307 to /login without one. */
  expect: number[];
  headers?: Record<string, string>;
  /** Text that must NOT appear in the body. For a page that refuses with notFound()
   *  after Next has begun streaming: the status is already 200 by then, so what
   *  matters is that the page it refused to render never reached the client. */
  bodyMustNotContain?: string[];
  /** Text that must appear in the body. */
  bodyMustContain?: string[];
}

async function ensureUser(db: ReturnType<typeof getPrismaClient>, email: string, roleCode: string): Promise<string> {
  const existing = await db.user.findUnique({ where: { orgId_email: { orgId: ORG_ID, email } } });
  if (existing) return existing.id;
  const role = await db.role.findUniqueOrThrow({ where: { orgId_code: { orgId: ORG_ID, code: roleCode } } });
  const user = await db.user.create({
    data: {
      orgId: ORG_ID,
      email,
      name: `Smoke ${roleCode}`,
      passwordHash: await hashPassword("Smoke-Unused-Password-1"),
      status: "ACTIVE",
      userRoles: { create: { roleId: role.id } },
    },
  });
  return user.id;
}

async function main(): Promise<void> {
  assertLocalDatabase();
  const db = getPrismaClient();

  const project = await db.project.findFirstOrThrow({ where: { orgId: ORG_ID, code: "PERF-PLOTS" }, select: { id: true } });
  const sellerUser = await db.user.findUniqueOrThrow({
    where: { orgId_email: { orgId: ORG_ID, email: "perf_assoc_01@perf.test" } },
    select: { id: true, associate: { select: { id: true } } },
  });
  const ownBooking = await db.booking.findFirstOrThrow({
    where: { projectId: project.id, sellingAssociateId: sellerUser.associate!.id },
    select: { id: true },
  });
  const otherBooking = await db.booking.findFirstOrThrow({
    where: { projectId: project.id, NOT: { sellingAssociateId: sellerUser.associate!.id } },
    select: { id: true },
  });
  const superAdminId = (await db.user.findUniqueOrThrow({ where: { orgId_email: { orgId: ORG_ID, email: "super_admin@demo.test" } } })).id;
  const adminId = await ensureUser(db, "smoke_admin@smoke.test", "ADMIN");

  const tokens: Record<Actor, string | null> = {
    none: null,
    superadmin: (await createSession(db, superAdminId, {})).rawToken,
    admin: (await createSession(db, adminId, {})).rawToken,
    associate: (await createSession(db, sellerUser.id, {})).rawToken,
  };

  const P = project.id;
  const checks: Check[] = [
    // Public.
    { method: "GET", path: "/login", actor: "none", expect: [200] },
    { method: "GET", path: "/login/forgot", actor: "none", expect: [200] },
    { method: "GET", path: "/api/health", actor: "none", expect: [200] },
    { method: "GET", path: "/login/reset?token=nope", actor: "none", expect: [200] },
    { method: "GET", path: "/login/change-password", actor: "none", expect: [307] },

    // Kept pages need a session.
    ...["/projects", `/projects/${P}`, "/stock", "/bookings", "/admin/users", "/inventory", "/my-bookings"].map(
      (path): Check => ({ method: "GET", path, actor: "none", expect: [307] }),
    ),
    // The board answers an anonymous caller 404, not a redirect, on purpose: it must
    // not even confirm the project exists.
    { method: "GET", path: `/board/${P}`, actor: "none", expect: [404] },
    // Kept APIs say 401, not a redirect.
    { method: "GET", path: `/api/v1/projects/${P}/units/deltas`, actor: "none", expect: [401] },
    { method: "GET", path: `/api/v1/bookings/${ownBooking.id}`, actor: "none", expect: [401] },
    { method: "POST", path: "/api/v1/bookings", actor: "none", expect: [401] },
    { method: "POST", path: "/api/jobs/holds/expire", actor: "none", expect: [401] },
    { method: "POST", path: "/api/jobs/backup/dump", actor: "none", expect: [401] },

    // Super admin and admin: the back office.
    ...(["superadmin", "admin"] as const).flatMap((actor): Check[] => [
      { method: "GET", path: "/projects", actor, expect: [200] },
      { method: "GET", path: `/projects/${P}`, actor, expect: [200] },
      { method: "GET", path: "/projects/new", actor, expect: [200] },
      { method: "GET", path: "/stock", actor, expect: [200] },
      { method: "GET", path: `/board/${P}`, actor, expect: [200] },
      { method: "GET", path: "/bookings", actor, expect: [200] },
      { method: "GET", path: `/bookings/${ownBooking.id}`, actor, expect: [200] },
      { method: "GET", path: "/admin/users", actor, expect: [200], bodyMustContain: ["Reset password", "New user"] },
      { method: "GET", path: `/api/v1/projects/${P}/units/deltas`, actor, expect: [200] },
      { method: "GET", path: `/api/v1/bookings/${otherBooking.id}`, actor, expect: [200] },
    ]),

    // Associate: the phone shell; no user admin, no project creation.
    { method: "GET", path: "/inventory", actor: "associate", expect: [200] },
    { method: "GET", path: `/inventory/${P}`, actor: "associate", expect: [200] },
    { method: "GET", path: "/my-bookings", actor: "associate", expect: [200] },
    { method: "GET", path: `/api/v1/projects/${P}/units/deltas`, actor: "associate", expect: [200] },
    { method: "GET", path: `/api/v1/bookings/${ownBooking.id}`, actor: "associate", expect: [200] },
    { method: "GET", path: `/api/v1/bookings/${otherBooking.id}`, actor: "associate", expect: [404] },
    {
      method: "GET",
      path: "/admin/users",
      actor: "associate",
      expect: [200, 404],
      bodyMustNotContain: ["perf_assoc_02@perf.test", "super_admin@demo.test", "Reset password", "New user"],
    },

    // Every switched-off prefix is a 404 for everybody, the super admin included.
    ...(["none", "superadmin", "admin", "associate"] as const).flatMap((actor): Check[] =>
      [
        "/dashboard",
        "/home",
        "/crm",
        "/leads",
        "/collections",
        "/network",
        "/team",
        "/commission",
        "/earnings",
        "/payouts",
        "/reports",
        "/bookings/discount-approvals",
        "/stock/holds",
        "/stock/blocked",
        "/stock/statement",
        "/admin/audit-log",
        "/admin/notification-rules",
      ].map((path): Check => ({ method: "GET", path, actor, expect: [404] })),
    ),
    ...(["none", "superadmin"] as const).flatMap((actor): Check[] =>
      [
        ["GET", "/api/v1/leads"],
        ["POST", "/api/v1/leads"],
        ["GET", "/api/v1/associates"],
        ["POST", "/api/v1/receipts"],
        ["GET", "/api/v1/payouts/batches"],
        ["GET", "/api/v1/reports/stock-statement"],
        ["GET", "/api/v1/notifications"],
        ["POST", "/api/v1/webhooks/leads/99acres"],
        ["GET", `/api/v1/bookings/${ownBooking.id}/demands`],
        ["POST", `/api/v1/bookings/${ownBooking.id}/discount-requests`],
        ["GET", `/api/v1/bookings/${ownBooking.id}/cancellation-preview`],
        ["POST", "/api/v1/discount-requests/x/decide"],
        ["POST", "/api/jobs/collections/sweep"],
        ["POST", "/api/jobs/grades/qualify"],
        ["POST", "/api/jobs/monitor/invariants"],
        ["POST", "/api/jobs/reports/send-scheduled"],
      ].map(([method, path]): Check => ({ method: method as "GET" | "POST", path: path!, actor, expect: [404] })),
    ),
  ];
  if (JOB_SECRET) {
    checks.push({ method: "POST", path: "/api/jobs/holds/expire", actor: "none", expect: [200], headers: { "x-job-secret": JOB_SECRET } });
  }

  const failures: string[] = [];
  const latencies: number[] = [];
  for (const check of checks) {
    const headers: Record<string, string> = { ...(check.headers ?? {}) };
    const token = tokens[check.actor];
    if (token) headers.cookie = `desire_session=${token}`;
    const started = performance.now();
    const response = await fetch(`${BASE_URL}${check.path}`, { method: check.method, headers, redirect: "manual" });
    const text = new TextDecoder().decode(await response.arrayBuffer());
    latencies.push(performance.now() - started);
    const label = `${check.actor.padEnd(10)} ${check.method.padEnd(4)} ${check.path}`;
    if (!check.expect.includes(response.status)) {
      failures.push(`${label} -> ${response.status}, expected ${check.expect.join(" or ")}`);
    }
    for (const needle of check.bodyMustNotContain ?? []) {
      if (text.includes(needle)) failures.push(`${label} -> body contains "${needle}"`);
    }
    for (const needle of check.bodyMustContain ?? []) {
      if (!text.includes(needle)) failures.push(`${label} -> body is missing "${needle}"`);
    }
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length / 2)] ?? 0;
  console.log(`${checks.length} checks, ${failures.length} failed. Median ${p50.toFixed(0)} ms, slowest ${(latencies[latencies.length - 1] ?? 0).toFixed(0)} ms.`);
  for (const failure of failures) console.log(`  FAIL ${failure}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
