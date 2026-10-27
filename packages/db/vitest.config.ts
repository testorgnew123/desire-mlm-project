import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    // narrow-roles and sync-roles both rewrite the GLOBAL permissions table
    // (they delete or create `user.manage`), so their files must not overlap.
    fileParallelism: false,
  },
});
