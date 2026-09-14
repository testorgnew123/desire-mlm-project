// Quarterly backup restore drill (docs/15-OPS-RUNBOOK.md,
// docs/21-TIER-LIMITS.md section 6). Restores a real nightly backup dump
// (packages/services/src/backup.ts's JSON output, fetched from Netlify
// Blobs) into a target Postgres database -- point DATABASE_URL at a
// SCRATCH database when running this, never the real one.
//
// Restores in dependency order without a hardcoded table list: repeated
// passes over the tables that still have rows left, inserting whatever
// succeeds and leaving FK-blocked rows for the next pass, until a full
// pass makes no progress. This is a real, reusable disaster-recovery
// mechanism, not just a one-off drill script -- the same backup this
// restores from is the only DR this project has, now that the free tier
// is permanent (PROGRESS.md decision log, 2026-09-13).
import "dotenv/config";
import { readFileSync } from "node:fs";
import { Client } from "pg";

interface Dump {
  dumpedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

// The only real Postgres array-typed (String[]) columns in the schema
// (grep "String\[\]" packages/db/prisma/schema.prisma) -- everything else
// that comes back as a JS array from JSON.parse is a jsonb column whose
// *value* happens to be an array (e.g. PriceListItem.otherCharges), which
// needs JSON.stringify like any other jsonb value, not native array
// binding. Found by running this drill for real: a plain "array vs jsonb"
// heuristic mis-restored otherCharges as a native array bind and Postgres
// rejected it.
const NATIVE_ARRAY_COLUMNS = new Set(["plcTags", "preferredTypes", "unitsShown", "audience"]);

async function main() {
  const dumpPath = process.argv[2];
  if (!dumpPath) throw new Error("usage: tsx scripts/restore-drill.ts <dump.json>");

  const dump: Dump = JSON.parse(readFileSync(dumpPath, "utf8"));
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const remaining = new Map(Object.entries(dump.tables).filter(([, rows]) => rows.length > 0));
  const restoredCount = new Map<string, number>();

  let progressed = true;
  while (remaining.size > 0 && progressed) {
    progressed = false;

    for (const [table, rows] of [...remaining]) {
      const stillFailing: typeof rows = [];
      let restored = restoredCount.get(table) ?? 0;

      for (const row of rows) {
        const columns = Object.keys(row);
        // A plain object survived JSON.parse as a JS object -- for a jsonb
        // column pg needs the literal JSON text, not a bound object, or it
        // rejects the parameter outright. Arrays are left alone: those are
        // real Postgres array columns (e.g. Lead.preferredTypes), which pg
        // binds natively from a JS array.
        const values = columns.map((c) => {
          const value = row[c];
          if (Array.isArray(value) && !NATIVE_ARRAY_COLUMNS.has(c)) return JSON.stringify(value);
          if (value !== null && typeof value === "object" && !Array.isArray(value)) return JSON.stringify(value);
          return value;
        });
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
        const columnList = columns.map((c) => `"${c}"`).join(", ");

        try {
          await client.query(`INSERT INTO "${table}" (${columnList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, values);
          restored++;
        } catch (error) {
          if (process.env.RESTORE_DRILL_DEBUG) console.error(`  [debug] ${table} ${String(row.id ?? "")}:`, (error as Error).message);
          stillFailing.push(row);
        }
      }

      restoredCount.set(table, restored);
      if (stillFailing.length < rows.length) progressed = true;
      if (stillFailing.length === 0) remaining.delete(table);
      else remaining.set(table, stillFailing);
    }
  }

  console.log(`Dump was taken: ${dump.dumpedAt}`);
  for (const [table, rows] of Object.entries(dump.tables)) {
    if (rows.length === 0) continue;
    const restored = restoredCount.get(table) ?? 0;
    const flag = restored === rows.length ? "OK" : "INCOMPLETE";
    console.log(`  ${flag.padEnd(10)} ${table}: ${restored}/${rows.length}`);
  }
  if (remaining.size > 0) {
    console.log(`\n${remaining.size} table(s) still have unrestored rows after a full pass with no further progress:`);
    for (const table of remaining.keys()) console.log(`  - ${table}`);
  }

  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
