import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    // Several files each open a real Prisma pool against local Postgres
    // (max_connections=100), and more than one file's 50-way concurrency
    // GATE test overlapping was enough to exhaust it ("Unable to start a
    // transaction in the given time" -- a real flake, not a logic bug,
    // first hit once this project had enough test files to overlap).
    // Running files sequentially keeps each file's own intra-test
    // concurrency (still real, still tested) without stacking multiple
    // files' bursts on top of each other.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      // docs/12-NFR.md targets >=80% for packages/services -- lower than
      // packages/commission's 100% because this package's job is talking to
      // a real database, and exhaustively branch-covering every Prisma error
      // path is not where the risk actually lives (the risk is in the
      // authorization logic, which IS held to a high bar via rbac.test.ts).
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
});
