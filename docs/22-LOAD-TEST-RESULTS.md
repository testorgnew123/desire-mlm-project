# 22 — Load Test Results

> ## Production latency investigation, 2026-09-20
>
> The client reported the deployed app "feeling slow". Measured production
> directly (10 samples per route, median TTFB) instead of guessing, and found
> the cause was **geography, not application code**:
>
> - The Netlify function ran in **`us-east-2` (Ohio)** — confirmed via
>   `netlify api getSite` → `functions_region` — while Neon sat in
>   **`ap-southeast-1` (Singapore)**. Every request therefore went
>   India → Ohio → Singapore → Ohio → India.
> - Measured RTT from the client machine: **~270 ms to Ohio, ~60 ms to
>   Singapore**. The Ohio↔Singapore leg cost **~200 ms per query**, paid on
>   every single round trip, warm or cold.
> - The dashboard needs **7 sequential round trips minimum (21 queries
>   total)**, so ~1.5 s of its latency was pure network.
>
> **Fix: moved the database to `aws-us-east-2`, colocating it with the
> function** (Neon cannot change an existing project's region, so this was a
> new free project + a data migration through this repo's own backup/restore
> tooling — 59 tables, 436 rows, verified row-for-row before cutover).
>
> | Route | Before | After | |
> |---|---|---|---|
> | `/login` (renders a page, **zero** DB queries) | 471 ms | 437 ms | unchanged, as expected |
> | `/api/health` (same, plus **one** `SELECT 1`) | 643 ms | 443 ms | **−200 ms** |
>
> (Minimum of 10 samples — the cleanest signal, least polluted by cold starts
> and Neon's free-tier scale-to-zero wake.) The per-query penalty collapsed
> from **~193 ms to ~6 ms**: `/api/health` now costs the same as the route
> that does no database work at all, which is exactly what colocation should
> produce.
>
> **The remaining ~440 ms floor is the India→Ohio round trip and is not
> fixable on the free tier.** Netlify only allows choosing the function region
> on **Pro**, which the permanent no-paid-services constraint rules out
> (PROGRESS.md decision log, 2026-09-13). Recorded in
> [21-TIER-LIMITS §7](21-TIER-LIMITS.md), not quietly absorbed.
>
> ### End state, measured live in production
>
> | Measurement | Result |
> |---|---|
> | `/api/health` (one query) | **442 ms min / 498 ms median** (was 643/891) |
> | `/login` (zero queries) | 485 ms min |
> | Authenticated `/dashboard`, real data | **537–674 ms first byte, 650–790 ms total** |
>
> `/api/health` is now *faster* than `/login` — a database query no longer
> costs more than not doing one, which is the whole point. The dashboard
> makes **≥7 sequential round trips**, so at the pre-move rate of ~193 ms
> each it was carrying roughly **1.3–1.5 s** of pure network that is now gone.
> (That delta is an inference from two solid measurements — the per-query
> penalty and the round-trip count — not a directly measured before/after of
> the authenticated page, which was never captured pre-move.)
>
> ### On the streaming change: working, but currently invisible
>
> Reading the production response chunk by chunk, `/dashboard` arrives in
> **6–9 chunks**, so it genuinely streams. But the skeleton and the real tile
> data now land in the *same millisecond* — because with the database
> colocated the tile queries finish before the shell has even flushed. Run
> against local Postgres, where render is slow relative to the DB, the gap is
> visible and real: **skeleton at 98 ms, data at 196 ms** in one response.
>
> So the colocation win has made the streaming win redundant *at today's data
> volume*. It is kept deliberately anyway: it is the thing that stops one slow
> query blocking an entire page once there is real data (the audit log alone
> is projected at 1–2 GB/year), and `loading.tsx` still gives instant feedback
> on client-side navigation regardless of query speed.
>
> ## Round two, same day: cold start, bundle weight, indexes
>
> With warm requests near the ~440 ms network floor, the remaining prize was
> the **cold start** — the worst experience any user gets on this tier, since
> Netlify Free has no provisioned concurrency.
>
> | | Before | After |
> |---|---|---|
> | **Cold `/dashboard`** (first hit after a deploy) | **4.2 s** | **1.73 s** |
> | `/dashboard` server trace | 7.62 MB, 124 files | **4.91 MB** |
> | Chunks over 1 MB | two, at 2,539 KB each | **none** |
>
> **What was actually wrong.** Prisma's `engineType="client"` ships its query
> compiler as a 2.5 MB base64 string. It was being inlined into the bundle
> **twice** — the identical blob emitted as two chunks, one traced by 97 of 98
> routes and a second by 34 more (the back-office pages, which reach it
> through a second webpack layer via their server actions). `/dashboard`
> traced both: 5.08 MB of its 7.62 MB, base64-decoded and WASM-compiled on
> every cold start. `serverExternalPackages` did not prevent it because
> `transpilePackages` includes `@desire/db`, whose `main` is TypeScript
> source, so the generated client entered webpack's graph and took its dynamic
> import with it. Externalising it exposed a second bug: `apps/web` had never
> declared `@prisma/client` — it only reached it transitively through
> `packages/db` — the same pnpm strict-linking failure as the `/login` argon2
> incident, and the same fix.
>
> Two libraries were also loading for routes that never use them: `exceljs`
> (~810 KB) appeared in 26 of 98 route traces because CSV and XLSX shared a
> module, and `otplib` sat in `auth.ts` beside `validateSession`, so every
> authenticated request paid for it.
>
> **Indexes.** Two `Booking` foreign keys had no index. More importantly,
> `AssociateHierarchy.path` had one that **could never be used**: every
> downline read queries it with `startsWith`, and on this database
> (collation `en_US.utf8`, not `C`) a plain btree cannot serve
> `LIKE 'prefix%'`. Confirmed with `EXPLAIN … enable_seqscan = off` — the
> planner applied `path` as a *Filter*, reading every row. Replaced with a
> hand-written `text_pattern_ops` index; now an *Index Cond*, verified in
> production. Seven further indexes the audit proposed were **deferred**:
> with 440 rows they buy nothing measurable and cost storage against the
> 0.5 GB cap.
>
> **Client-side caching.** `staleTimes.dynamic` was 0, so every back/forward
> refetched the full RSC payload (378–518 ms). Now 15 s. The inventory board
> refreshes on mount when its snapshot is older than 5 s, so the one screen
> where "cached inventory is wrong" can never paint stale availability out of
> that cache.
>
> **Rejected, with the arithmetic.** A keep-warm pinger would dodge cold
> starts and Neon's 5-minute scale-to-zero, but Neon Free allows
> **100 CU-hours/month** and keeping a 0.25 CU compute alive 24/7 costs
> 730 × 0.25 = **182 CU-h** — it would suspend the database mid-month. Even
> business-hours-only is ~90 CU-h, leaving no headroom. Server-side
> `unstable_cache` was also rejected: those queries now cost ~2–6 ms against a
> ~440 ms floor, so it would buy single-digit milliseconds for real
> invalidation risk.

> ## Round three, 2026-09-26: two external checklists, and where the latency actually is
>
> A client-supplied performance checklist was checked item by item against the
> repository and against live production. Almost none of it applied — the
> reasons are in the PROGRESS.md decision log — but measuring it produced the
> cleanest statement of the latency budget so far.
>
> ### The edge-hit/edge-miss measurement
>
> Requesting the **same immutable hashed JS chunk** from India, repeatedly:
>
> | | TTFB |
> |---|---|
> | Netlify Edge **hit** (`Cache-Status: hit; ttl=31536000`) | **80 ms** |
> | Netlify Edge **miss** (`fwd=miss; stored`) | **620–700 ms** |
> | `/api/health` — function + one query, reporting `durationMs: 3` | **660 ms** |
>
> India→edge is **80 ms**. Edge→Ohio origin adds **~560 ms**. **The database is
> 3 ms of a 660 ms request — 0.5%.** A function route costs the same as a
> static file that missed cache, which is the proof that nothing
> application-side is left to find: no index, query rewrite, driver swap or
> server-side cache can move a number that is 99.5% network. It is the
> `functions_region` Pro gate ([21-TIER-LIMITS §2](21-TIER-LIMITS.md)).
>
> Low traffic means even immutable assets miss often — each PoP node caches
> independently. Nothing to fix: `Cache-Control: public,max-age=31536000,immutable`
> is already correct.
>
> ### Correcting round two's round-trip claim
>
> Round two said there was no sequential-query problem on the request path.
> That was wrong: it counted `await`s. The Prisma generator here declares no
> `previewFeatures`, so `relationLoadStrategy` defaults to `"query"` and
> **every `include:` level is its own sequential SQL statement**.
>
> | Path | Sequential round trips | SQL statements |
> |---|---|---|
> | Back-office layout | 6 | 6 |
> | `/dashboard` (SUPER_ADMIN, 8 tiles) | **13** | **~43** |
> | `/bookings` | 10 (13 for TEAM_LEAD) | 16 |
> | `/crm` | 11 (14 for TEAM_LEAD) | 15 |
>
> The conclusion is unchanged — at ~3 ms/query that is **~40 ms of a 660 ms
> request, 6%** — but the reasoning behind it now matches reality. Prisma's
> `relationJoins` preview feature would collapse most of it and is
> **deliberately not adopted**: ~25 ms of upside, and its support under this
> project's `engineType="client"` + `@prisma/adapter-pg` is unverified.
>
> ### Login bundle, measured
>
> 389 KB raw ≈ ~120 KB gzip, of which **341 KB is the React 19 + Next 15
> baseline**. The chunks were grepped for `exceljs`, `pdfkit`, `@react-pdf`,
> `qrcode`, `input-otp` and charting libraries: **none present**. The large
> chunk in the client's screenshot is react-dom.
>
> ### Link prefetch — what it does and does not cost
>
> Sidebar links previously used Next's default prefetch. For a route marked
> `force-dynamic` (31 of them are) that fetches **only the `loading.tsx`
> shell**, so the click still paid the full round trip. Four back-office
> destinations (Dashboard, Inventory, CRM, Bookings) and three PWA ones
> (Home, Inventory, Leads) now set `prefetch` explicitly — see `NavItem` in
> `apps/web/lib/nav.ts`.
>
> **The cost model is not the obvious one, and was corrected after measuring
> it against a local production build.** Every link in the shell is
> prefetched on every page load *either way* — that is Next's pre-existing
> default, not something the flag enables. So request count is **unchanged**.
> What changes is what each prefetch does:
>
> | | Response | Effect on the click |
> |---|---|---|
> | default (partial) | a uniform **~27.7 KB** shell, byte-similar for every route | still pays a full ~600 ms round trip |
> | `prefetch` (full) | the route really renders: **31–64 KB** + its database work | costs **nothing** inside the cache window |
>
> Verified end to end on a local production build: clicking **`/bookings`
> (allowlisted) issued no network request at all** — served from the router
> cache — while **`/projects` (not allowlisted) issued a second request** on
> the click, on top of its prefetch. That is the whole feature, demonstrated
> both ways.
>
> So this is an allowlist, not a default, because the cost is **server compute
> per prefetch**: full-rendering all eleven sections on every page load would
> run the dashboard's ~13 sequential queries for screens most actors never
> open. The benefit is bounded by `staleTimes.dynamic` (15 s) — a click inside
> that window is free, a later one is unchanged. Stated plainly rather than
> oversold.

> ## Round four, 2026-10-12: where the time actually goes, measured logged in
>
> The client reported that after signing in, "functionalities taking time to
> render and open". Measured on production as `super_admin`, warm:
>
> | | |
> |---|---|
> | Static asset from the Cloudflare edge | **4 ms** |
> | `/api/health` — function + one `SELECT 1` | **398 ms** |
> | `/projects` full document | 482 ms |
> | `/dashboard` full document | 655 ms |
> | All 11 back-office sections (RSC payload) | 408–623 ms |
>
> **~394 ms of every click is the India→Ohio round trip, paid before the app
> does anything.** The app's own work is only 84 ms (`/projects`) to 257 ms
> (`/dashboard`) — which is why eleven very different screens land within
> 215 ms of each other. The tight clustering is the finding: it says the
> variable (server work) is small and the constant (network) dominates.
>
> This is the cleanest statement of the latency budget this project has, and
> it is the answer to every future "can we make this faster" question:
> **65–80% of it is geography**, the function region is Pro-gated, and the
> no-paid-services constraint rules it out.
>
> ### What was done about it
>
> Since the network cannot get faster, the only lever is **not making the
> request**. `staleTimes.dynamic` went 15 s → **60 s** and every sidebar link
> now prefetches a full payload rather than a shell, so a click inside the
> window is served from the router cache at **0 ms** instead of ~450 ms.
>
> The 15 s value existed to protect the rule that "inventory that is cached is
> inventory that is wrong". That rule is now enforced where it belongs — at
> the three screens where two people can act on the same row (receipt
> verification, discount approvals, holds) via `<RefreshIfStale>`, generalised
> from the board's existing mount-refresh — rather than by starving the whole
> app's cache.
>
> **The trade, recorded honestly:** full-prefetching all eleven means
> `/dashboard`'s ~13 sequential queries run on every page load even for
> someone who never opens it. Request *count* is unchanged (Next prefetches
> every link either way); server *compute* is not. If Neon CU-hours climb,
> narrowing the prefetch set is the first lever, before touching keep-warm.
>
> ### Still the worst number: the cold start
>
> 9.09 s for the first request of the day, against 0.4–0.6 s warm. Unchanged
> by any of the above, and ~20× larger than the warm-click problem. Addressed
> by the keep-warm Worker in [21-TIER-LIMITS §12](21-TIER-LIMITS.md) once it
> is deployed.

> ## Round five, 2026-10-25: the cut-down app, measured route by route
>
> The product was cut to plotted projects, booking a plot and user admin
> ([PROGRESS.md](../PROGRESS.md) decision log, 2026-10-25), and the client asked
> that every module and API load fast, with the load time of each function
> identified. This round measures the **kept** surface only (a switched-off route
> now answers 404 in about 5 ms), changes what the measurement pointed at, and
> measures again.
>
> ### How it was measured
>
> - A production build (`next build && next start`) on `localhost:3011`, against
>   local Postgres with `log_statement = 'all'`, seeded by
>   `apps/web/scripts/perf-seed.ts`: **one plotted project of 2,000 plots in 20
>   blocks**, an ACTIVE price list, 50 associates, 200 bookings (half CONFIRMED,
>   half DRAFT with a live hold). Both scripts refuse a database host that is not
>   local.
> - `apps/web/scripts/perf-run.ts`, one signed-in actor per route: the first
>   request after the server started (**cold** here means route-module load, not a
>   serverless cold start), then 30 sequential warm requests (p50 and p95 of the
>   whole response, streamed body included), then one more request wrapped in two
>   marker queries so the **statements** Postgres logged for exactly that request
>   can be counted. Mutations run as a chain (hold, draft, confirm, cancel), 12
>   iterations.
> - `apps/web/scripts/api-smoke.ts` calls every kept page and API as each of the
>   three roles and as nobody, and one URL under every switched-off prefix, and
>   checks the status of each (146 checks, none failed).
> - Three runs of the same script: **start** (before any change, every feature
>   on), **after the cut** (the scope cut and the new screens, before any
>   performance change), and **final** (the code as shipped; the better of two
>   runs for each route).
>
> ### Read the milliseconds with this in mind
>
> **Statement counts are exact; milliseconds are not.** This machine
> (Windows, Docker Desktop, other containers running) gave different answers for
> the same code: two back-to-back runs of the identical final build read
> `POST confirm` at 75 ms and then 114 ms, `POST holds` at 49 and 68, and
> `GET /projects/[id]` at 69 and 49 (the other way round). A single p50 is
> therefore not evidence of a change; a statement count is. The final column
> below is the better of those two runs, route by route. The change that matters most, the
> permission and session lookups every request makes, was timed head to head
> instead, **alternating old and new inside one process** (300 rounds each, so
> drift cancels):
>
> | Lookup | Before | After |
> |---|---|---|
> | Permissions (`getPermissionCodes`) | 4 statements, p50 8.9 ms | 1 statement, p50 2.8 ms |
> | Session (`validateSession`) | 2 statements, p50 4.8 ms | 1 statement, p50 2.4 ms |
>
> A statement here costs 1-2 ms. Against the colocated Ohio database it costs about
> 6 ms (round four), and every request also pays the ~400 ms India-to-Ohio round
> trip that nothing in this repository can remove. So a statement removed is worth
> roughly 6 ms to a real user, not 1.
>
> ### Results
>
> `p50 ms` is start / after the cut / final. `Payload` is the decoded response.
> Rows marked *(new)* did not exist at the start.
>
> | Route | Statements | Payload (KB) | p50 ms: start / after cut / final | p95 ms final |
> |---|---|---|---|---|
> | GET /login | 1 → 1 | 19.5 → 20.7 | 22.4 / 24.9 / 9.9 | 22.3 |
> | GET /api/health | 2 → 2 | 0.2 → 0.2 | 6.6 / 8.7 / 5.5 | 7.4 |
> | GET /projects | 9 → 5 | 77 → 64.5 | 38.7 / 53.5 / 42.1 | 53.2 |
> | GET /projects/[id] | 15 → 8 | 165 → 109 | 66.2 / 59.4 / 49 | 65.1 |
> | GET /stock | 8 → 4 | 79.5 → 59.7 | 42.6 / 42.4 / 29.1 | 42.5 |
> | GET /board/[id] | 14 → 11 | 1,091 → 376 | 161.4 / 175.2 / 140.1 | 220.5 |
> | GET /bookings | 17 → 10 | 577 → 308 | 208.8 / 102.9 / 78.7 | 95.8 |
> | GET /bookings/[id] (confirmed) | 26 → 12 | 84.1 → 62.9 | 66.4 / 55 / 34 | 58 |
> | GET /bookings/[id] (draft) | 24 → 15 | 86.9 → 59.4 | 81.2 / 58.7 / 35.1 | 53.2 |
> | GET /admin/users | 14 → 7 | 422 → 409 | 81.2 / 128.6 / 82.5 | 124.6 |
> | GET /inventory (associate) | 8 → 4 | 38.2 → 37.9 | 23.7 / 29.2 / 20.7 | 32.1 |
> | GET /inventory/[id] (associate) | 19 → 11 | 1,924 → 391 | 219.9 / 224.9 / 157.3 | 212 |
> | GET /my-bookings (associate) (new) | – → 10 | – → 37.2 | – / 38.3 / 29.3 | 35.5 |
> | GET …/units/deltas (full) | 9 → 5 | 312 → 312 | 53.4 / 73 / 32.6 | 44.4 |
> | GET …/units/deltas?since=now | 8 → 4 | 0.1 → 0.1 | 24.2 / 23.5 / 13.1 | 17.1 |
> | GET /api/v1/bookings/[id] | 11 → 7 | 0.7 → 0.7 | 28.4 / 34.7 / 21.5 | 32.5 |
> | GET /dashboard | 44 → switched off (404) | 139 → 12.1 | 86.7 / – / 6 | – |
> | GET /home (associate) | 30 → switched off (404) | 52.3 → 12.1 | 69 / – / 5.4 | – |
> | POST /api/jobs/holds/expire | 2 → 2 | 0 → 0 | 6.4 / 7.3 / 9.1 | 12.1 |
> | POST holds | 23 → 18 | 0.1 → 0.1 | 64.3 / 58.6 / 48.8 | 67.8 |
> | POST /api/v1/bookings (draft) | 25 → 20 | 0.7 → 0.7 | 70.8 / 66.3 / 55.2 | 97.8 |
> | POST bookings/[id]/confirm | 35 → 30 | 0.8 → 0.8 | 96.5 / 89.7 / 75.2 | 144.2 |
> | POST bookings/[id]/cancel | 19 → 15 | 0.2 → 0.2 | 61.3 / 56.2 / 44.4 | 84.5 |
>
> ### What changed
>
> - **The landing path.** Every sign-in used to end on the dashboard (44
>   statements, 139 KB) or, for an associate, the home screen (30 statements). Both
>   are switched off; staff land on `/projects` and associates on `/inventory`
>   (`/projects` is 5 statements and about 42 ms at p50, `/inventory` 4 statements and about 21 ms, against 44 statements and 87 ms for the dashboard and 30 and 69 ms for the home screen), and the login actions redirect straight there instead of through
>   `/`.
> - **Permissions and session in one statement each**, instead of four and two
>   (the table above). Every authenticated request pays both, and every
>   `assertPermission` inside a transaction pays the first, so this shortens the
>   row locks of a hold and a confirm as well. `hot-path-statements.test.ts` pins
>   the statement shape, so a tidy-up back into nested reads fails a test instead
>   of quietly adding statements again.
> - **The plot grid and the board send each unit type and each block once**, and
>   leave out what is empty, instead of 19 fields for every unit
>   (`app/board/[projectId]/catalogue.ts`; `catalogue.test.ts` proves the
>   rebuilt units equal the old ones field for field). At 2,000 plots that is the
>   board's response falling from 1,091 KB to 376 KB and the phone grid's from
>   1,924 KB to 391 KB. The server serialises and compresses the response on every
>   render and the phone downloads and parses it before it can draw a tile, so
>   this is render time as well as transfer. The phone grid's p50 went from 220 ms
>   to 157 ms and its p95 from 401 ms to 212 ms (this change and the block tabs
>   below together; they were not measured apart). The board's own time barely
>   moved: its server work is mostly the unit read (about 67 ms of it), which this
>   does not touch.
> - **The phone grid draws one block at a time** (block tabs) instead of 2,000
>   tiles, its clock ticks only while a plot is held and the tab is visible
>   (it re-sorted and re-rendered every tile every second, in a hidden tab as
>   well), and its page reads its data in parallel and no longer looks up the
>   viewer's associate profile (a hold is theirs exactly when its associate row is
>   theirs).
> - **Lists are bounded.** `/bookings` shows the latest 100, drafts first, and
>   says so when it is truncated (577 KB → 308 KB at the seeded 200 bookings).
>   `/admin/users` pages at 50 with Previous/Next and has a read ceiling of 500;
>   before, every account was drawn with two forms each.
> - **Pages lost the sections of switched-off features and their queries**:
>   payment plans and commission schemes on the project page, the payment
>   schedule, discount requests and clawback on a booking (including a
>   cancellation preview that ran on every page view).
> - **Booking a plot** (`bookPlot`) checks everything that can be checked before
>   it writes anything, so a typo or an unpriced plot never costs a plot its hold.
> - **Smaller reads inside the booking transactions.** A draft or a confirm reads
>   its price-list item once instead of twice, a hold reads the associate's grade
>   in one statement instead of two, and `confirmBooking` writes its cost-sheet
>   lines in one statement instead of one per line, inside the booking and unit
>   locks. The seeded plots have exactly one cost-sheet line each, so that last
>   change does not show in the table; it saves a statement per extra line on a
>   plot with PLC tags and fixed charges.
>
> ### What was not changed, and why
>
> - **The network floor.** About 400 ms of every request in production is the
>   India-to-Ohio round trip; the function region is a Pro setting (round one).
> - **The shape of the mutation chains.** A hold, a draft and a confirm are
>   18, 20 and 30 statements. They sit inside `FOR UPDATE` locks in the code
>   that keeps two associates from taking the same plot, and 800+ tests protect
>   them; restructuring them to move reads in front of `BEGIN` would save perhaps
>   25-50 ms of a click that costs ~700 ms, for a change in the riskiest function
>   in the product. Commission accrual and demand-schedule generation also still
>   run inside `confirmBooking` although their screens are off: skipping them now
>   would leave the bookings confirmed in the meantime without commission entries
>   when the features come back. The next cheap step, if wanted: have
>   `writeAuditLog` return its id so the three routes that look the audit row up
>   afterwards (`holds`, `bookings`, `confirm`) stop doing so (one statement each).
> - **`/projects` is not capped**: one card of about 1 KB per project, so 100
>   projects is 100 KB. It gets paging the day a developer has more than that.
> - **`expireStaleHolds`** is one transaction per expired hold (7 round trips
>   each), so a single sweep could pass a function's 10 s limit near 200 expired
>   holds. Correctness never depends on the sweep (a hold past its expiry reads as
>   free), each hold is its own transaction, so a sweep that times out still made
>   progress, and the next one continues.
> - **No new index.** Nothing measured was slow enough to prove one.
> - **Serverless cold start** is unchanged by this round and was not measured
>   here; the local "cold" column is route-module load only.
>
> ### Against the budget set before the work
>
> | Budget | Result |
> |---|---|
> | Every kept API p95 ≤ 150 ms, every page p95 ≤ 250 ms (local, warm) | Met on the better of the two final runs for every route. Two screens at 2,000 plots sit at the edge (board p95 220-246 ms and phone grid 212-263 ms across the two runs), and the mutations' p95 ranged 68-215 ms (hold), 98-188 (draft) and 144-160 (confirm): inside this machine's noise, but not a margin to claim. |
> | No unbounded list query | Met for bookings (latest 100) and users (50 per page, ceiling 500). `/projects` is bounded only by how many projects a developer has (see above). |
> | Fewer round trips on the request path | Every kept page lost 3-4 statements to the two joins; the table above has each route's count. The budget's "≤ 4 sequential round trips per page" was framed in round trips but measured in statements; pages that read in parallel (the PWA grid, the board) are shallower than their count, the rest are not provably ≤ 4. |
> | Hold, draft and confirm cut by ≥ 40% | **Not met**: hold 23 → 18 (-22%), draft 25 → 20 (-20%), confirm 35 → 30 (-14%), cancel 19 → 15 (-21%), nearly all of it from the permission and session joins. Reason above. Reason above. |

> ## Round six, 2026-10-26: the whole user and booking journey, the live site from India, and cold start
>
> The client said RERA registration is not mandatory (PROGRESS.md decision log, 2026-10-26: both guards are gone) and asked for every page and API listed and timed, the complete user-creation and plot-booking flow run, the slow places named with reasons, and fixes. Rounds one to five timed single routes on a local build; this round times the **journey** (admin creates an associate, the associate signs in and is forced to change the password, an admin sets up a plotted project, the associate books a plot, the admin confirms) and, for the first time, the **live site from India** and the **cold start**.
>
> ### The surface
>
> 20 live pages, 11 live route handlers (counting the `/api/disabled` sentinel), 19 Server Actions reachable from a live page. 33 pages and 41 routes of switched-off features answer 404 in about 3 ms (local `/dashboard`, p50 2.6 ms). `api-smoke.ts` calls every one as each role and as nobody: **146 checks, 0 failed**.
>
> ### How it was measured
>
> - **Local:** a production build on `localhost:3011`, a fresh database seeded by `perf-seed.ts` (one plotted project of 2,000 plots in 20 blocks, 50 associates, 200 bookings, **no RERA anywhere**), Postgres `log_statement = 'all'` to count statements, an SMTP stand-in (`smtp-sink.mjs`, answering after a settable delay) so the emailed password is real. `perf-run.ts`, two full runs, the better of the two per route (the two agreed closely). `perf-run.ts` now also runs the journey as a chain (`FLOW_RUNS`, default 10): each Server Action is called as a plain form post, each step is timed and its statements counted.
> - **Live:** logged-out requests with `curl` (reused and fresh connections, `/cdn-cgi/trace`), idle-gap probes of `/api/health`, and signed-in read-only GETs from the built-in browser while the admin was signed in (4 sequential GETs per URL, no clicks that write).
>
> To repeat the local half (nothing near the hosted database; `apps/web/.env.local` defines `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NODE_ENV`, `JOB_TRIGGER_SECRET`, `PII_ENCRYPTION_KEY` and `PII_ENCRYPTION_KEY_ID`, so export all six first, pointing the two database URLs at the local container):
>
> 1. `docker exec desire-postgres psql -U desire -d postgres -c "CREATE DATABASE desire_perf"`, then `pnpm db:migrate:deploy`, `pnpm db:seed` and `perf-seed.ts`, all with the exported URLs on that database.
> 2. `node apps/web/scripts/smtp-sink.mjs`, and export `SMTP_HOST=127.0.0.1 SMTP_PORT=2525 MAIL_FROM=noreply@perf.test SINK_URL=http://127.0.0.1:2526`.
> 3. `pnpm --filter @desire/web build`, then `pnpm --filter @desire/web exec next start -p 3011`.
> 4. `pnpm --filter @desire/db exec tsx ../../apps/web/scripts/api-smoke.ts`, then `.../perf-run.ts <label>` twice (`OUT=file.json` keeps the rows).
>
> ### Live, from this PC in India (Mon 12:50-14:30 IST)
>
> | What | Result |
> |---|---|
> | Cloudflare edge serving this PC | **Marseille** (`colo=MRS`, `loc=IN`); RTT to the edge 210-255 ms. Round three assumed ~80 ms. Free-plan traffic from India is reported to be served from a far PoP depending on the ISP's peering; this was not checked from a second network. |
> | Warm dynamic request, reused connection | `/api/health` **440-470 ms** (one `SELECT 1`, `durationMs` 2-3); `curl` over a reused connection 350-390 ms |
> | Every signed-in page and read-only API (warm) | **0.45-0.65 s**, whatever the server work (1-15 statements): `/projects` 0.50-0.57, `/stock` 0.5-0.57, `/board/[id]` 0.50, `/bookings` 0.55, `/bookings/[id]` 0.50, `/admin/users` 0.53, `/inventory/[id]` 0.53, `/my-bookings` 0.6, deltas API 0.54 |
> | Fresh connection (TCP + TLS + request) | 0.7-1.2 s over HTTP/1.1; the browser uses HTTP/3 |
> | Direct Netlify host (Singapore edge, no Cloudflare) | warm 0.40-0.47 s, the same as through Cloudflare; connect 110 ms against 170-230 ms |
> | **First request after 6.7 minutes idle** (13:01, 13:08, 13:15, inside the keep-warm window) | **8.46 s, 8.48 s, 2.14 s**; the database wake inside the function was 4.62 s, 4.51 s, 0.85 s. A browser load after the PC restarted: 8.17 s for a page that runs no query |
> | Compression | assets `br`, immutable, Cloudflare `HIT`; dynamic HTML `zstd` |
>
> **`infra/keepalive-worker` is not effective.** Its cron covers 09:30-19:29 IST on weekdays; three probes inside that window, each 6.7 minutes after the last request, were all cold. Either it was never deployed or it fails.
>
> ### Local, every kept route (best of two runs; ms; statements are exact)
>
> | Route | stmts | KB | p50 | p95 |
> |---|---:|---:|---:|---:|
> | GET /login | 1 | 20.7 | 7.5 | 9.8 |
> | GET /api/health | 2 | 0.2 | 3.9 | 5.3 |
> | GET /projects | 5 | 61.8 | 19.9 | 23.8 |
> | GET /projects/[id] | 8 | 109.2 | 24.4 | 33.5 |
> | GET /projects/new | 3 | 92 | 17.6 | 22.8 |
> | GET /stock | 4 | 57.4 | 15 | 21.7 |
> | GET /board/[id] (2,000 plots) | 11 | 376 | 74 | 91.8 |
> | GET /bookings | 10 | 308.1 | 58.9 | 71.3 |
> | GET /bookings/[id] (confirmed / draft) | 12 / 15 | 62.9 / 59.4 | 24.4 / 24.7 | 27.4 / 38.8 |
> | GET /admin/users | 7 | 408.9 | 48.7 | 53 |
> | GET /inventory (associate) | 4 | 31.3 | 12.5 | 16.9 |
> | GET /inventory/[id] (associate, 2,000 plots) | 11 | 390.9 | 69.7 | 82 |
> | GET /inventory/[id]/[unitId]/book | 9 | 39.3 | 15.7 | 18.9 |
> | GET /my-bookings (associate) | 10 | 37.2 | 19.6 | 25.4 |
> | GET /login/forgot, /login/reset?token=x | 1, 2 | 17.6, 14.7 | 6.5, 7 | 8.3, 9.6 |
> | GET / (signed in / out, both 307) | 4 / 1 | 8.2 | 10.6 / 6.7 | 12.8 / 10 |
> | GET units/deltas (full / since=now) | 5 / 4 | 312 / 0.1 | 23.8 / 8.2 | 29.8 / 10.2 |
> | GET /api/v1/bookings/[id] | 7 | 0.7 | 12.8 | 15.4 |
> | GET /dashboard (switched off, 404) | 1 | 12.1 | 2.6 | 4 |
> | POST holds / draft / confirm / cancel (REST) | 18 / 20 / 30 / 15 | - | 34.8 / 38.1 / 57 / 31.5 | 61.3 / 52.5 / 80.1 / 49 |
> | POST /api/jobs/holds/expire | 2 | 0 | 4.8 | 10.5 |
>
> The slowest page is the board at 74 ms. The application's own work is not where the time goes.
>
> ### The journey, step by step
>
> p50 of 10 warm iterations after one cold; server work only. The Server Action rows are the POST alone: in a browser the next page is rendered inside that response (or fetched right after it, see below).
>
> | Step | stmts | local p50 ms | model for the live site |
> |---|---:|---:|---|
> | Admin: GET /admin/users | 7 | 50.3 | 0.53 s |
> | Admin: **create user + email** (associate) | 15 | **133.4** | POST 0.65 s + the mail's round trips, then a GET 0.53 s |
> | Associate: GET /login | 1 | 7.3 | 0.46 s |
> | Associate: **sign in** with the temporary password | 4 | 30 | 0.50 s |
> | Associate: **change password** | 11 | 55.7 | 0.56 s |
> | Admin: create project (no RERA) | 7 | 17.1 | 0.50 s |
> | Admin: plot type | 8 | 18.7 | 0.51 s |
> | Admin: **block + 20 plots** | 17 | 42.9 | 0.57 s |
> | Admin: price list draft / publish | 13 / 12 | 24.2 / 24.1 | 0.53 s each |
> | Associate: **book a plot** | **42** | **87.4** | 0.73 s, 0.80 s with the page it lands on |
> | Admin: **confirm** | 29 | 57.9 | 0.64 s, 0.73 s with the page |
> | Admin: cancel | 15 | 32.7 | 0.55 s, 0.64 s with the page |
>
> The model is `0.45 s (warm floor of a dynamic request) + local ms + 4.5 ms x statements` (a statement is about 6 ms against the colocated Ohio database, 1.5 ms here). Checked against the live reads above it is within about 0.1 s: `/bookings/[id]` (15 statements) models 0.54 s against 0.50 s measured, `/admin/users` 0.53 against 0.53, `/inventory/[id]` 0.50 against 0.53.
>
> **Create user, where the time goes** (local; the sink stands in for the mail provider):
>
> | argon2 hash | send the mail, sink 0 ms | send the mail, sink 150 ms | whole POST, sink 0 ms | whole POST, sink 150 ms |
> |---:|---:|---:|---:|---:|
> | 16 ms | 93 ms | 933 ms | 137-171 ms | 991-997 ms |
>
> The mail is awaited inside the request and costs **about six sequential SMTP round trips** (no pooling: every send opens a connection, says hello, names the sender and recipient, sends the data, quits). Against a provider 150 ms away it is 0.84 s of a 1.0 s action; against one 15 ms away it is about 0.1 s. Which it is on the live site is the one number this round could not take (it needs the live write flow, below).
>
> ### What a browser does (local, real UI)
>
> - **Sign in** is one request: the POST answers with the next page (63 KB decoded, 22 KB on the wire) and the browser then fetches 6 script chunks.
> - **A redirect to another page** (create project and sign in were measured) is one request. **A redirect to the same URL** (update a role was measured; confirm, cancel, price list and plot type go through the same helper) is one request.
> - **Create user is the exception: two requests** (the POST, then a separate GET of `/admin/users?issued=...`), because the banner rides on a query string that makes the target a different URL. Reset password has the same code path. About one extra round trip, 0.45 s on the live site.
> - A sidebar click inside the 60 s router-cache window sends no request, as round four intended. List rows are the other thing: **`/bookings` prefetches one `?_rsc` shell per row** (30 in the first 160 ms locally, up to 100 on a full list) and `/projects` one per card. Each is a function invocation. Live today that is 3-4 requests (3 projects, 1 booking), so nothing to fix now; at 100 bookings it is 100 invocations per view against a 125k monthly budget. `prefetch={false}` on row links is the fix when the lists grow.
>
> ### Reasons, in the order a user feels them
>
> 1. **Cold start, 2-8.5 s, after any five idle minutes.** Neon's free tier suspends the database (0.85-4.6 s to wake) and the function itself starts cold (about 3 s in two probes, almost nothing in the third, 7+ s once after the PC restarted); the keep-warm Worker is not running. Nothing in the application can shorten a suspended database.
> 2. **The network, 0.45 s per request, paid by every click and form.** About 0.21 s of it is this PC's route to a Marseille Cloudflare PoP, the rest is edge to Ohio and back (round four measured 0.40 s, today 0.44-0.47 s). A fresh connection adds about 0.5 s. Round three's conclusion stands: the function region is Pro-gated.
> 3. **Create user's mail**: six SMTP round trips awaited inside the request, plus a second request for the banner.
> 4. **Statements at 6 ms each in production**: book a plot is 42 of them (about 0.25 s), confirm 29. Reasonable, and guarded by 800+ tests; round five declined restructuring them.
> 5. **Page weight** is not an issue at live volume: `/admin/users` is 73 KB gzip locally at 50 users, `/bookings` 78 KB at 100 rows.
>
> ### What changed
>
> - RERA is no longer required or checked (see the PROGRESS entry); a project without one can be populated, held, booked and confirmed. Proven at scale: `perf-seed.ts` now builds its 2,000-plot project with no RERA at all.
> - `perf-run.ts` runs the journey and the missing pages (the commit message has the detail).
> - **The sign-in page now wakes the database** while the person types (`components/warm-up.tsx`: one `GET /api/health` when the page opens). Verified: exactly one request per page open. It hides the database wake (0.85-4.6 s) behind the typing; it cannot hide the function's own cold start.
>
> ### Tried and reverted
>
> A shared submit button that disables itself and says "Working..." while a form's Server Action runs (`useFormStatus`). In Next 15.5.25 it **stalls same-page redirects**: the button stayed on "Working..." and the redirect landed only when the next action was submitted (reproduced in a visible, focused pane; the build without it behaves correctly). Not shipped. A pending indicator for these forms needs another design (an in-flight counter on `fetch` filtered by the `Next-Action` header, or `useActionState` with no redirect) and a Next upgrade is worth retrying first.
>
> ### Not changed, and why
>
> - **Statements in the booking chain** (42 / 29): round five's reasoning holds; ~0.1 s of a ~0.8 s click.
> - **Create user's second request and the mail**: moving the mail to `after()` would take away the only way the admin learns the mail failed (the temporary password is shown only then), and Netlify's `after()` support is unverified. A single-request create user (`useActionState`, banner in client state, no temporary password in a URL) is the better redesign and also gives a pending state; not done here.
> - **`prefetch` on list rows**: see above; not at today's volume.
> - **Cloudflare**: the route to Marseille is this ISP's and Cloudflare's, not the application's. The options (a paid Cloudflare plan, serving the host from Netlify directly) are separate trade-offs; ask two or three associates to open `https://crm.desirerealty.in/cdn-cgi/trace` and send the `colo=` line first.
>
> ### Open for the client
>
> 1. **Deploy the keep-warm Worker** (`infra/keepalive-worker`, three commands in its README, free, about 55 of Neon's 100 CU-hours a month by the arithmetic in docs/21 section 12). It is the only free fix for the 2-8.5 s cold start; re-run the idle-gap probe afterwards (expect 0.4-1 s).
> 2. A paid Netlify function region and/or a Neon plan with autosuspend off are the only ways to remove the cold start for good and to cut the 0.45 s floor.
> 3. **The live write flow** (create a user on the live site, sign in as them, set up a labelled test project, book, confirm, cancel) was not run: until the RERA change is deployed the live guards refuse plots and holds without a registration. It also needs an inbox for the test associate's emailed password and the admin and associate to sign in themselves. It is what turns the mail's round trips from a model into a number.

Phase 5. Run with `apps/web/scripts/load-test.mjs` (autocannon — pure npm,
no system binary to install, same free/open-source bar as k6). **Always run
against a local server + local Docker Postgres, never hosted Neon** — the
free tier's own invocation/compute ceilings
([21-TIER-LIMITS](21-TIER-LIMITS.md) §1: ~90,000 invocations/month, 80 CU-h
compute) make a real load test against it a self-inflicted outage, not a
measurement.

## How this was run

- `next build && next start` (production build, not `next dev`) on
  `localhost:3011`.
- `DATABASE_URL` pointed at local Docker Postgres (`desire-postgres`
  container), seeded via `packages/db/prisma/seed.ts`.
- 10 connections, 15 seconds per scenario — 10 concurrent associates is the
  actual concurrency ceiling [21-TIER-LIMITS §7](21-TIER-LIMITS.md) sizes
  the free tier for, not an arbitrary load-test number.
- Session cookie for a seeded demo user (`super_admin@demo.test`), issued
  the same way this project's other live-verification steps already do
  (`createSession` directly, not the login flow).

## Results (2026-09-14, local machine, no network hop)

| Scenario | p50 | p97.5 | p99 | Req/sec (avg) |
|---|---|---|---|---|
| Board delta poll (`GET /api/v1/projects/:id/units/deltas`) | 72 ms | 143 ms | 166 ms | 128 |
| Stock statement report export (`GET /api/v1/reports/stock-statement`) | 107 ms | 198 ms | 224 ms | 87 |
| Dashboard page (SSR, heaviest tile set — 5+ parallel aggregate queries) | 305 ms | 479 ms | 495 ms | 31 |

All requests returned `200` — no errors, no timeouts, at this concurrency
against the current (dev/demo scale) dataset.

## Compared against the free-tier targets

[21-TIER-LIMITS §7](21-TIER-LIMITS.md)'s revised targets, restated:

| Metric | Free-tier target | Measured (local, no network hop) |
|---|---|---|
| Delta poll p95 | < 600 ms | **166 ms (p99)** — comfortably inside, before the ~250 ms India→Ohio round trip the real deployment adds on top |
| Board first load p95 | < 3 s | **495 ms (p99)** for the dashboard, the heaviest SSR page measured — before the network hop |

**Caveat, stated plainly:** this measures application + database latency
only. It does not include the real India→Ohio network round trip
([21-TIER-LIMITS §2](21-TIER-LIMITS.md)) or a genuine serverless cold start
— neither is reproducible from a local `next start` process. Add roughly
250 ms to every number above for a real user's experience, and expect the
first request after 5+ minutes idle to add another 500 ms–2 s (Neon
scale-to-zero). Real-world figures at the deployed Netlify+Neon free tier
have not been measured this pass — only the part that's actually
controllable from this environment.

## What this does and doesn't prove

- **Proves:** the query/rendering logic itself is fast at the free tier's
  own stated concurrency ceiling (10 associates) against a dataset at
  today's (dev/demo) scale. No N+1 query blew up, no lock contention
  surfaced.
- **Does not prove:** behavior at real production data volume (the audit
  log alone is projected at 1-2 GB/year — [21-TIER-LIMITS §3](21-TIER-LIMITS.md)),
  or anything about the real network/cold-start numbers above.
- **Re-run before the pilot**, once there's a realistic amount of seed data
  (hundreds of units, thousands of leads/bookings) rather than the current
  handful of demo rows — today's numbers are a floor, not a ceiling.
