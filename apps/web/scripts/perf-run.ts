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
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { getPrismaClient } from "@desire/db";
import { createSession } from "@desire/services/auth";
import { assertLocalDatabase } from "./local-db-guard";

const ORG_ID = "org_demo";
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3011";
const WARM_RUNS = Number(process.env.WARM_RUNS ?? "30");
const MUTATION_RUNS = Number(process.env.MUTATION_RUNS ?? "12");
const COUNT_STATEMENTS = process.env.COUNT_STATEMENTS !== "0";
const PG_CONTAINER = process.env.PG_CONTAINER ?? "desire-postgres";
const JOB_SECRET = process.env.JOB_TRIGGER_SECRET;
const LABEL = process.argv[2] ?? "run";

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
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Hit> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (cookie) headers.cookie = `desire_session=${cookie}`;
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
  const result = spawnSync("docker", ["logs", PG_CONTAINER], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
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
  } finally {
    if (COUNT_STATEMENTS) {
      psql("ALTER SYSTEM RESET log_statement");
      psql("SELECT pg_reload_conf()");
    }
  }

  printTable();
  const outFile = process.env.OUT;
  if (outFile) {
    writeFileSync(outFile, JSON.stringify({ label: LABEL, baseUrl: BASE_URL, warmRuns: WARM_RUNS, rows }, null, 2));
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
