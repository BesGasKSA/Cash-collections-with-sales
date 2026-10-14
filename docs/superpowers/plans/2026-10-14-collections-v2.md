# Collections: three clear totals and an analytical breakdown by collector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** On the Collections screen, every figure, percentage, chart and list reflects exactly the filters chosen (period, city, area, branch, collector), the top shows three big clickable cards (Total collection, Total deposits, Total remaining) for the filtered data, and the screen always carries an analytical breakdown by collector.

**Spec:** the user, 2026-10-14: "once a filter is chosen every figure, %, chart and dashboard should reflect the filtered data; in the collections screen we must have very clear clickable cards: Total collection for filtered data, Total deposits, Total remaining; the collections must always have a breakdown by the collector with very analytical data; use motion, dashboards, graphics, visualizations and animations." Then: "please ensure the filter is reflected."

**Where things are:** `renderCollections` (index.html ~15847), `colCompute_` (pure, ~15806, tested in tests/run.js), `colStack_`, `colSheets_` (Excel/PDF), `tiles_`, `trendChart`, `barRows_`, `drawerOpen_` + `colListView_` (drill-down list), `countUp_`, `COL_DRAWN_` (first-paint motion), `COL_C_` stage colours. Server `collectionsData` is unchanged.

## Global Constraints
- **Every number on the screen comes from the filtered set `D` (= `colCompute_(reqs, filters)`), never from `reqs` or `T` of another scope.** Audit every figure in `renderCollections` after the change: the hero, cards, legend %, collector table, charts, aging, deposits list, area/branch cards, request list, exports. The deposits list must only show deposits that carry at least one request in the filtered set, and a deposit's amount shown must be the filtered requests' sum inside it (with "of X total deposit" when the deposit also carries requests outside the filter).
- The filter bar shows the active filters as removable chips ("Area: North ✕") and a one-line sentence of what is counted ("1 Oct – 14 Oct · North Area · Mazen"); it stays visible (sticky on scroll).
- Total collection = all requests in the filter (`T.total`); Total deposits = `T.deposited`; Total remaining = `T.total − T.deposited` (= deputy + on way + held). The three always add up; show the formula under the cards.
- Every card and figure is clickable and opens the requests behind it (`drawerOpen_(colListView_(...))`).
- Motion: figures count up (`countUp_`) and bars grow on first paint and on every filter change (short, 300–400 ms, decelerate, 40 ms stagger); nothing under `prefers-reduced-motion`. Transform/opacity only.
- ar/en/ur strings for everything; RTL correct; works at 390px (cards stack, table becomes cards); no horizontal page scroll.
- Never a bare `<tr>` through `el()`; compound `.card.x` selectors; `fillTemplate_` for repeated placeholders.
- Made-up names in tests.

### Task 1
- [ ] Tests first (tests/run.js, the existing colCompute_ section): extend `colCompute_` so each group (`collectors`, `areas`, `branches`) also carries `remaining`, `branchesN` (distinct branches, collectors only), `lastDeposit` (latest depositedAt), `share` of the filtered remaining, and per-collector `days` (requests per day, for a sparkline). Assert with a fixture of two collectors, three branches, mixed stages and two periods: totals equal the sum of collectors; remaining = total − deposited for T and every group; a city/area/branch/collector filter changes every one of them consistently; deposits outside the period are excluded.
- [ ] Top of the screen: replace the hero + tiles head with **three big cards** in one row (stack on phones): Total collection (count of requests, sparkline of the period), Total deposits (% of total as a ring/bar, last deposit date), Total remaining (split bar of deputy / on its way / held with each amount, oldest open days). Keep the secondary KPIs (shortfall, average days to bank, oldest) as a smaller row below.
- [ ] **By collector — always shown**: a section with (a) a horizontal bar chart of remaining by collector, (b) an analytical table (cards on phone): collector, branches served, requests, total, deposited, remaining, % banked (inline bar), average days to bank, oldest open (amber > threshold, red > 2×), shortfall/over, last deposit, share of remaining; sortable by any column; row tap filters to that collector (tap again clears); a "details" action opens a drawer with that collector's requests grouped branch › day. When a collector filter is on, the section still shows (that collector highlighted, the rest dimmed with "showing 1 of N").
- [ ] Filter bar: active-filter chips + "what is counted" sentence + sticky.
- [ ] Deposits list and exports (`colSheets_`) follow the filter as in the constraints; the collectors sheet gets the new columns.
- [ ] Browser check on the mock server (`node tests/mock-backend-server.js 8914`): seed several requests across two collectors/areas (sent, validated, received, deposited) via the API, then as admin and as a collector, in en/ar/ur, at 390px and desktop: change every filter and confirm every figure on the page changes accordingly (write down before/after for the three cards and the collector table); no console errors.
- [ ] `node tests/run.js` green; commit.
