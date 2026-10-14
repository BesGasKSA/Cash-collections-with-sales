# Collections v2 report (2026-10-14)

Branch collections-v2, worktree app-col. Final test line: `2418 passed, 0 failed` (baseline was 2401; 17 new colCompute_ checks, written first and seen failing).

Skills used: test-driven-development, ui-ux-pro-max, data-visualization, motion-system, accessibility-audit, verification-before-completion.

## What changed (index.html, tests/run.js, CLAUDE.md)
- colCompute_: groups carry remaining, branchesN, lastDeposit, share, days; new `deposits` (filtered share + whole deposit).
- Order: filters, sticky "Counted: ..." sentence with removable chips, three cards (Total collections / Total deposits / Total remaining, 36px desktop, 28px phone, accent green / deposit green / amber when remaining > 0, each a button opening its requests), equation line, small tiles (shortfall, days to bank, oldest), By collector (always shown: remaining chart + sortable table, cards on phone, Details drawer branch > day, others dimmed with "Showing 1 of N" when a collector is chosen), Bank deposits (filtered share, "of X total deposit"), charts, aging, per area/branch, requests.
- Excel/PDF: collectors sheet has the new columns, a deposits sheet, a Filters row. Excel built in the browser with no errors.
- Motion on every redraw (bars 400 ms decelerate, 40 ms stagger, count-up); verified `animation-name: none` under prefers-reduced-motion.
- ar/en/ur strings for everything new.

## Before / after per filter change (mock server, admin, All time; identical in en/ar/ur at 1400 and 390 px)
Collections - Deposits = Remaining (card figures, equation line, request list and collector table all agree)

| Filter step | Collections | Deposits | Remaining | Requests in list |
|---|---|---|---|---|
| All time, no filter | 11,552.00 | 7,232.00 | 4,320.00 | 6 |
| + City Jeddah | 4,500.00 | 1,500.00 | 3,000.00 | 3 |
| + Area South | 4,500.00 | 1,500.00 | 3,000.00 | 3 |
| + Branch Rawdah | 1,500.00 | 1,500.00 | 0.00 | 1 |
| clear, Collector Mazen | 5,732.00 | 5,732.00 | 0.00 | 2 |
| + Area North | 5,732.00 | 5,732.00 | 0.00 | 2 |
| + Branch Naseem | 2,400.00 | 2,400.00 | 0.00 | 1 (deposit shows 2,400.00 "of 5,732.00 total deposit") |
| clear, Yesterday | 0.00 | 0.00 | 0.00 | 0 |
| Today | 11,552.00 | 7,232.00 | 4,320.00 | 6 |

Collector table before/after: no filter Rami 4,500/1,500/3,000 (share 69.4%), Khalid 1,320/0/1,320 (30.6%), Mazen 5,732/5,732/0; Jeddah filter leaves Rami only (share 100%); Collector Mazen keeps all three rows with Rami and Khalid dimmed, "Showing 1 of 3". Aging (South: 3,000.00) and daily charts (South: 4,500 / 1,500) follow the filter. Roles: area manager North 7,052 / 5,732 / 1,320; collector Mazen 5,732 / 5,732 / 0; area manager South 4,500 / 1,500 / 3,000 (all scoped, equation exact).

Checks at 390 and 1400, en/ar/ur: no horizontal scroll, no "undefined/NaN/{placeholder}", zero console errors (only the mock's favicon 404). Sticky strip sits directly under the top bar (56 px phone, 78 px desktop).

## Screenshots
C:\Claude\bestgas-cash-collection\app-col\.superpowers\collections-v2-shots\ : `<lang>-<width>-<NN_step>.png` for every step above (en 1400, en 390, ar 390, ur 390), `admin-<lang>-<width>-top.png`, `sticky-390.png`, `sticky-1400.png`.

## Accessibility pass
Focus-visible outlines on cards, rows, chips, sort buttons; tap targets 44 px on phone (chips, details, chart rows, sort picker); aria-sort on headers; decorative bars/sparklines aria-hidden; stacked bar has a text label; contrast of figures (amber large text 3:1+, greens 4.9:1).

## Concerns
- The server's collectionsData sends no depositHasSlip or depositBy (HEAD's deposit card read them but nothing supplied them: it always said "No slip"). The new card shows the slip tag only when the field exists; a small server change would restore it.
- Requests all have today's createdAt on the mock, so period filters could only be shown as Today vs Yesterday; multi-day periods are proven by the unit tests.
- A deposit's "whole amount" is computed from the requests the viewer can see; a restricted role sees at most the visible share of a shared deposit.
- The mock's fake translations prefix names with "AR:" (also double in some selects); not caused by this change.
- index.protected.html and version.json not regenerated, as instructed. Nothing pushed or deployed.
