// Thin, deliberately. Every consumer imports the Prisma client through here so
// there is exactly one place that configures it — logging, the pooled vs.
// unpooled connection choice, and (later) any query middleware.
import { PrismaClient } from "@prisma/client";

/** Singleton client. Next.js hot-reloads modules in dev, which would otherwise
 *  open a new connection pool on every edit — stash it globally to avoid that. */
export function getPrismaClient(): PrismaClient {
  const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

  if (!globalForPrisma.__prisma) {
    globalForPrisma.__prisma = new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
  }
  return globalForPrisma.__prisma;
}

export * from "@prisma/client";
export * from "./permission-matrix";
