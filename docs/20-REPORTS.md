# 20 — Report Catalogue

Every report is row-scoped by the actor ([09-RBAC-MATRIX](09-RBAC-MATRIX.md)) —
an associate's "leaderboard" shows their own team, not the company.

All reports export to CSV and XLSX. Exports over 5,000 rows run async and deliver
a download link. Every export writes `AuditAction.EXPORT`.

## Inventory

| Report | Audience | Contents |
|---|---|---|
| **Stock statement** | All | Unit-level status across a project. The one finance and sales both use |
| **Availability heatmap** | Sales, Project | Tower × floor grid, absorption by unit type |
| **Absorption & velocity** | Head, Super | Units sold per week, days-on-market, projected sell-out |
| **Hold activity** | Sales admin | Active holds, expiry times, per-associate quota use, hoarding patterns |
| **Blocked inventory** | Project, Head | What is blocked, by whom, why, for how long |
| **Price realization** | Head, Finance | Achieved vs list rate per unit. **Discount leakage** |

## Sales & CRM

| Report | Audience | Contents |
|---|---|---|
| **Sales funnel** | All (scoped) | Lead → contacted → visit → negotiation → booked, with conversion at each stage |
| **Source ROI** | Head, Super | Leads, bookings and revenue by `LeadSource`; cost per booking where spend is known |
| **Associate performance** | Lead+, scoped | Bookings, value, conversion, average discount, avg days to close |
| **Team rollup** | Lead+ | Own + full downline, resolved via the hierarchy path |
| **Site visit conversion** | Sales | Visits → bookings, by associate and project |
| **Lost analysis** | Head | `lostReason` distribution, trend |

## Collections

| Report | Audience | Contents |
|---|---|---|
| **Outstanding aging** | Finance, Head | 0–7 / 8–30 / 31–60 / 60+ buckets with totals |
| **Collection vs target** | Finance, Head | Demanded vs collected by month and project |
| **Receipt register** | Finance | All receipts with mode, status, verifier. The audit-facing one |
| **Verification queue aging** | Finance | Receipts sitting in `ENTERED` — the maker-checker bottleneck |
| **Follow-up compliance** | Head, Lead | Overdue demands **with** vs **without** a logged follow-up, by associate |
| **Promise-to-pay tracking** | Lead, Finance | Promises made, kept, broken |
| **Bounced cheques** | Finance | With the commission reversals each triggered |

## Commission & payouts

| Report | Audience | Contents |
|---|---|---|
| **Commission liability** | Finance | **Accrued vs released vs paid.** What finance provisions against |
| **Associate earnings statement** | Own + Finance | Per-entry, with the explain drill-down. The associate-facing artifact |
| **Payout batch summary** | Finance | Gross, TDS, GST, recoveries, net, by associate |
| **Override distribution** | Head, Super | Who earns overrides and at which levels. Surfaces an unhealthy tree shape |
| **Breakage report** | Finance | Override money nobody qualified for, retained by the company. **Do not let this be invisible** |
| **Commission cost %** | Super, Finance | Total commission as a percentage of revenue, by project |
| **Clawback & recovery** | Finance | Cancellations, amounts reversed, outstanding recoveries |
| **Dispute log** | Head, Finance | Open and resolved disputes, ageing, resolution type |
| **Grade distribution** | Head, Super | Associates per grade; who is close to qualifying |

## Compliance & audit

| Report | Audience | Contents |
|---|---|---|
| **TDS summary** | Finance | By section and quarter; challan-ready |
| **Form 16A data** | Finance | Per payee, per quarter |
| **GST on brokerage** | Finance | Reconciliation for registered associates |
| **RERA project status** | Super | Registration validity, units sold, carpet-area disclosure check |
| **Audit trail** | Auditor, Super | Filterable by actor, entity, action, date |
| **Sensitive access log** | Super, Auditor | Who viewed which KYC document, when |
| **Separation-of-duties exceptions** | Auditor | Any invariant breach found by the nightly monitor |

## Dashboards

| Dashboard | For | Tiles |
|---|---|---|
| **Executive** | Super, Head | Revenue vs target, absorption, collection %, commission cost %, funnel |
| **Project** | Project manager | Stock position, holds, bookings this month, collections |
| **Team** | Team lead | Downline bookings, pipeline, overdue collections, team earnings |
| **Associate (mobile)** | Associate | This month's bookings, pipeline, tasks, earnings, **blocked-by-collections**, grade progress |
| **Finance** | Finance | Verification queue, aging, commission liability, batch status |

## Conventions

- **Money**: ₹ with Indian grouping. Exact figures in financial reports; lakh/crore
  abbreviation only in dashboards, with the exact value on hover.
- **Areas**: always labelled — `1,250 sq ft (saleable)`. Never bare.
- **Dates**: `DD-MMM-YYYY`.
- **Definitions on every report.** "Accrued", "released" and "paid" are three
  different numbers and all three are correct — a report that says "commission"
  without saying which one generates a support ticket.
- **As-of timestamp** printed on every export. A report without one gets emailed
  around and quoted six weeks later as current.

## Report builder

Phase 5. Saved views over a curated set of fields, with the same row scoping,
schedulable to email. Not raw SQL access — that bypasses scoping and audit.
