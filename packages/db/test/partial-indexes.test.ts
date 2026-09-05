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
