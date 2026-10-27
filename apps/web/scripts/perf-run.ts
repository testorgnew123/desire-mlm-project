#!/usr/bin/env tsx
// Per-route load time and SQL statement count, against a LOCAL production build.
//
// For every probe: the first request after the server started (cold: route
// module load), then WARM_RUNS sequential requests (p50/p95 of the total time
// including the streamed body), then one more request wrapped in two marker
// queries so the statements Postgres logged for it can be counted. Mutations
// (hold -> draft -> confirm -> cancel) run as a chain; the first iteration is
// the cold sample and the rest give p50/p95.
//
// FLOW_RUNS (default 10, 0 skips it) adds the whole journey through the UI's own
// Server Actions, as an admin and a brand-new associate: create the associate
// (credentials by email), first sign-in and forced password change, a plotted
// project with no RERA, block + plots, price list, book a plot, confirm, cancel.
// Each step is timed and its statements counted. The emailed password is read from
// the SMTP sink (scripts/smtp-sink.mjs, at SINK_URL); with SMTP unset the admin is
// shown it instead.
//
// Prerequisites, all local (this script refuses anything else):
//   1. perf-seed.ts has run.
//   2. `next start` is serving BASE_URL with DATABASE_URL pointing at the local
//      Docker Postgres and JOB_TRIGGER_SECRET set (the same value is passed here).
//   3. The Postgres container is reachable through `docker exec` (PG_CONTAINER).
//
//   pnpm --filter @desire/db exec tsx ../../apps/web/scripts/perf-run.ts <label>
//
// Env: BASE_URL (default http://localhost:3011), WARM_RUNS (30), MUTATION_RUNS (12),
// COUNT_STATEMENTS=0 to skip the log counting, JOB_TRIGGER_SECRET, OUT=<file.json>.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { getPrismaClient } from "@desire/db";
import { sendCredentialsEmail } from "@desire/services/account-mail";
import { createSession } from "@desire/services/auth";
import { hashPassword } from "@desire/services/password";
import { assertLocalDatabase } from "./local-db-guard";

const ORG_ID = "org_demo";
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3011";
const WARM_RUNS = Number(process.env.WARM_RUNS ?? "30");
const MUTATION_RUNS = Number(process.env.MUTATION_RUNS ?? "12");
const COUNT_STATEMENTS = process.env.COUNT_STATEMENTS !== "0";
const PG_CONTAINER = process.env.PG_CONTAINER ?? "desire-postgres";
const JOB_SECRET = process.env.JOB_TRIGGER_SECRET;
const LABEL = process.argv[2] ?? "run";
const FLOW_RUNS = Number(process.env.FLOW_RUNS ?? "10");
const SINK_URL = process.env.SINK_URL ?? "http://127.0.0.1:2526";
const WEB_DIR = resolve(process.cwd(), process.env.WEB_DIR ?? "../../apps/web");

type Actor = "admin" | "assoc" | "none";

interface Probe {
  name: string;
  method: "GET" | "POST";
  path: string;
  actor: Actor;
  body?: unknown;
  headers?: Record<string, string>;
  /** Present only to compare against the before/after picture; removed by the cut. */
  reference?: boolean;
}

interface Row {
  name: string;
  status: number;
  coldMs: number;
  p50: number;
  p95: number;
  kb: number;
  statements: number | null;
}

interface Hit {
  status: number;
  ttfbMs: number;
  totalMs: number;
  bytes: number;
  text: string;
}

const rows: Row[] = [];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? 0;
}

const round = (n: number) => Math.round(n * 10) / 10;

async function hit(
  method: "GET" | "POST",
  path: string,
  cookie: string | undefined,
  options: { body?: unknown; headers?: Record<string, string>; rawCookie?: string } = {},
): Promise<Hit> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.rawCookie) headers.cookie = options.rawCookie;
  else if (cookie) headers.cookie = `desire_session=${cookie}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const started = performance.now();
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual",
  });
  const ttfbMs = performance.now() - started;
  const buffer = await response.arrayBuffer();
  return {
    status: response.status,
    ttfbMs,
    totalMs: performance.now() - started,
    bytes: buffer.byteLength,
    text: new TextDecoder().decode(buffer),
  };
}

function psql(sql: string): void {
  const result = spawnSync("docker", ["exec", PG_CONTAINER, "psql", "-U", "desire", "-d", "postgres", "-tAc", sql], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
}

function pgLog(): string {
  // The tail, not the whole log: it only grows over a run, and the two markers sit at its end.
  const result = spawnSync("docker", ["logs", "--tail", "20000", PG_CONTAINER], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  return `${result.stderr}\n${result.stdout}`;
}

/** Statements Postgres logged while `run` executed, counted between two marker
 *  queries so the host/VM clock never matters. BEGIN and COMMIT count: each is a
 *  round trip. */
async function countStatements(run: () => Promise<unknown>): Promise<number | null> {
  if (!COUNT_STATEMENTS) return null;
  const id = randomUUID().replace(/-/g, "");
  psql(`SELECT 'PERFMARK_A_${id}'`);
  await run();
  await sleep(250);
  psql(`SELECT 'PERFMARK_B_${id}'`);
  await sleep(150);

  const log = pgLog();
  const start = log.lastIndexOf(`PERFMARK_A_${id}`);
  const end = log.lastIndexOf(`PERFMARK_B_${id}`);
  if (start === -1 || end === -1 || end < start) return null;
  const between = log.slice(start + `PERFMARK_A_${id}`.length, end);
  return (between.match(/LOG:\s+(?:statement:|execute [^:\n]*:)/g) ?? []).length;
}

function record(name: string, samples: Hit[], cold: Hit, statements: number | null): void {
  const totals = samples.map((s) => s.totalMs).sort((a, b) => a - b);
  const last = samples[samples.length - 1] ?? cold;
  rows.push({
    name,
    status: last.status,
    coldMs: round(cold.totalMs),
    p50: round(percentile(totals, 0.5)),
    p95: round(percentile(totals, 0.95)),
    kb: round(last.bytes / 1024),
    statements,
  });
}

async function runProbe(probe: Probe, cookie: string | undefined, warmRuns: number): Promise<void> {
  const options = { body: probe.body, headers: probe.headers };
  const cold = await hit(probe.method, probe.path, cookie, options);
  const samples: Hit[] = [];
  for (let i = 0; i < warmRuns; i++) samples.push(await hit(probe.method, probe.path, cookie, options));
  const statements = await countStatements(() => hit(probe.method, probe.path, cookie, options));
  record(probe.reference ? `${probe.name} (reference)` : probe.name, samples, cold, statements);
}

function printTable(): void {
  const header = "| Route | status | cold ms | p50 ms | p95 ms | KB | statements |";
  console.log(`\n${header}\n|---|---:|---:|---:|---:|---:|---:|`);
  for (const r of rows) {
    console.log(`| ${r.name} | ${r.status} | ${r.coldMs} | ${r.p50} | ${r.p95} | ${r.kb} | ${r.statements ?? "-"} |`);
  }
}

interface FormHit extends Hit {
  location: string | null;
  /** "name=value" of every cookie the response set. */
  cookies: string[];
}

/** A Server Action called the way a browser without JavaScript calls it: a multipart
 *  POST to the page that hosts the form, carrying the action's id as a `$ACTION_ID_<id>`
 *  field. The answer is a 303 to the next page, which is not followed here: that page is
 *  timed on its own as a GET. (A browser with JavaScript gets it rendered inside this
 *  same response, which saves it a round trip but not the server work.) */
async function formPost(
  path: string,
  actionId: string,
  fields: Record<string, string>,
  cookie?: string,
): Promise<FormHit> {
  const form = new FormData();
  form.set(`$ACTION_ID_${actionId}`, "");
  for (const [name, value] of Object.entries(fields)) form.set(name, value);

  const started = performance.now();
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: cookie ? { cookie } : {},
    body: form,
    redirect: "manual",
  });
  const ttfbMs = performance.now() - started;
  const buffer = await response.arrayBuffer();
  return {
    status: response.status,
    ttfbMs,
    totalMs: performance.now() - started,
    bytes: buffer.byteLength,
    text: new TextDecoder().decode(buffer),
    location: response.headers.get("location"),
    cookies: response.headers.getSetCookie().map((cookieLine) => cookieLine.split(";")[0] ?? ""),
  };
}

/** The id of a Server Action in the production build, by its exported name. The manifest
 *  also holds the build's encryption key, so only the id ever leaves this function. */
function loadActionIds(): (name: string) => string {
  const manifest = JSON.parse(
    readFileSync(resolve(WEB_DIR, ".next/server/server-reference-manifest.json"), "utf8"),
  ) as { node: Record<string, { exportedName: string }> };
  const byName = new Map(Object.entries(manifest.node).map(([id, entry]) => [entry.exportedName, id]));
  return (name) => {
    const id = byName.get(name);
    if (!id) throw new Error(`no Server Action named ${name} in the build; run next build first`);
    return id;
  };
}

/** A Server Action that worked answers 303 to the next page; one that failed answers 303
 *  to the same page with `?error=`, which is not a failure of the script, so look. */
function expectRedirect(label: string, result: FormHit, to?: RegExp): FormHit {
  const location = result.location ?? "";
  if (result.status !== 303 || /[?&]error=/.test(location) || (to && !to.test(location))) {
    throw new Error(`${label}: expected a 303${to ? ` to ${to}` : ""}, got ${result.status} ${decodeURIComponent(location)}`);
  }
  return result;
}

/** The temporary password of a new user: in the sink's copy of the email, or, when the
 *  server has no mail configured, in the redirect that shows it to the admin. */
async function emailedPassword(email: string, redirectTo: string): Promise<string> {
  const shown = new URL(redirectTo, BASE_URL).searchParams.get("tempPassword");
  if (shown) return shown;
  const mail = await (await fetch(`${SINK_URL}/last?to=${encodeURIComponent(email)}`)).text();
  const password = /Temporary password: (\S+)/.exec(mail)?.[1];
  if (!password) throw new Error(`no credentials email for ${email}; is the SMTP sink running on ${SINK_URL}?`);
  return password;
}

const sinkDelay = (ms: number) => fetch(`${SINK_URL}/delay?ms=${ms}`).then(() => undefined);
const p50 = (values: number[]) => round(percentile([...values].sort((a, b) => a - b), 0.5));

async function runFlow(db: ReturnType<typeof getPrismaClient>, adminToken: string): Promise<void> {
  const actionId = loadActionIds();
  const adminCookie = `desire_session=${adminToken}`;
  const runTag = Date.now().toString(36);
  const steps = new Map<string, { cold?: Hit; samples: Hit[]; statements: number | null }>();

  /** Iteration 0 is the cold sample, iteration 1 also counts statements, the rest are warm. */
  const step = async <T extends Hit>(name: string, iteration: number, run: () => Promise<T>): Promise<T> => {
    const { value, statements } = await measured(iteration === 1, run);
    const entry = steps.get(name) ?? { samples: [], statements: null };
    if (iteration === 0) entry.cold = value;
    else entry.samples.push(value);
    if (statements !== null) entry.statements = statements;
    steps.set(name, entry);
    return value;
  };

  await sinkDelay(0);
  for (let k = 0; k <= FLOW_RUNS; k++) {
    const tag = `${runTag}${k}`;
    const email = `flow_${tag}@perf.test`;

    // 1. An admin adds an associate; the login details go out by email.
    await step("GET /admin/users", k, () => hit("GET", "/admin/users", adminToken));
    const created = expectRedirect(
      "create user",
      await step("POST /admin/users (create user + email)", k, () =>
        formPost("/admin/users", actionId("createUserAction"), { email, name: `Flow ${tag}`, roleCode: "ASSOCIATE" }, adminCookie),
      ),
      /emailed=1|tempPassword=/,
    );
    const temporaryPassword = await emailedPassword(email, created.location ?? "");

    // 2. The associate's first sign-in: temporary password, forced change, landing page.
    await step("GET /login", k, () => hit("GET", "/login", undefined));
    const login = expectRedirect(
      "first sign-in",
      await step("POST /login (temporary password)", k, () =>
        formPost("/login", actionId("loginAction"), { email, password: temporaryPassword }),
      ),
      /\/login\/change-password/,
    );
    const pending = login.cookies.join("; ");
    await step("GET /login/change-password", k, () =>
      hit("GET", "/login/change-password", undefined, { rawCookie: pending }),
    );
    const newPassword = `Flow-${tag}-Password`;
    const changed = expectRedirect(
      "change password",
      await step("POST /login/change-password", k, () =>
        formPost("/login/change-password", actionId("changePasswordAction"), { password: newPassword, confirm: newPassword }, pending),
      ),
      /\/inventory/,
    );
    const associateToken = changed.cookies.find((c) => c.startsWith("desire_session="))?.slice("desire_session=".length);
    if (!associateToken) throw new Error("change password: no session cookie came back");
    await step("GET /inventory (associate)", k, () => hit("GET", "/inventory", associateToken));

    // 3. An admin sets up a plotted project with no RERA registration.
    const made = expectRedirect(
      "create project",
      await step("POST /projects/new (create project)", k, () =>
        formPost("/projects/new", actionId("createProjectAction"), { code: `FLOW${tag}`.toUpperCase(), name: `Flow ${tag}` }, adminCookie),
      ),
      /\/projects\/\w+/,
    );
    const projectId = /\/projects\/([^/?#]+)/.exec(made.location ?? "")?.[1];
    if (!projectId) throw new Error("create project: no project id in the redirect");
    const projectPath = `/projects/${projectId}`;
    await step("GET /projects/[id] (new project)", k, () => hit("GET", projectPath, adminToken));
    expectRedirect(
      "plot type",
      await step("POST /projects/[id] (plot type)", k, () =>
        formPost(projectPath, actionId("createUnitTypeAction"), { projectId, code: "PLOT-200", name: "200 sq yd plot", saleableArea: "200" }, adminCookie),
      ),
    );
    const plotType = await db.unitType.findFirstOrThrow({ where: { projectId, code: "PLOT-200" }, select: { id: true } });
    expectRedirect(
      "block with plots",
      await step("POST /projects/[id] (block + 20 plots)", k, () =>
        formPost(projectPath, actionId("createTowerAction"), { projectId, code: "A", name: "Block A", plotCount: "20", plotUnitTypeId: plotType.id }, adminCookie),
      ),
    );
    expectRedirect(
      "price list draft",
      await step("POST /projects/[id] (price list draft)", k, () =>
        formPost(projectPath, actionId("createDraftPriceListAction"), { projectId, name: "v1", unitTypeId: plotType.id, [`rate_${plotType.id}`]: "25000" }, adminCookie),
      ),
    );
    const draftList = await db.priceList.findFirstOrThrow({ where: { projectId, status: "DRAFT" }, select: { id: true } });
    expectRedirect(
      "price list publish",
      await step("POST /projects/[id] (price list publish)", k, () =>
        formPost(projectPath, actionId("publishPriceListAction"), { projectId, priceListId: draftList.id }, adminCookie),
      ),
    );

    // 4. The associate books a plot.
    const plot = await db.unit.findFirstOrThrow({ where: { projectId }, orderBy: { unitNumber: "asc" }, select: { id: true } });
    await step("GET /inventory/[id] (20 plots)", k, () => hit("GET", `/inventory/${projectId}`, associateToken));
    await step("GET /inventory/[id]/[unitId]/book", k, () => hit("GET", `/inventory/${projectId}/${plot.id}/book`, associateToken));
    expectRedirect(
      "book plot",
      await step("POST /inventory/[id]/[unitId]/book (book plot)", k, () =>
        formPost(
          `/inventory/${projectId}/${plot.id}/book`,
          actionId("bookPlotAction"),
          { projectId, unitId: plot.id, name: "Asha Rao", phone: `98${String(Date.now()).slice(-8)}`, email: "asha@example.com" },
          `desire_session=${associateToken}`,
        ),
      ),
      /my-bookings/,
    );
    await step("GET /my-bookings (one booking)", k, () => hit("GET", "/my-bookings", associateToken));

    // 5. The admin confirms the booking, then cancels it so the plot is free again.
    const booking = await db.booking.findFirstOrThrow({ where: { projectId }, select: { id: true } });
    await step("GET /bookings (admin)", k, () => hit("GET", "/bookings", adminToken));
    await step("GET /bookings/[id] (draft)", k, () => hit("GET", `/bookings/${booking.id}`, adminToken));
    expectRedirect(
      "confirm",
      await step("POST /bookings/[id] (confirm)", k, () =>
        formPost(`/bookings/${booking.id}`, actionId("confirmBookingAction"), { bookingId: booking.id }, adminCookie),
      ),
    );
    expectRedirect(
      "cancel",
      await step("POST /bookings/[id] (cancel)", k, () =>
        formPost(`/bookings/${booking.id}`, actionId("cancelBookingAction"), { bookingId: booking.id, reason: "perf run" }, adminCookie),
      ),
    );
    console.error(`flow ${k + 1}/${FLOW_RUNS + 1}`);
  }

  for (const [name, entry] of steps) {
    if (entry.cold) record(name, entry.samples, entry.cold, entry.statements);
  }
}

interface Breakdown {
  hashMs: number;
  mailMs0: number;
  mailMs150: number;
  postMs0: number;
  postMs150: number;
}

let breakdown: Breakdown | null = null;

/** What the email costs inside "create user": the whole POST with the sink answering at
 *  0 and at 150 ms per SMTP command (roughly a mail provider one 150 ms hop away), next
 *  to the two pieces timed alone, the argon2 hash and the send. p50 of 7 after a warm-up. */
async function createUserBreakdown(adminToken: string): Promise<Breakdown> {
  const actionId = loadActionIds();
  const samples = 8;

  const timeHash = async () => {
    const times: number[] = [];
    for (let i = 0; i < samples; i++) {
      const started = performance.now();
      await hashPassword("Perf-Hash-Password-1");
      if (i > 0) times.push(performance.now() - started);
    }
    return p50(times);
  };
  const timeMail = async (delay: number) => {
    await sinkDelay(delay);
    const times: number[] = [];
    for (let i = 0; i < samples; i++) {
      const started = performance.now();
      const outcome = await sendCredentialsEmail({
        to: "flow_mail@perf.test",
        name: "Flow Mail",
        loginId: "flow_mail@perf.test",
        temporaryPassword: "Temp-Password-1",
        kind: "created",
      });
      if (!outcome.sent) throw new Error(`mail not sent: ${outcome.note}`);
      if (i > 0) times.push(performance.now() - started);
    }
    return p50(times);
  };
  const timePost = async (delay: number) => {
    await sinkDelay(delay);
    const times: number[] = [];
    for (let i = 0; i < samples; i++) {
      const email = `flow_mail_${delay}_${Date.now().toString(36)}${i}@perf.test`;
      const result = expectRedirect(
        "create user",
        await formPost("/admin/users", actionId("createUserAction"), { email, name: "Flow Mail", roleCode: "ASSOCIATE" }, `desire_session=${adminToken}`),
        /emailed=1/,
      );
      if (i > 0) times.push(result.totalMs);
    }
    return p50(times);
  };

  const result = {
    hashMs: await timeHash(),
    mailMs0: await timeMail(0),
    mailMs150: await timeMail(150),
    postMs0: await timePost(0),
    postMs150: await timePost(150),
  };
  await sinkDelay(0);
  return result;
}

function printBreakdown(): void {
  if (!breakdown) return;
  console.log("\nCreate user, where the time goes (p50 ms; sink = SMTP stand-in answering after the delay)");
  console.log("\n| argon2 hash | send mail, sink 0 ms | send mail, sink 150 ms | whole POST, sink 0 ms | whole POST, sink 150 ms |");
  console.log("|---:|---:|---:|---:|---:|");
  console.log(
    `| ${breakdown.hashMs} | ${breakdown.mailMs0} | ${breakdown.mailMs150} | ${breakdown.postMs0} | ${breakdown.postMs150} |`,
  );
}

async function main(): Promise<void> {
  assertLocalDatabase();
  const db = getPrismaClient();

  const health = await hit("GET", "/api/health", undefined);
  if (health.status !== 200) throw new Error(`${BASE_URL}/api/health returned ${health.status}; is next start running?`);

  const project = await db.project.findFirstOrThrow({ where: { orgId: ORG_ID, code: "PERF-PLOTS" }, select: { id: true } });
  const priceList = await db.priceList.findFirstOrThrow({
    where: { projectId: project.id, status: "ACTIVE" },
    select: { id: true },
  });
  const confirmed = await db.booking.findFirstOrThrow({
    where: { projectId: project.id, status: "CONFIRMED" },
    select: { id: true },
  });
  const draft = await db.booking.findFirstOrThrow({
    where: { projectId: project.id, status: "DRAFT" },
    select: { id: true },
  });
  const freeUnit = await db.unit.findFirstOrThrow({
    where: { projectId: project.id, status: "AVAILABLE" },
    orderBy: { unitNumber: "asc" },
    select: { id: true },
  });

  const adminUser = await db.user.findUniqueOrThrow({
    where: { orgId_email: { orgId: ORG_ID, email: "super_admin@demo.test" } },
    select: { id: true, name: true },
  });
  const assocUsers = await db.user.findMany({
    where: { orgId: ORG_ID, email: { startsWith: "perf_assoc_" } },
    orderBy: { email: "asc" },
    select: { id: true, name: true },
  });
  const firstAssoc = assocUsers[0];
  if (!firstAssoc) throw new Error("perf associates missing; run perf-seed.ts");

  const adminToken = (await createSession(db, adminUser.id, {})).rawToken;
  const assocToken = (await createSession(db, firstAssoc.id, {})).rawToken;
  const cookies: Record<Actor, string | undefined> = { admin: adminToken, assoc: assocToken, none: undefined };

  if (COUNT_STATEMENTS) {
    psql("ALTER SYSTEM SET log_statement = 'all'");
    psql("SELECT pg_reload_conf()");
    await sleep(500);
  }

  try {
    const since = new Date().toISOString();
    const probes: Probe[] = [
      { name: "GET /login", method: "GET", path: "/login", actor: "none" },
      { name: "GET /api/health", method: "GET", path: "/api/health", actor: "none" },
      { name: "GET /projects", method: "GET", path: "/projects", actor: "admin" },
      { name: "GET /projects/[id]", method: "GET", path: `/projects/${project.id}`, actor: "admin" },
      { name: "GET /stock", method: "GET", path: "/stock", actor: "admin" },
      { name: "GET /board/[id]", method: "GET", path: `/board/${project.id}`, actor: "admin" },
      { name: "GET /bookings", method: "GET", path: "/bookings", actor: "admin" },
      { name: "GET /bookings/[id] (confirmed)", method: "GET", path: `/bookings/${confirmed.id}`, actor: "admin" },
      { name: "GET /bookings/[id] (draft)", method: "GET", path: `/bookings/${draft.id}`, actor: "admin" },
      { name: "GET /admin/users", method: "GET", path: "/admin/users", actor: "admin" },
      { name: "GET /inventory (associate)", method: "GET", path: "/inventory", actor: "assoc" },
      { name: "GET /inventory/[id] (associate)", method: "GET", path: `/inventory/${project.id}`, actor: "assoc" },
      { name: "GET /my-bookings (associate)", method: "GET", path: "/my-bookings", actor: "assoc" },
      {
        name: "GET /inventory/[id]/[unitId]/book (associate)",
        method: "GET",
        path: `/inventory/${project.id}/${freeUnit.id}/book`,
        actor: "assoc",
      },
      { name: "GET /projects/new", method: "GET", path: "/projects/new", actor: "admin" },
      { name: "GET /admin (redirects)", method: "GET", path: "/admin", actor: "admin" },
      { name: "GET / (signed in, redirects)", method: "GET", path: "/", actor: "admin" },
      { name: "GET / (signed out, redirects)", method: "GET", path: "/", actor: "none" },
      { name: "GET /login/forgot", method: "GET", path: "/login/forgot", actor: "none" },
      { name: "GET /login/reset?token=x", method: "GET", path: "/login/reset?token=x", actor: "none" },
      {
        name: "GET /api/v1/.../units/deltas (full)",
        method: "GET",
        path: `/api/v1/projects/${project.id}/units/deltas`,
        actor: "admin",
      },
      {
        name: "GET /api/v1/.../units/deltas?since=now",
        method: "GET",
        path: `/api/v1/projects/${project.id}/units/deltas?since=${encodeURIComponent(since)}`,
        actor: "admin",
      },
      { name: "GET /api/v1/bookings/[id]", method: "GET", path: `/api/v1/bookings/${confirmed.id}`, actor: "admin" },
      { name: "GET /dashboard", method: "GET", path: "/dashboard", actor: "admin", reference: true },
      { name: "GET /home (associate)", method: "GET", path: "/home", actor: "assoc", reference: true },
    ];
    if (JOB_SECRET) {
      probes.push({
        name: "POST /api/jobs/holds/expire",
        method: "POST",
        path: "/api/jobs/holds/expire",
        actor: "none",
        body: {},
        headers: { "x-job-secret": JOB_SECRET },
      });
    }

    for (const probe of probes) {
      await runProbe(probe, cookies[probe.actor], probe.method === "POST" ? 5 : WARM_RUNS);
      console.error(`measured ${probe.name}`);
    }

    // Mutation chain: hold -> draft -> confirm -> cancel, one associate and one
    // plot per iteration so quota and locks never interfere with the timing.
    const ops: Record<string, { cold?: Hit; samples: Hit[]; statements: number | null }> = {
      "POST holds": { samples: [], statements: null },
      "POST /api/v1/bookings (draft)": { samples: [], statements: null },
      "POST bookings/[id]/confirm": { samples: [], statements: null },
      "POST bookings/[id]/cancel": { samples: [], statements: null },
    };
    const take = (key: string, h: Hit, iteration: number, statements: number | null) => {
      const op = ops[key];
      if (!op) return;
      if (iteration === 0) op.cold = h;
      else op.samples.push(h);
      if (statements !== null) op.statements = statements;
    };

    for (let k = 0; k < MUTATION_RUNS; k++) {
      const assoc = assocUsers[k + 1];
      if (!assoc) throw new Error("not enough perf associates for the mutation chain");
      const token = (await createSession(db, assoc.id, {})).rawToken;
      const unit = await db.unit.findFirstOrThrow({
        where: { projectId: project.id, status: "AVAILABLE" },
        orderBy: { unitNumber: "asc" },
        select: { id: true },
      });
      const customer = await db.customer.create({
        data: { orgId: ORG_ID, name: `Perf Mutation ${k}`, phone: `+9180000${String(k).padStart(5, "0")}` },
      });
      const measure = k === 1;

      const hold = await measured(measure, () =>
        hit("POST", `/api/v1/projects/${project.id}/units/${unit.id}/holds`, token),
      );
      take("POST holds", hold.value, k, hold.statements);

      const draftRun = await measured(measure, () =>
        hit("POST", "/api/v1/bookings", token, {
          body: { unitId: unit.id, priceListId: priceList.id, customerId: customer.id },
        }),
      );
      take("POST /api/v1/bookings (draft)", draftRun.value, k, draftRun.statements);
      const draftId = (JSON.parse(draftRun.value.text) as { id?: string }).id;
      if (!draftId) throw new Error(`draft failed: ${draftRun.value.status} ${draftRun.value.text.slice(0, 200)}`);

      const confirmRun = await measured(measure, () =>
        hit("POST", `/api/v1/bookings/${draftId}/confirm`, adminToken),
      );
      take("POST bookings/[id]/confirm", confirmRun.value, k, confirmRun.statements);

      const cancelRun = await measured(measure, () =>
        hit("POST", `/api/v1/bookings/${draftId}/cancel`, adminToken, { body: { reason: "perf run" } }),
      );
      take("POST bookings/[id]/cancel", cancelRun.value, k, cancelRun.statements);
      console.error(`mutation chain ${k + 1}/${MUTATION_RUNS}`);
    }

    for (const [name, op] of Object.entries(ops)) {
      if (!op.cold) continue;
      record(name, op.samples, op.cold, op.statements);
    }

    if (FLOW_RUNS > 0) {
      await runFlow(db, adminToken);
      breakdown = await createUserBreakdown(adminToken);
    }
  } finally {
    if (COUNT_STATEMENTS) {
      psql("ALTER SYSTEM RESET log_statement");
      psql("SELECT pg_reload_conf()");
    }
  }

  printTable();
  printBreakdown();
  const outFile = process.env.OUT;
  if (outFile) {
    writeFileSync(
      outFile,
      JSON.stringify({ label: LABEL, baseUrl: BASE_URL, warmRuns: WARM_RUNS, rows, breakdown }, null, 2),
    );
    console.error(`wrote ${outFile}`);
  }
}

/** Runs `run`, and when `enabled` also counts the statements it caused. */
async function measured<T>(enabled: boolean, run: () => Promise<T>): Promise<{ value: T; statements: number | null }> {
  if (!enabled || !COUNT_STATEMENTS) return { value: await run(), statements: null };

  let outcome: { value: T } | undefined;
  const statements = await countStatements(async () => {
    outcome = { value: await run() };
  });
  if (!outcome) throw new Error("measured run did not execute");
  return { value: (outcome as { value: T }).value, statements };
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
