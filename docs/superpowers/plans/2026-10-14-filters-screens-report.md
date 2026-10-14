# Filters and screens, report (2026-10-14, branch filters-screens)

## What changed

Filters that stay and drive everything
- `listFilters_` takes `state`: values and open/closed are kept and restored when a screen redraws. It also draws the active filters as removable chips, gives every field and the sort an aria-label, has 44px targets at phone width and a visible focus ring. `match` accepts rows with `locationIds` and `clusterId`; `sortMode()` is exposed.
- Handoffs: the bar is never rebuilt. `draw_()` redraws only the waiting cards, the collect pivot, the analysis, the by-level pivot, the list and the export source. State lives in `HF_STATE_` (also survives a full `render()`).
- Collect pivot: `collectPivotTree_` takes `include(h)` (chain lookups still see every handover); `collectPivotCard_` takes `include` and `period` (the bar's dates, month-to-date when empty) and drops its own pickers on Handoffs. Home still uses its own pickers.
- Deputy: the bar is always built (also with nothing waiting); it drives the request list and the area-batch cards with one "N of M".
- Audit: `listAudit` filters before the limit (`dateFrom`, `dateTo`, `text` incl. person name, `userId`, `auditAction`, `order`), returns `matched` and `total`, refuses a bad date (`invalid_date`) or a reversed range (`invalid_range`), caps the limit at 2000. The screen sends the bar's values (debounced, stale answers dropped) and shows "N of M" plus a note when the answer is capped.
- Profitability costs tab: `plCostMonths_` — a custom range of 2+ months is exactly those months (max 12, says so), a single month keeps the 6-month trend and the heading says "last 6 months".

Handover date (added task)
- Server: every handover has `handoffDate`; `entryDate`, `entryDates`, `dateChanged`, `dateChangeReason`, `dateChangedBy/At` are stored. The default is worked out by walking sources down to the entries (latest date), never from the client. Validation: `invalid_handoff_date`, `handoff_date_future`, `handoff_date_before_entries`, `date_reason_required`. Audit `handoff_date_changed`. `dryRun` on `createHandoff` (all four kinds, per branch for the area request) and on `recordDeposit` returns the dates without writing. `listHandoffs` and `collectionsData` rows carry the dates, `dateMismatch` (several entry dates) and the flag; rows saved before this get the derived date, no flag. A request without `handoffDate` gets the default, no flag.
- Client: date field on car, branch, area (per branch and send-all), correction panel, collector hand-on, Handoffs deposit form and the collector's bank sheet. Changing it shows an amber warning, requires a reason, and one more confirmation panel showing both dates. Banner and chip on the folded row, banner in the open row (also the deputy card), on the collector's receive card, in the handover document. All ar/en/ur, with error messages and `ERR_FIELD_` entries.
- `api()` does not mark caches stale for a `dryRun`.

## Tests
`node tests/run.js`: 2476 passed, 0 failed. New: audit filtering (red first, then green), date rules through every hop (car, branch, area, collector hop, deposit), refusals, audit, flag through listHandoffs/collectionsData, old rows, `plCostMonths_`, `collectPivotTree_` include.

## Browser check (mock server 8916, stopped)
- Handoffs: every filter in turn (text, status, dates, area, branch, payment, movement, person, min, max) stays set after redraw, the count, analysis and pivot follow; chip removal works.
- Deputy with a waiting request (and filter text); with no batches. Area batches filtering is code only: no batch could be seeded.
- Audit: 372 rows, search for an old action found rows outside the latest 200; reversed range message; chip.
- Profitability: single month, 3 months, 34 months (capped note), same-month custom.
- Date feature: car, deposit sheet, collector hand-on, area per-branch send with changed date, reason, confirmation, server stored values and audit; deputy card and collector card banners; ar and ur rendering; 390px layout (fixed the grid span of `.ac-bdate`).
- No JS errors (only the mock's missing `version.json` 404s).

## Not done / notes
- Handoffs "hub" counters (waiting for me, sent, returned) stay unfiltered by design: they are the person's own to-do.
- The "History tab" is the journey inside each row; the date banner sits at the top of the row body above it, not inside the timeline.
- Entries and Risk screens already redrew only their lists; unchanged (Risk's list takes no state).
- `version.json` / BUILD_ID not stamped (deploy step). No push, no deploy.
- Skills used: ui-ux-pro-max, accessibility-audit, data-validation, verification-before-completion (plus test-first for the server).
