// Thin, deliberately. Every consumer imports the Prisma client through here so
// there is exactly one place that configures it — logging, the connection
// adapter, and (later) any query middleware.
//
// engineType="client" (see prisma/schema.prisma) generates no native query
// engine binary, so PrismaClient needs a driver adapter to actually talk to
// Postgres. @prisma/adapter-pg (generic node-postgres) rather than
// @prisma/adapter-neon deliberately -- the Neon-specific adapter uses Neon's
// HTTP/WebSocket transport, which only works against Neon itself and would
// break every local Docker Postgres test in this project plus CI's ephemeral
// Postgres container. adapter-pg speaks plain Postgres wire protocol, so the
// identical code path works against local, CI, and hosted Neon.
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

let cachedAdapter: PrismaPg | undefined;

function getAdapter(): PrismaPg {
  if (!cachedAdapter) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set.");
    }
    // Pool options set explicitly; pg's defaults are not built for
    // serverless. max is small on purpose -- a serverless container serves
    // one request at a time and the widest Promise.all burst in this
    // codebase is ~4 queries, so a bigger pool only buys simultaneous
    // handshakes on a cold start. connectionTimeoutMillis is set because
    // pg's default of 0 means a stalled connect hangs until the whole
    // function times out, with no error worth reading.
    //
    // idleTimeoutMillis is raised off pg's 10s default (a warm container
    // idle just over ten seconds would otherwise drop its socket and
    // re-handshake) but deliberately NOT set to 0/never: with the database
    // now colocated in us-east-2 a handshake is single-digit ms, so
    // "never reap" buys almost nothing, while holding sockets open forever
    // is a real liability in any long-lived process (it destabilised the
    // 38-file test suite when tried).
    cachedAdapter = new PrismaPg({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return cachedAdapter;
}

/** Singleton client. Next.js hot-reloads modules in dev, which would otherwise
 *  open a new connection pool on every edit — stash it globally to avoid that. */
export function getPrismaClient(): PrismaClient {
  const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

  if (!globalForPrisma.__prisma) {
    globalForPrisma.__prisma = new PrismaClient({
      adapter: getAdapter(),
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
  }
  return globalForPrisma.__prisma;
}

export * from "./generated/prisma/client";
export * from "./permission-matrix";
