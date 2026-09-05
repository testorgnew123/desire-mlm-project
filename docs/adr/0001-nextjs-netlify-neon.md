# ADR-0001 — Next.js on Netlify with Neon Postgres

**Status:** Accepted, with an open dependency on the data residency decision
**Date:** 2026-09-05

## Context

Greenfield internal platform: dashboard-heavy back-office plus an associate PWA.
Small team, ~20 week timeline, India-based users, and data that includes KYC.

## Decision

Next.js 15 (App Router) on Netlify, Postgres on Neon, Prisma as the ORM.

- Netlify functions in region `sin` (Singapore)
- Neon in `aws-ap-southeast-1` (Singapore)
- File storage on Netlify Blobs (decided during Phase 0 -- see
  PROGRESS.md decision log; supersedes the S3-in-Mumbai plan this ADR
  originally made, see the amendment at the end)

## Why

**Next.js** — one repo and one language for a product that is mostly forms,
tables and dashboards. Server Components keep the inventory grid's payload small.
Server Actions remove an API layer we would otherwise hand-write.

**Netlify** — the Next.js Runtime v5 handles App Router, Server Actions, ISR and
middleware without configuration. Deploy previews per PR are worth real money
during a client engagement where the client reviews weekly.

**Neon** — serverless pooling solves the Lambda-concurrency problem that
otherwise exhausts Postgres connections. **Database branching per PR** is the
decisive feature: a reviewer gets a working app on realistic data from a link.

**Prisma** — typed schema, and a migration history that doubles as a change
record on a system where schema changes affect money.

## Verified constraints

| Constraint | Value |
|---|---|
| Function timeout, synchronous | 60 s |
| Function timeout, scheduled | 30 s |
| Function timeout, background | 15 min |
| Function memory | 1 GB default, 4 GB on credit-based Pro |
| Function region selection | **Pro or Enterprise only** |
| Neon regions | us-east-1/2, us-west-2, eu-central-1, eu-west-2, ap-southeast-1, ap-southeast-2, sa-east-1 |

Function region and DB region are deliberately identical, so the function↔DB
round trip stays in single-digit ms and only the user↔edge hop crosses water
(~60–80 ms Mumbai→Singapore).

### Amendment — the project is on the free tier

Region selection is Pro-only, so functions are locked to `cmh` (Ohio) and the
Singapore pairing above is **not available today**. Neon therefore sits in
`aws-us-east-2` (Ohio) instead, colocated with the functions.

Three further constraints follow: Background Functions are Pro-only, the
synchronous timeout is 10 s rather than 60 s, and Neon scale-to-zero cannot be
disabled. Full analysis, revised targets and upgrade triggers:
**[21-TIER-LIMITS](../21-TIER-LIMITS.md)**.

The decision in this ADR is unchanged — the stack is still correct. What changes
is capacity and operational posture, plus a known upgrade point before Phase 4.

## Consequences

### Accepted costs

**No India region on Neon.** Relational data including KYC sits in Singapore.
DPDP permits this today — Singapore is not a restricted country — but it is
standing policy risk on a multi-year product. **No longer partially mitigated
by India-resident document storage** — see the amendment below; the original
S3-in-Mumbai plan was replaced with Netlify Blobs, which has no region
control. See [11-COMPLIANCE-INDIA](../11-COMPLIANCE-INDIA.md).

**Netlify Pro subscription required.**

**Prisma needs two connection strings** — pooled for runtime, unpooled for
migrations. Running `prisma migrate deploy` through the pooler is the classic
deploy-day failure; it is wired into CI as a separate env var to make that hard
to get wrong.

**Neon autosuspend must be disabled** on the paid tier, or an associate hits a
cold start while standing in front of a customer.

### Follow-on decisions

This choice forces three others, each with its own ADR:
[no Redis](0005-netlify-native-jobs-no-redis.md),
[polling instead of SSE](0004-polling-not-sse.md), and pure-JS PDF generation
rather than Puppeteer.

## If full India residency is required

Decide **before Phase 0**. It is a one-line choice at kickoff and a painful
migration at Phase 4.

| Option | DB in India | App in India | Change required |
|---|:-:|:-:|---|
| Netlify + **Supabase** `ap-south-1` | Yes | No | Swap the Neon connection strings. Prisma unchanged |
| **AWS Mumbai** — App Runner/ECS + RDS | Yes | Yes | Lose Netlify's zero-config Next.js; add DevOps work |
| **Azure Central India** — App Service + Postgres Flexible | Yes | Yes | Same trade-off |

Nothing in the application design changes across these — it is standard Next.js
plus Prisma throughout.

## Alternatives considered

**Vercel + Neon** — better Next.js integration, but no Indian region either, and
Netlify's DB branching integration is at least as good for this workflow.

**AWS Mumbai from the start** — solves residency, costs weeks of DevOps the team
does not have, on a project whose risk is the commission engine and adoption, not
infrastructure.

**Supabase from the start** — has Mumbai, but we would trade Neon's PR branching
for it. Worth revisiting the moment residency becomes a hard requirement.

---

## Amendment — S3 replaced with Netlify Blobs

**Date:** 2026-09-05

### What changed

This ADR originally specified S3 in `ap-south-1` (Mumbai) for file storage,
specifically so documents and KYC scans stayed India-resident even though the
database rows did not (a deliberate partial mitigation for the Neon residency
gap above). The user decided against S3; the project uses **Netlify Blobs**
instead, since it requires no separate account or credentials given the stack
is already all-in on Netlify.

### Consequence: the India-resident-documents mitigation is gone

Netlify Blobs has no user-controlled region for the durable, cross-deploy
store this system needs (`getStore()`). A region CAN be set for a
*deploy-specific* store (`getDeployStore({ region })`), but that is scoped to
one deploy, not the kind of persistent storage KYC documents need. So as of
this amendment, **no artifact in this system — rows or files — is guaranteed
India-resident.** Full detail: [11-COMPLIANCE-INDIA](../11-COMPLIANCE-INDIA.md).

Also gone: presigned direct-to-storage uploads (S3's mechanism) and built-in
versioning/cross-region replication. Neither is a blocker — Blobs is reached
only through server code regardless, which is arguably the stricter posture —
but both are real, load-bearing capabilities this system no longer has for
free. See [10-SECURITY](../10-SECURITY.md) and
[15-OPS-RUNBOOK](../15-OPS-RUNBOOK.md).

### Why this wasn't fought

The India-residency gap on the *database* (no Neon region in India) was
already an accepted, documented risk in this ADR before this amendment.
Extending that same gap to documents is a real regression, not a neutral
trade — but re-litigating it would mean re-opening the storage-provider
decision the user already made. Recorded here so it is visible at the next
compliance review, not silently absorbed.

### Revisit if

India residency for documents specifically becomes a hard client requirement.
The fallback is not a code change — it is a provider decision: reintroduce an
S3-compatible bucket in `ap-south-1` for documents alone (Netlify Blobs
elsewhere), or move file storage entirely to a provider with real region
control (Cloudflare R2, Backblaze B2 — neither has a Mumbai region either,
so this still needs a real answer, not an assumption).
