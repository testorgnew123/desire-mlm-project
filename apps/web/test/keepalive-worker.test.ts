import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// The keep-warm Worker lives outside the app (infra/keepalive-worker) and is deployed to
// Cloudflare by hand, so nothing else would notice if its schedule drifted. It did: the
// weekdays were written as 1-5, which Cloudflare reads as Sunday-Thursday. These tests
// read the real wrangler.toml and the real Worker, so a change to either is checked here,
// in CI, rather than found out on a Friday morning.
const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../infra/keepalive-worker");
// CRLF on a Windows checkout, LF elsewhere: read it as LF either way.
const toml = readFileSync(resolve(WORKER_DIR, "wrangler.toml"), "utf8").replace(/\r\n/g, "\n");

// ── The schedule ───────────────────────────────────────────────────────────

/** Cloudflare numbers the days 1 = Sunday to 7 = Saturday (most cron systems: 0 = Sunday). */
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const IST_OFFSET_MS = 330 * 60_000;

function expand(field: string, min: number, max: number, names?: readonly string[]): Set<number> {
  const value = (token: string): number => {
    const named = names?.indexOf(token.toLowerCase()) ?? -1;
    if (named !== -1) return named + 1;
    const number = Number(token);
    if (!Number.isInteger(number)) throw new Error(`cannot read the cron value "${token}"`);
    return number;
  };
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    let low: number;
    let high: number;
    if (range === "*") {
      low = min;
      high = max;
    } else if (range.includes("-")) {
      const [from = "", to = ""] = range.split("-");
      low = value(from);
      high = value(to);
    } else {
      low = value(range);
      high = stepText === undefined ? low : max;
    }
    for (let v = low; v <= high; v += step) out.add(v);
  }
  return out;
}

/** Every minute (as epoch ms) in the week of Monday 2026-11-16 UTC at which `cron` fires. */
function firings(cron: string): number[] {
  const [minute, hour, dayOfMonth, month, weekday] = cron.trim().split(/\s+/);
  if (dayOfMonth !== "*" || month !== "*") throw new Error("this check reads only schedules that leave day-of-month and month as *");
  const minutes = expand(minute!, 0, 59);
  const hours = expand(hour!, 0, 23);
  const days = expand(weekday!, 1, 7, DAY_NAMES);
  const start = Date.UTC(2026, 10, 16);
  const out: number[] = [];
  for (let t = start; t < start + 7 * 86_400_000; t += 60_000) {
    const at = new Date(t);
    if (minutes.has(at.getUTCMinutes()) && hours.has(at.getUTCHours()) && days.has(at.getUTCDay() + 1)) out.push(t);
  }
  return out;
}

const ist = (t: number) => new Date(t + IST_OFFSET_MS);
const istWeekdays = (times: number[]) => [...new Set(times.map((t) => ist(t).getUTCDay()))].sort();

describe("the keep-warm schedule", () => {
  const crons = [...toml.matchAll(/^crons\s*=\s*\[([^\]]*)\]/gm)].flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((s) => s[1]!));

  it("has exactly one cron trigger", () => {
    expect(crons).toHaveLength(1);
  });

  it("fires on Monday to Friday, Indian time, and on no other day", () => {
    expect(istWeekdays(firings(crons[0]!))).toEqual([1, 2, 3, 4, 5]);
  });

  it("fires only between 09:30 and 19:29 Indian time", () => {
    for (const t of firings(crons[0]!)) {
      const minuteOfDay = ist(t).getUTCHours() * 60 + ist(t).getUTCMinutes();
      expect(minuteOfDay).toBeGreaterThanOrEqual(9 * 60 + 30);
      expect(minuteOfDay).toBeLessThanOrEqual(19 * 60 + 29);
    }
  });

  it("fires 150 times on each of those days, never 5 minutes apart (Neon sleeps at 5)", () => {
    const byDay = new Map<number, number[]>();
    for (const t of firings(crons[0]!)) {
      const day = ist(t).getUTCDay();
      byDay.set(day, [...(byDay.get(day) ?? []), t]);
    }
    for (const times of byDay.values()) {
      expect(times).toHaveLength(150);
      for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeLessThanOrEqual(4 * 60_000);
    }
  });

  it("is why the schedule names its days: the numeric range 1-5 is Sunday to Thursday", () => {
    expect(istWeekdays(firings("*/4 4-13 * * 1-5"))).toEqual([0, 1, 2, 3, 4]);
  });

  it("keeps each run's log line (Workers Logs is on)", () => {
    expect(toml).toMatch(/^\[observability\]\s*\n(?:#.*\n)*enabled\s*=\s*true/m);
  });
});

// ── The Worker ─────────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;
type Worker = {
  scheduled(event: unknown, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void>;
};

const HEALTH_URL = "https://crm.example.test/api/health";

async function runWorker(env: Env, fetchImpl: typeof fetch): Promise<void> {
  vi.stubGlobal("fetch", fetchImpl);
  const mod = (await import(/* @vite-ignore */ pathToFileURL(resolve(WORKER_DIR, "src/index.js")).href)) as { default: Worker };
  const pending: Promise<unknown>[] = [];
  await mod.default.scheduled({}, env, { waitUntil: (promise) => void pending.push(promise) });
  await Promise.all(pending);
}

const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("the keep-warm Worker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("pings the health URL without caching and logs one warm line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = answer({ status: "ok", durationMs: 3 });

    await runWorker({ HEALTH_URL }, fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
    expect(url).toBe(HEALTH_URL);
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ ok: true, status: 200, dbDurationMs: 3, state: "warm" });
  });

  it("says when the database was asleep", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runWorker({ HEALTH_URL }, answer({ status: "ok", durationMs: 4890 }) as unknown as typeof fetch);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ state: "neon-asleep", dbDurationMs: 4890 });
  });

  it("says when only the function was cold", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(2_700);
    await runWorker({ HEALTH_URL }, answer({ status: "ok", durationMs: 4 }) as unknown as typeof fetch);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ state: "function-cold", elapsedMs: 1_700 });
  });

  it("logs an error answer at the error level", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runWorker({ HEALTH_URL }, answer({ status: "down" }, 503) as unknown as typeof fetch);
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(error.mock.calls[0]![0] as string)).toMatchObject({ ok: false, status: 503, state: "error" });
  });

  it("logs, and does not throw, when the ping cannot be made", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refused = vi.fn(async () => {
      throw new Error("connection refused");
    });
    await expect(runWorker({ HEALTH_URL }, refused as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(JSON.parse(error.mock.calls[0]![0] as string)).toMatchObject({ ok: false, state: "error", error: "connection refused" });
  });

  it("does nothing, loudly, without a HEALTH_URL", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = answer({});
    await runWorker({}, fetchMock as unknown as typeof fetch);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(String(error.mock.calls[0]![0])).toContain("HEALTH_URL");
  });
});
