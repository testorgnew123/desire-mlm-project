# 06 — Inventory Specification

Units, the state machine, hold concurrency, and versioned pricing.

## 1. State machine

**`UnitStatus` has no `CANCELLED` value** (confirmed against the migrated,
gate-tested schema — the enum is `AVAILABLE, HELD, BOOKED, AGREEMENT_SIGNED,
REGISTERED, POSSESSION, BLOCKED`). Cancellation is a `Booking.status`
concept, not a unit one: cancelling a booking frees the unit by returning it
to `AVAILABLE` for resale, and the commission clawback it triggers is tracked
entirely on the booking/commission side. An earlier draft of this diagram
showed a `CANCELLED` box on the unit state machine; that was a documentation
error, corrected here rather than added to the schema, since the schema was
already migrated and gate-tested by the time this was caught.

```
                    ┌──── expire (TTL) / release / admin force ────┐
                    ▼                                              │
  AVAILABLE ──hold──► HELD ──confirm──► BOOKED ──agreement──► AGREEMENT_SIGNED
      ▲                                   │                          │
      │                                   │                     registration
      └──────────── cancel ◄──────────────┘                          ▼
                                                                 REGISTERED
                                                                      │
                                                                 possession
                                                                      ▼
                                                                 POSSESSION

  Any state ──admin──► BLOCKED (management / legal / mortgage) ──► back to prior
```

### Transition guards

| Transition | Guard |
|---|---|
| `AVAILABLE → HELD` | Unit not blocked · associate has hold quota remaining · an ACTIVE price list exists · project RERA registration valid |
| `HELD → AVAILABLE` | TTL expiry (automatic) · associate release · admin force-release (audited, reason required) |
| `HELD → BOOKED` | Booking form complete · booking-amount receipt captured · sales admin confirms |
| `BOOKED → AVAILABLE` | Booking cancelled. Approval required · **triggers commission clawback**. (This is the diagram's "cancel" transition — there is no separate `CANCELLED` unit state; see above) |
| `BOOKED → AGREEMENT_SIGNED` | Agreement document uploaded and verified |
| `AGREEMENT_SIGNED → REGISTERED` | Registration completed with the sub-registrar |
| `REGISTERED → POSSESSION` | Completion certificate issued, handover done |
| `* → BLOCKED` | Admin only; reason mandatory |
| `BLOCKED → <prior status>` | Admin only; returns to whatever status the unit held immediately before blocking (read from `UnitStatusHistory`), not a fixed target |

Every transition writes a `UnitStatusHistory` row. Table-driven tests cover every
(state, transition) pair — legal ones succeed, illegal ones throw.

Cancellation is only modelled from `BOOKED`. Cancelling after `AGREEMENT_SIGNED`
or later is a materially different, rarer legal process (unwinding a registered
agreement) and is out of scope until a real client case requires it — do not
add those transitions speculatively.

## 2. Hold concurrency — the double-hold race

Two associates tapping **Hold** on the same unit in the same second is the
realistic failure mode, not a theoretical one. Two independent defences:

### Structural — the database refuses

```sql
CREATE UNIQUE INDEX one_active_hold_per_unit
  ON unit_holds (unit_id) WHERE released_at IS NULL;
```

Prisma cannot express a partial unique index. This must be added by hand in a
Phase 0 migration. **Without it the application-level check is a race.**

### Transactional — serialise check-then-act

```sql
BEGIN;
  SELECT status FROM units WHERE id = $1 FOR UPDATE;
  -- evaluate guards: not blocked, quota available, price list active
  INSERT INTO unit_holds (unit_id, associate_id, expires_at, ...) VALUES (...);
  UPDATE units SET status = 'HELD', current_hold_id = $2 WHERE id = $1;
COMMIT;
```

The row lock serialises concurrent attempts; the index is the backstop if a code
path ever forgets the lock.

Losing attempts must fail **cleanly** — "just taken by Ravi (A-0042)", not a 500.

### Test

50 parallel hold requests on one unit → exactly 1 success, 49 clean rejections.
Run against real Postgres, never a mock. A mock cannot reproduce this.

## 3. Expiry — lazy plus scheduled

A cron alone leaves a window where an expired hold still reads as `HELD`. Two
mechanisms:

**Lazy** — any read treats `expiresAt < now()` as available. The board is never
wrong even between sweeps.

**Scheduled** — a sweep runs every 5 minutes (external cron, see
[21-TIER-LIMITS §11](21-TIER-LIMITS.md)) and materialises the release: sets
`releasedAt`, `releaseReason = EXPIRED`, flips the unit to `AVAILABLE`, writes
history, notifies the associate.

Belt and braces, and the split matters: **the lazy path guarantees correctness,
the sweep only guarantees the audit trail and the notification.** That is why the
sweep can run every 5 minutes rather than every minute, and why a sweep that
stops entirely never makes the board wrong — it only delays notifications, which
the dead-man's switch catches.

## 4. Hold policy

| Setting | Where | Default (PLACEHOLDER) |
|---|---|---|
| TTL | `Project.holdTtlMinutes` | 1440 (24 h) |
| Extension | `Project.holdExtensionMinutes` | 720 (12 h) |
| Max extensions | `Project.maxHoldExtensions` | 1 |
| Quota per associate | `Grade.holdQuota` | 3 |
| Approval needed | `Project.holdRequiresApproval` | false |

Quota is counted across projects, on live holds only. It exists to stop
hoarding — without it, one associate parks every good unit "for a client".

Notifications: 30 minutes before expiry, and on expiry.

## 5. Price lists

Versioned and immutable. A change publishes a new version and archives the old.

- `PriceList` has `status` (`DRAFT → PENDING_APPROVAL → ACTIVE → ARCHIVED`) and
  `validFrom` / `validTo`.
- **Maker-checker**: `preparedById != approvedById`.
- A `Booking` pins `priceListId`. "Why was this unit cheaper in January" is
  answered by a row, not by memory.
- `PriceListItem` sets a rate per unit type, or per unit as an override.

### Cost sheet computation

```
baseAmount   = saleableArea × baseRatePerSqft
plcAmount    = saleableArea × Σ(plcCharges[tag] for tag in unit.plcTags)
otherCharges = Σ(fixed charges: parking, club, IFMS, ...)
gross        = baseAmount + plcAmount + otherCharges − discount
gst          = Σ(line × line.gstRatePct) for taxable lines
agreementValue = gross + gst + stampDuty + registration

commissionableValue = Σ(lines where chargeHead.countsTowardCommission)
                      adjusted per scheme.baseDefinition
                      (netOfDiscount, netOfGst)
```

Both `agreementValue` and `commissionableValue` are **frozen onto the booking** at
confirmation. Every line is snapshotted into `CostSheetLine` — regenerating from
the price list later would not reproduce what the customer signed.

## 6. The live inventory board

The screen this product is judged on. Used standing on site, one-handed, in
sunlight, on 4G.

- Tower/floor grid, colour-coded by status, countdown on held tiles
- Filters: unit type, floor range, facing, budget, PLC tags, availability
- Unit drawer: live cost sheet, floor plan, hold button, hold history
- **Delta polling every 10–15 s**, paused on blur — see [ADR-0004](adr/0004-polling-not-sse.md)

```
GET /api/v1/projects/:id/units/deltas?since=<iso8601>
→ { units: [ { id, status, currentHoldExpiresAt, updatedAt } ], serverTime }
```

Backed by `@@index([orgId, updatedAt])` on `units`.

A 15-second-stale tile is a **UX** issue, not a correctness one — the index and
the row lock prevent double-booking regardless of what the screen showed.

## 7. Invariants

```
∀ unit:  at most one unit_hold with released_at IS NULL
∀ unit in BOOKED:  exactly one booking in CONFIRMED or beyond
∀ unit in HELD:    currentHoldId is set and that hold is live
∀ associate:  live holds ≤ their grade's holdQuota
∀ booking:    its priceList was ACTIVE on the booking date
```
