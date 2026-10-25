// Static nav-tree data: section -> gating permission code(s) -> route.
// One tree per shell (docs/08-SCREENS.md). A section is reachable if the
// actor's permission set contains ANY ONE of its listed codes -- most
// sections need only one representative permission, but a few (Collections)
// are only reachable at all through a union of several role-specific grants
// (see packages/db/src/permission-matrix.ts).
//
// Which sections exist at all is decided by lib/features.ts; this tree only
// says where each one lives and who may see it.
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
import { isFeatureEnabled, type FeatureKey } from "./features";

export interface NavItem {
  key: string;
  label: string;
  href: string;
  icon: LucideIcon;
  /** The feature switch (lib/features.ts) this entry belongs to. While that
   *  feature is off the entry is hidden whatever the actor's permissions. */
  feature: FeatureKey;
  /** Omit (or empty) for "always visible to an authenticated user of this
   *  shell" -- otherwise the actor needs at least one of these. */
  permissions?: PermissionCode[];
}

export const BACK_OFFICE_NAV: NavItem[] = [
  { key: "dashboard", label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, feature: "dashboard" },
  { key: "projects", label: "Projects", href: "/projects", icon: Building2, feature: "projects", permissions: ["project.read"] },
  { key: "inventory", label: "Inventory", href: "/stock", icon: Warehouse, feature: "inventory", permissions: ["unit.read"] },
  { key: "crm", label: "CRM", href: "/crm", icon: Users, feature: "crm", permissions: ["lead.read"] },
  { key: "bookings", label: "Bookings", href: "/bookings", icon: Handshake, feature: "bookings", permissions: ["booking.read"] },
  {
    key: "collections",
    label: "Collections",
    href: "/collections",
    icon: Wallet,
    feature: "collections",
    permissions: ["demand.raise", "receipt.enter", "receipt.verify", "demand.waive", "demand.follow_up"],
  },
  { key: "network", label: "Network", href: "/network", icon: Users2, feature: "network", permissions: ["associate.read"] },
  { key: "commission", label: "Commission", href: "/commission", icon: Percent, feature: "commission", permissions: ["commission.read"] },
  { key: "payouts", label: "Payouts", href: "/payouts", icon: Banknote, feature: "payouts", permissions: ["payout.prepare"] },
  { key: "reports", label: "Reports", href: "/reports", icon: FileBarChart, feature: "reports", permissions: ["report.read"] },
  { key: "admin", label: "Admin", href: "/admin", icon: Shield, feature: "adminUsers", permissions: ["user.manage", "rbac.manage"] },
];

export const PWA_NAV: NavItem[] = [
  { key: "home", label: "Home", href: "/home", icon: Home, feature: "dashboard" },
  { key: "inventory", label: "Inventory", href: "/inventory", icon: Warehouse, feature: "inventory", permissions: ["unit.read"] },
  { key: "my-bookings", label: "My bookings", href: "/my-bookings", icon: Handshake, feature: "bookings", permissions: ["booking.read"] },
  { key: "leads", label: "Leads", href: "/leads", icon: Users, feature: "crm", permissions: ["lead.read"] },
  { key: "earnings", label: "Earnings", href: "/earnings", icon: Wallet, feature: "commission", permissions: ["commission.read"] },
  // Managers only -- lead.reassign is granted to TEAM_LEAD and above, never
  // to a plain ASSOCIATE (docs/08-SCREENS.md: "Team -- Managers only").
  { key: "team", label: "Team", href: "/team", icon: Users2, feature: "network", permissions: ["lead.reassign"] },
];

/** Filters a nav tree down to what is switched on AND what a permission set
 *  can reach. `enabled` is injectable so a test can flip features without
 *  touching the registry. */
export function filterNav(
  items: NavItem[],
  permissions: ReadonlySet<string>,
  enabled: (key: FeatureKey) => boolean = isFeatureEnabled,
): NavItem[] {
  return items.filter(
    (item) =>
      enabled(item.feature) &&
      (!item.permissions || item.permissions.length === 0 || item.permissions.some((code) => permissions.has(code))),
  );
}
