// The permission grant matrix, transcribed exactly from
// docs/09-RBAC-MATRIX.md -- if this file and that doc ever disagree, one of
// them is a bug. This is the SOURCE OF TRUTH the seed script uses to create
// Role/Permission/RolePermission rows; see permission-matrix.test.ts for the
// consistency check.
//
// Scope annotations (O = own only, T = own + downline, "band" = gated by an
// amount threshold) are documented in the doc but NOT encoded here as a
// separate mechanism -- they describe how a service calls
// getAccessibleAssociateIds (rbac.ts) once a permission is already confirmed
// held, not a different kind of grant. Building a declarative scope-encoding
// layer was not asked for and would duplicate what the doc already says
// plainly; each service picks OWN vs OWN_AND_DOWNLINE for its own known role,
// same way "band" is resolved by the discount approval-routing config
// (docs/09-RBAC-MATRIX.md "Approval matrix (discounts)"), not by RBAC itself.

export const ROLE_CODES = [
  "SUPER_ADMIN",
  "FINANCE_ADMIN",
  "PROJECT_MANAGER",
  "SALES_HEAD",
  "SALES_ADMIN",
  "TEAM_LEAD",
  "ASSOCIATE",
  "AUDITOR",
] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

export const ROLE_NAMES: Record<RoleCode, string> = {
  SUPER_ADMIN: "Super Admin",
  FINANCE_ADMIN: "Finance Admin",
  PROJECT_MANAGER: "Project Manager",
  SALES_HEAD: "Sales Head",
  SALES_ADMIN: "Sales Admin",
  TEAM_LEAD: "Team Lead",
  ASSOCIATE: "Associate",
  AUDITOR: "Auditor",
};

/** Mirrors auth.ts MFA_REQUIRED_ROLE_CODES -- duplicated as data here
 *  (rather than importing from auth.ts) because this file seeds Role rows
 *  directly and must not create a circular dependency between the two. The
 *  seed-consistency test asserts the two lists match. */
export const MFA_REQUIRED_ROLES: RoleCode[] = ["SUPER_ADMIN", "FINANCE_ADMIN", "SALES_HEAD"];

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
] as const;

export type PermissionCode = (typeof PERMISSION_CODES)[number];

/** One row per permission = every column read independently from the
 *  docs/09-RBAC-MATRIX.md table. Transcribed by column, not copy-pasted from
 *  a spreadsheet -- verify against the doc directly if this is ever
 *  suspected of drifting. */
export const PERMISSION_MATRIX: Record<PermissionCode, RoleCode[]> = {
  "project.read": ["SUPER_ADMIN", "FINANCE_ADMIN", "PROJECT_MANAGER", "SALES_HEAD", "SALES_ADMIN", "TEAM_LEAD", "ASSOCIATE", "AUDITOR"],
  "project.write": ["SUPER_ADMIN", "PROJECT_MANAGER"],
  "pricelist.prepare": ["SUPER_ADMIN", "PROJECT_MANAGER"],
  "pricelist.approve": ["SUPER_ADMIN", "SALES_HEAD"],
  "unit.read": ["SUPER_ADMIN", "FINANCE_ADMIN", "PROJECT_MANAGER", "SALES_HEAD", "SALES_ADMIN", "TEAM_LEAD", "ASSOCIATE", "AUDITOR"],
  "unit.block": ["SUPER_ADMIN", "PROJECT_MANAGER", "SALES_HEAD"],
  "hold.create": ["SUPER_ADMIN", "SALES_HEAD", "SALES_ADMIN", "TEAM_LEAD", "ASSOCIATE"],
  "hold.force_release": ["SUPER_ADMIN", "PROJECT_MANAGER", "SALES_HEAD", "SALES_ADMIN"],
  "lead.read": ["SUPER_ADMIN", "SALES_HEAD", "SALES_ADMIN", "TEAM_LEAD", "ASSOCIATE", "AUDITOR"],
  // Added for Phase 2 CRM: no write permission existed for leads at all
  // (only read/reassign). Flat ✓ for TEAM_LEAD/ASSOCIATE, same shape as
  // booking.create -- the actual OWN-only restriction (an associate can only
  // create/update a lead assigned to themselves; a TEAM_LEAD, their downline)
  // is enforced in leads.ts via the same scope resolver as everywhere else,
  // not by narrowing the grant itself. Covers createLead AND updateLead,
  // mirroring project.write's create+update combo.
  "lead.write": ["SUPER_ADMIN", "SALES_HEAD", "SALES_ADMIN", "TEAM_LEAD", "ASSOCIATE"],
  // Logging an activity (and the STAGE_CHANGE case, which also moves
  // Lead.stage) is a distinct enough action from lead.write to audit
  // separately, same reasoning booking.confirm is split from booking.create.
  "lead.activity": ["SUPER_ADMIN", "SALES_HEAD", "SALES_ADMIN", "TEAM_LEAD", "ASSOCIATE"],
  "lead.reassign": ["SUPER_ADMIN", "SALES_HEAD", "SALES_ADMIN", "TEAM_LEAD"],
  // Covers scheduleSiteVisit AND completeSiteVisit (project.write's
  // create+update combo again) -- SiteVisit is its own resource, not a Lead
  // mutation, so it gets its own code rather than reusing lead.write.
  "sitevisit.create": ["SUPER_ADMIN", "SALES_HEAD", "SALES_ADMIN", "TEAM_LEAD", "ASSOCIATE"],
  // Added for Phase 2 booking-core: no read permission existed for bookings
  // at all (only create/confirm/cancel) -- mirrors lead.read's role set and
  // scope split exactly (ASSOCIATE = own, TEAM_LEAD = own + downline via
  // getAccessibleAssociateIds, AUDITOR for oversight).
  "booking.read": ["SUPER_ADMIN", "SALES_HEAD", "SALES_ADMIN", "TEAM_LEAD", "ASSOCIATE", "AUDITOR"],
  "booking.create": ["SUPER_ADMIN", "SALES_HEAD", "SALES_ADMIN", "TEAM_LEAD", "ASSOCIATE"],
  "booking.confirm": ["SUPER_ADMIN", "SALES_HEAD", "SALES_ADMIN"],
  "booking.cancel": ["SUPER_ADMIN", "SALES_HEAD"],
  "discount.request": ["SUPER_ADMIN", "SALES_HEAD", "SALES_ADMIN", "TEAM_LEAD", "ASSOCIATE"],
  // TEAM_LEAD and FINANCE_ADMIN are both gated by amount band -- see doc.
  // FINANCE_ADMIN added for Phase 2 discount routing: the approval-matrix
  // table names it for the 3-5% band, but this grant list omitted it
  // entirely, leaving that band unreachable by the role the doc itself names.
  "discount.approve": ["SUPER_ADMIN", "SALES_HEAD", "TEAM_LEAD", "FINANCE_ADMIN"],
  // Added for Phase 2 demand generation: no permission gated raising a
  // demand at all (only waiving it). Mirrors receipt.enter's exact role
  // set -- the same finance/back-office population that handles collections
  // paperwork, not associates.
  "demand.raise": ["SUPER_ADMIN", "FINANCE_ADMIN", "SALES_ADMIN"],
  "receipt.enter": ["SUPER_ADMIN", "FINANCE_ADMIN", "SALES_ADMIN"],
  "receipt.verify": ["SUPER_ADMIN", "FINANCE_ADMIN"],
  "demand.waive": ["SUPER_ADMIN", "FINANCE_ADMIN", "SALES_HEAD"],
  // Closing an overdue alert with a FollowUpOutcome (docs/05-COLLECTIONS-
  // SPEC.md section 4) is an associate-level action, not a finance one --
  // mirrors discount.request's exact role set, not demand.raise/waive's.
  "demand.follow_up": ["SUPER_ADMIN", "SALES_HEAD", "SALES_ADMIN", "TEAM_LEAD", "ASSOCIATE"],
  "associate.read": ["SUPER_ADMIN", "FINANCE_ADMIN", "SALES_HEAD", "SALES_ADMIN", "TEAM_LEAD", "ASSOCIATE", "AUDITOR"],
  "associate.move": ["SUPER_ADMIN", "SALES_HEAD"],
  "grade.change": ["SUPER_ADMIN", "SALES_HEAD"],
  "scheme.prepare": ["SUPER_ADMIN"],
  "scheme.approve": ["SUPER_ADMIN", "SALES_HEAD"],
  "scheme.simulate": ["SUPER_ADMIN", "FINANCE_ADMIN", "SALES_HEAD", "AUDITOR"],
  "commission.read": ["SUPER_ADMIN", "FINANCE_ADMIN", "SALES_HEAD", "TEAM_LEAD", "ASSOCIATE", "AUDITOR"],
  // Resolving a money dispute is finance-adjacent -- mirrors payout.approve's
  // exact role set, the same population that already owns clawbacks and
  // payout approval. Nothing gated this before Phase 3 Slice 6.
  "commission.dispute_resolve": ["SUPER_ADMIN", "FINANCE_ADMIN"],
  "payout.prepare": ["SUPER_ADMIN", "FINANCE_ADMIN"],
  "payout.approve": ["SUPER_ADMIN", "FINANCE_ADMIN"],
  "payout.export": ["SUPER_ADMIN", "FINANCE_ADMIN"],
  "recovery.write_off": ["SUPER_ADMIN", "FINANCE_ADMIN"],
  "report.read": ["SUPER_ADMIN", "FINANCE_ADMIN", "PROJECT_MANAGER", "SALES_HEAD", "SALES_ADMIN", "TEAM_LEAD", "ASSOCIATE", "AUDITOR"],
  "audit.read": ["SUPER_ADMIN", "FINANCE_ADMIN", "AUDITOR"],
  "rbac.manage": ["SUPER_ADMIN"],
};

/** Derived the other way around -- role -> permission codes it holds. What
 *  the seed script actually iterates to create RolePermission rows. */
export function permissionsForRole(role: RoleCode): PermissionCode[] {
  return PERMISSION_CODES.filter((code) => PERMISSION_MATRIX[code].includes(role));
}
