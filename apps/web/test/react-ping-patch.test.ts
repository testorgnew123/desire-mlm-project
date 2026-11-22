import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// The App Router renders with the React that Next bundles (next/dist/compiled/react-dom),
// not the react-dom in package.json. The one in Next 15.5 (19.2.0-canary-0bdb9206-20250818)
// drops a Suspense "ping" that arrives during the render phase while the root is already
// suspended with delay. A streamed RSC row that lands while React has yielded resolves
// synchronously inside the ping listener's then(), which is exactly that case: the router
// held the new page and React's transition stayed suspended with nothing left to wake it, so
// a navigation or a save sometimes never painted. patches/next@15.5.25.patch backports
// upstream React's fix (record the ping, so the lane is not marked suspended again). pnpm
// refuses to install if the patch stops matching the installed next; this test fails if a
// next upgrade ships a react-dom whose render-phase branch still drops the ping.
const require = createRequire(import.meta.url);
const BUILDS_DIR = join(dirname(require.resolve("next/package.json")), "dist/compiled/react-dom/cjs");

const BUILDS = [
  "react-dom-client.production.js",
  "react-dom-client.development.js",
  "react-dom-profiling.profiling.js",
  "react-dom-profiling.development.js",
];

function pingSuspendedRoot(file: string): string {
  const source = readFileSync(join(BUILDS_DIR, file), "utf8");
  const start = source.indexOf("function pingSuspendedRoot(");
  expect(start, `${file} has no pingSuspendedRoot`).toBeGreaterThan(-1);
  const end = source.indexOf("function ", start + "function ".length);
  return source.slice(start, end);
}

describe("the React that Next bundles keeps a ping that lands during the render phase", () => {
  it.each(BUILDS)("%s", (file) => {
    const body = pingSuspendedRoot(file);
    // The dropped-ping shape: restart outside the render phase, do nothing inside it.
    expect(body).not.toMatch(/&&\s*prepareFreshStack\(root, 0\)/);
    // Recorded on both paths: the render-phase one and the "cannot restart" one.
    expect(body.match(/workInProgressRootPingedLanes \|= pingedLanes/g)).toHaveLength(2);
  });
});
