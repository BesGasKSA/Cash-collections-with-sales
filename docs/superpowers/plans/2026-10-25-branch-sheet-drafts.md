# Branch daily sheet → drafts, daily opening stock, stock health — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An area manager uploads the branches' "Daily Branches Report" Excel (sample `C:\Users\User\Downloads\كوثر.xlsx`, sheet per branch-day); each branch-day becomes a draft they review and send; the sheet's daily opening becomes that day's starting stock; a stock health check flags every variance; the live opening balances are cancelled.

**Architecture:** The client already parses this sheet (`brParse_`, `brParseStock_`, `brToAbx_` in index.html) and the area upload already dry-runs and submits through `bulkSubmitAreaBatch` to the deputy. We add (1) server-side drafts that hold the parsed lines and stock block and touch nothing until sent, (2) a day-opening record per branch, item and state that resets the running stock at the start of that day without posting any move, (3) one server health function used by the draft view and an Inventory card, (4) an admin action that cancels opening moves.

**Tech Stack:** Apps Script (`Collection.gs`, `Inventory.gs`, `Code.gs`), single-file client `index.html`, SheetJS/ExcelJS already loaded, tests `TZ=UTC node tests/run.js` on the stub harness.

**Spec:** the user's decisions of 2026-10-25 in this session, recorded under Decisions below.

## Decisions (the user's, 2026-10-25)
- Uploads become **drafts to review, then send**; Send goes to the deputy exactly as the area upload does today.
- The sheet's **بداية اليوم** is that day's starting stock ("take the beginning of every day, not the previous day's ending, until the data is accurate"). Variances are **flagged only, never posted**.
- Accounting rule for the check: a day's ending is the next day's opening. Compare the sheet's figures with the system's calculation and highlight every variance.
- Inventory is **branch-wise**; every POS device's sales draw on its branch's stock (already the model: an entry counts at `entry.locationId`).
- **Cancel all current opening balances**, all branches, voided with a reason (kept in the audit trail, never deleted).

## Global Constraints
- Live data: nothing is written until **Send**; a draft never changes cash, stock or reports.
- Every string ar/en/ur; numbers in `bdi dir=ltr`; compound `.card.x` selectors; no bare `<tr>` through `el()`; `fillTemplate_`/`colFill_` for repeated placeholders.
- New sheets store `[uuid, JSON, ISO]` rows through `writeRow` (the text-coercion sweep in tests must stay green).
- Scope = `checkClusterBulkEntryScope_` for the area manager (active area), admin and finance anywhere; deputy and company-wide roles read only.
- No new copy of the net formula (`computeNet_`) or of the stock arithmetic (`actionInventoryReport_`).
- The test fixture is anonymised (branch "Test Branch", devices D1..D4) with the real sheet's numbers; no real device serials or branch names in the public repo.

## Review Focus
1. A device number in the sheet that is not a POS of that branch → the draft shows it in red and **Send stays disabled** until it is mapped (test in Task 3).
2. The same branch and day uploaded twice (two files, or a re-upload) → one draft, replaced, never two; a branch-day already sent refuses a new draft with `day_already_entered` (test in Task 3).
3. The first day on file for a branch has no previous day → no opening variance is reported for it, not a variance of the full opening (test in Task 2).
4. The sheet's end-of-day row left blank → no end variance for that item, not a variance equal to the calculated end (test in Task 2).
5. A Send that dies half-way (Apps Script timeout) and is pressed again → the stock moves and the batch are not written twice (status `sending`, `importRef`, batch reuse) (test in Task 3).

---

### Task 1: The sheet parser reads this sheet's opening row and date

**Files:**
- Modify: `index.html` `brParseStock_` (~17168, the `KIND` table at ~17183)
- Create: `tests/fixtures/branch-sheet-sample.json` (aoa of the sample sheet, anonymised)
- Test: `tests/run.js` new section "branch sheet: opening row and date (2026-10-25)"

**Interfaces:**
- Produces: `brParseStock_(aoa) -> {branch, date, cols:[{col, header, group, state, opening, purchase, transfer_in, transfer_out, sales, end}]}` (adds `date`, the same date `brParse_` reads).

- [ ] **Step 1: Failing test** — load the fixture, `clientFn_('brParseStock_')` with its helpers; assert the iron full column has `opening === 206, purchase === 630, sales === 653, end === 183`, iron empty `opening === 1627, end === 1647`, and `date === '2026-10-20'`. Today the opening row ("بداية اليوم Openning Quantities") is missed: its label matches neither `opening` nor `رصيد`.
- [ ] **Step 2: Run, see it fail.** `TZ=UTC node tests/run.js` → FAIL on opening.
- [ ] **Step 3: Implement** — add `'بداية'`, `'openning'`, `'opening quantities'` to the opening keywords; return `date` from the same "التاريخ Date :" scan `brParse_` uses (share it as `brSheetDate_(aoa)`).
- [ ] **Step 4: Run, see it pass.**
- [ ] **Step 5: Commit** `Branch sheet: read the daily opening row and the sheet date`.

### Task 2: Day openings and the stock health check (server)

**Files:**
- Modify: `Code.gs` (`SHEETS.INV_DAY_OPEN: 'inv_day_open'`, routes), `Inventory.gs`
- Test: `tests/run.js` "day openings and stock health (2026-10-25)"

**Interfaces:**
- Produces:
  - row `inv_day_open`: `{id, locationId, itemId, state|null, date, qty, sheetEnd|null, importRef, by, at, voided}`; one live row per `locationId|itemId|state|date` (a newer one voids the older).
  - `invDayOpenWrite_(locId, date, cols, user, ref)` — writes the day's openings and the sheet's typed ends from `brParseStock_` columns already resolved to `{itemId, state, opening, end}`.
  - `actionInventoryReport_`: on a date with a live day-opening for a row, the running balance starts that day at `qty`; the gap `qty − calculated balance before that day` goes to a new row field `dayOpenGap` (summed over the period) so `opening + receipts − issues + dayOpenGap = ending` still holds. No move is written.
  - `getStockDayHealth {locationId?, dateFrom, dateTo}` → `{ok, rows:[{locationId, date, itemId, state, open, purchase, transferIn, transferOut, sales, calcEnd, sheetEnd, endGap, prevCalcEnd, openGap}]}`; `endGap = sheetEnd − calcEnd` (null when `sheetEnd` is null); `openGap = open − prevCalcEnd` (null when there is no earlier day for that row). Reads only; scope `invReadBranches_`. Built on `actionInventoryReport_` day by day, no second formula.
- [ ] **Step 1: Failing tests** — seed a branch, iron (cylinder) with day-opens 20 Oct `{full 206, empty 1627, sheetEnd full 183, empty 1647}`, a purchase of 630 full, sales 653 exchange + 3 empty; 21 Oct day-open `{full 190, empty 1647}`. Assert: 20 Oct `calcEnd` full 183, `endGap` 0; 21 Oct `openGap` full `190 − 183 = 7`, empty 0; 20 Oct `openGap === null` (first day); a row with `sheetEnd` null has `endGap === null`; the inventory report for 20–21 Oct ends at the 21 Oct figures with `dayOpenGap` full 7; no `inventory_moves` row was written by the day-opens.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** the sheet, `invDayOpenWrite_`, the report reset and `actionStockDayHealth_` (route `getStockDayHealth`, add to the client's `READ_ACTIONS`).
- [ ] **Step 4: Run all tests, green.**
- [ ] **Step 5: Commit** `Stock: the day's opening from the branch sheet, and the day-by-day health check`.

### Task 3: Area drafts (server)

**Files:**
- Modify: `Code.gs` (`SHEETS.AREA_DRAFTS: 'area_drafts'`, number prefix `ADR`, routes), `Collection.gs`
- Test: `tests/run.js` "area drafts (2026-10-25)"

**Interfaces:**
- Consumes: `invDayOpenWrite_` (Task 2), the existing `actionImportInventoryDay_` internals for purchases/transfers, `actionBulkSubmitAreaBatch_`.
- Produces:
  - row `area_drafts`: `{id, txNo, clusterId, locationId, date, uploadedBy, fileName, status: draft|sending|sent|discarded, rows (the area-upload lines as `abxRows_` sends them), stock (resolved columns), checks {devicesUnknown:[], salesGap:[{itemId,state,sheet,devices}]}, batchId, createdAt, sentAt}`.
  - `saveAreaDraft {locationId, date, fileName, rows, stock, checks}` → `{ok, draft}`; replaces the caller's own live draft for the same branch-day; refuses `day_already_entered` when that branch-day already has sales on file or a sent draft.
  - `listAreaDrafts {status?}` → the caller's scope; `discardAreaDraft {id}`; `sendAreaDraft {id}`: under `withCashLock_`; sets `sending`; refuses `devices_unknown` while `checks.devicesUnknown` is not empty; writes stock (`importRef = 'sheet:' + locationId + ':' + date`, reused on a retry), day-opens, then the batch (`bulkSubmitAreaBatch` path, `submissionId = 'draft:' + id` so a retry answers `already`); sets `sent` + `batchId`.
- [ ] **Step 1: Failing tests** — save → `draft`; save again same branch-day → same id, rows replaced, one row on file; send → batch `pending_deputy`, stock moves written once, day-opens written; send again → `already`, nothing doubled; a draft with an unknown device → `devices_unknown`; another area's manager → `forbidden`; save for a branch-day already sent → `day_already_entered`; a draft changes no figure in `getSalesReport` or `getInventoryReport` before Send.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all tests, green.**
- [ ] **Step 5: Commit** `Area upload: drafts per branch-day, sent to the deputy when reviewed`.

### Task 4: Drafts on the Area upload screen (client)

**Files:**
- Modify: `index.html` `renderAreaBulk` (~17303) and the branch-sheet helpers; strings in `L.ar/en/ur` (`adr_*`).

**Interfaces:**
- Consumes: Task 1 parser, Task 3 actions, `getStockDayHealth` (Task 2) for the previous day's calculated end.
- Produces: the screen's flow: pick one or more files → each sheet is parsed and saved as a draft (`saveAreaDraft`) → a **Drafts** list (branch, day, lines, cash to hand over from the dry run, health badge: green / amber with the count of variances) → open a draft = the existing preview (lines, dry-run figures, stock panel) plus a **Health** panel with three tables: (a) devices' sales vs the stock block's sales per item, (b) the sheet's end vs the calculated end per item and state, (c) today's opening vs the previous day's calculated end; every non-zero gap amber with its sign written as a word, not a minus. Buttons: Send to the deputy (disabled with a reason line while a device is unknown), Discard, Edit lines (the existing correction table). A draft opened again after a reload shows the same.
- [ ] **Step 1:** Browser check on the mock server with the anonymised fixture saved as .xlsx (`tests/fixtures/branch-sheet-sample.xlsx`, built from the JSON by a small ExcelJS script in `tests/`): upload → one draft; health shows 0 gaps for 20 Oct; change the fixture's iron end to 180 → end gap 3 shown amber; an unregistered device → Send disabled; Send → batch appears for the deputy. en/ar/ur, 390px and desktop, no console errors.
- [ ] **Step 2: Commit** `Area upload screen: drafts list, draft view with the stock health panel`.

### Task 5: Stock health on the Inventory screen

**Files:** `index.html` Inventory screen (`renderInventory`), strings `sh_*`.

**Interfaces:** Consumes `getStockDayHealth`. Produces a card "Stock health" under the period bar: one row per branch, day, item and state with a gap, newest first, filters by branch and kind of gap, totals, Excel/PDF through `exButtons_`; tapping a row opens that branch-day's draft or sales (`nsSalesView_` pattern). Empty = `emptyOk_` "Every day's opening matches the day before".
- [ ] **Step 1:** Browser check (mock): the Task 4 data shows the 3-unit gap; export opens in Excel (`tests/export-opens-in-excel.ps1`).
- [ ] **Step 2: Commit** `Inventory: stock health card with every variance`.

### Task 6: Cancel the opening balances

**Files:** `Inventory.gs`, `Code.gs` route, `tests/run.js`.

**Interfaces:** `adminVoidOpenings {reason, dryRun}` — admin or finance; `dryRun` answers `{count, byLocation}` and writes nothing; otherwise voids every live `opening` move (`voided, voidReason, voidedBy, voidedAt`), audits `inventory_openings_voided` with the count, under the script lock. Refuses without a reason.
- [ ] **Step 1: Failing test** — two openings, `dryRun` → count 2, nothing voided; real run → both voided, the inventory report no longer starts from them; a branch manager → `forbidden`.
- [ ] **Step 2–4:** implement, run green.
- [ ] **Step 5: Commit** `Admin: cancel all opening balances (kept, voided with a reason)`.

### Release
- Reviewer agent on the branch; fix findings.
- Deploy the server (`clasp pull`, copy `Code.gs`→`الرمز.js`, `Collection.gs`, `Inventory.gs`; push; deploy; ping), then the site.
- On live, signed in as admin: `adminVoidOpenings {dryRun:true}` → show the count to the user → run it (approved by the user on 2026-10-25) → report the count.
