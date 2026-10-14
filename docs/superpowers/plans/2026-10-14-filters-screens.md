# Handoffs, Deputy, Audit, Profitability: filters that stay put and drive everything — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** On every list screen with a filter bar, a chosen filter stays chosen, and every figure, chart, pivot, card and export on that screen follows it.

**Spec:** the user, 2026-10-14: "once a filter is chosen every figure and % and charts and dashboards should reflect the filtered data … please ensure the filter is reflected."

**Audit findings (main 1cd98c1, index.html):**
1. **Handoffs filter resets itself.** `hFilter = listFilters_({... onChange: function(){ renderHandoffs(body); }})` (≈16442-16449): every change re-runs the whole screen, which rebuilds the bar with empty inputs. Entries/Risk/Audit avoid it by redrawing only their list in onChange.
2. Handoffs: `collectPivotCard_(res.handoffs…)` (16516) uses the full list with its own month-to-date period (`CPV_`) instead of the screen's filter.
3. Deputy review: the area-batch list (`res.batches`, ≈14925) ignores the filter; the filter bar (14896) is not built at all when no requests wait.
4. Audit (22415): `listAudit {limit:200}` — the filter only searches the latest 200 rows.
5. Profitability: `getCostReport` (19158) uses a trailing 6 months ending at the selected month when the range is not custom — label it clearly as the 6-month trend, or follow the chosen range when it is longer than one month (rule below).

## Rules (binding)
- `listFilters_` keeps its values across a redraw: give it an optional `state` object (or a `key` that keeps values in a module-level map) and restore inputs from it when rebuilt; the Handoffs screen redraws only what depends on the filter (lists, analysis, pivots, export source), not the bar. Apply the same to any other screen whose onChange re-renders the whole screen (grep `listFilters_(` and check each onChange).
- Handoffs: `collectPivotCard_` takes the screen's filtered set and its period (the pivot's own period selector is removed or synced with the bar).
- Deputy: the filter bar is always built; the batch list follows it (text, date, area, branch, amount).
- Audit: `listAudit` accepts `dateFrom`, `dateTo`, `text`, `userId`, `action` and filters server-side before the limit (keep the limit for the response size); the screen sends the bar's values and shows "N of M matches".
- Profitability costs tab: when the chosen range spans more than one month, the cost report covers exactly that range's months; for a single month it keeps the 6-month trend and its heading says "last 6 months".
- Every list with a filter shows "N of M" and the active filters as removable chips (reuse `listFilters_`'s count and clear).
- ar/en/ur strings; no new copy of the net formula; motion only where the screen already animates; none under reduced motion.

### Task 1
- [ ] Tests first where the server changes (`listAudit` filters; tests/run.js). For client-only behaviour, add a pure helper test if a pure function is introduced (load with `clientFn_`).
- [ ] Implement.
- [ ] Browser check on the mock server (`node tests/mock-backend-server.js 8916`): on Handoffs set each filter in turn and confirm it stays set after the list redraws and that the analysis, pivots and export follow; Deputy with and without waiting requests; Audit with a date range older than the latest 200 rows (seed enough audit rows through actions); Profitability multi-month range; en/ar/ur; 390px and desktop; no console errors.
- [ ] `node tests/run.js` green; commit.
