// GATE (docs/02-ARCHITECTURE.md, PROGRESS.md Phase 0): three partial unique
// indexes cannot be expressed in schema.prisma and must be added by hand in a
// migration. This test is the backstop -- if a future migration or a
// `prisma db push` ever drops one, the suite fails instead of production
// silently allowing a double-hold or a duplicate role grant.
//
// Requires Docker Postgres running: `docker compose up -d` from the repo root,
// then `pnpm db:migrate` to apply migrations before running this test.
import "dotenv/config";
import { describe, it, expect, afterAll } from "vitest";
import { getPrismaClient } from "../src/index";

const prisma = getPrismaClient();

const REQUIRED_INDEXES = [
  "one_active_hold_per_unit",
  "user_role_org_wide",
  "user_role_scoped",
] as const;

describe("hand-written partial unique indexes", () => {
  it.each(REQUIRED_INDEXES)("%s exists", async (indexName) => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE indexname = ${indexName}
    `;
    expect(rows, `Missing index: ${indexName}`).toHaveLength(1);
    expect(rows[0]?.indexdef).toMatch(/UNIQUE/i);
    expect(rows[0]?.indexdef).toMatch(/WHERE/i);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
});

// Same backstop, different reason: this one is not about correctness but about
// the index being USABLE at all. A plain btree on `path` cannot serve
// `LIKE 'prefix%'` under this database's en_US.utf8 collation -- the planner
// silently falls back to filtering every row, which is what it did before
// 20260920185000 replaced it with a text_pattern_ops index. If someone
// "tidies" this back into a normal @@index([path]) in schema.prisma, the
// downline queries keep working and only get quietly slower, so a plain
// existence check is not enough -- assert the operator class too.
describe("hand-written text_pattern_ops index", () => {
  it("associate_hierarchy_path_prefix exists AND uses text_pattern_ops", async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'associate_hierarchy_path_prefix'
    `;
    expect(rows, "Missing index: associate_hierarchy_path_prefix").toHaveLength(1);
    expect(rows[0]?.indexdef).toMatch(/text_pattern_ops/i);
  });

  it("is actually chosen by the planner for a downline prefix scan", async () => {
    // enable_seqscan off so table size (tiny in test) cannot decide this for
    // us -- we want to know the index is CAPABLE of serving the predicate.
    await prisma.$executeRawUnsafe("SET enable_seqscan = off");
    const plan = await prisma.$queryRawUnsafe<Array<Record<string, string>>>(
      `EXPLAIN SELECT * FROM associate_hierarchy WHERE path LIKE 'A/B/%'`,
    );
    const text = plan.map((row) => Object.values(row)[0]).join("\n");
    expect(text, `planner did not use the prefix index:\n${text}`).toContain(
      "associate_hierarchy_path_prefix",
    );
    // An Index Cond is a real range scan; a Filter means it read every row.
    expect(text).toMatch(/Index Cond/);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
});
