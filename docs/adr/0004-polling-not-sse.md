# ADR-0004 — Delta polling instead of server-sent events

**Status:** Accepted
**Date:** 2026-09-05

## Context

The live inventory board must show current unit status to associates working on
site. The obvious design is Postgres `LISTEN/NOTIFY` fanned out to browsers over
SSE.

## Decision

No SSE. Poll a delta endpoint while the board is focused, paused on blur.

**Interval: 60 s on the free tier, 10–15 s on Pro.** The free-tier invocation
budget is the constraint, not the technology — see
[21-TIER-LIMITS §1](../21-TIER-LIMITS.md).

```
GET /api/v1/projects/:id/units/deltas?since=<iso8601>
→ { units: [ { id, status, currentHoldExpiresAt, updatedAt } ], serverTime }
```

Backed by `@@index([orgId, updatedAt])` on `units`.

## Why

**Serverless cannot hold the connection.** Netlify functions cap at 60 seconds
synchronous. `LISTEN/NOTIFY` needs a persistent Postgres connection; SSE needs a
persistent HTTP response. Neither survives in an ephemeral function.

**Neon autosuspends.** Even with a long window, a listener connection is exactly
the kind of thing that fights the platform rather than using it.

**Freshness is not the correctness mechanism.** This is the load-bearing point:

> Double-booking is prevented by the partial unique index and the
> `SELECT … FOR UPDATE` critical section — **not** by the screen being current.

A 15-second-stale tile means an associate occasionally taps Hold on a unit
someone just took. The database rejects it cleanly and the UI says *"Just taken
by Ravi (A-0042)"*. That interaction has to be handled gracefully regardless of
refresh rate, because even true realtime has a race window.

So SSE would buy a nicer average case for a failure the system must handle
anyway.

## Consequences

**Up to 15 seconds of staleness.** Acceptable, and invisible in practice at the
observed rate of hold activity.

**Polling load.** 200 concurrent associates at 12 s = ~17 requests/second. The
delta query is an indexed scan returning only changed rows — well within
[12-NFR](../12-NFR.md) targets, to be confirmed by the Phase 5 load test.

**On the free tier the constraint is cost, not throughput.** Netlify Free allows
125,000 invocations/month total. A 12 s poll for 10 associates viewing the board
one hour a day consumes 78,000 of that — 62% of the entire budget on polling
alone. Hence 60 s, and hence pause-on-blur being mandatory rather than nice.

**Losing a race must be a first-class UI state**, not an error toast. Named
winner, clear message, board refreshed immediately. This is specified in
[08-SCREENS](../08-SCREENS.md) rather than left to implementation.

**Pause on blur is required**, not an optimisation. Without it, background tabs
poll all day. On the free tier that is measured directly in invocations against a
hard monthly cap.

**A prominent manual refresh button is part of the design**, not a fallback. At
60 s an associate about to hold a unit should be able to force a check rather
than wait for the tick.

## Revisit if

The board moves off serverless, or observed hold-collision rates make 15 seconds
genuinely painful for associates. Neither is expected at this scale. If it
happens, a hosted realtime service is a smaller change than re-platforming.
