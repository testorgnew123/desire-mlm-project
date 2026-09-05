# 10 — Security

This system holds KYC for buyers and associates, and it moves money. Treat both
accordingly.

## Authentication

| Control | Setting |
|---|---|
| Hashing | argon2id |
| Session | `httpOnly` + `secure` + `sameSite=lax` cookie, server-side session row |
| Idle timeout | 12 h (`SESSION_IDLE_TIMEOUT_MINUTES`) |
| Absolute timeout | 7 d |
| Lockout | 5 failed attempts → 15 min lock, per IP **and** per account |
| MFA | TOTP, mandatory for `SUPER_ADMIN`, `FINANCE_ADMIN`, `SALES_HEAD` |
| Session revocation | `Session.revokedAt`; role change or password reset revokes all |

Impersonation (support) requires `SUPER_ADMIN`, shows a persistent banner, and
writes `AuditAction.IMPERSONATE`.

## Authorization

Enforced in `packages/services`. Every method takes an actor and asserts before
touching data. Handlers never authorize. See [09-RBAC-MATRIX](09-RBAC-MATRIX.md).

Row scoping goes through one tested resolver, never ad-hoc `where` clauses.

## Fraud vectors — the ones specific to this product

### 1. Receipt fraud unlocking commission

Commission releases pro-rata on collection, so **whoever can mark money as
received can unlock their own or their team's pay.** The highest-value control in
the system:

```ts
assert(receipt.enteredById !== actor.id)                  // maker-checker
assert(actor.associateId !== booking.sellingAssociateId)  // not the seller
assert(!uplineChainOf(booking.sellingAssociateId).includes(actor.associateId))
```

Plus: only `VERIFIED` receipts with a `clearedOn` date count toward release.

### 2. Scheme manipulation

Anyone who can both write a commission scheme and run a payout can pay themselves
whatever they like. `scheme.approve` and `payout.prepare` are mutually exclusive,
and accrual hard-asserts `maxTotalPct`.

### 3. Tree manipulation before a payout

Moving yourself above a high performer just before month-end harvests their
overrides. **Tree moves and grade changes are frozen while a payout period is
open**, and every move is logged with its subtree size.

### 4. Self-referral and cycles

An associate can never be their own ancestor. Cycle detection runs on every move.

### 5. Backdated bookings

`bookingDate` outside a configurable window from `createdAt` requires approval —
otherwise a booking can be backdated into a more favourable scheme version.

## Data protection

| Data | Treatment |
|---|---|
| PAN, Aadhaar, bank account | **AES-256-GCM at the application layer** before insert. Only `last4` stored plainly, for display |
| Passwords | argon2id, never recoverable |
| In transit | TLS 1.3 |
| At rest | Neon encrypts the volume; field encryption is *in addition*, so a database dump is not a KYC breach |

Key material is `PII_ENCRYPTION_KEY` with a `PII_ENCRYPTION_KEY_ID`. Rotation
keeps old keys available for decryption — **rotating without re-encrypting makes
that data unreadable.**

### PII handling rules

- Aadhaar is masked in **all** UI, logs, and exports. No exceptions.
- PAN is masked outside finance.
- Viewing a KYC document writes `AuditAction.VIEW_SENSITIVE`.
- PII never appears in URLs or query strings.
- Structured logs run through a redaction filter keyed on field name.
- Error reports (Sentry) scrub request bodies on any route touching KYC.

## Uploads

MIME allowlist · size cap · virus scan before the object is readable ·
short-TTL presigned S3 URLs (`S3_PRESIGNED_URL_TTL_SECONDS`) · no public
buckets, ever · content-type set on the object, never trusted from the client.

## Application security

- Parameterized queries via Prisma. Raw SQL only for the partial indexes, in migrations.
- CSP headers; no inline scripts.
- CSRF: Next handles server actions; explicit tokens on route handlers.
- No `eval`, no dynamic `require`.
- Dependabot + `npm audit` gate CI.
- Job endpoints require `JOB_TRIGGER_SECRET` — otherwise anyone can trigger a payout run.

## Rate limits

| Endpoint | Limit |
|---|---|
| Login | 5 / 15 min per IP + account |
| Hold acquire | 30 / min per associate |
| Report export | 10 / hour per user |
| All others | 100 / min per token |

## Audit

`AuditLog` is append-only: no `UPDATE`, no `DELETE`. Retention by partitioning,
not deletion. Captures actor, action, entity, before/after JSON, IP, user agent,
request id.

Logged beyond ordinary mutations: login and failed login, logout, exports,
sensitive-document views, impersonation, every approval decision.

## Before go-live

- [ ] Penetration test by an external firm — **non-negotiable**
- [ ] Secrets rotated off any development values
- [ ] `AUTH_SECRET` and `PII_ENCRYPTION_KEY` generated fresh for production
- [ ] MFA enrolled for every privileged user, verified
- [ ] Separation-of-duties assertions each covered by a passing test
- [ ] Invariant monitor running and paging
- [ ] Backup restore drill completed
- [ ] No `PLACEHOLDER` values remaining in production config
