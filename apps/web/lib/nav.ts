// Static nav-tree data: section -> gating permission code(s) -> route.
// One tree per shell (docs/08-SCREENS.md). A section is reachable if the
// actor's permission set contains ANY ONE of its listed codes -- most
// sections need only one representative permission, but a few (Collections)
// are only reachable at all through a union of several role-specific grants
// (see packages/db/src/permission-matrix.ts).
//
// Target routes for sections not yet built (everything past Dashboard/
// Inventory as of Slice 2) 404 until their own slice ships -- expected
// mid-build state, not a fabricated screen; each slice fills in its own
// route as it lands.
import type { LucideIcon } from "lucide-react";
import {
  Banknote,
  Building2,
  FileBarChart,
  Handshake,
  Home,
  LayoutDashboard,
  Percent,
  Shield,
  Users,
  Users2,
  Wallet,
  Warehouse,
} from "lucide-react";
import type { PermissionCode } from "@desire/db";

export interface NavItem {
  key: string;
  label: string;
  href: string;
  icon: LucideIcon;
  /** Omit (or empty) for "always visible to an authenticated user of this
   *  shell" -- otherwise the actor needs at least one of these. */
  permissions?: PermissionCode[];
  /** Fetch this route's FULL RSC payload on prefetch, rather than the
   *  loading.tsx shell Next returns by default for a dynamic route.
   *
   *  This does NOT change how many requests are made. Measured against a
   *  local production build: every link in the shell is prefetched on every
   *  page load either way -- that is Next's existing default behaviour, not
   *  something this flag turns on. What it changes is what each prefetch
   *  COSTS and what it is worth:
   *
   *    default (partial) -- a uniform ~27.7 KB shell, identical for every
   *                         route, and the click still pays a full round
   *                         trip (~600 ms to Ohio) to fetch the real page.
   *    prefetch: true    -- the route actually renders server-side
   *                         (31-64 KB, and its real database work), and a
   *                         click inside the cache window costs NOTHING.
   *
   *  So the cost is server compute per prefetch, which is why this is an
   *  allowlist and not the default: full-rendering all eleven sections on
   *  every page load would run the dashboard's ~13 sequential queries for
   *  screens most actors never open.
   *
   *  Bounded by next.config.ts's `staleTimes.dynamic` (15s) -- a click
   *  within that window renders from the router cache, a later one refetches
   *  as before. Verified both ways in docs/22-LOAD-TEST-RESULTS.md. */
  prefetch?: true;
}

export const BACK_OFFICE_NAV: NavItem[] = [
  { key: "dashboard", label: "Dashboard", href: "/dashboard", prefetch: true, icon: LayoutDashboard },
  { key: "projects", label: "Projects", href: "/projects", icon: Building2, permissions: ["project.read"] },
  { key: "inventory", label: "Inventory", href: "/stock", prefetch: true, icon: Warehouse, permissions: ["unit.read"] },
  { key: "crm", label: "CRM", href: "/crm", prefetch: true, icon: Users, permissions: ["lead.read"] },
  { key: "bookings", label: "Bookings", href: "/bookings", prefetch: true, icon: Handshake, permissions: ["booking.read"] },
  {
    key: "collections",
    label: "Collections",
    href: "/collections",
    icon: Wallet,
    permissions: ["demand.raise", "receipt.enter", "receipt.verify", "demand.waive", "demand.follow_up"],
  },
  { key: "network", label: "Network", href: "/network", icon: Users2, permissions: ["associate.read"] },
  { key: "commission", label: "Commission", href: "/commission", icon: Percent, permissions: ["commission.read"] },
  { key: "payouts", label: "Payouts", href: "/payouts", icon: Banknote, permissions: ["payout.prepare"] },
  { key: "reports", label: "Reports", href: "/reports", icon: FileBarChart, permissions: ["report.read"] },
  { key: "admin", label: "Admin", href: "/admin", icon: Shield, permissions: ["rbac.manage", "audit.read"] },
];

export const PWA_NAV: NavItem[] = [
  { key: "home", label: "Home", href: "/home", prefetch: true, icon: Home },
  { key: "inventory", label: "Inventory", href: "/inventory", prefetch: true, icon: Warehouse, permissions: ["unit.read"] },
  { key: "leads", label: "Leads", href: "/leads", prefetch: true, icon: Users, permissions: ["lead.read"] },
  { key: "earnings", label: "Earnings", href: "/earnings", icon: Wallet, permissions: ["commission.read"] },
  // Managers only -- lead.reassign is granted to TEAM_LEAD and above, never
  // to a plain ASSOCIATE (docs/08-SCREENS.md: "Team -- Managers only").
  { key: "team", label: "Team", href: "/team", icon: Users2, permissions: ["lead.reassign"] },
];

/** Filters a nav tree down to what a permission set can reach. */
export function filterNav(items: NavItem[], permissions: ReadonlySet<string>): NavItem[] {
  return items.filter(
    (item) => !item.permissions || item.permissions.length === 0 || item.permissions.some((code) => permissions.has(code)),
  );
}
