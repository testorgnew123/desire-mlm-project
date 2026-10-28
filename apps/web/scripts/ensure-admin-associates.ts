#!/usr/bin/env tsx
// Gives every Admin and Super Admin without one an associate profile, so they can
// hold and book plots like an associate. Add-only and idempotent; a dry run (the
// default) lists who would get one.
//
//   pnpm --filter @desire/db exec tsx ../../apps/web/scripts/ensure-admin-associates.ts [--apply] [--allow-remote] [--org <orgId>]
//
// Run by packages/db/scripts/migrate-on-deploy.sh after the role sync, and by the
// Neon preview workflow. Narrow subpath import: the services barrel would load the
// password hasher, a native addon the deploy step does not need.
import { getPrismaClient } from "@desire/db";
import { ensureAdminAssociateProfiles } from "@desire/services/associate-profile";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const allowRemote = args.includes("--allow-remote");
  const orgFlag = args.indexOf("--org");
  const orgId = orgFlag === -1 ? undefined : args[orgFlag + 1];

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host) && !allowRemote) {
    throw new Error(`DATABASE_URL points at "${host}", which is not local. Re-run with --allow-remote if you mean it.`);
  }

  const db = getPrismaClient();
  console.log(`admin associate profiles   database host: ${host}   mode: ${apply ? "APPLY" : "dry run"}`);
  const outcomes = await ensureAdminAssociateProfiles(db, { apply, orgId });
  if (outcomes.length === 0) console.log("  every Admin and Super Admin already has a profile");
  for (const outcome of outcomes) {
    console.log(`  ${outcome.email}: ${outcome.result}${outcome.code ? ` (${outcome.code})` : ""}`);
  }
  if (!apply) console.log("\nDry run: nothing changed. Add --apply to perform it.");
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
