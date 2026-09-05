# 11 — India Compliance

> Nothing here is legal advice. Every rate and rule must be confirmed with the
> client's CA and legal counsel before go-live. The engineering commitment is
> that all of it is **configurable data**, not constants in code.

## RERA

The Real Estate (Regulation and Development) Act 2016.

| Requirement | Implementation |
|---|---|
| Project registration before marketing | `Project.reraRegNo`, `reraValidTill`. Units cannot be held or booked under an expired registration |
| **Carpet area disclosure** | `UnitType.carpetArea` mandatory; printed on cost sheet, allotment letter, agreement, and shown on every customer-facing screen |
| Agent registration | `Associate.reraAgentRegNo` — relevant for `CHANNEL_PARTNER`. An employee of the promoter is generally not a separately registrable agent; **confirm with counsel** |
| 70% escrow of collections | Out of scope for this system, but receipts export to the client's accounting for it |
| Quarterly project updates | Reports available; filing is manual |

Carpet area is the RERA figure. Pricing is quoted on saleable area. Both are
stored and both are shown, always labelled. See [19-GLOSSARY](19-GLOSSARY.md).

## Tax on commission — driven entirely by engagement type

`Associate.engagementType` is the single field that decides everything:

| `engagementType` | Nature | TDS | GST | Route |
|---|---|---|---|---|
| `EMPLOYEE` | Incentive = salary | **Sec. 192**, slab rate | **None** | Payroll |
| `CONSULTANT` | Professional fee | Sec. 194J | 18% if registered | Direct |
| `CHANNEL_PARTNER` | Brokerage | Sec. 194H | 18% if registered | Direct |

**The network is in-house staff, so `EMPLOYEE` is the expected default** — which
means commission flows through payroll under Sec. 192, and no GST arises. Many
Indian developers nonetheless run mixed models. The field exists so this is data,
not an assumption baked into the code.

> **Open item.** Confirm the actual engagement basis with the client's CA before
> Phase 4. It changes the TDS section, GST treatment, and whether payouts route
> through payroll or the bank file. Getting it wrong is a compliance exposure,
> not a bug.

### Rates are rows, not constants

`TaxRate` is effective-dated with `validFrom` / `validTo`. Rates change at every
Finance Act — Sec. 194H moved from 5% to 2% with effect from 1 October 2024.
Seed the current values only after CA confirmation, and keep history so a
payout run crossing a rate change resolves correctly per period.

`noPanRatePct` covers Sec. 206AA — a higher rate where the payee has no PAN on
file.

## GST on the unit sale

| Case | Rate |
|---|---|
| Under-construction, affordable housing | 1%, no ITC |
| Under-construction, other | 5%, no ITC |
| Ready-to-move with completion certificate | Nil |

Feeds `Booking.gstAmount`. **Excluded from the commissionable base by default** —
paying commission on the tax collected for the government is a straightforward
overpayment.

## Stamp duty & registration

State-specific, normally buyer-borne. Tracked on the booking for the cost sheet
and the total the buyer owes. **Never commissionable.**

## DPDP Act 2023

This system holds buyer and associate KYC — personal data under the Act.

| Obligation | Implementation |
|---|---|
| Purpose limitation | KYC collected only for booking and payout |
| Security safeguards | Field-level AES-256-GCM, masking, access audit — [10-SECURITY](10-SECURITY.md) |
| Access logging | `AuditAction.VIEW_SENSITIVE` on every KYC document view |
| Retention | Policy required — **open item**, needs counsel |
| Breach notification | Runbook required — [15-OPS-RUNBOOK](15-OPS-RUNBOOK.md) |
| Data principal rights | Access and correction via the admin console; erasure constrained by statutory retention |

### Cross-border transfer — the live issue

**Neon has no India region.** Available regions are `us-east-1`, `us-east-2`,
`us-west-2`, `eu-central-1`, `eu-west-2`, `ap-southeast-1` (Singapore),
`ap-southeast-2`, `sa-east-1`. Netlify has no Indian function region either.

So under the chosen stack, **relational data including KYC sits outside India.**

> **On the free tier it sits in the United States, not Singapore.** Netlify Free
> locks functions to Ohio, so Neon is colocated in `aws-us-east-2` to avoid a
> Pacific round trip on every query ([21-TIER-LIMITS §2](21-TIER-LIMITS.md)).
> Neither country is currently restricted under DPDP, so the analysis below is
> unchanged in kind — but the client should be told the data is US-hosted, and
> the answer to "where is our data" changes again on upgrade.

Where that stands:

- DPDP does **not** impose blanket localization. It permits cross-border transfer
  except to countries the government restricts. Singapore is not restricted today.
  Legal now — **standing policy risk** over a multi-year product.
- **RBI payment-data localization** binds the payment gateway, not this system,
  provided we never store card or payment-instrument data. We don't. Keep it that way.
- The practical risk is the client's counsel, not the statute — and that
  requirement usually surfaces at contract signing, not at kickoff.

**The India-resident-documents mitigation no longer applies.** The original
design put file storage on S3 `ap-south-1` (Mumbai) specifically so documents,
KYC scans and agreements stayed India-resident even though the database rows
did not. **The project uses Netlify Blobs instead** (decided during Phase 0 —
see PROGRESS.md decision log), which has no user-controlled region: Netlify's
own docs describe it as stored in a single region with edge caching, without
specifying or letting the caller pin which region for the site-wide store
`getStore()` uses (a region CAN be set for a *deploy-specific* store via
`getDeployStore({ region })`, which does not apply to the durable, cross-deploy
storage this system needs). So as of this decision, **no artifact in this
system — rows or documents — is guaranteed India-resident.**

This raises, not lowers, the residency question's stakes. If India residency
for documents specifically turns out to matter to the client, Netlify Blobs
does not offer a way to satisfy it; the fallback would be reintroducing an
S3-compatible bucket in `ap-south-1` for documents alone while keeping Blobs
for anything non-sensitive, or moving file storage to a provider with real
region control (Cloudflare R2, Backblaze B2) — see [ADR-0001](adr/0001-nextjs-netlify-neon.md)
for the equivalent database-residency alternatives, which apply here too.

**Decide before the first real document is stored** — practically, before
Phase 2 (KYC upload, cost sheets, agreements). Today's Phase 0/1 data is
synthetic and no documents have been uploaded, so this is not urgent, but it
is a real gap to close before it is.

## Outputs the system must produce

- Form 16A (Sec. 194H / 194J payees); Form 16 data handed to payroll for Sec. 192
- TDS challan export, quarterly return data
- GST reconciliation on brokerage
- Statements matching Form 26AS
- RERA-compliant cost sheet, allotment letter, agreement with carpet area
- Demand letters
- DLT-registered SMS templates and approved WhatsApp templates

## Compliance checklist before go-live

- [ ] CA has reviewed the tax fixtures in `packages/tax`
- [ ] `TaxRate` rows seeded with current, CA-confirmed values
- [ ] Engagement type confirmed for every associate
- [ ] RERA registration numbers and validity loaded for every live project
- [ ] Carpet area verified against the RERA filing for every unit type
- [ ] Data residency decision made and documented
- [ ] Retention policy defined with counsel
- [ ] WhatsApp templates approved; SMS templates DLT-registered
