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
  // The matching problem for @node-rs/argon2 is NOT solved here: listing it
  // had no effect, because its index.js requires a PLATFORM-SPECIFIC sibling
  // (@node-rs/argon2-win32-x64-msvc locally, -linux-x64-gnu on Netlify) that
  // is a different request string. That one is solved structurally instead --
  // password hashing lives in packages/services/src/password.ts, which nothing
  // on a request path imports. See the note at the top of that file.
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
};

export default nextConfig;
