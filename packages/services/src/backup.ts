// Nightly logical backup -- the free-tier substitute for PITR/proper disaster
// recovery, per docs/21-TIER-LIMITS.md section 6. Neon Free gives 6 hours of
// point-in-time restore; the client cannot fund the paid tier that would fix
// that, ever (PROGRESS.md decision log, 2026-09-13), so this is the only DR
// this system has. Not optional once real data exists.
//
// A real `pg_dump` binary is not available in a Netlify Function, so this
// dumps logically instead: every base table in the `public` schema, read via
// plain SQL rather than a hardcoded table list, so it never silently misses a
// table added by a later migration. Written to Netlify Blobs (the store this
// project already committed to for durable, cross-deploy files -- see
// docs/adr/0001-nextjs-netlify-neon.md's amendment), one JSON object per
// night, pruned after 30 days.
import { getStore } from "@netlify/blobs";
import type { PrismaClient } from "@desire/db";

const BACKUP_STORE_NAME = "backups";
const BACKUP_RETENTION_DAYS = 30;

export interface BackupResult {
  key: string;
  tableCount: number;
  totalRows: number;
  prunedCount: number;
}

interface TableNameRow {
  table_name: string;
}

export interface DatabaseDump {
  tables: Record<string, unknown[]>;
  tableCount: number;
  totalRows: number;
}

/** The Postgres half only -- kept separate from the Netlify Blobs write so it
 *  can be tested against real Postgres. There is no local emulation for
 *  Netlify Blobs the way there is a real Docker Postgres for everything else
 *  in this codebase, so the write+prune half is verified live after deploy
 *  instead, the same way an actual Netlify deploy always has been. */
export async function buildDatabaseDump(db: PrismaClient): Promise<DatabaseDump> {
  // information_schema.tables.table_name is Postgres's internal `name` type,
  // which Prisma's raw-query deserializer can't handle directly -- cast to
  // text or every call fails with "Failed to deserialize column of type
  // 'name'", found by actually running this against real Postgres.
  const tableNames = await db.$queryRawUnsafe<TableNameRow[]>(
    `SELECT table_name::text AS table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );

  const tables: Record<string, unknown[]> = {};
  let totalRows = 0;
  for (const { table_name: tableName } of tableNames) {
    const rows = await db.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${tableName}"`);
    tables[tableName] = rows;
    totalRows += rows.length;
  }

  return { tables, tableCount: tableNames.length, totalRows };
}

export async function runNightlyBackup(db: PrismaClient): Promise<BackupResult> {
  const dump = await buildDatabaseDump(db);

  const store = getStore(BACKUP_STORE_NAME);
  const key = `${new Date().toISOString().slice(0, 10)}.json`;
  await store.setJSON(key, { dumpedAt: new Date().toISOString(), tables: dump.tables });

  const prunedCount = await pruneOldBackups(store);

  return { key, tableCount: dump.tableCount, totalRows: dump.totalRows, prunedCount };
}

async function pruneOldBackups(store: ReturnType<typeof getStore>): Promise<number> {
  const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const { blobs } = await store.list();

  let prunedCount = 0;
  for (const blob of blobs) {
    const dumpedAt = Date.parse(blob.key.replace(/\.json$/, ""));
    if (Number.isNaN(dumpedAt) || dumpedAt >= cutoff) continue;
    await store.delete(blob.key);
    prunedCount++;
  }
  return prunedCount;
}
