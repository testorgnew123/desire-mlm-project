# 19 — Glossary

> **Read this before writing code.** These terms are not intuitive, several look
> interchangeable and are not, and getting one wrong produces software that runs
> perfectly while paying the wrong amount to the wrong person.

## Area — three numbers, never interchangeable

| Term | Meaning | Where it matters |
|---|---|---|
| **Carpet area** | Net usable floor area within walls, excluding external walls, shaft, balcony, terrace | **RERA-mandated.** Must appear on the cost sheet, allotment letter and every customer-facing screen |
| **Built-up area** | Carpet + internal walls + balcony | Rarely quoted to customers now; legacy data uses it |
| **Saleable / super built-up area** | Built-up + a share of common areas (lobby, stairs, amenities) | **What price per sqft is quoted on.** Also the multiplier for `PER_SQFT` commission rates |

The loading factor between carpet and saleable is typically 1.3–1.5×. Quoting a
carpet-area price against a saleable-area rate misprices a unit by ~35%.

## Money on a booking

| Term | Meaning |
|---|---|
| **BSP** (Basic Sale Price) | Base rate × saleable area. The core price before anything is added |
| **PLC** (Preferential Location Charge) | Premium for corner, park-facing, higher floor, etc. Priced per sqft, keyed off `Unit.plcTags` |
| **IFMS** (Interest-Free Maintenance Security) | Refundable deposit held for maintenance. Refundable, so normally excluded from commission |
| **Agreement value** | Total the customer owes: BSP + PLC + parking + club + IFMS + GST + stamp duty + registration |
| **Commissionable value** | **The subset commission is computed on.** Almost never the agreement value — usually BSP only, or BSP + PLC. Defined by `CommissionScheme.baseDefinition`, resolved once at booking confirmation, then frozen on the booking |
| **Net realization** | What the developer actually keeps after discount. Not currently a commission base, but the term appears in client conversations |

> Confusing agreement value with commissionable value overpays commission by
> roughly 30–40% on every sale. This is the single most expensive mistake
> available in this codebase.

## Collections

| Term | Meaning |
|---|---|
| **Payment plan** | Template of milestones and percentages (e.g. CLP, "10:80:10") |
| **Demand** | A single scheduled amount the customer owes, with a due date. Generated from the plan at booking |
| **Demand letter** | The document sent to the customer asking for a demand |
| **Receipt** | Money actually received. Has `receivedOn` **and** `clearedOn` — a cheque in hand is not money in the bank |
| **Allocation** | The link between a receipt and a demand. Many-to-many: one cheque can settle two demands, one demand can take three transfers. **The only source of truth for how much a demand has been paid** |
| **Credit balance** | Overpayment parked on the booking, auto-applied to the next demand raised |
| **CLP** | Construction-Linked Plan — demands trigger on construction milestones, not dates |

## Sales lifecycle

| Term | Meaning |
|---|---|
| **Hold** | Temporary exclusive claim on a unit by one associate. Timed, quota-limited, auto-expiring |
| **Booking** | Customer has committed and paid a booking amount. Unit leaves the available pool |
| **Allotment letter** | Developer's formal confirmation of the unit to the buyer |
| **Agreement to Sale** | The registered sale agreement. A distinct legal milestone from booking |
| **Registration** | Registration of the agreement with the sub-registrar; stamp duty paid |
| **Possession** | Handover after the completion certificate |
| **Cancellation** | Booking reversed. Triggers commission clawback |

## Commission — the terms most often conflated

| Term | Meaning |
|---|---|
| **Grade** | The associate's rank. Sets their commission rate on their **own** sales |
| **Level** | Distance up the tree from the seller. L1 is the seller's immediate upline |
| **Self commission** | What the selling associate earns: their grade rate × commissionable value |
| **Override** | What an upline earns: a fixed **percentage of the seller's commission**, by level. *Not* a percentage of the sale |
| **Upline / downline** | Ancestors / descendants in the hierarchy |
| **Compression** | What happens when the upline at a level is ineligible. `NONE` = the level is consumed and the amount becomes breakage. `ROLL_UP` = the level is not consumed and the next eligible upline takes it |
| **Breakage** | Override money nobody qualified for. Retained by the company |
| **Accrual** | Recording what is **owed** when a booking confirms. Not yet payable |
| **Release** | Moving accrued money to **payable**, as the buyer pays |
| **Payout** | Actually paying it, in a batch, after tax |
| **Clawback** | Reversing released or paid commission after a cancellation |
| **Recovery** | Outstanding clawback owed *back* by an associate, netted off future payouts |
| **Contra entry** | A reversing ledger row. The **only** way to correct a commission entry — never an UPDATE |
| **Snapshot** | The resolved grade, rates and upline chain frozen onto an entry at accrual, so the number stays explainable years later |

### Accrued vs released vs paid, concretely

A ₹1cr sale at 1.5% accrues **₹1,50,000** the day the booking confirms. If the
buyer has paid 30% of the agreement value, **₹45,000** is released (payable). If
last month's batch already paid ₹20,000 of that, then **₹25,000** is payable now
and **₹1,05,000** remains accrued but not yet payable.

Finance provisions against *accrued*. Associates ask about *payable*. Their bank
statement shows *paid*. Three different numbers, all correct.

## Tax & regulatory

| Term | Meaning |
|---|---|
| **RERA** | Real Estate (Regulation and Development) Act 2016. Mandates project registration, carpet-area disclosure, escrow of 70% of collections |
| **TDS** | Tax Deducted at Source. Which section applies depends entirely on `EngagementType` |
| **Sec. 192** | TDS on **salary**. Applies when the associate is an `EMPLOYEE` and commission is an incentive |
| **Sec. 194H** | TDS on **commission/brokerage**. Applies to `CHANNEL_PARTNER` |
| **Sec. 194J** | TDS on **professional fees**. Applies to `CONSULTANT` |
| **Sec. 206AA** | Higher TDS rate when the payee has no PAN on file |
| **GST** | On the *unit sale*: 1% affordable / 5% non-affordable under-construction, nil for ready-to-move with CC. On *brokerage*: 18%, only if the associate is GST-registered — never for an employee |
| **Form 16 / 16A** | TDS certificates. 16 for salary (Sec. 192), 16A for everything else |
| **DLT** | TRAI's Distributed Ledger Technology registry. SMS templates must be pre-registered |
| **DPDP Act** | Digital Personal Data Protection Act 2023. Governs the KYC data this system holds |

## System-specific

| Term | Meaning |
|---|---|
| **Effective dating** | `validFrom` / `validTo` on assignments, so a past commission run resolves the grade and tree that were true *then* |
| **Maker-checker** | Two-person control: preparer and approver must differ |
| **Idempotency key** | Prevents a retried job double-accruing or double-releasing |
| **Escalation rung** | One step of the collections alert ladder. Each fires at most once per demand |
| **Delta poll** | The inventory board's refresh mechanism — returns only units changed since a timestamp |
