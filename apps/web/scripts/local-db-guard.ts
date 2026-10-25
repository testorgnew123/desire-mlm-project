// Refuses to run against anything but a local Postgres.
//
// apps/web/.env.local points at the hosted Neon database, and `next build` /
// `next start` load it. A seed or load run that picks it up by accident writes
// into production. These scripts (and the web test setup) call this first, so a
// wrong environment fails loudly before the first query instead of silently
// after the thousandth.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function assertLocalDatabase(env: NodeJS.ProcessEnv = process.env): void {
  const primary = env.DATABASE_URL;
  if (!primary) {
    throw new Error("DATABASE_URL is not set. Export it explicitly, pointing at the local Docker Postgres.");
  }

  for (const [name, value] of [
    ["DATABASE_URL", primary],
    ["DATABASE_URL_UNPOOLED", env.DATABASE_URL_UNPOOLED],
  ] as const) {
    if (!value) continue;
    let host: string;
    try {
      host = new URL(value).hostname;
    } catch {
      throw new Error(`${name} is not a valid URL.`);
    }
    if (!LOCAL_HOSTS.has(host)) {
      throw new Error(`${name} points at "${host}", which is not a local database. Refusing to run.`);
    }
  }
}
