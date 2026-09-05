# 09 — Roles, Permissions & Separation of Duties

Roles are **data** (`Role`, `Permission`, `RolePermission`), not an enum. Sales
organisations restructure constantly and a hardcoded enum means a deploy every
time they do.

Authorization is enforced in `packages/services`. Every service method takes an
actor and asserts. **The UI hiding a button is not access control.**

## Roles

| Role | Scope |
|---|---|
| `SUPER_ADMIN` | Everything, including schemes and RBAC. MFA required |
| `FINANCE_ADMIN` | Payouts, tax, receipt verification, recoveries, liability. **Cannot touch inventory or schemes.** MFA required |
| `PROJECT_MANAGER` | Inventory, price lists, unit blocking — scoped to assigned projects |
| `SALES_HEAD` | All associates and bookings, discount approvals, tree moves. MFA required |
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
| `lead.reassign` | ✓ | – | – | ✓ | ✓ | T | – | – |
| `booking.create` | ✓ | – | – | ✓ | ✓ | ✓ | ✓ | – |
| `booking.confirm` | ✓ | – | – | ✓ | ✓ | – | – | – |
| `booking.cancel` | ✓ | – | – | ✓ | – | – | – | – |
| `discount.request` | ✓ | – | – | ✓ | ✓ | ✓ | ✓ | – |
| `discount.approve` | ✓ | – | – | ✓ | – | band | – | – |
| `receipt.enter` | ✓ | ✓ | – | – | ✓ | – | – | – |
| `receipt.verify` | ✓ | ✓ | – | – | – | – | – | – |
| `demand.waive` | ✓ | ✓ | – | ✓ | – | – | – | – |
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
| Publish a price list | The requester | Prevents unilateral repricing |
| Approve a discount | The requesting associate | Self-approval |
| Change a commission scheme | Anyone holding `payout.prepare` | Prevents writing the rule and running it |
| Move a tree node | Anyone, while a payout period is open | The batch would compute against a shifting tree |
| Approve a grade change | Self | |

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
| 3–5% | `SALES_HEAD` + `FINANCE_ADMIN` |
| > 5% | `SUPER_ADMIN` |

Routing is a config row, resolved into `ApprovalRequest.requiredRoleCode`.

## MFA

TOTP mandatory for `SUPER_ADMIN`, `FINANCE_ADMIN`, `SALES_HEAD` — set via
`Role.requiresMfa`. Optional below. A user holding any MFA-required role cannot
complete login without it.
