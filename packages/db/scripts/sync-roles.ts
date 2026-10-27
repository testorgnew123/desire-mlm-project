#!/usr/bin/env tsx
// Adds the roles, permissions and grants the permission matrix says exist but a
// database lacks. ADD-ONLY: it never removes a grant, a role or a user's role
// (that is narrow-roles.ts). Runs on every production build and every preview
// database; see src/sync-roles.ts for why.
//
//   pnpm --filter @desire/db exec tsx scripts/sync-roles.ts            # dry run
//   pnpm --filter @desire/db exec tsx scripts/sync-roles.ts --apply    # do it
//
// Dry run is the default and changes nothing. Refuses any database that is not
// local unless --allow-remote is given; the deploy script passes it on purpose.
// --org <id> limits it to one organisation (default: every organisation).
import "dotenv/config";
import { applyRoleSync, planRoleSyncForOrgs } from "../src/sync-roles";
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
  const plans = await planRoleSyncForOrgs(db, orgId);

  console.log(`role sync   database host: ${host}   organisations: ${plans.length}   mode: ${apply ? "APPLY" : "dry run"}`);
  for (const plan of plans) {
    console.log(`\norganisation ${plan.orgId}`);
    console.log(`  permissions to create : ${plan.permissionsToCreate.join(", ") || "none"}`);
    console.log(`  roles to create       : ${plan.rolesToCreate.join(", ") || "none"}`);
    console.log(`  grants to add         : ${plan.grantsToAdd.length}`);
    if (plan.extraGrants.length > 0) {
      const extras = plan.extraGrants.map((grant) => `${grant.role}:${grant.permission}`).join(", ");
      console.log(`  extra grants (kept)   : ${plan.extraGrants.length} -- ${extras}`);
    }
  }

  if (!apply) {
    console.log("\nDry run: nothing changed. Add --apply to perform the plan above.");
    return;
  }

  for (const plan of plans) await applyRoleSync(db, plan);
  console.log("\nApplied.");
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
