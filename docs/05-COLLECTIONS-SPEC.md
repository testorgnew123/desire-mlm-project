# 05 — Collections Specification

Demands, receipts, allocation, and the escalation ladder.

This module matters more than it looks: commission releases pro-rata on
collection, so collections performance directly gates what associates get paid.
That coupling is a feature — see §6.

## 1. Payment plans and demands

A `PaymentPlan` is a template of milestones (label, percentage, due-days offset).
At booking confirmation the plan expands into a `DemandSchedule` of concrete
`Demand` rows against that booking.

`Demand.status`: `SCHEDULED → RAISED → PARTIALLY_PAID → PAID`, with `OVERDUE` and
`WAIVED` as terminal-ish states.

**A demand never stores how much has been paid.** It is always derived from
`ReceiptAllocation`. One cheque routinely settles two demands; one demand
routinely takes three transfers. A denormalised `paidAmount` drifts, and once
finance catches it drifting they stop trusting the system.

```sql
-- outstanding on a demand
SELECT d.amount + d.gst_amount - COALESCE(SUM(ra.amount), 0)
FROM demands d
LEFT JOIN receipt_allocations ra
  ON ra.demand_id = d.id AND ra.reversed_at IS NULL
WHERE d.id = $1
GROUP BY d.id;
```

## 2. Recording money received

The admin entry form captures: amount, mode, instrument number, drawn-on bank,
deposited-to bank, received date, and the demands to allocate against.

Lifecycle:

```
ENTERED ──verify──► VERIFIED ──funds land──► CLEARED
   │                    │                       │
   └──cancel──►CANCELLED└────bounce────► BOUNCED ◄──┘
```

| Field | Meaning |
|---|---|
| `receivedOn` | Physically in hand |
| `clearedOn` | **Funds in the bank.** Commission release keys off this |
| `bouncedOn` | Reverses allocations and any commission released against it |

### Allocation rules

1. Allocate to the oldest unpaid demand first, unless the admin overrides.
2. One receipt may span several demands; one demand may take several receipts.
3. **Overpayment becomes `Booking.creditBalance`**, auto-applied to the next
   demand raised. Buyers pay round numbers; demand schedules do not.
4. Reversal writes `reversedAt` — allocations are never deleted.

### The maker-checker rule, and why

> Commission releases pro-rata on collection. Therefore **anyone who can mark
> money as received can unlock their own or their team's commission.**

Enforced in code, with tests:

- `enteredById != verifiedById`
- neither may be the booking's selling associate, nor anyone in their upline
- only `VERIFIED` + `clearedOn` receipts count toward release

This is the highest-value control in the product. See
[10-SECURITY](10-SECURITY.md).

## 3. Escalation ladder

A daily job — driven by external cron, see [21-TIER-LIMITS §11](21-TIER-LIMITS.md)
— evaluates open demands and fires the due rung. Each
rung fires **at most once per demand** — enforced by
`@@unique([demandId, rung])` on `CollectionAlert`.

| Rung | When | Recipients | Content |
|---|---|---|---|
| `DUE_MINUS_7` | 7 days before | Associate | "Collect ₹X from <buyer> by <date>" |
| `DUE_MINUS_3` | 3 days before | Associate | Reminder + one-tap call/WhatsApp |
| `DUE_MINUS_1` | 1 day before | Associate | Reminder |
| `DUE_TODAY` | Due date | Associate + Sales Admin | Due today |
| `OVERDUE_1` | +1 day | Associate | **Overdue.** Follow-up log becomes mandatory |
| `OVERDUE_7` | +7 days | + Team Lead (L1 upline) | Team escalation |
| `OVERDUE_15` | +15 days | + Sales Head, Finance | Delay interest begins accruing, if configured |
| `OVERDUE_30` | +30 days | + Finance Admin | Flag for demand letter / cancellation review |
| `PROMISE_BREACHED` | Promise date passes unpaid | Associate + Team Lead | Promise broken |
| `CHEQUE_BOUNCED` | On bounce | Associate + Sales Admin + Finance | **Reverses released commission** |

Offsets, audiences and channels are `NotificationRule` rows, not code — every
developer runs a different collections policy. All values above are PLACEHOLDER.

**Alert fatigue kills a collections system faster than having no alerts.** The
once-per-rung constraint is the whole reason the ladder is modelled as rows
rather than computed on the fly.

## 4. Follow-up as tracked work

`OVERDUE_1` and beyond raise a **Payment Follow-Up task** on the associate's task
list. Closing it requires a `FollowUpOutcome` and, where relevant, a
`promiseToPayDate`.

A promise that passes unpaid fires `PROMISE_BREACHED` and is visible on the
associate's record. This turns a passive notification into something with a
paper trail.

## 5. Collections Console (admin)

One row per open demand: buyer, project/unit, amount, days overdue, associate,
last follow-up, promise date, one-tap call.

Filters: overdue bucket (0–7 / 8–30 / 30+), project, associate, team, amount.
Default sort: amount descending within the worst bucket — chase the money, not
the row count.

## 6. The lever that actually moves collections

Because release is pro-rata on collection, an unpaid demand blocks the
associate's **own** money. Surface that, explicitly, on their dashboard:

> **₹1,05,000 of your commission is blocked by ₹42,00,000 in pending collections**
> — with a drill-down to the exact demands and the buyer's phone number.

Nothing else in this system will move collections faster than an associate
seeing their own withheld earnings next to the number they need to call.

## 7. Interest on delayed payment

Optional per project. `Demand.interestRatePctPerAnnum` (PLACEHOLDER), accrued
daily by the sweep into `interestAccrued`.

Interest is **never commissionable** — it compensates the developer for delay,
not the associate for selling.

## 8. Invariants

```
Σ(allocations per receipt)   ≤  receipt.amount
Σ(allocations per demand)    ≤  demand.amount + demand.gstAmount
Σ(cleared receipts)          =  Σ(active allocations) + booking.creditBalance
∀ demand, rung:  at most one CollectionAlert
∀ receipt:       enteredById ≠ verifiedById, and neither is the
                 selling associate or in their upline
∀ bounced receipt: all its allocations reversed, and every commission
                 release triggered by it reversed
```
