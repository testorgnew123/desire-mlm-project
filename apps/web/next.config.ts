import type { NextConfig } from "next";
import { disabledRewrites } from "./lib/features";

const nextConfig: NextConfig = {
  // Every page and API prefix of a switched-off feature (lib/features.ts) is
  // rewritten to a 404 before the filesystem is consulted. A rewrite rather than
  // middleware: it needs no edge function, costs enabled paths nothing, and
  // still catches typed URLs, prefetches and server-action POSTs.
  async rewrites() {
    return { beforeFiles: disabledRewrites(), afterFiles: [], fallback: [] };
  },

  // packages/db and packages/services are workspace SOURCE packages -- their
  // package.json main points at .ts, so Next has to transpile them.
  transpilePackages: ["@desire/services", "@desire/db"],

  experimental: {
    // Client-side router cache. Next 15 defaults dynamic routes to 0, so every
    // back/forward re-fetched the whole RSC payload from Ohio -- measured at
    // 378-518 ms per navigation (and 64 KB for /dashboard). 15 s makes repeat
    // navigation instant, and also cuts function invocations, which are the
    // binding free-tier constraint (125k/month, docs/21-TIER-LIMITS.md §1).
    //
    // Raised 15 s -> 60 s. The client reported that moving between screens
    // after login feels slow, and measuring production said why: a static
    // asset off the Cloudflare edge is 4 ms, but /api/health -- a function
    // plus one SELECT 1 -- is 398 ms. That ~394 ms is the India->Ohio round
    // trip, paid before this app does any work at all (its own work is only
    // 84-257 ms, which is why all eleven sections land within 408-623 ms).
    // The function region is Pro-gated, so no free change moves it.
    //
    // The only way to make a click fast is therefore to not make the request.
    // A cache hit costs 0 ms; 60 s covers realistic "click around the sidebar"
    // behaviour where 15 s did not.
    //
    // The original 15 s existed because of this app's rule that "inventory
    // that is cached is inventory that is wrong". That rule still holds and is
    // still enforced -- but by freshness guards at the screens that need them,
    // not by starving the whole app's cache:
    //   - the board refreshes on mount when its snapshot is > 5 s old
    //     (app/board/[projectId]/InventoryBoard.tsx)
    //   - receipt verification, discount approvals and holds use
    //     <RefreshIfStale> for the same reason -- they are the screens where
    //     two people can act on the same row
    // Everything else is a read that tolerates a minute.
    staleTimes: { dynamic: 60, static: 180 },
  },

  // Prisma's engineType="client" build carries a WASM query compiler. Bundling
  // it produces "Module parse failed: Unexpected character" at request time --
  // a 500 on every route touching the database. Typecheck and lint pass
  // straight through it, because neither parses the binary; only building or
  // actually running the app surfaces it.
  //
  // @node-rs/argon2 also needs to be here, but listing it was NOT sufficient
  // on its own (confirmed live via `netlify logs`: "Cannot find module
  // '@node-rs/argon2'" on every /login request, even after adding this
  // entry). Root cause: apps/web never had @node-rs/argon2 as its own
  // package.json dependency -- it only reached apps/web transitively via
  // packages/services/packages/db. transpilePackages (above) makes Next
  // inline their .ts *source*, but under pnpm's strict linking that does
  // nothing for a native dependency's actual on-disk resolution: nothing
  // under apps/web/node_modules pointed at @node-rs/argon2, so neither
  // Node's runtime require() nor Next's file tracer could resolve it from
  // the compiled apps/web/.next/server/... output, no matter what's listed
  // here. Fixed by adding @node-rs/argon2 directly to apps/web/package.json
  // (matching the same "each package that needs it declares it" pattern
  // already used for packages/db) -- once pnpm symlinks it into
  // apps/web/node_modules, both resolution and tracing work, platform
  // binary included, with nothing extra needed here.
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg", "@node-rs/argon2"],

  // pdfkit (a dependency of @react-pdf/renderer, used by the commission
  // statement route) resolves its built-in fonts via a dynamic require
  // keyed by font name (js/standard-fonts/Helvetica.cjs etc.) -- Next's
  // output file tracing only follows static imports, so those font files
  // were silently missing from the deployed Lambda. That crashed the
  // shared server-handler function outright (MODULE_NOT_FOUND, unhandled
  // promise rejection) on every route, not just the statement one, since
  // Netlify bundles the whole app into one function. Confirmed via
  // `netlify logs --source functions` against the live deploy.
  outputFileTracingIncludes: {
    "/api/**/*": ["../../node_modules/.pnpm/pdfkit@*/node_modules/pdfkit/js/standard-fonts/**/*"],
  },

  // serverExternalPackages alone does not stop webpack from opening
  // @node-rs/argon2/index.js and its platform-specific sibling package
  // (confirmed by testing both a Server Action and a plain Route Handler
  // that import packages/services/src/password.ts) -- combined with
  // transpilePackages above, Next still traces into @node-rs/argon2's own
  // requires rather than treating the bare specifier as external. A
  // webpack-level function external, matched on the request string, is the
  // documented fallback when serverExternalPackages doesn't take effect.
  webpack(config, { isServer }) {
    if (isServer) {
      const originalExternals = Array.isArray(config.externals) ? config.externals : [];
      config.externals = [
        ...originalExternals,
        ({ request }: { request?: string }, callback: (err?: null, result?: string) => void) => {
          if (request && request.startsWith("@node-rs/argon2")) {
            return callback(null, `commonjs ${request}`);
          }
          // Prisma's engineType="client" ships its query compiler as a 2.5 MB
          // base64 string in an .mjs file, loaded by the generated client via
          // `await import("@prisma/client/runtime/...")`. Listing
          // @prisma/client in serverExternalPackages above does NOT keep it
          // out of the bundle here, because transpilePackages includes
          // @desire/db (whose main is TypeScript source), so the generated
          // client enters webpack's graph and its dynamic import gets inlined
          // with it. Measured: the same 2 539 KB blob was emitted as TWO
          // chunks -- one on 97 of 98 routes, a second on 34 more (the
          // back-office pages, which pull it through a second layer via their
          // server actions). /dashboard traced both: 5.08 MB of its 7.62 MB.
          //
          // `import` (not `commonjs`) because these are real ESM files loaded
          // through dynamic import -- requiring an .mjs would throw at
          // runtime. Node then loads the file from node_modules once, instead
          // of every route carrying its own base64 copy to decode on cold start.
          if (request && request.startsWith("@prisma/client/runtime/")) {
            return callback(null, `import ${request}`);
          }
          callback();
        },
      ];
    }
    return config;
  },
};

export default nextConfig;
