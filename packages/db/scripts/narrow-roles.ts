#!/usr/bin/env tsx
// Brings an existing database in line with the three-role matrix.
//
//   pnpm --filter @desire/db exec tsx scripts/narrow-roles.ts            # dry run
//   pnpm --filter @desire/db exec tsx scripts/narrow-roles.ts --apply    # do it
//
// Dry run is the default and changes nothing. Refuses any database that is not
// local unless --allow-remote is given, because it re-roles real users and
// deletes Role rows; a hosted run is a deliberate act, not an accident.
// --org <id> picks the organisation (default: the only one).
import "dotenv/config";
import { applyNarrowing, planNarrowing } from "../src/narrow-roles";
import { getPrismaClient } from "../src/index";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function databaseHost(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  return new URL(url).hostname;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const allowRemote = args.includes("--allow-remote");
  const orgFlag = args.indexOf("--org");
  const orgId = orgFlag === -1 ? undefined : args[orgFlag + 1];

  const host = databaseHost();
  if (!LOCAL_HOSTS.has(host) && !allowRemote) {
    throw new Error(`DATABASE_URL points at "${host}", which is not local. Re-run with --allow-remote if you mean it.`);
  }

  const db = getPrismaClient();
  const org = orgId
    ? await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { id: true } })
    : await db.organization.findFirstOrThrow({ select: { id: true } });

  const plan = await planNarrowing(db, org.id);

  console.log(`database host: ${host}   organisation: ${org.id}   mode: ${apply ? "APPLY" : "dry run"}\n`);
  console.log(`permissions to create : ${plan.permissionsToCreate.join(", ") || "none"}`);
  console.log(`roles to create       : ${plan.rolesToCreate.join(", ") || "none"}`);
  console.log(`grants to add         : ${plan.grantsToAdd.length}`);
  console.log(`grants to remove      : ${plan.grantsToRemove.length}`);
  console.log(`users to re-role      : ${plan.reRole.length}`);
  for (const move of plan.reRole) {
    console.log(`  ${move.userEmail}: ${move.fromRole} -> ${move.toRole}${move.projectId ? ` (project ${move.projectId})` : ""}`);
  }
  console.log(`roles to delete       : ${plan.rolesToDelete.join(", ") || "none"}`);
  if (plan.needsDecision.length > 0) {
    console.log(`\nNEEDS A DECISION (no equivalent role; left untouched, role row kept):`);
    for (const user of plan.needsDecision) console.log(`  ${user.userEmail} holds ${user.role}`);
  }

  if (!apply) {
    console.log("\nDry run: nothing changed. Add --apply to perform the plan above.");
    return;
  }

  await applyNarrowing(db, plan);
  console.log("\nApplied.");
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
