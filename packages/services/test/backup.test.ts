// buildDatabaseDump scans the WHOLE database (a real nightly run would too),
// so -- same discipline as invariant-monitor.test.ts -- these tests never
// assert exact counts. Other test files' fixtures can be live at the same
// time under Vitest's parallel file execution. Instead: assert our own
// known row appears in the right table.
//
// The Netlify Blobs write in runNightlyBackup is not covered here -- there is
// no local emulation for Blobs the way there is a real Docker Postgres for
// everything else, so that half is verified live after deploy instead.
import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { getPrismaClient } from "@desire/db";
import { buildDatabaseDump } from "../src/backup";

const db = getPrismaClient();
const ORG = "org_test_backup";

async function reset() {
  await db.organization.deleteMany({ where: { id: ORG } });
}

afterAll(reset);

describe("buildDatabaseDump", () => {
  it("discovers tables via information_schema, not a hardcoded list, and includes real rows", async () => {
    await reset();
    await db.organization.create({
      data: { id: ORG, name: "Backup Test Org", legalName: "Backup Test Org Pvt Ltd" },
    });

    const dump = await buildDatabaseDump(db);

    // A handful of real tables must be present -- proves the introspection
    // query actually found tables, not just returned an empty result.
    expect(dump.tableCount).toBeGreaterThan(10);
    expect(Object.keys(dump.tables)).toEqual(expect.arrayContaining(["organizations", "associates", "payout_batches"]));

    const orgRows = dump.tables["organizations"] as Array<{ id: string; name: string }>;
    expect(orgRows.some((row) => row.id === ORG && row.name === "Backup Test Org")).toBe(true);

    expect(dump.totalRows).toBeGreaterThanOrEqual(orgRows.length);
  });

  it("never includes a bigint value JSON.stringify would choke on", async () => {
    const dump = await buildDatabaseDump(db);
    // Every value must survive a real JSON round-trip -- this is exactly
    // what runNightlyBackup does before writing to Blobs, and BigInt throws
    // on JSON.stringify with no schema check to catch it ahead of time.
    expect(() => JSON.stringify(dump.tables)).not.toThrow();
  });
});
