# Collection reports and Comparison — build report (2026-10-15 to 17)

Branch `col-reports` (worktree `app-crep`). Not pushed, not deployed.

## Commits
- `5a05bd2` Collection reports: a new screen with 23 reports on the collections
- `5e578e6` WIP comparison screen (folded into the next one)
- `883e59a` Merge main (profitability filters)
- `51ab7e0` Comparison: the period against the ones before, by entry date

`TZ=UTC node tests/run.js`: 2671 passed, 0 failed.

## Skills used
kpi-dashboard-design, dataviz (palette validated with its script), data-visualization, motion-system,
ui-ux-pro-max, accessibility-audit, verification-before-completion, reverse-engineering (benchmark below).

## Collection reports (تقارير التحصيل / وصولی رپورٹس)
Same roles and scope as Collections. Server `collectionReports` = `collectionsData` rows plus each
request's own fields (`rp`: deputy and return times, dispute, how it ended, receipt corrections of the
request and its hops, the mix of its takings). Additive; `colCompute_` is not touched — every report
runs it, so totals equal the Collections screen for the same filter (checked in the browser for
"this month", the South area and a collector's own view).

Layout: sticky filter bar (period list, dates, city › area › branch › collector, stage), a grouped
searchable catalogue (chips on a phone), a green hero with Excel/PDF, a KPI strip with the change
against the period before, charts, a table with a total row; any figure, bar, cell or row opens its
requests (`drawerOpen_(colListView_)`).

Reports (23):
1. Collection summary (equation, stage funnel, stages, exceptions)
2. Collection composition: cash, card, credit customers, bank transfers, direct deposits, other
   collections, delivery fees, Souq Gas/channels — amount and % (shares sum to 100.0), donut,
   100% bar per branch/area/collector/city/day, bridge to the net cash sent
3. Exceptions panel
4. Period comparison and top movers (branches, collectors, areas)
5. By collector (banked % ranking, still out, full table)
6. Cash in transit now (who holds what, since when)
7. Collector statement (opening, received, handed on, banked, running balance, closing; a collector
   sees only his own)
8. Collector to collector
9–11. By area / branch / city (share bars, treemap)
12. Branch statement (declared, short, received, banked, out)
13. Branch calendar (branch × day heatmap) — added
14. Daily / weekly / monthly trend (sent, banked, still out: three charts, never dual axis)
15. Aging of open cash by collector (stacked)
16. Deputy approval time (by day, by area manager, waiting now)
17. Deposits register
18. Bank reconciliation status
19. Shortfalls and overs (by hop, by person, per day)
20. Returned, disputed, rejected (reasons, time to resolve)
21. Receipt corrections (`receiptCorrections`, hop corrections, left deposit)
22. Handover date warnings (`dateChanged`, `dateMismatch`, `entryDates`)
23. Largest and oldest requests — added

## Comparison (المقارنة / موازنہ)
Zoho Books style: period list (shared with the reports, built on `PL_PRESETS_`/`plPresetRange_`),
compare with previous period(s) or year(s), 1–12 periods, city › area › branch › collector. One column
per period (oldest to newest), statement order: sales, − card, − direct deposits, − other deductions,
(+ additions), = cash to collect, − deposited, = remaining; then shortfalls, requests, average days to
the bank. Every cell shows ▲/▼ amount and % against the column before, green or red by the figure's
own good direction. Small multiples per figure; breakdown by area, branch, collector or city for any
figure; Excel/PDF. Rooted in entry dates: one `getSalesReport` over the span plus `listHandoffs`;
`cmpCompute_` is pure and tested (ties to the report's sales and net to the cent), ready to take a
server `entryCohort_` later.

## Benchmark (public product behaviour, studied for ideas)
| Product | What it shows | Taken here |
|---|---|---|
| Zoho Books | Report period list, "Compare with previous period(s)/year(s)", number of periods | Comparison screen as specified |
| SAP Cash Management | Cash position by bank/company, liquidity items, drill to source documents | Cash in transit by holder, drill from every number to the requests |
| Oracle Treasury | Bank reconciliation status, exposure by entity | Reconciliation status with unmatched aging |
| Kyriba | Cash visibility dashboard, variance vs prior period, exception alerts | KPI deltas vs period before, exceptions panel, top movers |
| Odoo / NetSuite | Aged reports, statements per partner, saved filters | Aging buckets, collector and branch statements, sticky filters |
| Cash-in-transit dashboards (bank CIT) | Who holds what since when, pickup-to-deposit time | Cash in transit, days to the bank, deputy SLA |
Observed: the column on the left is from these products' public docs and demos as known; inferred:
how they compute it. Not taken: forecasting (no forecast data here).

## Browser check (mock server 8921, seeded through the API)
Two areas, three collectors: send, validate, return one, receive (one 50 short), hand on, deposit,
an admin receipt correction, a day with card/transfer/delivery fee. Admin and a collector, en/ar/ur,
390 px and desktop. No console errors from the screens (the mock answers the app's GET ping with 404,
as before). Screenshots: `.superpowers/crp/` (desktop-en-summary, desktop-en-composition,
desktop-ar-summary, desktop-ur-statement, desktop-en-collector-statement, phone-ar-composition,
phone-ar-composition-kinds, phone-en-collector-summary, cmp-en-table, cmp-en-small-multiples,
cmp-en-breakdown, cmp-ar-table).

## Concerns
- Comparison "deposited" counts the entries whose handovers reached a deposit (net basis); a shortfall
  shows as its own row, so it differs from the Collections screen's cash-basis deposits by the
  shortfalls. A handover shared by two periods counts its shortfall in both. Entries consumed by an
  area bulk batch are not followed to the bank yet (the batch id is not a handover).
- The phone "Facebook layer" restyles every card; the hero needed `html body` rules to keep its colours.
- Excel/PDF buttons were not clicked in the browser (download needs approval); the sheets use the
  shared model.
- `index.protected.html` was not rebuilt.
