# 08 — Screens & Information Architecture

Roughly 40 screens across two shells: a desktop back-office and a mobile PWA.

They are genuinely different products. Associates work standing up, one-handed,
on 4G, on cheap Android phones — they will never open the desktop app. Do not
build one responsive shell and hope.

## Back-office (sidebar navigation)

| Section | Screens |
|---|---|
| **Dashboard** | Role-specific landing |
| **Projects** | List · Detail · Towers · Units · Price lists · Payment plans · Commission scheme |
| **Inventory** | Live board · Stock statement · Active holds · Blocked units |
| **CRM** | Leads · Lead detail · Site visits · Source ROI |
| **Bookings** | List · Detail (cost sheet, documents, timeline) · Discount approvals · Cancellations |
| **Collections** | Console · Demands · Receipts · **Verification queue** · Aging |
| **Network** | Org tree · Associates · Associate detail · Grades · Promotions |
| **Commission** | Schemes · Scheme simulator · Ledger · Disputes |
| **Payouts** | Batches · Batch detail · Recoveries · Adjustments · Statements |
| **Reports** | Catalogue + builder — see [20-REPORTS](20-REPORTS.md) |
| **Admin** | Users · Roles · Config · Audit log · Notification rules |

## Associate PWA (5-tab bottom navigation)

| Tab | Contents |
|---|---|
| **Home** | Today's tasks, alerts, this-month stats |
| **Inventory** | Browse, filter, unit detail, hold |
| **Leads** | List, detail, log activity, schedule visit |
| **Earnings** | Accrued / payable / paid · blocked-by-collections · statements · grade progress |
| **Team** | Managers only — downline performance |

Installable, offline-tolerant for reads. **No offline writes in v1** — a hold
taken offline cannot be guaranteed exclusive, and a hold that later evaporates is
worse than no hold.

## The three screens that carry the product

### 1. Live inventory board

The screen the project is judged on.

- Tower/floor grid, colour-coded: available · held · booked · registered · blocked
- **Countdown timer visible on every held tile** — a hold without a visible clock
  gets forgotten, and forgotten holds are how inventory silently disappears
- Filter rail: type, floor range, facing, budget, PLC, availability
- Unit drawer: live cost sheet, floor plan, hold button, hold history
- Hold button shows the associate's remaining quota
- Delta poll every 10–15 s, paused on blur
- Losing a hold race shows **"Just taken by Ravi (A-0042)"** — never a generic error

Design constraints: legible in sunlight, thumb-reachable actions, works at 360 px.

### 2. Commission statement with "explain this number"

This screen is what makes associates trust the system, which is what makes them
stop keeping private spreadsheets.

Every line expands to the full derivation:

```
₹15,000 — Override, Level 1 — Sharma booking, Unit C-1204
├─ Commissionable value          ₹1,00,00,000
├─ Seller                        Ravi (A-0042), Grade G4 Manager
├─ Seller rate                   1.5000% of base  →  ₹1,50,000
├─ Your level                    L1  (you were Ravi's direct upline on 14-Mar-2026)
├─ Level rate                    10.0000% of seller commission  →  ₹15,000
├─ Scheme                        Skyline Phase 2, version 3
└─ Release                       Pro-rata on collection · 30% collected · ₹4,500 payable
```

Every figure comes from `CommissionEntry.snapshot`, so it renders identically
three years later regardless of what changed since.

### 3. Collections console

One row per open demand: buyer · project/unit · amount · days overdue ·
associate · last follow-up · promise date · **one-tap call**.

- Filter by overdue bucket: 0–7 / 8–30 / 30+
- Default sort: amount descending within the worst bucket — chase the money, not
  the row count
- Bulk actions: raise demand letters, reassign follow-up

## Cross-cutting UI rules

**Money** — always ₹ with Indian digit grouping (`₹1,00,00,000`). Never truncate
to lakh/crore in a financial screen; do it in dashboards only, with the exact
figure on hover.

**Areas** — always labelled with which area it is. `1,250 sq ft (saleable)`.
Never a bare number. See [19-GLOSSARY](19-GLOSSARY.md) for why.

**Dates** — `DD-MMM-YYYY`. `03-09-2026` is ambiguous across the team.

**Destructive actions** — cancellation shows a **clawback preview** before
confirming: who loses how much. Force-releasing a hold names the associate being
overridden.

**Empty states** — say what to do next, not "no data".

**PII** — Aadhaar always masked. PAN masked outside finance. Revealing a KYC
document writes an audit row.

**Accessibility** — WCAG 2.1 AA on back-office. Keyboard-navigable tables, real
focus states, no colour-only status (the inventory board pairs colour with a
label or icon — a colour-blind associate must still read the grid).
