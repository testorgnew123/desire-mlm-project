import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The same "@/" alias tsconfig.json declares, for the route handlers that use it.
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // @netlify/blobs is a dependency of packages/services, not of this app, so a
      // vi.mock() from here would not match the copy the services import. An alias
      // applies to every import vite resolves, whichever package makes it.
      "@netlify/blobs": fileURLToPath(new URL("./test/stubs/netlify-blobs.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    // Route-handler tests share one real Postgres (see test/support.ts); running
    // files one at a time keeps each file's own concurrency tests from stacking.
    fileParallelism: false,
  },
});
