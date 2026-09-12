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
import type { PermissionCode } from "@desire/db";

export interface NavItem {
  key: string;
  label: string;
  href: string;
  /** Omit (or empty) for "always visible to an authenticated user of this
   *  shell" -- otherwise the actor needs at least one of these. */
  permissions?: PermissionCode[];
}

export const BACK_OFFICE_NAV: NavItem[] = [
  { key: "dashboard", label: "Dashboard", href: "/dashboard" },
  { key: "projects", label: "Projects", href: "/projects", permissions: ["project.read"] },
  { key: "inventory", label: "Inventory", href: "/board", permissions: ["unit.read"] },
  { key: "crm", label: "CRM", href: "/crm", permissions: ["lead.read"] },
  { key: "bookings", label: "Bookings", href: "/bookings", permissions: ["booking.read"] },
  {
    key: "collections",
    label: "Collections",
    href: "/collections",
    permissions: ["demand.raise", "receipt.enter", "receipt.verify", "demand.waive", "demand.follow_up"],
  },
  { key: "network", label: "Network", href: "/network", permissions: ["associate.read"] },
  { key: "commission", label: "Commission", href: "/commission", permissions: ["commission.read"] },
  { key: "payouts", label: "Payouts", href: "/payouts", permissions: ["payout.prepare"] },
  { key: "reports", label: "Reports", href: "/reports", permissions: ["report.read"] },
  { key: "admin", label: "Admin", href: "/admin", permissions: ["rbac.manage", "audit.read"] },
];

export const PWA_NAV: NavItem[] = [
  { key: "home", label: "Home", href: "/home" },
  { key: "inventory", label: "Inventory", href: "/inventory", permissions: ["unit.read"] },
  { key: "leads", label: "Leads", href: "/leads", permissions: ["lead.read"] },
  { key: "earnings", label: "Earnings", href: "/earnings", permissions: ["commission.read"] },
  // Managers only -- lead.reassign is granted to TEAM_LEAD and above, never
  // to a plain ASSOCIATE (docs/08-SCREENS.md: "Team -- Managers only").
  { key: "team", label: "Team", href: "/team", permissions: ["lead.reassign"] },
];

/** Filters a nav tree down to what a permission set can reach. */
export function filterNav(items: NavItem[], permissions: ReadonlySet<string>): NavItem[] {
  return items.filter(
    (item) => !item.permissions || item.permissions.length === 0 || item.permissions.some((code) => permissions.has(code)),
  );
}
