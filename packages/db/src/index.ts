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
    cachedAdapter = new PrismaPg({ connectionString });
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
