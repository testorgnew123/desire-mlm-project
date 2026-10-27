// migrate-on-deploy.sh decides, on every Netlify build, whether the production
// database is migrated before the app is published. Each branch matters: a wrong
// skip lets a merge outrun the schema (PR 8), a wrong run migrates a database a
// preview must not touch, and a swallowed failure publishes code over a broken
// schema. `pnpm` is replaced by a recorder, so nothing here reaches a database.
//
// After the migration the script runs the role sync (src/sync-roles.ts): add-only,
// retried (a Neon database may still be waking), and a failure fails the build.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/migrate-on-deploy.sh", import.meta.url));
const hasSh = spawnSync("sh", ["-c", "exit 0"]).status === 0;

const UNPOOLED = "postgresql://direct.example/db";
const POOLED = "postgresql://pooler.example/db";

describe.skipIf(!hasSh)("migrate-on-deploy.sh", () => {
  let dir: string;
  let record: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "migrate-on-deploy-"));
    record = join(dir, "pnpm-call.txt");
    const fake = join(dir, "pnpm");
    const recordPath = record.replaceAll("\\", "/");
    const counterPath = join(dir, "sync-calls.txt").replaceAll("\\", "/");
    // Appends one block per call. FAKE_PNPM_EXIT fails every call; FAKE_PNPM_FAIL_FIRST=n
    // fails only the first n calls to the role sync, so a retry can succeed.
    writeFileSync(
      fake,
      [
        "#!/bin/sh",
        `{ echo "args: $*"; echo "DATABASE_URL=\${DATABASE_URL-unset}"; echo "--"; } >> "${recordPath}"`,
        'case "$*" in',
        "  *sync-roles*)",
        `    n=$(cat "${counterPath}" 2>/dev/null || echo 0)`,
        `    echo $((n + 1)) > "${counterPath}"`,
        '    if [ "$n" -lt "${FAKE_PNPM_FAIL_FIRST:-0}" ]; then exit 5; fi',
        "    ;;",
        "esac",
        'exit "${FAKE_PNPM_EXIT:-0}"',
        "",
      ].join("\n"),
    );
    chmodSync(fake, 0o755);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(vars: Record<string, string>) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ["CONTEXT", "DATABASE_URL", "DATABASE_URL_UNPOOLED", "FAKE_PNPM_EXIT", "FAKE_PNPM_FAIL_FIRST"]) {
      delete env[key];
    }
    Object.assign(env, { ROLE_SYNC_RETRY_SLEEP: "0" }, vars, { PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` });
    const result = spawnSync("sh", [SCRIPT], { env, encoding: "utf8" });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      pnpmCall: existsSync(record) ? readFileSync(record, "utf8") : null,
    };
  }

  it("skips a deploy preview and touches nothing", () => {
    const result = run({ CONTEXT: "deploy-preview", DATABASE_URL_UNPOOLED: UNPOOLED });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/not production; skipping/);
    expect(result.pnpmCall).toBeNull();
  });

  it("skips a branch deploy, and a build with no context at all", () => {
    expect(run({ CONTEXT: "branch-deploy", DATABASE_URL_UNPOOLED: UNPOOLED }).pnpmCall).toBeNull();
    const local = run({ DATABASE_URL_UNPOOLED: UNPOOLED });
    expect(local.status).toBe(0);
    expect(local.pnpmCall).toBeNull();
  });

  it("fails a production build that has no unpooled URL, and runs nothing", () => {
    const cases: Record<string, string>[] = [{ CONTEXT: "production" }, { CONTEXT: "production", DATABASE_URL_UNPOOLED: "" }];
    for (const vars of cases) {
      const result = run(vars);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/DATABASE_URL_UNPOOLED is not set/);
      expect(result.pnpmCall).toBeNull();
    }
  });

  it("runs prisma migrate deploy on a production build", () => {
    const result = run({ CONTEXT: "production", DATABASE_URL_UNPOOLED: UNPOOLED });
    expect(result.status).toBe(0);
    expect(result.pnpmCall).toContain("args: --filter @desire/db exec prisma migrate deploy");
  });

  it("names the unpooled URL as DATABASE_URL when there is no pooled one, and keeps a pooled one that exists", () => {
    const without = run({ CONTEXT: "production", DATABASE_URL_UNPOOLED: UNPOOLED });
    expect(without.pnpmCall).toContain(`DATABASE_URL=${UNPOOLED}`);
    const withPooled = run({ CONTEXT: "production", DATABASE_URL_UNPOOLED: UNPOOLED, DATABASE_URL: POOLED });
    expect(withPooled.pnpmCall).toContain(`DATABASE_URL=${POOLED}`);
  });

  it("fails the build when the migration fails, so the code is not published over a broken schema", () => {
    const result = run({ CONTEXT: "production", DATABASE_URL_UNPOOLED: UNPOOLED, FAKE_PNPM_EXIT: "3" });
    expect(result.status).toBe(3);
    // ...and does not go on to sync roles into a database whose schema is not ready.
    expect(result.pnpmCall).not.toContain("sync-roles");
  });

  it("syncs roles after the migration, with the unpooled URL even when a pooled one exists", () => {
    const result = run({ CONTEXT: "production", DATABASE_URL_UNPOOLED: UNPOOLED, DATABASE_URL: POOLED });
    expect(result.status).toBe(0);
    const calls = (result.pnpmCall ?? "").split("--\n").filter((block) => block.trim() !== "");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("prisma migrate deploy");
    expect(calls[1]).toContain("args: --filter @desire/db exec tsx scripts/sync-roles.ts --apply --allow-remote");
    expect(calls[1]).toContain(`DATABASE_URL=${UNPOOLED}`);
  });

  it("tries the role sync again when it fails, and the build passes if a later try works", () => {
    const result = run({ CONTEXT: "production", DATABASE_URL_UNPOOLED: UNPOOLED, FAKE_PNPM_FAIL_FIRST: "2" });
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/trying again \(3 of 3\)/);
    expect((result.pnpmCall ?? "").match(/sync-roles\.ts/g)).toHaveLength(3);
  });

  it("fails the build when the role sync keeps failing, after three tries", () => {
    const result = run({ CONTEXT: "production", DATABASE_URL_UNPOOLED: UNPOOLED, FAKE_PNPM_FAIL_FIRST: "9" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/role sync failed after 3 attempts/);
    expect((result.pnpmCall ?? "").match(/sync-roles\.ts/g)).toHaveLength(3);
  });

  it("runs no role sync on a preview: its Neon branch is synced by the workflow", () => {
    expect(run({ CONTEXT: "deploy-preview", DATABASE_URL_UNPOOLED: UNPOOLED }).pnpmCall).toBeNull();
  });
});
