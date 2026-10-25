import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FEATURES,
  classifyPath,
  disabledApiPrefixes,
  disabledPagePrefixes,
  disabledRewrites,
  isFeatureEnabled,
  prefixCovers,
  type FeatureKey,
  type FeatureMap,
} from "../lib/features";
import { BACK_OFFICE_NAV, PWA_NAV, filterNav } from "../lib/nav";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "app");

/** Every page and route handler under app/, as the URL path it serves. Route
 *  groups "(x)" vanish, "[id]" becomes ":id". */
function discoverRoutes(dir: string = APP_DIR): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith("_")) found.push(...discoverRoutes(full));
      continue;
    }
    if (!/^(page|route)\.tsx?$/.test(entry.name)) continue;

    const segments = relative(APP_DIR, dirname(full))
      .split(sep)
      .filter((segment) => segment !== "" && !(segment.startsWith("(") && segment.endsWith(")")))
      .map((segment) => (segment.startsWith("[") ? `:${segment.slice(1, -1)}` : segment));
    found.push(`/${segments.join("/")}`);
  }
  return found;
}

const ROUTES = discoverRoutes();

function isRewritten(pathname: string, features: FeatureMap = FEATURES): boolean {
  return [...disabledPagePrefixes(features), ...disabledApiPrefixes(features)].some((prefix) =>
    prefixCovers(prefix, pathname),
  );
}

describe("feature registry", () => {
  it("finds the routes it is meant to classify", () => {
    expect(ROUTES.length).toBeGreaterThan(50);
    expect(ROUTES).toContain("/projects/:projectId");
    expect(ROUTES).toContain("/api/v1/bookings");
  });

  it("classifies every page and route handler under app/", () => {
    const unclassified = ROUTES.filter((route) => classifyPath(route) === "unclassified");
    expect(unclassified).toEqual([]);
  });

  it("agrees with the rewrites: a path is disabled exactly when a rewrite would catch it", () => {
    const disagreements = ROUTES.filter((route) => isRewritten(route) !== (classifyPath(route) === "disabled"));
    expect(disagreements).toEqual([]);
  });

  it("never nests an enabled prefix inside a disabled one", () => {
    const disabled = [...disabledPagePrefixes(), ...disabledApiPrefixes()];
    const enabled = Object.values(FEATURES)
      .filter((feature) => feature.enabled)
      .flatMap((feature) => [...feature.pages, ...feature.api]);
    for (const prefix of enabled) {
      expect(disabled.filter((d) => prefixCovers(d, prefix)), prefix).toEqual([]);
    }
  });

  it("keeps the product to plots, booking and user admin", () => {
    const on = (Object.keys(FEATURES) as FeatureKey[]).filter((key) => isFeatureEnabled(key)).sort();
    expect(on).toEqual(["adminUsers", "bookings", "inventory", "jobs", "projects"]);
  });

  it.each([
    ["/", "enabled"],
    ["/login", "enabled"],
    ["/login/forgot", "enabled"],
    ["/api/health", "enabled"],
    ["/projects", "enabled"],
    ["/projects/abc", "enabled"],
    ["/stock", "enabled"],
    ["/board/abc", "enabled"],
    ["/inventory/abc/def/book", "enabled"],
    ["/bookings", "enabled"],
    ["/my-bookings", "enabled"],
    ["/admin/users", "enabled"],
    ["/api/v1/projects/p1/units/u1/holds", "enabled"],
    ["/api/v1/bookings", "enabled"],
    ["/api/v1/bookings/b1/confirm", "enabled"],
    ["/api/v1/bookings/b1/cancel", "enabled"],
    ["/api/jobs/holds/expire", "enabled"],
    ["/api/jobs/backup/dump", "enabled"],
    ["/dashboard", "disabled"],
    ["/home", "disabled"],
    ["/crm/123", "disabled"],
    ["/leads", "disabled"],
    ["/collections/receipts", "disabled"],
    ["/network/associates/a1", "disabled"],
    ["/team", "disabled"],
    ["/commission", "disabled"],
    ["/earnings/e1/explain", "disabled"],
    ["/payouts/batches/b1", "disabled"],
    ["/reports", "disabled"],
    ["/bookings/discount-approvals", "disabled"],
    ["/stock/holds", "disabled"],
    ["/stock/blocked", "disabled"],
    ["/stock/statement", "disabled"],
    ["/admin/audit-log", "disabled"],
    ["/admin/notification-rules", "disabled"],
    ["/api/v1/leads/l1/activities", "disabled"],
    ["/api/v1/receipts/r1/verify", "disabled"],
    ["/api/v1/bookings/b1/demands", "disabled"],
    ["/api/v1/bookings/b1/discount-requests", "disabled"],
    ["/api/v1/bookings/b1/cancellation-preview", "disabled"],
    ["/api/v1/associates/a1/move", "disabled"],
    ["/api/v1/payouts/batches", "disabled"],
    ["/api/jobs/collections/sweep", "disabled"],
    ["/api/jobs/monitor/invariants", "disabled"],
    ["/api/jobs/reports/send-scheduled", "disabled"],
    ["/somewhere/nobody/declared", "unclassified"],
  ])("%s is %s", (path, expected) => {
    expect(classifyPath(path)).toBe(expected);
  });

  it("turns an ambiguous declaration into a closed door", () => {
    const features = {
      a: { enabled: true, pages: ["/x"], api: [] },
      b: { enabled: false, pages: ["/x"], api: [] },
    } as unknown as FeatureMap;
    expect(classifyPath("/x", features)).toBe("disabled");
  });

  it("generates one rewrite per disabled prefix, to one of two destinations", () => {
    const rewrites = disabledRewrites();
    expect(rewrites).toHaveLength(disabledPagePrefixes().length + disabledApiPrefixes().length);
    for (const rewrite of rewrites) {
      expect(rewrite.source.endsWith("/:path*")).toBe(true);
      expect(["/feature-disabled", "/api/disabled"]).toContain(rewrite.destination);
    }
    expect(rewrites.filter((r) => r.destination === "/api/disabled").every((r) => r.source.startsWith("/api/"))).toBe(
      true,
    );
  });

  it("rewrites nothing for an enabled feature", () => {
    const everythingOn = Object.fromEntries(
      Object.entries(FEATURES).map(([key, feature]) => [key, { ...feature, enabled: true }]),
    ) as FeatureMap;
    expect(disabledRewrites(everythingOn)).toEqual([]);
  });
});

describe("navigation", () => {
  const everything: ReadonlySet<string> = new Set([
    "project.read",
    "unit.read",
    "lead.read",
    "booking.read",
    "demand.raise",
    "associate.read",
    "commission.read",
    "payout.prepare",
    "report.read",
    "rbac.manage",
    "audit.read",
    "lead.reassign",
  ]);

  it("shows only what is switched on, even to someone who holds every permission", () => {
    expect(filterNav(BACK_OFFICE_NAV, everything).map((item) => item.key)).toEqual([
      "projects",
      "inventory",
      "bookings",
      "admin",
    ]);
    expect(filterNav(PWA_NAV, everything).map((item) => item.key)).toEqual(["inventory", "my-bookings"]);
  });

  it("brings a section back when its feature is switched on", () => {
    const crmOn = (key: FeatureKey) => key === "crm" || isFeatureEnabled(key);
    expect(filterNav(BACK_OFFICE_NAV, everything, crmOn).map((item) => item.key)).toContain("crm");
  });

  it("shows an ADMIN (user.manage, no rbac.manage) the Admin section", () => {
    const admin = new Set(["project.read", "unit.read", "booking.read", "user.manage"]);
    expect(filterNav(BACK_OFFICE_NAV, admin).map((item) => item.key)).toEqual(["projects", "inventory", "bookings", "admin"]);
  });

  it("gives an ASSOCIATE the phone shell's two tabs and no Admin", () => {
    const associate = new Set(["project.read", "unit.read", "hold.create", "booking.read", "booking.create"]);
    expect(filterNav(PWA_NAV, associate).map((item) => item.key)).toEqual(["inventory", "my-bookings"]);
    expect(filterNav(BACK_OFFICE_NAV, associate).map((item) => item.key)).not.toContain("admin");
  });

  it("still applies permissions to a section that is on", () => {
    expect(filterNav(BACK_OFFICE_NAV, new Set(["project.read"])).map((item) => item.key)).toEqual(["projects"]);
  });

  it("points every entry at a path on the same side of the switch as its feature", () => {
    for (const item of [...BACK_OFFICE_NAV, ...PWA_NAV]) {
      expect(classifyPath(item.href), `${item.key} -> ${item.href}`).toBe(
        isFeatureEnabled(item.feature) ? "enabled" : "disabled",
      );
    }
  });
});
