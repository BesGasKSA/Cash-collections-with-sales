# Dashboard filters: report (2026-10-14)

## What changed

Server (`Collection.gs`)
- `followRequest_` extracted from `actionCollectionsData_`: the single path that follows an area request through collector hand-ons to its deposit. The Collections screen and the new filter both use it. Hops now also carry `carried` (what the hop took from that request). No second copy of the net formula was written.
- `filterHandoffs_(rows, req, allRows, placeOnly)`: a handover is in the filter when its Riyadh creation day is in [dateFrom, dateTo] and its branch / area / city match. Hand-ons (`collector_to_collector`) and deposits come along only with the part that came from requests in the filter (`amount` = that part, `fullAmount` = what it banked, `filtered: true`). Direct (banked-at-source) deposits belong by their own day and branch. No filter set: rows are returned untouched.
- `actionListHandoffs_` applies it after the role scope (it can only narrow). `actionDashboard_` applies it to `companyOutstanding`, `companyHeldByHolder` and `openDisputes`. `actionDashboardAll_` also returns `handoffIds` (every handover id the role sees) so an entry whose handover is outside the filter is not drawn as "awaiting the deputy".
- `getDashboardComparison`: chosen period vs the period of the same length right before it, same city/area/branch, returns `period`. With no period it keeps the old last-7-days answer (the dashboard does not call it for "all").
- `getHeldCashTrend`: chosen period and place (cap 62 days, longer is one point a week, `weekly: true`); no period keeps the last 14 days.
- `getShortfallByEntrant`: honours dateFrom/dateTo/city/clusterId/locationId.

Client (`index.html`)
- A line under the dashboard filter bar says what is counted ("Counting: 2026-10-10 – 2026-10-14 · North Area", `role=status`, `aria-live=polite`), `dashFilterLine_`. The period chips carry `aria-pressed`.
- Held, where-is-cash and the equation follow the filtered bundle; the "held" tile foot and the where-is-cash hint say "for this filter" when a filter is on. Deposit drill-down notes that a shared deposit counts only the filter's share.
- Comparison panel: "Chosen period vs. the period before" with both date ranges; "all" shows a prompt to choose a period. Held trend panel is for the chosen period and says when it is by week.
- Count-up on every filter change (`countUp_`, text only, none under reduced motion).
- Customers header tiles sum exactly the rows the table shows (`cusTotals_`, redrawn on search and chips). Sales report shortfall card sends the report's filters.
- New strings (`dash_forFilter`, `dash_allDates`, `dash_wholeCompany`, `dash_counting`, `dash_cmpNeedPeriod`, `dash_cmpTitle2`, `dash_cmpPrev2`, `dash_heldTrendTitle2/Hint2`, `dash_trendWeekly`, `dash_depositShare`) in ar, en and ur.

## Browser check (mock server, admin, 7 branches, 35 dated handovers seeded as rows)

Handovers cannot be dated in the past through the API, so a throwaway server (not committed) added dated sheet rows on top of the mock scenario.

| Filter | Net cash | Banked / remaining | Not yet deposited (held) | Pending (n, SAR) | Deposits (n, SAR) |
|---|---|---|---|---|---|
| All dates | 41,702 | 10,890 / 30,812 | 19,012 | 12, 11,800 | 11, 10,890 |
| Today | 11,520 | 1,850 / 9,670 | 9,602 | 2, 1,550 | 2, 1,850 |
| Yesterday | 6,440 | 1,690 / 4,750 | 1,990 | 3, 2,760 | 2, 1,690 |
| This week | 24,890 | 6,510 / 18,380 | 13,422 | 7, 6,440 | 7, 6,510 |
| This month | 40,220 | 10,890 / 29,330 | 19,012 | 12, 11,800 | 11, 10,890 |
| Last month | 1,482 | 0 / 1,482 | 0 | 0 | 0 |
| Month + Jeddah | 19,350 | 6,300 / 13,050 | 6,600 | 5, 6,450 | 5, 6,300 |
| Month + Riyadh | 20,870 | 4,590 / 16,280 | 12,412 | 7, 5,350 | 6, 4,590 |
| Month + North Area | 18,170 | 4,050 / 14,120 | 11,402 | 5, 4,200 | 5, 4,050 |
| Month + South Area | 19,350 | 6,300 / 13,050 | 6,600 | 5, 6,450 | 5, 6,300 |
| Month + Olaya | 5,300 | 1,450 / 3,850 | 4,022 | 2, 1,310 | 2, 1,450 |
| Today + Olaya | 2,400 | 0 / 2,400 | 3,332 | 1, 550 | 0 |

Parts add up: Jeddah + Riyadh = month (net 19,350 + 20,870 = 40,220; pending 5 + 7 = 12; deposits 6,300 + 4,590 = 10,890; held 6,600 + 12,412 = 19,012). Riyadh = North 18,170 + Central 2,700. In each row the held holders in the trend sum to the held tile.

Also changed with every filter (checked): where-is-cash total, status counts, chain-step amounts, aging buckets, recent handovers count, held trend holders and axis dates, comparison figures and date ranges ("Today": 11,520 vs 6,440, +79%; "Today + Olaya": 2,400 vs 620). The period line follows the pickers. English, Arabic (RTL) and Urdu checked; at 390 px no horizontal overflow. No JS errors; the only console errors are the app's startup `GET /api` probe answered 404 by the mock server on each reload (present before this change).

## Tests

`node tests/run.js`: all green (2463 passed, 0 failed). New section "dashboard filters" uses a fresh system with two areas, three branches in two cities and requests on several days in several stages, and asserts: no-filter bundle unchanged; period only, area, city, branch, period + branch each give exactly the expected handovers; a deposit shared by two areas counts only the filter's share; collected never exceeds what the filter banked and "today" never gives a negative remaining; held, held-by-holder and outstanding equal the sums over the filtered rows; an area manager's foreign branch/area returns nothing extra; comparison (previous equal-length period, place filters, 7-day fallback); trend (chosen period, place, 62-day daily, weekly beyond); shortfall filters; the "what is counted" line; the Customers totals.

## Not done / concerns

- The "Where is the remaining cash" total (65,462 on all dates) does not equal "Still to bank" (30,812) even with no filter; it adds notYet + in transit + held, which overlap in the existing design. Unchanged by this work, and no filter is applied in that case.
- A request is placed in a period by its creation day, entries by their entry date (as the plan specifies), so a request made today for older sales shows in today's collected/remaining but the net is the entry-dated one.
- Period chips on this bar are 33 px tall (existing style); above the 24 px WCAG 2.2 minimum, below 44 px.
- Customers tiles verified to redraw on search/chips in the browser, but the mock data has zero balances, so the figures themselves are covered by the unit test only.
- Held trend with a place filter attributes hand-on amounts by the filtered share, as deposits are.
