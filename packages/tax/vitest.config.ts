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
    },
  },
});
