import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
    // 15 s rather than the 30 s+ that would cut more: this app's own rule is
    // "inventory that is cached is inventory that is wrong"
    // (app/board/[projectId]/page.tsx). The board additionally refreshes on
    // mount so it can never paint stale unit states out of this cache -- the
    // cache window only ever affects how quickly the shell appears there, not
    // what availability the associate is shown.
    staleTimes: { dynamic: 15, static: 180 },
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
