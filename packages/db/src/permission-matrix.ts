// The permission grant matrix. This is the SOURCE OF TRUTH the seed script uses
// to create Role/Permission/RolePermission rows; see permission-matrix.test.ts
// for the consistency check.
//
// CUT DOWN TO THREE ROLES (2026-10-25). The product is currently limited to
// plotted projects, booking a plot and user admin, with exactly three kinds of
// user: SUPER_ADMIN, ADMIN and ASSOCIATE. docs/09-RBAC-MATRIX.md still holds the
// full eight-role design (Finance Admin, Project Manager, Sales Head, Sales
// Admin, Team Lead, Auditor) -- that grid is where to return to when those
// features are switched back on (apps/web/lib/features.ts). Until then:
//   - a key for a feature that is on goes to the roles that use it today;
//   - a key for a feature that is off is SUPER_ADMIN only, so even a route that
//     slipped past the router's feature switch refuses everyone else.
//
// Scope annotations (own only, own + downline, amount "band") are NOT encoded
// here as a separate mechanism -- they describe how a service calls
// getAccessibleAssociateIds (rbac.ts) once a permission is already confirmed
// held, not a different kind of grant.

export const ROLE_CODES = ["SUPER_ADMIN", "ADMIN", "ASSOCIATE"] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

export const ROLE_NAMES: Record<RoleCode, string> = {
  SUPER_ADMIN: "Super Admin",
  ADMIN: "Admin",
  ASSOCIATE: "Associate",
};

/** Mirrors auth.ts MFA_REQUIRED_ROLE_CODES -- duplicated as data here
 *  (rather than importing from auth.ts) because this file seeds Role rows
 *  directly and must not create a circular dependency between the two. The
 *  seed-consistency test asserts the two lists match.
 *
 *  Deferred by client decision (2026-09-14): MFA enrollment isn't ready
 *  yet, so no role forces it at login for now -- see docs/09-RBAC-MATRIX.md
 *  §MFA and the PROGRESS.md decision log. Not a removal of the capability:
 *  a user who already has User.mfaEnabled=true is unaffected, and this list
 *  goes back to naming real roles once the client is ready to enroll. */
export const MFA_REQUIRED_ROLES: RoleCode[] = [];

export const PERMISSION_CODES = [
  "project.read",
  "project.write",
  "pricelist.prepare",
  "pricelist.approve",
  "unit.read",
  "unit.block",
  "hold.create",
  "hold.force_release",
  "lead.read",
  "lead.write",
  "lead.activity",
  "lead.reassign",
  "sitevisit.create",
  "booking.read",
  "booking.create",
  "booking.confirm",
  "booking.cancel",
  "discount.request",
  "discount.approve",
  "demand.raise",
  "receipt.enter",
  "receipt.verify",
  "demand.waive",
  "demand.follow_up",
  "associate.read",
  "associate.move",
  "grade.change",
  "scheme.prepare",
  "scheme.approve",
  "scheme.simulate",
  "commission.read",
  "commission.dispute_resolve",
  "payout.prepare",
  "payout.approve",
  "payout.export",
  "recovery.write_off",
  "report.read",
  "audit.read",
  "rbac.manage",
  "user.manage",
] as const;

export type PermissionCode = (typeof PERMISSION_CODES)[number];

/** One row per permission: the roles that hold it. */
export const PERMISSION_MATRIX: Record<PermissionCode, RoleCode[]> = {
  // ── Plotted projects, inventory, holds, bookings: ON ────────────────────
  "project.read": ["SUPER_ADMIN", "ADMIN", "ASSOCIATE"],
  // Creating and editing projects, blocks, plot types and plots -- ADMIN's job.
  "project.write": ["SUPER_ADMIN", "ADMIN"],
  // Price-list approval is a permission, not a second person (client decision,
  // PROGRESS.md 2026-10-15): whoever holds both can publish their own list.
  "pricelist.prepare": ["SUPER_ADMIN", "ADMIN"],
  "pricelist.approve": ["SUPER_ADMIN", "ADMIN"],
  "unit.read": ["SUPER_ADMIN", "ADMIN", "ASSOCIATE"],
  "unit.block": ["SUPER_ADMIN", "ADMIN"],
  // An associate holds a plot for a customer. Holding needs an Associate profile
  // (and a grade quota); an ADMIN or SUPER_ADMIN is given one when the account is
  // made or changed (services/associate-profile.ts), so they can hold too.
  "hold.create": ["SUPER_ADMIN", "ADMIN", "ASSOCIATE"],
  "hold.force_release": ["SUPER_ADMIN", "ADMIN"],
  "booking.read": ["SUPER_ADMIN", "ADMIN", "ASSOCIATE"],
  // The associate drafts the booking; ADMIN (or SUPER_ADMIN) confirms it. An admin
  // may also draft one, and nothing stops them confirming their own: the rule that
  // a seller never confirms their own sale holds for associates only.
  "booking.create": ["SUPER_ADMIN", "ADMIN", "ASSOCIATE"],
  "booking.confirm": ["SUPER_ADMIN", "ADMIN"],
  "booking.cancel": ["SUPER_ADMIN", "ADMIN"],

  // ── User administration: ON ─────────────────────────────────────────────
  // RBAC itself (who may be an admin or superadmin) stays with SUPER_ADMIN.
  "rbac.manage": ["SUPER_ADMIN"],
  // ADMIN manages ASSOCIATE accounts only; admin.ts enforces that ceiling.
  "user.manage": ["SUPER_ADMIN", "ADMIN"],

  // ── Everything below belongs to a switched-off feature: SUPER_ADMIN only ─
  "lead.read": ["SUPER_ADMIN"],
  "lead.write": ["SUPER_ADMIN"],
  "lead.activity": ["SUPER_ADMIN"],
  "lead.reassign": ["SUPER_ADMIN"],
  "sitevisit.create": ["SUPER_ADMIN"],
  "discount.request": ["SUPER_ADMIN"],
  "discount.approve": ["SUPER_ADMIN"],
  "demand.raise": ["SUPER_ADMIN"],
  "receipt.enter": ["SUPER_ADMIN"],
  "receipt.verify": ["SUPER_ADMIN"],
  "demand.waive": ["SUPER_ADMIN"],
  "demand.follow_up": ["SUPER_ADMIN"],
  "associate.read": ["SUPER_ADMIN"],
  "associate.move": ["SUPER_ADMIN"],
  "grade.change": ["SUPER_ADMIN"],
  "scheme.prepare": ["SUPER_ADMIN"],
  "scheme.approve": ["SUPER_ADMIN"],
  "scheme.simulate": ["SUPER_ADMIN"],
  "commission.read": ["SUPER_ADMIN"],
  "commission.dispute_resolve": ["SUPER_ADMIN"],
  "payout.prepare": ["SUPER_ADMIN"],
  "payout.approve": ["SUPER_ADMIN"],
  "payout.export": ["SUPER_ADMIN"],
  "recovery.write_off": ["SUPER_ADMIN"],
  "report.read": ["SUPER_ADMIN"],
  "audit.read": ["SUPER_ADMIN"],
};

/** Derived the other way around -- role -> permission codes it holds. What
 *  the seed script actually iterates to create RolePermission rows. */
export function permissionsForRole(role: RoleCode): PermissionCode[] {
  return PERMISSION_CODES.filter((code) => PERMISSION_MATRIX[code].includes(role));
}
