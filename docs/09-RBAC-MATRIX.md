# 09 — Roles, Permissions & Separation of Duties

> ## Active scope (2026-10-25): three roles
>
> The product is currently cut down to plotted projects, booking a plot and user
> admin, with exactly three kinds of user: **SUPER_ADMIN**, **ADMIN** and
> **ASSOCIATE**. `packages/db/src/permission-matrix.ts` is what is granted today;
> the eight-role design below (Finance Admin, Project Manager, Sales Head, Sales
> Admin, Team Lead, Auditor) is kept as the design to return to when those
> features are switched back on (`apps/web/lib/features.ts`). Where this page and
> the code disagree about today, the code is right.
>
> - **ADMIN** runs projects, plots and price lists, confirms and cancels bookings,
>   and manages **ASSOCIATE** accounts only (`user.manage`). It cannot create,
>   promote, demote or reset an admin or superadmin: anything touching those needs
>   `rbac.manage`, which only SUPER_ADMIN holds.
> - **ASSOCIATE** browses plots, holds one and drafts a booking. It cannot confirm:
>   the seller never confirms their own sale.
> - A key for a switched-off feature is held by SUPER_ADMIN alone.
> - Moving an existing database to this matrix is `packages/db/scripts/narrow-roles.ts`
>   (dry run by default).

Roles are **data** (`Role`, `Permission`, `RolePermission`), not an enum. Sales
organisations restructure constantly and a hardcoded enum means a deploy every
time they do.

Authorization is enforced in `packages/services`. Every service method takes an
actor and asserts. **The UI hiding a button is not access control.**

## Roles

| Role | Scope |
|---|---|
| `SUPER_ADMIN` | Everything, including schemes and RBAC. MFA planned (see §MFA) |
| `FINANCE_ADMIN` | Payouts, tax, receipt verification, recoveries, liability. **Cannot touch inventory or schemes.** MFA planned (see §MFA) |
| `PROJECT_MANAGER` | Inventory, price lists, unit blocking — scoped to assigned projects |
| `SALES_HEAD` | All associates and bookings, discount approvals, tree moves. MFA planned (see §MFA) |
| `SALES_ADMIN` | Booking paperwork, receipt entry, hold administration |
| `TEAM_LEAD` | Own team's leads, bookings, downline performance, own + team earnings |
| `ASSOCIATE` | Own leads, holds, bookings, own earnings |
| `AUDITOR` | Read-only across everything. No mutations, ever |

`UserRole.projectId` scopes a role to one project — that is how a Project Manager
is confined to their own towers.

## Permission matrix

`O` = own only · `T` = own + downline · `✓` = all · `–` = none

| Permission | SUPER | FIN | PROJ | HEAD | S.ADM | LEAD | ASSOC | AUDIT |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `project.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `project.write` | ✓ | – | ✓ | – | – | – | – | – |
| `pricelist.prepare` | ✓ | – | ✓ | – | – | – | – | – |
| `pricelist.approve` | ✓ | – | – | ✓ | – | – | – | – |
| `unit.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `unit.block` | ✓ | – | ✓ | ✓ | – | – | – | – |
| `hold.create` | ✓ | – | – | ✓ | ✓ | ✓ | ✓ | – |
| `hold.force_release` | ✓ | – | ✓ | ✓ | ✓ | – | – | – |
| `lead.read` | ✓ | – | – | ✓ | ✓ | T | O | ✓ |
| `lead.write` | ✓ | – | – | ✓ | ✓ | ✓ | ✓ | – |
| `lead.activity` | ✓ | – | – | ✓ | ✓ | ✓ | ✓ | – |
| `lead.reassign` | ✓ | – | – | ✓ | ✓ | T | – | – |
| `sitevisit.create` | ✓ | – | – | ✓ | ✓ | ✓ | ✓ | – |
| `booking.read` | ✓ | – | – | ✓ | ✓ | T | O | ✓ |
| `booking.create` | ✓ | – | – | ✓ | ✓ | ✓ | ✓ | – |
| `booking.confirm` | ✓ | – | – | ✓ | ✓ | – | – | – |
| `booking.cancel` | ✓ | – | – | ✓ | – | – | – | – |
| `booking.set_price` | ✓ | – | – | – | – | – | – | – |
| `discount.request` | ✓ | – | – | ✓ | ✓ | ✓ | ✓ | – |
| `discount.approve` | ✓ | band | – | ✓ | – | band | – | – |
| `demand.raise` | ✓ | ✓ | – | – | ✓ | – | – | – |
| `receipt.enter` | ✓ | ✓ | – | – | ✓ | – | – | – |
| `receipt.verify` | ✓ | ✓ | – | – | – | – | – | – |
| `demand.waive` | ✓ | ✓ | – | ✓ | – | – | – | – |
| `demand.follow_up` | ✓ | – | – | ✓ | ✓ | ✓ | ✓ | – |
| `associate.read` | ✓ | ✓ | – | ✓ | ✓ | T | O | ✓ |
| `associate.move` | ✓ | – | – | ✓ | – | – | – | – |
| `grade.change` | ✓ | – | – | ✓ | – | – | – | – |
| `scheme.prepare` | ✓ | – | – | – | – | – | – | – |
| `scheme.approve` | ✓ | – | – | ✓ | – | – | – | – |
| `scheme.simulate` | ✓ | ✓ | – | ✓ | – | – | – | ✓ |
| `commission.read` | ✓ | ✓ | – | ✓ | – | T | O | ✓ |
| `payout.prepare` | ✓ | ✓ | – | – | – | – | – | – |
| `payout.approve` | ✓ | ✓ | – | – | – | – | – | – |
| `payout.export` | ✓ | ✓ | – | – | – | – | – | – |
| `recovery.write_off` | ✓ | ✓ | – | – | – | – | – | – |
| `report.read` | ✓ | ✓ | ✓ | ✓ | ✓ | T | O | ✓ |
| `audit.read` | ✓ | ✓ | – | – | – | – | – | ✓ |
| `rbac.manage` | ✓ | – | – | – | – | – | – | – |

Both `payout.prepare` and `payout.approve` appear against `FINANCE_ADMIN`
because a finance team has several people. The instance-level rule below is what
stops one person doing both on the same batch.

## Separation of duties

Role permissions are not enough — these are **instance-level** rules, coded and
tested individually.

| Action | May not be performed by | Why |
|---|---|---|
| Verify a receipt | Whoever entered it | Maker-checker |
| Verify a receipt | The booking's selling associate, **or anyone in their upline** | Commission releases on collection — otherwise they unlock their own pay |
| Approve a payout batch | The preparer | Maker-checker |
| Approve a discount | The requesting associate | Self-approval |
| Change a commission scheme | Anyone holding `payout.prepare` | Prevents writing the rule and running it |
| Move a tree node | Anyone, while a payout period is open | The batch would compute against a shifting tree |
| Approve a grade change | Self | |

**Publishing a price list is deliberately not on this list.** It was until
2026-10-14 ("the requester may not publish"), and was relaxed at the client's
instruction: project creation and editing are admin-only, and the only role
holding both `pricelist.prepare` and `pricelist.approve` is the Super Admin, so
the rule could only ever block the one admin who runs the project. Holding
`pricelist.approve` is now the only gate; a self-approved publish is written into
the audit reason. The Project Manager (prepares) and Sales Head (approves) split
is unchanged, because it comes from the permissions, not from this rule.

### The one worth restating

> Commission releases pro-rata on collection. **Anyone who can mark money as
> received can unlock their own or their team's commission.**

That is why receipt verification carries two separate exclusions — the enterer,
*and* the seller's whole upline chain. Both are assertions with tests, checked
again nightly by the invariant monitor.

## Row scoping

`ASSOCIATE` sees own. `TEAM_LEAD` sees own + downline, resolved via the
materialised `AssociateHierarchy.path` prefix.

All scoping goes through **one** resolver in `packages/services`, unit-tested
against a deep tree. Ad-hoc `where` clauses scattered across services is how
somebody eventually sees another team's earnings.

## Approval matrix (discounts)

Bands are `PLACEHOLDER` — confirm with the client.

| Discount as % of base | Approver |
|---|---|
| ≤ 1% | `TEAM_LEAD` |
| 1–3% | `SALES_HEAD` |
| 3–5% | `SALES_HEAD` **or** `FINANCE_ADMIN` |
| > 5% | `SUPER_ADMIN` |

"3–5%" lists two roles because `DiscountRequest` has one `decidedById` --
either one may decide, this is not dual sign-off. `FINANCE_ADMIN` is
therefore granted `discount.approve` band-restricted to this row only
(the permission matrix above previously omitted it entirely, leaving this
band unreachable by the role the table itself names -- fixed to match).

Routing is a config row, resolved into `DiscountRequest.approverRoleCode` --
the model already carries this field directly; the generic
`ApprovalRequest` table is not used for discounts (see Decision log).

## MFA

TOTP infrastructure (`Role.requiresMfa`, enrollment, `verifyMfaToken`) is
built and working, but **not currently enforced for any role** — deferred by
client decision 2026-09-14: real enrollment isn't ready yet, and forcing it
now would lock people out. `MFA_REQUIRED_ROLES`/`MFA_REQUIRED_ROLE_CODES`
are both empty. Originally-planned mandatory roles: `SUPER_ADMIN`,
`FINANCE_ADMIN`, `SALES_HEAD` — restore by naming them in both lists (they
must stay equal, a test enforces this) once the client is ready to enroll.
A user who already has `User.mfaEnabled = true` is unaffected either way —
that per-user opt-in path is independent of role-level enforcement.
