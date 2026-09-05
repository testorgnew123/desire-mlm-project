# 17 — Rollout, Training & Change Management

The technical risk is Phases 1 and 3. **The delivery risk is adoption.**

Commission-paid sales associates will not use a system they do not trust with
their money — and they have a working spreadsheet to fall back on. A technically
perfect platform that associates route around has failed.

## Principle

> Trust is built by associates being able to **audit their own payout**, not by
> being told the system is correct.

Every decision below follows from that.

## Pilot before launch

**One project, one team, four weeks.** Not a company-wide launch.

| Week | Focus |
|---|---|
| 1 | Inventory only. Associates browse and hold. Bookings still on the spreadsheet |
| 2 | Bookings and collections in-system, spreadsheet in parallel |
| 3 | Commission visible. Associates compare against their own records |
| 4 | Full loop including a payout dry run |

Pilot team selection matters: pick a team with a **respected senior associate**
and a manager who is willing to complain loudly. A team that quietly tolerates
problems teaches you nothing.

## Ship "explain this number" in the pilot

Not in Phase 5. Not "once the basics work".

The commission drill-down ([08-SCREENS §2](08-SCREENS.md)) is the feature that
converts sceptics. An associate who can expand ₹15,000 into base → grade → rate →
level → release rule stops keeping a private spreadsheet. One who cannot, does
not — no matter how correct the number is.

## Parallel run

Covered in [14-DATA-MIGRATION](14-DATA-MIGRATION.md), repeated here because it is
as much an adoption mechanism as a data one.

For 30 days both systems run and month-end payouts are compared **to the rupee**.
Associates watch the numbers agree before anyone asks them to trust the new one.

The spreadsheet is retired only after a month that matches exactly.

## Champions

One respected senior associate per team, trained first, a week ahead.

They answer the questions people will not ask the project team, and their opinion
carries more weight in the sales floor than any training session. If the
champions are not convinced, stop and find out why before rolling further.

## Training

| Audience | Format | Length |
|---|---|---|
| Finance / admin | Hands-on, real data, in their own workflow | 2 h |
| Sales admin | Hands-on: bookings, receipts, hold administration | 2 h |
| Managers | Team dashboards, approvals, override earnings | 1 h |
| **Associates** | **Mobile only.** Live on their own phones | 45 min |

Associates get a **one-page laminated card**: how to hold a unit, how to read
the countdown, how to log a follow-up, how to read their earnings. Not a PDF —
paper, in their pocket.

Do not train associates on the desktop app. They will never open it, and time
spent on it signals the product was not built for them.

A WhatsApp support group runs for the pilot duration, staffed by the project team
during business hours. It is where you will learn what is actually broken.

## Communication before launch

| When | What |
|---|---|
| 4 weeks before | Announce: what, why, what changes for you |
| 3 weeks before | Champions trained |
| 2 weeks before | Spreadsheet freeze date announced |
| 1 week before | Training sessions |
| Launch | Support group live, champions on the floor |
| Weekly through pilot | Open feedback session, decisions published |

Say plainly what associates gain: real-time inventory, no more double-selling
arguments, and a commission number they can check themselves. Do not lead with
"management visibility" — that is what they are afraid of.

## Success metrics

| Metric | Target |
|---|---|
| Bookings created in-system | 100% by pilot week 4 |
| Holds via the app vs verbal | > 90% by week 3 |
| Manual commission spreadsheets in use | **Zero by month 2** |
| Payout disputes per cycle | < 2% of associates |
| Parallel-run variance | ₹0 for one full month before retirement |
| Associate weekly active use | > 85% |
| Collections follow-ups logged against overdue demands | > 80% |

The zero-spreadsheets metric is the real one. Everything else can look healthy
while associates quietly maintain their own records — and that means they still
do not trust it.

## Feedback loop

Weekly during pilot, monthly after. An in-app feedback button, permanently.

Publish what changed as a result. Feedback that visibly changes the product
generates more feedback; feedback into a void stops within two weeks.

## Rollout beyond the pilot

Project by project, not all at once. Each new project gets its champions trained
first and a two-week parallel run of its own.

Stop and reassess if any project shows: bookings still arriving by WhatsApp
after week 2, more than 5% payout disputes, or champions going quiet.
