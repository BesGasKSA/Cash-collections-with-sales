# Dashboard: every figure follows the filter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** On the Dashboard, once a period or a city/area/branch is chosen, every figure, percentage, chart, tile, panel and drill-down reflects exactly that filtered data. Same for the Customers header tiles and the Sales report's shortfall card.

**Spec:** the user, 2026-10-14: "once a filter is chosen everything, every figure and % and charts and dashboards should reflect the filtered data; I'm very confused because only a few figures reflect it." "Please ensure the filter is reflected."

**Audit findings (index.html / Collection.gs line numbers on main 1cd98c1):**
1. `actionDashboardAll_` (Collection.gs:3075) passes `req` to `actionListHandoffs_` (2260), which honours only `status`/`kind` — dateFrom/dateTo/city/clusterId/locationId are dropped, so the bundle's `handoffs` is all-time. `eqForScreen_` (index.html:9707-9718) and `netEquation_` (7294-7320) then show Collected / Remaining = net − all-time deposits (goes hugely negative on "Today"); `salesAndCollectionStatements_` (9644-9703) same.
2. Key-figure tiles (9890-9895): pending/disputed/deposits counts+amounts from the unfiltered handoffs; "Company outstanding" = `dash.companyOutstanding` from `actionDashboard_` (2623-2650) which ignores the request.
3. `whereIsCashPanel_` (9725-9751): rows T (in transit) and B (held, `dash.companyHeldByHolder`) unfiltered; total mixes.
4. Collections analysis on the dashboard (9964-10030): status, kind, aging, recent and their drill-downs from unfiltered handoffs.
5. `getDashboardComparison` (9940) called with `{}` — server (3355-3380) fixed last-7 vs prior-7 company-wide; `getHeldCashTrend` (10003) `{}`, fixed 14 days company-wide.
6. Customers header tiles (18410-18420) sum all customers; search/chips only filter the table.
7. Sales report `getShortfallByEntrant {}` (17190) all-time under a filtered report.

## Rules (binding)
- **One definition of "in the filter" for handover cash, the Collections screen's own:** a `cluster_to_collector` request belongs to the filter when its creation day is in [dateFrom, dateTo] and its branch/area/city match; it is followed to its current stage (deputy / on its way / held / deposited). Collected (deposited) = the deposited ones among those; Remaining = net − collected for the dashboard equation, and the stage split comes from the same set. Earlier hops (car → branch, branch → area) belong to the filter by their own creation day and branch. Deposits listed/ counted = deposits that bank at least one request in the filter, with only that filtered part of their amount. Reuse the server logic behind `collectionsData` (`actionCollectionsData_`) rather than writing a second follower.
- `actionListHandoffs_` gains the optional filters dateFrom/dateTo/city/clusterId/locationId (applied after the role scope, only narrowing). The dashboard bundle passes them.
- Company outstanding, held by holder and in transit are computed for the filter (same scope rules). Their tiles keep their labels and say "for this filter" in the foot when a filter is on.
- Comparison: the chosen period vs the period of the same length right before it, with the same city/area/branch; for "all" show no comparison. Held-cash trend: over the chosen period (cap 62 days; longer → by week), same place filters.
- Every drill-down opened from the dashboard lists only filtered rows.
- Customers: the header tiles follow the search and chips (sum over the rows the table shows).
- Sales report: `getShortfallByEntrant` takes the report's filters.
- A small line under the dashboard filter bar says what is counted ("1–14 Oct · North Area"), and every card heading that is a point-in-time figure (none should remain) says so.
- Never a new copy of the net formula (`computeNet_`/`entryAmt_`/`brkParts_`); ar/en/ur strings; motion: figures count up and bars grow when the filter changes (existing `countUp_`), none under reduced motion.

### Task 1
- [ ] Tests first (tests/run.js): a fixture with two areas, three branches, requests on three days in several stages and deposits; assert for `getDashboardAll` with each filter (period only, area, branch, period+branch) that handoffs, companyOutstanding, heldByHolder, in-transit, collected and every count/amount equal the sums over the filtered requests; that "Today" never gives remaining < 0 from deposits outside the filter; comparison uses the previous equal-length period with the same place filter; held trend covers the chosen period; shortfall-by-entrant honours filters; an area manager's filter can only narrow his scope (a foreign branch id returns nothing extra).
- [ ] Implement server, then client (Dashboard, Customers tiles, Sales report shortfall card).
- [ ] Browser check on the mock server (`node tests/mock-backend-server.js 8915`): seed handovers across areas/days, then as admin change every filter chip and place picker and confirm each figure listed in the audit changes accordingly (note before/after); en/ar/ur; 390px and desktop; no console errors.
- [ ] `node tests/run.js` green; commit.
