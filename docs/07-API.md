# 07 — API Surface

Two entry styles, one implementation.

- **Server Actions** for mutations from the Next.js app.
- **REST route handlers** at `/api/v1/*` for the associate PWA and integrations.

Both are thin. They validate input, resolve the actor, call a service in
`packages/services`, and shape a response. **No business logic in either.**

## Conventions

| Concern | Rule |
|---|---|
| Validation | Zod at the boundary. Reject before the service is called |
| Auth | Session cookie (web) or bearer token (PWA). Actor resolved once, passed into the service |
| Authorization | In the service layer, never in the handler |
| Errors | RFC 7807 `application/problem+json` |
| Pagination | Cursor-based: `?cursor=&limit=` → `{ data, nextCursor }` |
| Idempotency | **`Idempotency-Key` header mandatory on every money-mutating POST** |
| Audit | Every mutation response includes `auditId` |
| Money | Strings in JSON, never floats. `"150000.00"` |
| Dates | ISO 8601 UTC |

### Error shape

```json
{
  "type": "https://docs.internal/errors/unit-already-held",
  "title": "Unit already held",
  "status": 409,
  "detail": "C-1204 was held by Ravi (A-0042) 3 seconds ago.",
  "instance": "/api/v1/units/unit_abc/hold",
  "requestId": "req_01J..."
}
```

Losing a hold race returns `409` with the winner named. The UI shows that
verbatim — a generic failure message here makes associates distrust the board.

## Endpoints

### Inventory

| Method | Path | Notes |
|---|---|---|
| `GET` | `/projects/:id/units` | Filter by type, floor, facing, status, budget, PLC |
| `GET` | `/projects/:id/units/deltas?since=` | Board refresh. Returns only changed units |
| `GET` | `/units/:id` | Detail + live cost sheet |
| `POST` | `/units/:id/hold` | Idempotent. `409` if lost the race |
| `DELETE` | `/holds/:id` | Release |
| `POST` | `/holds/:id/extend` | Subject to `maxHoldExtensions` |
| `POST` | `/units/:id/block` | Admin. Reason required |

### Leads

| Method | Path | Notes |
|---|---|---|
| `GET` `POST` | `/leads` | Create runs dedup on `phoneHash`; returns a conflict if a live claim exists |
| `PATCH` | `/leads/:id` | |
| `POST` | `/leads/:id/activities` | |
| `POST` | `/leads/:id/reassign` | Manager only. Reason required |
| `POST` | `/leads/:id/site-visits` | |

### Bookings

| Method | Path | Notes |
|---|---|---|
| `POST` | `/bookings` | Creates DRAFT from a held unit |
| `GET` | `/bookings/:id` | |
| `POST` | `/bookings/:id/confirm` | **Freezes cost sheet, agreement value, commissionable value. Triggers accrual** |
| `POST` | `/bookings/:id/cancel` | Approval required. Returns a clawback preview first |
| `POST` | `/bookings/:id/discount-request` | Routed by the approval matrix |

### Collections

| Method | Path | Notes |
|---|---|---|
| `GET` | `/bookings/:id/demands` | |
| `POST` | `/demands/:id/raise` | |
| `POST` | `/receipts` | Admin entry. Status `ENTERED` |
| `POST` | `/receipts/:id/verify` | Finance. **Rejects if actor entered it, or is the seller / their upline** |
| `POST` | `/receipts/:id/clear` | Sets `clearedOn`; triggers commission release |
| `POST` | `/receipts/:id/bounce` | Reverses allocations and released commission |
| `POST` | `/demands/:id/follow-up` | Outcome + optional promise date |
| `GET` | `/collections/console` | Overdue buckets, filters |

### Network & grades

| Method | Path | Notes |
|---|---|---|
| `GET` | `/associates` | Scoped: own + downline unless privileged |
| `GET` | `/associates/:id/tree` | |
| `POST` | `/associates/:id/move` | **Rejected while a payout period is open.** Cycle-checked |
| `POST` | `/associates/:id/grade` | Effective-dated. Approval required |

### Commission

| Method | Path | Notes |
|---|---|---|
| `GET` | `/associates/:id/earnings` | Accrued / payable / paid / blocked-by-collections |
| `GET` | `/commission/entries/:id/explain` | Returns the snapshot, expanded. Powers the drill-down |
| `POST` | `/schemes/:id/simulate` | Dry-run a hypothetical sale. **No writes** |
| `POST` | `/commission/entries/:id/dispute` | |

### Payouts

| Method | Path | Notes |
|---|---|---|
| `POST` | `/payout-batches` | Opens a period; freezes tree and grade changes |
| `GET` | `/payout-batches/:id` | |
| `POST` | `/payout-batches/:id/approve` | **Rejects if actor is the preparer** |
| `GET` | `/payout-batches/:id/export` | Bank file |
| `GET` | `/payout-lines/:id/statement` | PDF |

## Job endpoints

Under `/api/jobs/*`, triggered by **external cron** (GitHub Actions — see
[21-TIER-LIMITS §11](21-TIER-LIMITS.md)). Every one requires the
`x-job-secret` header matching `JOB_TRIGGER_SECRET` and rejects otherwise —
these must not be triggerable from the open internet.

All are **idempotent**: a delayed, repeated or overlapping run is harmless.

| Path | Trigger | Cadence |
|---|---|---|
| `/jobs/holds/expire` | GitHub Actions cron | Every 5 min |
| `/jobs/collections/sweep` | GitHub Actions cron | Daily 08:00 IST |
| `/jobs/grades/qualify` | GitHub Actions cron | Daily 08:00 IST |
| `/jobs/monitor/invariants` | GitHub Actions cron | Nightly |
| `/jobs/backup/dump` | GitHub Actions cron | Nightly |
| `/jobs/payouts/run` | On demand, self-chaining | Cursor-persisted |

Commission accrual and release are **not** job endpoints — they fire in-request
after the booking or receipt transaction commits, so money never waits on a
scheduler.

Each returns `{ ok, processed, durationMs, nextCursor? }` and records its
completion for the dead-man's switch on `/api/health`.

## Rate limits

| Endpoint | Limit |
|---|---|
| `POST /auth/login` | 5 per 15 min per IP + account |
| `POST /units/:id/hold` | 30 per min per associate |
| All others | 100 per min per token |
