// The one place that says which parts of the product are switched on.
//
// "Switched off" means unreachable, not deleted: flip `enabled` and redeploy and
// the feature is back, with its code, tables and tests untouched. Three things
// read this file:
//   - next.config.ts turns every disabled prefix into a rewrite -- a 404 page for
//     pages, a 404 problem+json for API and job routes -- so a typed URL, a
//     prefetch and a server-action POST are all refused by the router itself.
//   - nav.ts hides the sidebar / tab entry.
//   - a page that embeds another feature's section can ask isFeatureEnabled().
//
// Permissions still decide WHO may use a feature that is on; this decides
// WHETHER it exists. This file must stay free of imports (next.config.ts loads it).

export type FeatureKey =
  | "projects"
  | "inventory"
  | "bookings"
  | "adminUsers"
  | "jobs"
  | "dashboard"
  | "crm"
  | "collections"
  | "network"
  | "commission"
  | "payouts"
  | "reports"
  | "discounts"
  | "notifications"
  | "auditLog"
  | "stockReports"
  | "monitoring";

interface FeatureDefinition {
  enabled: boolean;
  /** Page path prefixes. A prefix covers itself and everything beneath it. */
  pages: readonly string[];
  /** API and job path prefixes, same rule. `:name` matches any one segment. */
  api: readonly string[];
}

export type FeatureMap = Record<FeatureKey, FeatureDefinition>;

export const FEATURES: FeatureMap = {
  // ── On: plotted projects, booking a plot, managing users ────────────────
  projects: { enabled: true, pages: ["/projects"], api: [] },
  // Holds are part of inventory: the hold route lives under /api/v1/projects.
  inventory: { enabled: true, pages: ["/stock", "/board", "/inventory"], api: ["/api/v1/projects"] },
  bookings: { enabled: true, pages: ["/bookings", "/my-bookings"], api: ["/api/v1/bookings"] },
  adminUsers: { enabled: true, pages: ["/admin"], api: [] },
  jobs: { enabled: true, pages: [], api: ["/api/jobs/holds", "/api/jobs/backup"] },

  // ── Off ─────────────────────────────────────────────────────────────────
  dashboard: { enabled: false, pages: ["/dashboard", "/home"], api: [] },
  crm: { enabled: false, pages: ["/crm", "/leads"], api: ["/api/v1/leads", "/api/v1/webhooks"] },
  collections: {
    enabled: false,
    pages: ["/collections"],
    api: [
      "/api/v1/collections",
      "/api/v1/demands",
      "/api/v1/receipts",
      "/api/v1/bookings/:bookingId/demands",
      "/api/jobs/collections",
    ],
  },
  network: {
    enabled: false,
    pages: ["/network", "/team"],
    api: ["/api/v1/associates", "/api/v1/grades", "/api/jobs/grades"],
  },
  commission: {
    enabled: false,
    pages: ["/commission", "/earnings"],
    api: ["/api/v1/commission", "/api/v1/schemes", "/api/v1/bookings/:bookingId/cancellation-preview"],
  },
  payouts: { enabled: false, pages: ["/payouts"], api: ["/api/v1/payouts"] },
  reports: { enabled: false, pages: ["/reports"], api: ["/api/v1/reports", "/api/jobs/reports"] },
  discounts: {
    enabled: false,
    pages: ["/bookings/discount-approvals"],
    api: ["/api/v1/discount-requests", "/api/v1/bookings/:bookingId/discount-requests"],
  },
  notifications: { enabled: false, pages: ["/admin/notification-rules"], api: ["/api/v1/notifications"] },
  auditLog: { enabled: false, pages: ["/admin/audit-log"], api: [] },
  stockReports: { enabled: false, pages: ["/stock/holds", "/stock/blocked", "/stock/statement"], api: [] },
  monitoring: { enabled: false, pages: [], api: ["/api/jobs/monitor"] },
};

/** Always reachable, whatever the flags say: the way in, the health probe, and
 *  the two targets disabled routes are rewritten to. `/` itself is handled in
 *  classifyPath as an exact match, because as a prefix it would cover everything. */
const ALWAYS_ON: readonly string[] = ["/login", "/api/health", "/api/disabled", "/feature-disabled"];

export function isFeatureEnabled(key: FeatureKey, features: FeatureMap = FEATURES): boolean {
  return features[key].enabled;
}

export function disabledPagePrefixes(features: FeatureMap = FEATURES): string[] {
  return Object.values(features).flatMap((feature) => (feature.enabled ? [] : [...feature.pages]));
}

export function disabledApiPrefixes(features: FeatureMap = FEATURES): string[] {
  return Object.values(features).flatMap((feature) => (feature.enabled ? [] : [...feature.api]));
}

const segmentsOf = (path: string): string[] => path.split("/").filter((segment) => segment !== "");

/** Does `prefix` cover `pathname`? A `:name` segment matches any one segment. */
export function prefixCovers(prefix: string, pathname: string): boolean {
  const wanted = segmentsOf(prefix);
  const actual = segmentsOf(pathname);
  if (wanted.length > actual.length) return false;
  return wanted.every((segment, index) => segment.startsWith(":") || segment === actual[index]);
}

export type PathStatus = "enabled" | "disabled" | "unclassified";

/** Which side of the switch a path is on. The longest matching prefix wins, and
 *  a tie goes to "disabled", so an ambiguous declaration fails closed. */
export function classifyPath(pathname: string, features: FeatureMap = FEATURES): PathStatus {
  if (pathname === "/") return "enabled";

  let best: { length: number; status: PathStatus } | null = null;
  const consider = (prefix: string, status: PathStatus) => {
    if (!prefixCovers(prefix, pathname)) return;
    const length = segmentsOf(prefix).length;
    if (!best || length > best.length || (length === best.length && status === "disabled")) {
      best = { length, status };
    }
  };

  for (const prefix of ALWAYS_ON) consider(prefix, "enabled");
  for (const feature of Object.values(features)) {
    const status: PathStatus = feature.enabled ? "enabled" : "disabled";
    for (const prefix of [...feature.pages, ...feature.api]) consider(prefix, status);
  }

  return (best as { status: PathStatus } | null)?.status ?? "unclassified";
}

/** What next.config.ts feeds to `rewrites().beforeFiles`. */
export function disabledRewrites(features: FeatureMap = FEATURES): { source: string; destination: string }[] {
  return [
    ...disabledPagePrefixes(features).map((prefix) => ({
      source: `${prefix}/:path*`,
      destination: "/feature-disabled",
    })),
    ...disabledApiPrefixes(features).map((prefix) => ({
      source: `${prefix}/:path*`,
      destination: "/api/disabled",
    })),
  ];
}
