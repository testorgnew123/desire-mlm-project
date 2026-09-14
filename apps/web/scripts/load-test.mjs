#!/usr/bin/env node
// Phase 5 load test (docs/21-TIER-LIMITS.md section 7's revised free-tier
// targets). Uses autocannon (pure npm, no system binary to install) rather
// than k6 -- same free/open-source bar, no extra setup on the machine
// running this.
//
// MUST run against a LOCAL server + LOCAL Docker Postgres, never hosted
// Neon: the free tier's own invocation/compute ceilings
// (docs/21-TIER-LIMITS.md section 1: ~90,000 invocations/month, 80 CU-h
// compute) make a real load test against it a self-inflicted outage, not a
// measurement.
//
// Usage (from apps/web):
//   BASE_URL=http://localhost:3011 SESSION_TOKEN=<raw session token> \
//     node scripts/load-test.mjs
//
// SESSION_TOKEN: a raw session token for a demo user with report.read/
// unit.read, e.g. issued the same way this project's own live-verification
// steps already do (see PROGRESS.md decision log).
import autocannon from "autocannon";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3011";
const SESSION_TOKEN = process.env.SESSION_TOKEN;
if (!SESSION_TOKEN) {
  console.error("SESSION_TOKEN is required -- issue one against LOCAL Postgres, never hosted Neon.");
  process.exit(1);
}

const headers = { cookie: `desire_session=${SESSION_TOKEN}` };
const PROJECT_ID = process.env.PROJECT_ID ?? "project_demo_skyline";

async function run(name, path) {
  console.log(`\n=== ${name} ===`);
  // Passing url + a separate path option double-concatenates under this
  // autocannon version (verified against a real 200 via curl vs. a bogus
  // 307 from autocannon until this was found) -- one full URL string per
  // call avoids it.
  const result = await autocannon({ url: `${BASE_URL}${path}`, headers, connections: 10, duration: 15 });
  console.log(autocannon.printResult(result));
  return result;
}

async function main() {
  // docs/21-TIER-LIMITS.md section 7's free-tier target: 10 concurrent
  // associates, 60s poll interval -- 10 connections is the actual
  // concurrency ceiling this tier is sized for, not an arbitrary number.
  await run("Board delta poll (GET /api/v1/projects/:id/units/deltas)", `/api/v1/projects/${PROJECT_ID}/units/deltas`);
  await run("Stock statement report export", "/api/v1/reports/stock-statement?format=csv");
  await run("Dashboard page (SSR, heaviest tile set)", "/dashboard");
}

main();
