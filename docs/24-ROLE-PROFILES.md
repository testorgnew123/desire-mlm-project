# 24 — Role Profiles: who does what

A plain-language guide to the eight profiles: what each one is for, what it can
do, what it deliberately cannot, and what it sees when it signs in.

**This is the operational view.** The formal grant table, the separation-of-duty
rules and the discount approval bands live in
[09-RBAC-MATRIX](09-RBAC-MATRIX.md), and `packages/db/src/permission-matrix.ts`
is the executable source of truth that seeds the database. Everything below was
generated from that file — if this document and the code ever disagree, the code
is right and this is a bug.

Permission counts are out of **39** total.

---

## At a glance

| Profile | Permissions | One-line job | Touches money? |
|---|---|---|---|
| **Super Admin** | 39 / 39 | Everything, including who else can do what | Yes — all of it |
| **Finance Admin** | 17 / 39 | Collections, commission disputes, payouts | **Yes — the most** |
| **Sales Head** | 26 / 39 | Owns the sales org, the tree and the schemes | Indirectly (approves) |
| **Sales Admin** | 18 / 39 | Runs the sales desk day to day | Enters receipts |
| **Team Lead** | 16 / 39 | Works a team, sees its downline | Small discounts only |
| **Associate** | 14 / 39 | Sells. Own leads, own earnings | No |
| **Project Manager** | 7 / 39 | Builds and maintains the inventory | No |
| **Auditor** | 9 / 39 | Reads everything, changes nothing | No — read-only |

---

## Super Admin

**Holds all 39 permissions.** The only profile that can manage roles
(`rbac.manage`) and the only one that can author a commission scheme
(`scheme.prepare`).

Intended for one or two people. Everything else should be a narrower profile —
not because the Super Admin is dangerous in itself, but because the
separation-of-duty rules below protect the business by splitting work between
people, and a single account holding every permission can satisfy both halves
of a maker-checker pair on its own.

> The instance-level rules still apply even here: a Super Admin cannot verify a
> receipt they entered themselves, or approve a payout batch they prepared. The
> rule is enforced per action, not per role.

---

## Finance Admin

**17 permissions.** The money profile, and the one to scrutinise most.

**Owns:** receipt entry and verification, raising and waiving demands, payout
preparation, approval and export, write-offs on recoveries, and resolving
commission disputes.

**Cannot:** create or confirm a booking, create a hold, touch a lead, or change
the sales tree. Deliberately — finance records what sales did, it does not do it.

**One band-restricted exception:** Finance Admin holds `discount.approve`, but
only for the 3–5% band ([09-RBAC-MATRIX](09-RBAC-MATRIX.md), *Approval matrix*).
It is not a general discount approver.

**Also holds `audit.read`** — one of only three profiles that can read the audit
log.

---

## Sales Head

**26 permissions.** Owns the sales organisation.

**Owns:** the associate tree (`associate.move`), grades (`grade.change`),
price-list approval, scheme approval, and the full lead-to-booking chain
including cancellation.

**Cannot:** enter or verify a receipt, prepare or approve a payout, or author a
scheme. They approve schemes; the Super Admin writes them. That split exists so
that the person who sets commission rules is not the person who signs them off.

**Scope:** whole organisation.

---

## Sales Admin

**18 permissions.** The sales desk — the person who keeps the pipeline moving.

**Owns:** leads (including reassignment), site visits, holds, booking creation
and confirmation, demand raising, receipt entry, follow-ups.

**Cannot:** approve a discount, verify a receipt, cancel a booking, or see
commission. The receipt split is the important one: Sales Admin can **enter** a
receipt but never **verify** it, because verification is what releases
commission.

**Notable:** this is the only sales-side profile with `receipt.enter`.

---

## Team Lead

**16 permissions.** An associate who also runs a team.

**Owns:** everything an Associate owns, plus lead reassignment within the team
and discount approval for the smallest band (≤ 1%).

**Scope: own + downline.** The one profile where scope is genuinely interesting
— resolved through the materialised `AssociateHierarchy.path`, in a single
shared resolver. A Team Lead sees their own subtree and no sibling's.

**Cannot:** confirm a booking, enter a receipt, or move anyone in the tree.

---

## Associate

**14 permissions.** The field profile, and the one the mobile app is built for.

**Owns:** their own leads, site visits, unit holds, booking creation, discount
requests, collection follow-ups, and their own earnings.

**Cannot:** confirm a booking, approve their own discount, reassign a lead, or
see anyone else's numbers.

**Scope: own only.** Every list this profile opens is filtered to them.

---

## Project Manager

**7 permissions — the narrowest profile.** Builds inventory; does not sell it.

**Owns:** project and tower configuration, unit types, price-list preparation,
blocking units (`unit.block`) and force-releasing stuck holds.

**Cannot:** see a lead, a booking, a receipt or a commission figure. The nav
collapses to four sections. This is correct: a PM configures the stock, and the
commercial side is none of their business.

**Note:** they *prepare* price lists; a Sales Head approves them.

---

## Auditor

**9 permissions, all read.** Holds no permission that writes anything.

**Owns:** read access across projects, inventory, leads, bookings, associates,
commission and reports, plus `audit.read` and `scheme.simulate` — they can model
a scheme's effect without being able to change one.

**Cannot:** write anything at all. There is no exception.

---

## Separation of duties — the part roles alone cannot express

Holding a permission is not sufficient. These are **per-action** rules, each
coded and tested individually (full list in [09-RBAC-MATRIX](09-RBAC-MATRIX.md)):

| Action | Blocked for |
|---|---|
| Verify a receipt | Whoever entered it |
| Verify a receipt | The selling associate **and their entire upline** |
| Approve a payout batch | Whoever prepared it |
| Publish a price list | Whoever requested it |
| Approve a discount | The requesting associate |
| Change a commission scheme | Anyone holding `payout.prepare` |
| Move a tree node | Anyone, while a payout period is open |

**Why the receipt rule is doubled.** Commission releases pro-rata on collection,
so anyone who can mark money as received can unlock their own or their team's
pay. That is why verification excludes both the enterer *and* the seller's whole
upline chain. The nightly invariant monitor re-checks it.

---

## What each profile sees on sign-in

Generated from `apps/web/lib/nav.ts`. **Nav visibility is not data visibility** —
an Associate sees a Bookings tab, but row scoping means it contains only their
own. The nav answers "can this profile reach the screen"; scoping answers "what
is on it".

| Profile | Back-office sections |
|---|---|
| Super Admin | all eleven |
| Finance Admin | Dashboard, Projects, Inventory, Collections, Network, Commission, Payouts, Reports, Admin |
| Sales Head | Dashboard, Projects, Inventory, CRM, Bookings, Collections, Network, Commission, Reports |
| Sales Admin | Dashboard, Projects, Inventory, CRM, Bookings, Collections, Network, Reports |
| Team Lead | Dashboard, Projects, Inventory, CRM, Bookings, Collections, Network, Commission, Reports |
| Associate | Dashboard, Projects, Inventory, CRM, Bookings, Collections, Network, Commission, Reports |
| Project Manager | Dashboard, Projects, Inventory, Reports |
| Auditor | Dashboard, Projects, Inventory, CRM, Bookings, Network, Commission, Reports, Admin |

Associate PWA tabs (Home, Inventory, Leads, Earnings, Team):

| Profile | PWA tabs |
|---|---|
| Associate | Home, Inventory, Leads, Earnings |
| Team Lead / Sales Head / Super Admin | all five (**Team** needs `lead.reassign`) |
| Sales Admin | Home, Inventory, Leads, Team |
| Finance Admin | Home, Inventory, Earnings |
| Project Manager | Home, Inventory |
| Auditor | Home, Inventory, Leads, Earnings |

### Which shell you land in

Signing in sends you to one of two shells automatically, by role
(`apps/web/app/page.tsx`):

- **Associate** and **Team Lead** → the mobile PWA at `/home`
- **everyone else** → the back-office at `/dashboard`

Team Lead is in the PWA group deliberately: the PWA's **Team** tab is the
manager view for that role, so they do not need the desktop app.

> **Minor rough edge:** the two shells are not sealed off from each other. An
> Associate who types a back-office URL directly still reaches it and sees the
> nine sections in the table above. Nothing leaks — every list is still
> scope-filtered to them — but it is more nav than the role needs. Worth
> tightening before a wide rollout.

---

## MFA — currently off for everyone

TOTP is built and working (`Role.requiresMfa`, enrollment, `verifyMfaToken`),
but **no role enforces it**. Deferred by client decision (2026-09-14): real
enrollment was not ready and forcing it would have locked people out.

Originally planned as mandatory for **Super Admin, Finance Admin and Sales
Head** — restore by naming them in both `MFA_REQUIRED_ROLES` and
`MFA_REQUIRED_ROLE_CODES` (a test enforces that the two lists match). A user who
has already opted in via `User.mfaEnabled` is unaffected either way.

This matters more than it looks: the three roles above are the ones that move
money.
