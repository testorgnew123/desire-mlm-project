# 12 — Non-Functional Requirements

> **These are the paid-tier targets.** The project currently runs on Netlify Free
> and Neon Free, where concurrency, freshness, storage and DR targets are all
> materially lower. See [21-TIER-LIMITS §7](21-TIER-LIMITS.md) for what applies
> today, and the upgrade triggers that restore these numbers.

## Performance

| Operation | Target |
|---|---|
| Inventory board first load, 500 units | p95 < 1.5 s |
| Delta poll response | p95 < 200 ms |
| Hold acquire (end to end) | p95 < 500 ms |
| Unit detail with cost sheet | p95 < 800 ms |
| Lead list, 50 rows | p95 < 600 ms |
| Commission "explain" drill-down | p95 < 400 ms |
| Report export, 10k rows | < 30 s, async with download link |
| Payout batch, 2,000 associates | < 10 min (Netlify background ceiling is 15) |

The hold-acquire target includes the `SELECT … FOR UPDATE` critical section. It
is the one interaction an associate performs while a customer watches.

## Scale

| Dimension | Design target | Notes |
|---|---|---|
| Units under management | 50,000 | Across all projects |
| Live projects | 20 | |
| Associates | 2,000 | Tree depth ≤ 8 |
| Concurrent associates | 200 sustained / 500 peak | Launch day is the peak |
| Bookings | 500 / month | |
| Receipts | 2,000 / month | |
| Commission entries | ~24,000 / year | 500 × 4 beneficiaries × 12 |
| Audit rows | ~5 M / year | Partition by month from the start |
| Documents | 200 GB / year | Netlify Blobs. **5 GB per-object limit** -- fine for scans/PDFs, worth tracking as volume grows |

## Availability

| Metric | Target |
|---|---|
| Uptime, 09:00–21:00 IST | 99.5% |
| Uptime, overall | 99% |
| RPO | 1 hour |
| RTO | 4 hours |
| Planned maintenance | Outside business hours, announced 48 h ahead |

Business hours matter more than the aggregate. A sales floor down at 3 pm on a
Saturday costs bookings; down at 3 am costs nothing.

## Mobile

- Usable on 4G with 150 ms RTT
- Works on a ₹10,000 Android (4 GB RAM, Chrome 100+)
- First contentful paint < 2 s on 4G
- Inventory board interactive < 3 s
- Installable PWA
- Offline: **reads tolerated, no offline writes** — a hold that later evaporates
  is worse than no hold

## Accessibility

WCAG 2.1 AA on back-office screens.

- Keyboard-navigable tables and dialogs, real focus indicators
- Colour contrast ≥ 4.5:1 for text
- **No colour-only status.** The inventory board pairs colour with a label or
  icon — a colour-blind associate must still be able to read the grid
- Screen-reader labels on all form controls
- Respect `prefers-reduced-motion`

## Browsers

Chrome, Safari, Edge — last 2 versions. Android Chrome 100+. iOS Safari 15+.
No IE, no Chrome below 100.

## Data quality

- Money rounded `ROUND_HALF_UP` to 2dp; residual to the company
- Areas to 2dp
- No float arithmetic anywhere in a money path
- Timezone `Asia/Kolkata` for all business dates; UTC in storage
- Currency INR only in v1

## Operational

| Metric | Target |
|---|---|
| Deploy frequency | Daily to staging, weekly to production |
| Lead time, commit to production | < 3 days |
| Change failure rate | < 15% |
| Mean time to restore | < 4 h |
| Test coverage, `packages/commission` | **100% branch — non-negotiable** |
| Test coverage, `packages/services` | ≥ 80% |
| Test coverage, overall | ≥ 70% |

`packages/commission` is held at 100% branch coverage because it is pure, small,
and every uncovered branch is a payout nobody has verified.

## Capacity assumptions to revisit

These drive the targets above and should be re-checked against the client's real
numbers before Phase 1:

- Peak concurrency is a launch-day phenomenon, not a steady state
- Inventory board is the hottest read path by an order of magnitude
- Commission and payout load is monthly and bursty, not continuous
- Document storage grows linearly with bookings, never shrinks
