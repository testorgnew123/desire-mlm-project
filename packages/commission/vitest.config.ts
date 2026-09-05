import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts", // re-exports only, nothing to branch-cover
        "src/types.ts", // type/interface declarations only -- zero executable statements
      ],
      // GATE (docs/04-COMMISSION-SPEC.md section 8, PROGRESS.md Phase 3):
      // 100% branch coverage on the commission engine is non-negotiable --
      // every uncovered branch here is a payout nobody has verified.
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
