# Real Estate Sales & Commission Platform

> **Working title.** Product name TBD — see Open Items in [plan.md](plan.md).

Sales, inventory and multi-level commission management for a residential real estate
developer selling its own (primary) inventory in India.

## What it does

| Problem today | What the platform does |
|---|---|
| Associates don't know what's actually available; units get double-sold | Live inventory board with timed, quota-limited holds and DB-enforced exclusivity |
| Commission computed by hand each month, disputed, unauditable | Commission engine whose every rupee is reproducible, explainable and reversible |
| Collections chased over WhatsApp, nothing tracked | Demand schedules, receipt entry with maker-checker, automated escalation ladder |
| No view of who sold what, or what a team is worth | Role-scoped dashboards, downline rollups, payout batches with statements |

## Core model in one paragraph

Associates sit in an **admin-assigned hierarchy**. Each holds a **grade**, and the grade
sets the commission rate on their own sales. Their uplines earn a **fixed percentage of
that commission** by tree level (L1, L2, L3…). Commission **accrues** when a booking is
confirmed and **releases** as the buyer actually pays, on a schedule configured per
project. Cancellations reverse it. Nothing is ever edited — corrections are contra
entries against an append-only ledger.

## Stack

Next.js 15 (App Router) · TypeScript · Prisma · Postgres (Neon) · Netlify · S3 · Auth.js

See [ADR-0001](docs/adr/0001-nextjs-netlify-neon.md) for why, and
[02-ARCHITECTURE](docs/02-ARCHITECTURE.md) for how it fits together.

## Documentation map

Start with the PRD, then the spec for whatever you're building.

### Understand the product
| Doc | Read it when |
|---|---|
| [01-PRD](docs/01-PRD.md) | You need scope, users, and what's explicitly out |
| [19-GLOSSARY](docs/19-GLOSSARY.md) | **Read this before writing any code.** The domain terms are not intuitive and getting one wrong pays the wrong amount |
| [16-ROADMAP](docs/16-ROADMAP.md) | You need phases, exit criteria, team, effort |
| **[PROGRESS](PROGRESS.md)** | **Daily.** What is done, what is blocked, what to pick up next. Keep it open |

### Build it
| Doc | Read it when |
|---|---|
| [02-ARCHITECTURE](docs/02-ARCHITECTURE.md) | Setting up, or deciding where code belongs |
| [03-DATA-MODEL](docs/03-DATA-MODEL.md) | You need the ERD and entity dictionary |
| [04-COMMISSION-SPEC](docs/04-COMMISSION-SPEC.md) | Touching anything that computes money |
| [05-COLLECTIONS-SPEC](docs/05-COLLECTIONS-SPEC.md) | Demands, receipts, allocation, alerts |
| [06-INVENTORY-SPEC](docs/06-INVENTORY-SPEC.md) | Units, holds, state machine, price lists |
| [07-API](docs/07-API.md) | Adding an endpoint or a server action |
| [08-SCREENS](docs/08-SCREENS.md) | Building UI |
| [20-REPORTS](docs/20-REPORTS.md) | Building a report |

### Don't get it wrong
| Doc | Read it when |
|---|---|
| [09-RBAC-MATRIX](docs/09-RBAC-MATRIX.md) | Any question of who can do what |
| [10-SECURITY](docs/10-SECURITY.md) | Auth, PII, uploads, or anything money-adjacent |
| [11-COMPLIANCE-INDIA](docs/11-COMPLIANCE-INDIA.md) | RERA, GST, TDS, DPDP |
| [12-NFR](docs/12-NFR.md) | Performance or scale targets |
| [13-TEST-STRATEGY](docs/13-TEST-STRATEGY.md) | Writing tests — especially commission tests |
| [21-TIER-LIMITS](docs/21-TIER-LIMITS.md) | **Read before assuming any capacity number.** We are on Netlify Free + Neon Free |

### Ship and run it
| Doc | Read it when |
|---|---|
| [14-DATA-MIGRATION](docs/14-DATA-MIGRATION.md) | Importing legacy spreadsheets, cutover |
| [15-OPS-RUNBOOK](docs/15-OPS-RUNBOOK.md) | Monitoring, backups, DR, on-call |
| [17-ROLLOUT](docs/17-ROLLOUT.md) | Pilot, training, adoption |
| [18-RISKS](docs/18-RISKS.md) | Risk register |

### Decisions
[docs/adr/](docs/adr/) — six architecture decision records covering the choices most
likely to be re-litigated later by someone who wasn't in the room.

## Getting started

> Nothing is implemented yet. This repository currently holds the design set and the
> Prisma schema. Phase 0 (see [16-ROADMAP](docs/16-ROADMAP.md)) begins by running the
> schema.

```bash
cp .env.example .env.local        # fill in the values
npm install
npx prisma migrate dev            # creates the schema from prisma/schema.prisma
npx prisma db seed                # PLACEHOLDER grades, rates, and a demo project
npm run dev
```

## A note on PLACEHOLDER values

The client has not supplied the grade ladder, commission rates, level override
percentages, hold durations, or escalation offsets. Every such value in these documents
and in `prisma/schema.prisma` is tagged **`PLACEHOLDER`** and listed in
`plan.md` → Open Items.

**Do not ship a PLACEHOLDER.** They exist so the system can be built and demonstrated,
not so it can go live unconfirmed. Paying an associate the wrong rate once costs more
trust than the whole project buys.
