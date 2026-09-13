import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // packages/db and packages/services are workspace SOURCE packages -- their
  // package.json main points at .ts, so Next has to transpile them.
  transpilePackages: ["@desire/services", "@desire/db"],

  // Prisma's engineType="client" build carries a WASM query compiler. Bundling
  // it produces "Module parse failed: Unexpected character" at request time --
  // a 500 on every route touching the database. Typecheck and lint pass
  // straight through it, because neither parses the binary; only building or
  // actually running the app surfaces it.
  //
  // @node-rs/argon2 itself being listed was not enough on its own -- its
  // index.js requires a PLATFORM-SPECIFIC sibling package (a different
  // require() request string), so that sibling has to be externalized too:
  // -win32-x64-msvc locally, -linux-x64-gnu on Netlify. Needed now that
  // Phase 3.5's login flow (apps/web/app/login/actions.ts) is the first
  // request-path code to import packages/services/src/password.ts.
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],

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
          callback();
        },
      ];
    }
    return config;
  },
};

export default nextConfig;
