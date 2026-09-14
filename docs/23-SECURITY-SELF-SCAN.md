# 23 — Security Self-Scan (Free-Tier Substitute)

Phase 5. `docs/10-SECURITY.md`'s own "Before go-live" checklist calls a
penetration test by an external firm **non-negotiable** — professional
pen-test firms are a paid service, and the client cannot fund any paid
service, ever (`PROGRESS.md` decision log, 2026-09-13). This is **not**
that audit. It's a best-effort internal pass using free, open-source
tooling, run once, documented honestly. Treat every finding below as real;
treat the absence of a finding as "not found by this pass," not as
"secure."

## 1. `pnpm audit` — dependency vulnerabilities

13 findings (1 critical, 4 high, 8 moderate) as of 2026-09-14. **All 13 are
in dev/build tooling, not runtime production code**:

| Package | Path | Severity | Why it doesn't reach production |
|---|---|---|---|
| `vitest` / `@vitest/mocker` | `packages/*` test tooling | critical, high | Only runs during `pnpm test`, never in the deployed app. The critical finding requires the Vitest UI server listening, which nothing in CI or prod ever starts |
| `vite` | pulled in by `vitest` | high, moderate | Same — dev/test-only dependency chain |
| `postcss` | pulled in by `next`'s build pipeline | high, moderate (×2) | Runs at build time inside Netlify's build container, never at request time in the deployed function |
| `uuid` | pulled in by `autocannon` (the load-test tool, `apps/web/scripts/load-test.mjs`) | moderate | `autocannon` is a devDependency, never bundled or run in production |
| `launch-editor` | pulled in by `vite` | moderate | Dev-server-only, triggers a code editor to open a file; irrelevant outside a local dev machine |

**Not fixed this pass**: the patches are all major-version bumps to
`vitest`/`vite` (2.x → 4.x), which is a real upgrade to plan and verify
deliberately, not something to force blindly during a security scan whose
own premise is "verify before trusting." Tracked here rather than silently
ignored. None of the 13 change the actual runtime attack surface a real
pen-test would probe.

## 2. Manual OWASP Top 10 (2021) pass

Checked against what actually exists in the code, not assumed from docs.

| # | Category | Finding |
|---|---|---|
| A01 | Broken Access Control | Every service function checked this pass goes through `assertPermission` or an equivalent scope check (own/downline/admin) before touching data — confirmed for the six new Phase 5 report functions specifically, each with a real-Postgres test asserting the wrong role is refused. No new gap found. |
| A02 | Cryptographic Failures | PII (bank account, PAN) encrypted at rest via `packages/services/src/encryption.ts` (AES-256-GCM); passwords via `@node-rs/argon2`. Unchanged this pass. |
| A03 | Injection | Prisma parameterizes every query except the handful of raw SQL calls introduced this pass (`packages/services/src/backup.ts`, `packages/services/src/reports.ts`'s table-name discovery, `packages/db/scripts/restore-drill.ts`). All three build table/column identifiers from `information_schema` or the dump's own recorded keys — never from user input — so there is no injectable string in any of them. Verified by reading each call site, not assumed. |
| A04 | Insecure Design | **Real gap found, not introduced this pass**: `docs/10-SECURITY.md`'s own rate-limit table ("Login 5/15min", "Report export 10/hour", "All others 100/min") names limits that **do not exist anywhere in the codebase** — confirmed by grep, zero matches for any rate-limiting mechanism. This predates Phase 5 (it's not specific to the new report routes) and is a real, standing gap: nothing stops a credential-stuffing loop against `/login` or a scripted loop against any `/api/v1/*` route today. Not fixed this pass — a real rate limiter needs a shared counter store, and this project explicitly has no Redis ([ADR-0005](adr/0005-netlify-native-jobs-no-redis.md)); a serverless-function-safe design (DB-backed counters, or a free-tier-compatible edge rate limiter) is real design work, not a quick patch, and deserves its own pass rather than a rushed addition here. |
| A05 | Security Misconfiguration | `JOB_TRIGGER_SECRET`/`LEAD_WEBHOOK_SECRET` both fail closed (reject every request) when unset, confirmed by reading each route's auth check. CSP headers and no-inline-script already documented in `docs/10-SECURITY.md` §Application security — not re-verified this pass (no code change touched them). |
| A06 | Vulnerable Components | See §1 above. |
| A07 | Identification and Authentication Failures | Session tokens hashed before storage (`packages/services/src/auth.ts`), constant-time compared everywhere a shared secret is checked (every job route, the new webhook route) — confirmed by reading each comparison, all use `timingSafeEqual` over a SHA-256 hash, never `===`. |
| A08 | Software and Data Integrity Failures | Backup restore (`packages/db/scripts/restore-drill.ts`) trusts the JSON dump's own field names/values with no signature or checksum — acceptable for a same-project internal DR tool reading its own backup output, not acceptable if this dump were ever exposed to an untrusted party. Noted, not treated as a real-world exploitable gap given the Blobs store access is already gated by Netlify's own auth. |
| A09 | Security Logging and Monitoring Failures | `AuditLog` covers every mutation and every export (`AuditAction.EXPORT`, wired for real this phase in `packages/services/src/export.ts`). No intrusion-detection/anomaly alerting exists — out of scope for a project on the free tier with no paid monitoring product, consistent with `docs/21-TIER-LIMITS.md`'s permanent-free-tier posture. |
| A10 | Server-Side Request Forgery | No code in this codebase makes an outbound HTTP request to a user-supplied URL (checked: the portal lead webhook is inbound-only, the new SMTP/email code connects to a fixed, operator-configured host, never a request-supplied one). No finding. |

## 3. What this scan cannot do

- No fuzzing, no automated exploit attempts, no authenticated crawl.
- No infrastructure-level check (Netlify/Neon's own security posture is
  their responsibility, not auditable from inside this codebase).
- No timing-side-channel or business-logic-abuse testing beyond what's
  already covered by this project's own test suite.

**The real external penetration test `docs/10-SECURITY.md` calls
non-negotiable remains blocked on budget** — same status as BLOCKED#14 in
`plan.md`. This document is not a substitute for it; it is what could be
done for free in its place.
