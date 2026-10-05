# Collection Pivot: collector › area › branch › date › transactions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** On the receiving (Handoffs) screen, and as the first card a collector sees, one tree that answers "how much must each collector collect, from which area and branch, since which day, made of which requests", so a collector knows at a glance what to collect per branch and management sees it per collector.

**Architecture:** Client-side tree over the handoffs the screen already loads (`listHandoffs`, already scoped server-side), using the same tree/pivot pattern as the inventory levels table (`renderInventory`'s `build`/`kids`/`draw`, classes `pv-*`) and `exButtons_` for Excel/PDF. No new money arithmetic: amounts are the handoffs' own `amount` and `brkParts_`/`cashCalcRows_` for a transaction's statement. If the screen's data lacks something (e.g. a collector's whole scope for management), add a read-only server action `getCollectionPivot` returning the same handoff rows company-wide for company-wide roles — scoped like `listHandoffs`.

**Tech Stack:** one-file client `index.html` (ar/en/ur), Apps Script read action only if needed, Node tests.

**Spec:** the user, 2026-10-05: "the receiving screen should be pivoted by the collector person, then by area, by branch, then by date and by transactions; check these aggregated levels and do the best for the business, not only in the receiving screen but also in the collector user screen, to be easy for him to know how much he needs to collect by branch."

## Global Constraints
- Read-only; nothing is written. Scope: a collector sees only his own; an area manager his area; company-wide roles everything (same as the Handoffs screen today).
- The levels are fixed in this order: **المحصّل › المنطقة › الفرع › اليوم › الطلب** (collector › area › branch › day › request); open-to-level buttons, search, totals row, Excel (whole tree with grouping) and PDF (what is open), like the inventory levels table.
- Columns per node (money, SAR): **بانتظار نائب المدير** (pending_deputy), **بانتظار استلامك/استلامه** (pending), **مستلم لم يودَع** (confirmed, collector cash not yet deposited), **أُودع** (in the chosen period), **المطلوب تحصيله** = pending_deputy + pending (what is still to be collected), and **أقدم يوم** (oldest open day, with days waiting; older than the stale threshold shown amber, red past twice it).
- A returned request is not money to collect; it shows only as a muted count on its branch ("1 returned for correction").
- A collector's own view opens on his branches (level 1 = himself, opened to branch), sorted by amount to collect, largest first; a "Collect from here" summary line per branch shows the amount and the number of requests, and tapping a request opens that handoff row (confirm/dispute actions stay where they are).
- Every string ar/en/ur; numbers via `money()`; a zero recedes; RTL for ar/ur; phone width 390px works (the table scrolls inside its card; the first column sticks).
- Never a bare `<tr>` through `el()`; the table carries `data-nosort`.

### Task 1: the pivot card

**Files:** `index.html` (new `collectPivot_(handoffs, opts)` near `handoffItem`; mounted at the top of the Handoffs screen for collector, admin, finance, deputy, accountant, operations roles, and on Home for collectors; strings), `tests/run.js` (load `collectPivotTree_` — the pure tree builder — with `clientFn_` and test it), optionally `Collection.gs`/`Code.gs` for `getCollectionPivot`.

- [ ] Tests first for the pure builder `collectPivotTree_(handoffs, meta)` → nodes `{lvl, key, name, T:{deputy, pending, held, deposited, toCollect, oldest}, kids}`: two collectors, two areas, three branches, requests across three days in each status; assert every level's totals add up to its children, a returned request adds nothing but a returned count, a deposit counts in `deposited` of its collector, and the collector level sorts by `toCollect` desc.
- [ ] Implement the builder and the card (reuse the inventory tree's markup and CSS classes; do not copy the money formula).
- [ ] Browser check on the mock server (port 8909): as collectors mazen and khalid (North), as admin and deputy; 390px and desktop; Excel opens; no console errors.
- [ ] `node tests/run.js` green; commit.
