# LPG Cylinder Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the inventory module into an LPG cylinder ledger that always knows, right now, how many full and empty cylinders of each type sit in each branch, on each car and with each deposit customer, and alerts when the figures go below zero.

**Architecture:** The cylinder is the unit. Everything still lives in `inventory_moves` (moves typed in) plus `daily_entries` (sales and expenses already entered), and one engine, `actionInventoryReport_` (Inventory.gs), turns them into rows per branch × stock item × full/empty. New move kinds and two product/item links extend that engine. Nothing is edited or deleted: a wrong move is voided with a reason, as today.

**Tech Stack:** Google Apps Script (V8) `.gs` files, single-file client `index.html` (plain JS, ar/en/ur), tests in Node via `tests/stub-harness.js` + `tests/run.js`, browser check via `tests/mock-backend-server.js`.

**Spec:** the user's answers of 2026-10-05 (this session), the branch sheets in `C:\Users\User\Downloads\TG.xlsx` (six branches, 28/9/2026), and CLAUDE.md sections "Inventory", "Cylinders full and empty", "Stock and sales checked against the branch sheets".

## The LPG process this models (from TG.xlsx and the user)

| Event | Full | Empty | Where it comes from |
|---|---|---|---|
| Exchange sale (تبديل), 37 SAR gas | −1 | +1 (same type) | day entry product line (exists) |
| Cross-type exchange (empty iron in, full fiber out) | −1 fiber | +1 iron | day entry line of a product with `returnOf` (**new**) |
| Cylinder body sale (بيع), 186/409.89/340 SAR | — | −1 | product `stockEffect: sell_empty` (exists) |
| Full cylinder sold outright | −1 | — | `sell_full` (exists) |
| Gasko refill (empty boxes out, full boxes back; 1 box = 35) | +N | −N | purchase on full (exists), entered in boxes (**new**) |
| New cylinders bought (no empties sent) | +N | — | purchase on full with `newCylinders` (**new**) |
| Empty bought back from a customer | — | +N | expense line whose item has `buysEmptyOf` + quantity (**new**) |
| Cylinders given on deposit to a customer | −N | — | move `deposit_out` + customer (**new**) |
| Deposit cylinders returned by the customer | — | +N (or full) | move `deposit_return` + customer (**new**) |
| Branch to branch | −N at A | +N at B | one linked transfer, both sides (**new**) |
| Car loaded from the store / returned in the evening | branch unchanged; car holder ± | same | `car_load` / `car_return` (**new**) |
| Physical count differs from the book | ± variance | ± variance | `count_gain` / `count_loss` from a count (**new**) |
| Damaged | −N | −N | `damage` (exists) |

Control that falls out of it: for one cylinder type, **full + empty + at customers** changes only through new cylinders, buy-backs, body sales, full sold outright and damage. An exchange or a Gasko refill never changes it. The screen shows this "cylinder pool" line.

## Global Constraints

- No move, entry or handover is ever edited or deleted; corrections are voids with a reason (CLAUDE.md "Locking").
- No change of cost rewrites a saved figure: costs are dated (CLAUDE.md "No change of rate rewrites a saved day").
- Every user-visible string exists in ar, en and ur in `L` (index.html); every refusal has its own code with three messages in `ERROR_KEYS_` (CLAUDE.md "Refusals name their field").
- Arabic labels: فرع, منطقة, مليان, فارغ, تبديل, بيع, عهدة (deposit), جرد (count). Company name الناقل الأفضل للغاز.
- Lookup tables keyed by ids are `Object.create(null)`; client input keys go through `hasOwn_`/`safeOwnKeys_` (trap 4).
- Never a bare `<tr>` through `el()` (trap 1); compound selectors `.card.x` to beat `.card` (trap 7); `fillTemplate_` for repeated placeholders (trap 9).
- Tests use made-up names and numbers only (the repo is public).
- Permission: record = admin, finance, area manager (his area), branch manager (his branch) — `invBranches_`; read = company-wide roles + those — `invReadBranches_`. Unchanged.
- Below zero is **warned, never blocked** (user, 2026-10-05).

## Review Focus

1. A cross-type exchange whose `returnOf` cylinder has no opening count at that branch: the full side must still deduct, the empty side reads "no opening yet", never short.
2. Voiding one side of a linked transfer must void the other; a transfer whose destination is the same branch is refused.
3. A car with sales but no load ever recorded is "not tracked", never short; the branch figure is unaffected by car loads.
4. A count entered for a date before the opening count, or for an item with no opening, is refused (`no_opening`), not turned into a gain.
5. A cost changed today does not move the value of a period that ended yesterday (full = gas + cylinder, both dated).

---

### Task 1: Cylinder types — cross-type exchange, boxes, new cylinders

**Files:**
- Modify: `Admin.gs` (`validateEntity_` product rules near line 731: `returnOf`, `boxSize`)
- Modify: `Inventory.gs` (`invCheckMove_`: `newCylinders`; `actionInventoryReport_`: refill skip, `returnOf`)
- Modify: `Costing.gs` (`costOfProduct_`: cross-type exchange cost)
- Modify: `index.html` (`ENTITY_FIELDS.product`: `returnOf`, `boxSize`; inventory add form: boxes/cylinders switch and "new cylinders" check; `L` strings; `ERROR_KEYS_`)
- Test: `tests/run.js` new section `--- LPG: cross-type exchange, boxes, new cylinders ---` after line 2726

**Interfaces:**
- Produces: product field `returnOf` (id of a `cylinder` product; only with `stockOf` + `stockEffect: 'exchange'`); product field `boxSize` (positive integer, cylinder items only, default 35 on the client); move field `newCylinders: true` (only on `kind: 'purchase'`, `state: 'full'`).
- Errors: `invalid_return_link` (returnOf not a cylinder, or set without an exchange), `invalid_box_size`, `invalid_new_cylinders` (flag on anything but a full purchase).

- [ ] **Step 1: Write the failing tests** (use the scenario branch helpers `scProd`, `scRep`, `scRow`, `scLine` from line 2738 onwards; place the section after section 2728's block ends)

```js
console.log('--- LPG: cross-type exchange, boxes, new cylinders ---');
var lxIron = scProd({ name: 'Lx Iron Exchange', type: 'goods', unitPrice: 37, unitCost: 11, emptyCost: 140, cylinder: true, stockName: 'Lx iron', boxSize: 35 });
var lxFiber = scProd({ name: 'Lx Fiber Exchange', type: 'goods', unitPrice: 37, unitCost: 11, emptyCost: 400, cylinder: true, stockName: 'Lx fiber' });
var lxUp = scProd({ name: 'Lx Iron to Fiber', type: 'goods', unitPrice: 297, stockOf: lxFiber.id, stockEffect: 'exchange', returnOf: lxIron.id });
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Lx Bad Return', type: 'goods', stockOf: lxFiber.id, stockEffect: 'sell_empty', returnOf: lxIron.id } }).error === 'invalid_return_link', 'a return type needs an exchange');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Lx Bad Return2', type: 'goods', stockOf: lxFiber.id, stockEffect: 'exchange', returnOf: scReg.id } }).error === 'invalid_return_link', 'and must be a cylinder item');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Lx Bad Box', type: 'goods', cylinder: true, stockName: 'x', boxSize: -3 } }).error === 'invalid_box_size', 'a box holds a whole positive number');
[[lxIron, 'full', 50], [lxIron, 'empty', 20], [lxFiber, 'full', 30], [lxFiber, 'empty', 5]].forEach(function (o) {
  check(call({ action: 'addInventoryMove', token: adminTok, locationId: scLoc.id, productId: o[0].id, state: o[1], kind: 'opening', qty: o[2], date: '2026-09-01' }).ok, 'lx opening');
});
check(call({ action: 'importDailyEntries', token: adminTok, rows: [scLine({ sub: 'lx-1', date: '2026-09-10', productId: lxUp.id, qty: 3, unitPrice: 297, cashSales: 891 })] }).ok, 'three customers swap iron for fiber');
var lx1 = scRep();
check(scRow(lx1, lxFiber.id, 'full').sales === 3, 'three full fiber leave (got ' + scRow(lx1, lxFiber.id, 'full').sales + ')');
check(scRow(lx1, lxIron.id, 'empty').exchangeIn === 3 && !scRow(lx1, lxFiber.id, 'empty').exchangeIn, 'three empty IRON come back, no fiber empty');
check(call({ action: 'addInventoryMove', token: adminTok, locationId: scLoc.id, productId: lxIron.id, state: 'full', kind: 'purchase', qty: 70, newCylinders: true, date: '2026-09-11' }).ok, 'seventy brand-new full cylinders bought');
check(call({ action: 'addInventoryMove', token: adminTok, locationId: scLoc.id, productId: lxIron.id, state: 'full', kind: 'purchase', qty: 35, date: '2026-09-11' }).ok, 'and one box refilled at the plant');
var lx2 = scRep();
check(scRow(lx2, lxIron.id, 'full').purchases === 105 && scRow(lx2, lxIron.id, 'empty').refillOut === 35, 'only the refilled box took empties (refillOut ' + scRow(lx2, lxIron.id, 'empty').refillOut + ')');
check(scRow(lx2, lxIron.id, 'full').newCylinders === 70, 'the new cylinders are counted as such');
check(call({ action: 'addInventoryMove', token: adminTok, locationId: scLoc.id, productId: lxIron.id, state: 'empty', kind: 'damage', qty: 1, newCylinders: true, date: '2026-09-11' }).error === 'invalid_new_cylinders', 'the flag belongs to a full purchase only');
```

- [ ] **Step 2: Run** `node tests/run.js 2>&1 | Select-Object -Last 3` (PowerShell). Expected: the new checks FAIL (`returnOf`, `boxSize` unknown, `newCylinders` ignored).

- [ ] **Step 3: Implement**
  - `Admin.gs` `validateEntity_` product block: if `d.returnOf` set → the target must be an active product with `cylinder: true`, and `d.stockOf` set and `(d.stockEffect || 'exchange') === 'exchange'`, else `invalid_return_link`. `d.boxSize` given → must be a whole number 1..1000, and only on `d.cylinder`, else `invalid_box_size`. Clear `returnOf` when `stockOf` is cleared.
  - `Inventory.gs` `invCheckMove_`: read `m.newCylinders === true`; allowed only when `kind === 'purchase' && product.cylinder && st === 'full'`, else `invalid_new_cylinders`; return it on `move.newCylinders`. Write it in `actionAddInventoryMove_` and `actionImportInventoryDay_`.
  - `actionInventoryReport_`: row field `newCylinders: 0`. In the moves loop, a full purchase with `m.newCylinders` posts `purchases` and `newCylinders` but **not** `refillOut`. In the entries loop, an exchange's empty goes to `row(e.locationId, sp.returnOf && products[sp.returnOf] ? sp.returnOf : anchor.id, 'empty')`.
  - `Costing.gs` `costOfProduct_`: for `p.stockEffect === 'exchange'` with `p.returnOf`, return `gas + emptyCostOn_(anchor) − emptyCostOn_(returnOf)` (the customer leaves with a dearer cylinder); keep existing behaviour otherwise (Task 5 later makes `emptyCost` dated; here read `Number(x.emptyCost || 0)`).
  - `index.html`: `ENTITY_FIELDS.product` add `{k:'returnOf', l:'admin_returnOf', pick:'products', pickFilter: cylinder only}` after `stockEffect`, and `{k:'boxSize', l:'admin_boxSize', type:'number'}` after `emptyCost`; `ERR_FIELD_` entries for both errors. Inventory add form: when the item is a cylinder and kind is purchase, show a "boxes / cylinders" switch (boxes multiply by `p.boxSize || 35`, the result shown beside the field) and a "new cylinders (no empties sent)" checkbox. Strings `admin_returnOf`, `admin_boxSize`, `inv_inBoxes`, `inv_newCyl`, `inv_newCylHint`, `inv_boxesEq` ("{n} boxes = {q} cylinders") in ar/en/ur; error texts for the three new codes.

- [ ] **Step 4: Run** the tests. Expected: `N passed, 0 failed`.
- [ ] **Step 5: Commit** — `git add Admin.gs Inventory.gs Costing.gs index.html tests/run.js; git commit` with message "LPG: cross-type exchange, purchases in boxes, new cylinders".

### Amendment A (user, 2026-10-05): inventory items are not sales items

The user: "differentiate between the sales item and the inventory item — exchange gas is a sales item; we have filled cylinders and empty ones, and we don't have exchange gas as a cylinder." Until now a *product* (e.g. «استبدال غاز») carried `cylinder` and held the stock. From here on:

- **Inventory item** (entity kind `stock_item`, sheet `stock_items`, code prefix `STK`): what the branch holds and counts. Fields: `name`, `kind` (`cylinder` = counted مليانة/فارغة, or `unit`), `boxSize` (cylinder only, default 35), `gasCost` (cost to fill one; cylinder only), `cylinderCost` (value of the empty body; cylinder only), `unitCost` (unit only), `active`. Every move (opening, purchase, damage, transfer, deposit, car load/return, count) names a `stockItemId`, never a product.
- **Sales item** (`product`, unchanged sheet): what the customer pays for. Its stock link: `stockItemId` + `stockEffect` (`exchange` | `sell_empty` | `sell_full` for a cylinder item; `unit` for a unit item; none for a service) + optional `returnItemId` (cross-type exchange: the cylinder item whose empty comes back). A product never holds stock.
- **Reading old data without rewriting it**: a move saved before has `productId` and no `stockItemId`; it belongs to `stockItemOf_(productId)` = that product's `stockItemId`. The one-time job `migrateStockItemsOnce_` (flag `MIGRATED_STOCK_ITEMS`) creates one stock item per existing `cylinder` product (name = its `stockName`, else its name; `cylinderCost` = `emptyCost`, `gasCost` = `unitCost`, `boxSize`) and one unit stock item per other goods product that has moves or is not drawn from another, then writes `stockItemId` (+ `stockEffect`) onto every goods product: the cylinder product itself gets `exchange`, a `stockOf` product its own `stockEffect` on its anchor's new item, a plain goods product `unit`. Moves and entries are never touched. Audited `migrate_stock_item`.
- Task 1's product fields `returnOf` and `boxSize` move: `returnOf` → product `returnItemId` (a cylinder stock item); `boxSize` → the stock item. Product `cylinder`, `stockName`, `emptyCost`, `stockOf` stay readable for the migration and old rows but leave the product form.
- Cost of goods (`costOfProduct_`): a sales item's cost comes from its stock item and effect, dated: exchange = gasCost (+ cylinderCost of the item going out − cylinderCost of the item coming back, floored at 0, for cross-type); sell_empty = cylinderCost; sell_full = gasCost + cylinderCost; unit = unitCost. Dated history in `product_costs` keyed `stk:<id>#gas`, `stk:<id>#cyl`, `stk:<id>#unit`. A product's own legacy `unitCost` history still wins for days before the migration (`costOfProduct_` falls back to it when the stock item has no record yet).
- **Every later task reads "productId" of a move, a row, a line, a holding or a pool entry as `stockItemId`.** Report rows become `{locationId, stockItemId, state, ...}`; `salesBySource` keeps the sales item that sold. Product fields `buysEmptyOf` (Task 3) point at a cylinder stock item.

### Task 1b: Inventory items separate from sales items

**Files:** `Code.gs` (SHEETS.STOCK_ITEMS, CODE_PREFIX_ `STK`, `runOneTimeMigrations_` adds the job), `Admin.gs` (ENTITY_SHEET/validateEntity_ for `stock_item`; product link validation; `ENTITY_CHILDREN` so a stock item with moves or linked products can't be deleted; `listMeta` sends `stockItems`, costs only to cost readers as today; `migrateStockItems_`), `Inventory.gs` (moves on `stockItemId`; report rows per stock item; legacy resolution), `Costing.gs` (cost from stock items, dated), `index.html` (master-data tab "الأصناف المخزنية / Inventory items / انوینٹری اشیاء", product form: stock link fields replace cylinder/stockName/emptyCost/stockOf/returnOf/boxSize; inventory screen, live card, branch-sheet stock panel and its one-tap setup all on stock items; strings ar/en/ur), `tests/run.js`, `tests/mock-backend-server.js` seed.

- [ ] Tests first (new section `--- LPG: inventory items are not sales items ---`): create stock items «أسطوانة حديد» (cylinder, boxSize 35, gasCost 11, cylinderCost 140), «أسطوانة فايبر» (cylinder, cylinderCost 400), «منظم» (unit, unitCost 28); sales items «استبدال غاز» (stockItemId iron, exchange), «بيع أسطوانة حديد» (iron, sell_empty), «تبديل حديد بفايبر» (fiber, exchange, returnItemId iron), «منظم» (unit item, unit), «توصيل» (services, no link). Assert: a move naming a product id is refused `use_stock_item`; opening/purchase on the stock items work; a day selling 10 exchange + 2 body sales + 3 cross-type + 4 regulators gives iron full −10, iron empty +10 +3 −2, fiber full −3, regulator −4; report rows carry `stockItemId` and no product-named row exists; a product linked to a unit item with `stockEffect: 'exchange'` is refused `invalid_stock_link`; `returnItemId` on a non-exchange or to a unit item refused `invalid_return_link`; deleting a stock item with moves → `has_children`. Migration test: build the old shape (a `cylinder` product with moves and a `stockOf` product with sales, written the old way through the existing actions before the flag), run `ctx.migrateStockItems_()`, then the report's figures are identical to before, every goods product has a `stockItemId`, no move or entry row changed (compare JSON of both sheets before/after), and a second run changes nothing.
- [ ] Implement per Amendment A; carry Task 1's `newCylinders`, refill skip and box entry onto stock items; move Task 1's `returnOf`/`boxSize` tests onto the new fields.
- [ ] `node tests/run.js` all green; commit "LPG: inventory items separate from sales items".

### Amendment B (user, 2026-10-05): a sale without stock is flagged the moment it is entered

The user: "when we record the sales without inventory available it must be flagged directly." Still a warning, never a block (the user's earlier answer). Task 6 owns it, in addition to its daily digest:
- **Before saving** (entry form, area Excel preview): each sales line linked to a stock item shows the branch's available figure for the stock it draws (`getInventoryLive` for that branch, cached for the form's life, minus what earlier lines of the same form take), and turns red with «لا يوجد مخزون كافٍ» when its quantity is larger.
- **On save** (`createDailyEntry`, `importDailyEntries`, `bulkSubmitAreaBatch`, the deputy's approval): the server works out the branch's stock after the write (`invShortAfter_(locationId, stockKeys)`), stamps every new entry row whose stock went below zero with `stockShort: [{stockItemId, state, ending}]`, and returns `stockShort` in the response; the client shows it at once in red. Lists, the day card and the sales report show a «بيع بدون مخزون» chip on such rows; the inventory screen lists them ("sales recorded without stock") until a later purchase, transfer or count brings the item back to zero or above.
- The branch's manager and area manager get the alert the same day (the Task 6 digest, triggered also right after a flagged save, still once per branch per day).

### Amendment C (user, 2026-10-06): gas is the stock, the cylinder is its container

The user, repeated with emphasis: "10 filled cylinders = 10 empty cylinders + 10 gas"; "the gas is the main inventory"; gas exists **only inside cylinders** (no bulk tank). So for one cylinder type at one place:

- **Gas** = filled cylinders (one charge each). **Bodies** = filled + empty. Empty = bodies − gas.
- Value: gas × gas cost of the day + bodies × cylinder cost of the day. That is exactly the sum of today's filled and empty values (filled = gas + cylinder, empty = cylinder), so nothing already valued changes.

What each event does, and the two identities every test checks:

| Event | Gas | Bodies |
|---|---|---|
| Exchange sale (تبديل) | −1 | 0 |
| Cross-type exchange (iron in, fiber out) | fiber −1 | fiber −1, iron +1 |
| Filled cylinder sold outright | −1 | −1 |
| Empty body sold (بيع) | 0 | −1 |
| Gasko refill of N | +N | 0 |
| New cylinders bought filled | +N | +N |
| Empty bought back from a customer (Task 3) | 0 | +N |
| Damaged filled / damaged empty | −N / 0 | −N / −N |
| Transfer out / in (Task 2) | −filled / +filled | −all / +all |
| Car load / return (Task 4) | moves between branch and car, company total unchanged | same |
| Deposit with a customer (Task 2) | see question below | company bodies unchanged, branch −N |

- `gas.ending === filled.ending` and `bodies.ending === filled.ending + empty.ending` for every branch and type, every period.
- `gasValue + bodiesValue === filledValue + emptyValue` (to the halala).

**Open question for the user (asked 2026-10-06, Task 2 waits on it):** when filled cylinders go to a restaurant on deposit (عهدة), is the gas inside sold at that moment (a sales line), with only the body staying the company's? The default until answered is yes: deposit moves bodies, and the gas leaves through the day's sales line.

### Task 1c: Gas and bodies on every stock screen (priority, before Task 2)

**Files:** `Inventory.gs` (`actionInventoryReport_` adds `cylSummary`), `index.html` (equation card per cylinder type, live card, tree, Excel/PDF), `Admin.gs` (stock item `fillKg`, optional), `tests/run.js`.

Today the equation card adds filled, empty and unit items into one figure (`sumOf(counted)` in `renderInventory`), which reads as neither gas nor bodies. The live card lists filled and empty as separate tiles with no gas/bodies line.

- [ ] **Tests first** (section `--- LPG: gas is the stock, the cylinder its container ---`): one branch, iron (gasCost 11, cylinderCost 140, fillKg 12.5) and fiber, opening filled 10 / empty 5. Run the table's events in one period: 1 exchange, 1 cross-type, 1 filled sold, 1 body sold, refill 4, 2 new, 1 damaged filled, 1 damaged empty. Assert per type the `cylSummary` row: `gas`, `bodies`, `empty`, each in/out column from the table, `gasKg = gas × 12.5`; both identities for every branch and type; the value identity; a unit item has no `cylSummary` row; a branch with no opening has none either (still "not counted").
- [ ] **Server:** `cylSummary: [{locationId, stockItemId, gasOpening, gasIn: {refill, newCyl, transferIn}, gasOut: {sold, soldFull, damaged, transferOut}, gas, bodiesOpening, bodiesIn: {newCyl, boughtBack, transferIn, exchangeOtherIn}, bodiesOut: {soldEmpty, soldFull, damaged, transferOut, exchangeOtherOut}, bodies, empty, gasValue, bodiesValue, gasKg}]`, built from the filled/empty rows already worked out (no second pass over moves or entries). The cross-type exchange is split from the same-type one in the row (`exchangeIn` by `returnItemId`), so bodies move between types correctly.
- [ ] **Stock item** `fillKg` (optional, kg of gas in one filled cylinder, 0–100): `validateEntity_` (`invalid_fill_kg`), the item form and the setup table. Where set, gas also shows in kg and the company total in kg.
- [ ] **Screens** (strings ar/en/ur: غاز / Gas / گیس, أسطوانات (أجسام) / Cylinders / سلنڈر):
  - Equation card: one block per cylinder type with two lines, **Gas**: opening + refilled + new + transfers in − sold − damaged − transfers out = gas now, and **Cylinders**: opening + new + bought back + transfers in − bodies sold − filled sold − damaged − transfers out = cylinders now (of which filled / empty). Unit items keep the old equation in their own block. No figure ever adds a gas charge to a body.
  - Live card: per type, `Gas 598 · Cylinders 1,264 (empty 666)`, kg where known, red when gas or bodies are below zero.
  - Tree: the item level gets Gas and Cylinders columns; filled/empty stay as children.
  - Excel/PDF: a "Gas and cylinders" sheet first.
- [ ] Mock-server browser check at 390px and desktop in ar/en/ur, `node tests/run.js` green, review (code-review skill), then publish straight away (user, 2026-10-06: push every update): build, push `main`, clasp push + deploy, GET/POST ping, live page without console errors.

### Order from here (user, 2026-10-06: "handle it as priority now")

1c → 2 → 3 → 4 → 5 → 6 → 7. Each task is published live when it passes, not held for the end. Task 6's "cylinder pool" line becomes the company-wide **Cylinders** figure of 1c (branches + cars + with customers), so it is not built twice.

### Task 2: Cylinders leaving the branch — linked transfers and customer deposits

**Files:**
- Modify: `Inventory.gs` (new `actionTransferInventory_`; `actionVoidInventoryMove_` voids a linked pair; kinds `deposit_out`, `deposit_return`; report fields and `customerHoldings`)
- Modify: `Code.gs` (`route_` handlers `transferInventory`)
- Modify: `index.html` (transfer form, deposit fields, "cylinders with customers" card, strings)
- Test: `tests/run.js` section `--- LPG: branch transfers go in pairs; cylinders on deposit ---`

**Interfaces:**
- Produces: action `transferInventory {fromLocationId, toLocationId, date, note, lines:[{productId, state, qty}]}` → `{ok, moves}`; each pair shares `linkId`. Move kinds `deposit_out` (customerId required, any state) and `deposit_return` (customerId required); row fields `depositOut`, `depositBack`; report key `customerHoldings: [{locationId, customerId, productId, state, out, back, held}]` (all time up to `dateTo`, branch scope).
- Errors: `same_branch`, `customer_required`, `unknown_customer`, `deposit_over_held` (warning only? **no**: a return larger than held is refused — returning cylinders a customer never had is a typing error).

- [ ] **Step 1: Failing tests**

```js
console.log('--- LPG: branch transfers go in pairs; cylinders on deposit ---');
var tr1 = call({ action: 'transferInventory', token: adminTok, fromLocationId: scLoc.id, toLocationId: scOther.id, date: '2026-09-12', note: 'to the other branch', lines: [{ productId: lxIron.id, state: 'full', qty: 10 }, { productId: lxIron.id, state: 'empty', qty: 4 }] });
check(tr1.ok && tr1.moves.length === 4, 'one transfer writes both branches, both states (' + (tr1.error || '') + ')');
check(tr1.moves[0].linkId && tr1.moves.every(function (m) { return m.linkId; }), 'every side carries the link');
check(call({ action: 'transferInventory', token: adminTok, fromLocationId: scLoc.id, toLocationId: scLoc.id, date: '2026-09-12', lines: [{ productId: lxIron.id, state: 'full', qty: 1 }] }).error === 'same_branch', 'a branch cannot send to itself');
check(call({ action: 'transferInventory', token: scMgr2Tok, fromLocationId: scLoc.id, toLocationId: scOther.id, date: '2026-09-12', lines: [{ productId: lxIron.id, state: 'full', qty: 1 }] }).error === 'forbidden', 'only who keeps the sending branch sends');
var outMv = tr1.moves.filter(function (m) { return m.locationId === scLoc.id && m.state === 'full'; })[0];
check(call({ action: 'voidInventoryMove', token: adminTok, id: outMv.id, reason: 'never left' }).ok, 'one side voided');
check(ctx.readSheet(ctx.SHEETS.INV_MOVES).filter(function (m) { return m.linkId === outMv.linkId; }).every(function (m) { return m.voided; }), 'and its partner with it');
var dep = call({ action: 'addInventoryMove', token: adminTok, locationId: scLoc.id, productId: lxIron.id, state: 'full', kind: 'deposit_out', qty: 6, customerId: scCust.id, date: '2026-09-13' });
check(dep.ok, 'six full cylinders on deposit with the restaurant (' + (dep.error || '') + ')');
check(call({ action: 'addInventoryMove', token: adminTok, locationId: scLoc.id, productId: lxIron.id, state: 'full', kind: 'deposit_out', qty: 1, date: '2026-09-13' }).error === 'customer_required', 'a deposit names its customer');
check(call({ action: 'addInventoryMove', token: adminTok, locationId: scLoc.id, productId: lxIron.id, state: 'empty', kind: 'deposit_return', qty: 9, customerId: scCust.id, date: '2026-09-14' }).error === 'deposit_over_held', 'nobody returns more than they hold');
check(call({ action: 'addInventoryMove', token: adminTok, locationId: scLoc.id, productId: lxIron.id, state: 'empty', kind: 'deposit_return', qty: 2, customerId: scCust.id, date: '2026-09-14' }).ok, 'two come back empty');
var dRep = scRep();
check(scRow(dRep, lxIron.id, 'full').depositOut === 6 && scRow(dRep, lxIron.id, 'empty').depositBack === 2, 'each shows in its own column');
var held = (dRep.customerHoldings || []).filter(function (h) { return h.customerId === scCust.id && h.productId === lxIron.id; });
check(held.reduce(function (a, h) { return a + h.held; }, 0) === 4, 'the restaurant still holds four (got ' + JSON.stringify(held) + ')');
```
(Create `scMgr2Tok` by signing in `scMgr2` with the same helper the file uses for other users — search `function loginAs` / `tokenFor` near the top of run.js and reuse it.)

- [ ] **Step 2: Run** — expected FAIL (`unknown_action` for `transferInventory`, deposit kinds `invalid_kind`).
- [ ] **Step 3: Implement**
  - `INV_KINDS_` (server and client) gain `deposit_out`, `deposit_return`. `invCheckMove_`: for those two kinds read `m.customerId` → `customer_required` if empty, `unknown_customer` if no active customer; return it on the move. `actionAddInventoryMove_`: under the lock, for `deposit_return` sum the customer's not-voided `deposit_out` − `deposit_return` for that branch, product (any state) and refuse `deposit_over_held` if `qty` is larger.
  - Report: `MOVE_FIELD_` maps `deposit_out → depositOut` (deduct), `deposit_return → depositBack` (add, `IN_`). `available` adds `depositBack`; `ending` deducts `depositOut`. `customerHoldings`: aggregate all not-voided deposit moves in scope with `date <= to`, keyed `locationId|customerId|productId` (state of the out move is `full`, back may be either: `held = out − back`), keep rows with `out || back`.
  - `actionTransferInventory_(req, user)`: `invLocFor_(user, fromLocationId)`; `to` must be an existing location ≠ from (`same_branch`); 1..50 lines each through `invCheckMove_` with `kind: 'transfer_out'`; under the script lock write for each line a `transfer_out` at from and `transfer_in` at to, same `linkId` (`Utilities.getUuid()`), `note`, `enteredBy`; audit `inventory_transfer`. Route it in `Code.gs` next to `addInventoryMove`.
  - `actionVoidInventoryMove_`: after the permission check, if `m.linkId`, void every not-voided move with that `linkId` with the same reason (the permission is checked on the side clicked; admin/finance or the sender side's keeper).
  - Client: kind picker shows "Transfer to another branch" (opens the transfer form: destination branch, lines full/empty per cylinder item, or units) instead of the two one-sided kinds (keep those two only in the branch-sheet import); deposit kinds show a customer picker (`state.meta.customers`, active). New card under the equation when `customerHoldings` has rows: "Cylinders with customers (عهدة)" — customer, item, out, back, held. Strings in ar/en/ur; errors in `ERROR_KEYS_`.

- [ ] **Step 4: Run** tests — all pass.
- [ ] **Step 5: Commit** "LPG: linked branch transfers, cylinders on deposit with customers".

### Task 3: Empties bought back, paid from the takings

**Files:**
- Modify: `Admin.gs` (`validateEntity_` expense_item: `buysEmptyOf`)
- Modify: `Collection.gs` (`checkNonSalesFields_`: `expenseQty`)
- Modify: `Inventory.gs` (report: `buyBack` from entries)
- Modify: `index.html` (`ENTITY_FIELDS.expense_item`; entry form expense line: quantity box when the item buys empties; strings)
- Test: `tests/run.js` section `--- LPG: an empty bought back is an expense and an empty in, from one line ---`

**Interfaces:**
- Produces: expense item field `buysEmptyOf` (cylinder product id); entry field `expenseQty` (whole number > 0, required when the item has `buysEmptyOf`, refused otherwise); row field `buyBack` (adds to empty).
- Errors: `invalid_buy_link`, `qty_required`, `qty_not_allowed`.

- [ ] **Step 1: Failing tests**

```js
console.log('--- LPG: an empty bought back is an expense and an empty in, from one line ---');
var bbItem = call({ action: 'adminSaveEntity', token: adminTok, kind: 'expense_item', data: { name: 'Lx Empty Bought Back', buysEmptyOf: lxIron.id, active: true } });
check(bbItem.ok, 'an expense item can buy empties of a cylinder type (' + (bbItem.error || '') + ')');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'expense_item', data: { name: 'Lx Bad Buy', buysEmptyOf: scReg.id } }).error === 'invalid_buy_link', 'only a cylinder type');
var bbDay = call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-15', sourceType: 'store', sourceId: scStore.id, cashSales: 500, expenseAmount: 150, expenseItemId: bbItem.entity.id, expenseReason: 'two old cylinders', expenseQty: 2 });
check(bbDay.ok, 'the day saves (' + (bbDay.error || '') + ')');
check(scRow(scRep(), lxIron.id, 'empty').buyBack === 2, 'two empties come in');
check(call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-15', sourceType: 'store', sourceId: scStore.id, cashSales: 100, expenseAmount: 75, expenseItemId: bbItem.entity.id, expenseReason: 'x' }).error === 'qty_required', 'a buy-back says how many');
var plainItem = (call({ action: 'listMeta', token: adminTok }).expenseItems || []).filter(function (x) { return !x.buysEmptyOf && x.active !== false; })[0];
check(call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-15', sourceType: 'store', sourceId: scStore.id, cashSales: 100, expenseAmount: 10, expenseItemId: plainItem.id, expenseReason: 'tea', expenseQty: 3 }).error === 'qty_not_allowed', 'an ordinary expense carries no quantity');
check(call({ action: 'voidEntries', token: adminTok, ids: [bbDay.entry.id], reason: 'test' }).ok && !scRow(scRep(), lxIron.id, 'empty').buyBack, 'a voided day takes them out again');
```
(Check the actual meta key for expense items with `grep -n "expenseItems\|expense_items" Admin.gs` and use that name.)

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — validation in `validateEntity_` (`buysEmptyOf` must be an active `cylinder` product); `checkNonSalesFields_` reads `expenseQty` (whole positive number up to 100000) and applies the two rules, stores it; the extra expense lines (`extraMoneyRows_`) carry their own `expenseQty`. Report entries loop: an entry with `expenseItemId` whose item has `buysEmptyOf` (read `SHEETS.EXPENSE_ITEMS` once) and `expenseQty > 0` posts `buyBack` on `row(e.locationId, item.buysEmptyOf, 'empty')`; `IN_` gains `buyBack`. Client: `ENTITY_FIELDS.expense_item` gains the cylinder pick; on the entry form an expense line whose item has `buysEmptyOf` shows a quantity box (`.mExpQty`), required; the draft (`draftCollect_`/`draftApply_`) keeps it. The area Excel's expense row refuses a buy-back item with `abx_e_qty` ("this item needs a quantity: enter it on the entry screen"). Strings ar/en/ur.
- [ ] **Step 4: Run** — pass. **Step 5: Commit** "LPG: empties bought back from customers".

### Task 4: Stock on each car

**Files:**
- Modify: `Inventory.gs` (`actionCarStockMove_`; report key `cars`)
- Modify: `Code.gs` (route `carStockMove`)
- Modify: `index.html` (car load/return form; "On the cars" card on the inventory screen and in the live card; strings)
- Test: `tests/run.js` section `--- LPG: a car carries its own stock ---`

**Interfaces:**
- Consumes: `entryCarId_(e)` (Collection.gs) — the car a `car` entry or a car-owned `pos` entry belongs to.
- Produces: action `carStockMove {locationId, carId, kind: 'car_load'|'car_return', date, note, lines:[{productId, state, qty}]}` → `{ok, moves}` (moves carry `carId`). Report key `cars: [{locationId, carId, productId, state, loaded, returned, sold, exchangeIn, onCar, tracked, since}]`, all-time to `dateTo`: `onCar = loaded − returned − sold + exchangeIn` (empty side: `exchangeIn` adds, `sell_empty` deducts). `tracked` is true from the car's first not-voided load (`since`); sales before it don't count on the car. Car moves never change the branch rows.
- Errors: `invalid_car` (car not in that branch), `return_over_car` is **not** an error (warn: the screen shows it).

- [ ] **Step 1: Failing tests**

```js
console.log('--- LPG: a car carries its own stock ---');
var cr0 = call({ action: 'getInventoryReport', token: financeTok, dateFrom: '2026-09-01', dateTo: '2026-09-30', locationId: scLoc.id });
var carBefore = (cr0.cars || []).filter(function (c) { return c.carId === scCar.id; });
check(carBefore.every(function (c) { return !c.tracked; }), 'a car with sales but no load is not tracked, never short');
var ld = call({ action: 'carStockMove', token: adminTok, locationId: scLoc.id, carId: scCar.id, kind: 'car_load', date: '2026-09-20', lines: [{ productId: lxIron.id, state: 'full', qty: 40 }] });
check(ld.ok && ld.moves.length === 1 && ld.moves[0].carId === scCar.id, 'the car is loaded with 40 full (' + (ld.error || '') + ')');
check(call({ action: 'importDailyEntries', token: adminTok, rows: [scLine({ sub: 'car-1', date: '2026-09-20', sourceType: 'car', sourceId: scCar.id, productId: lxIron.id, qty: 25, unitPrice: 37, cashSales: 925 })] }).ok, 'the car exchanges 25');
var cr1 = call({ action: 'getInventoryReport', token: financeTok, dateFrom: '2026-09-20', dateTo: '2026-09-20', locationId: scLoc.id });
function carRow(rep, st) { return (rep.cars || []).filter(function (c) { return c.carId === scCar.id && c.productId === lxIron.id && c.state === st; })[0] || {}; }
check(carRow(cr1, 'full').onCar === 15 && carRow(cr1, 'empty').onCar === 25, 'the car holds 15 full and 25 empty');
var branchFullBefore = scRow(cr1, lxIron.id, 'full').ending;
check(call({ action: 'carStockMove', token: adminTok, locationId: scLoc.id, carId: scCar.id, kind: 'car_return', date: '2026-09-20', lines: [{ productId: lxIron.id, state: 'full', qty: 15 }, { productId: lxIron.id, state: 'empty', qty: 24 }] }).ok, 'evening return: 15 full, 24 empty');
var cr2 = call({ action: 'getInventoryReport', token: financeTok, dateFrom: '2026-09-20', dateTo: '2026-09-20', locationId: scLoc.id });
check(carRow(cr2, 'full').onCar === 0 && carRow(cr2, 'empty').onCar === 1, 'one empty is still on the car: the driver owes it');
check(scRow(cr2, lxIron.id, 'full').ending === branchFullBefore, 'loading and returning never change the branch total');
check(call({ action: 'carStockMove', token: adminTok, locationId: scOther.id, carId: scCar.id, kind: 'car_load', date: '2026-09-20', lines: [{ productId: lxIron.id, state: 'full', qty: 1 }] }).error === 'invalid_car', 'a car loads only at its own branch');
check(call({ action: 'carStockMove', token: dpTok, locationId: scLoc.id, carId: scCar.id, kind: 'car_load', date: '2026-09-20', lines: [{ productId: lxIron.id, state: 'full', qty: 1 }] }).error === 'forbidden', 'a driver does not load his own car');
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — `actionCarStockMove_`: `invLocFor_`; car = `getById_(SHEETS.CARS, carId)` with `locationId === loc.id` else `invalid_car`; kind in the two; 1..50 lines through `invCheckMove_` (pass `kind: 'purchase'` for the field checks, then set the real kind); write under the lock with `carId`. The report's moves loop skips `car_load`/`car_return` for branch rows and builds `cars` instead; the entries loop, for an entry whose `entryCarId_(e)` is a car with a load on or before `e.date`, adds to that car's `sold`/`exchangeIn` (same anchor/effect/returnOf logic as the branch). Void works on car moves as on any move. Client: a "Car load / return" form (car picker of the branch's cars, kind, lines for each cylinder item full/empty) and an "On the cars" card listing each tracked car's full and empty on board, red when below zero, "not tracked yet" for the rest; the live card shows a line per car under the branch figures. Strings ar/en/ur.
- [ ] **Step 4: Run** — pass. **Step 5: Commit** "LPG: stock on each car, loaded and returned".

### Task 5: Counts with variance, and values at the cost of their day

**Files:**
- Modify: `Inventory.gs` (`actionCountInventory_`; kinds `count_gain`, `count_loss`; row costs from dated history)
- Modify: `Costing.gs` (`emptyCostOn_`; `noteProductCost_` also for `emptyCost`; `costOfProduct_` uses it)
- Modify: `Admin.gs` (`saveEntity_` calls the empty-cost note)
- Modify: `Code.gs` (route `countInventory`)
- Modify: `index.html` (count form; strings)
- Test: `tests/run.js` section `--- LPG: a count books the difference; values keep their day's cost ---`

**Interfaces:**
- Produces: action `countInventory {locationId, date, reason, lines:[{productId, state, counted}]}` → `{ok, moves, lines:[{productId, state, book, counted, diff}]}`; writes one `count_gain` or `count_loss` move per line with a difference, carrying `book` and `counted`. Row fields `countGain` (add), `countLoss` (deduct). `emptyCostOn_(p, date, hist)` → number. Row `unitCost` is the cost on `dateTo`.
- Errors: `no_opening` (item or date before the opening count), `reason_required` (any difference without a reason), `invalid_qty` (counted negative).

- [ ] **Step 1: Failing tests**

```js
console.log('--- LPG: a count books the difference; values keep their day\'s cost ---');
var bookNow = scRow(scRep('2026-09-01', '2026-09-21'), lxFiber.id, 'full').ending;
var cnt = call({ action: 'countInventory', token: adminTok, locationId: scLoc.id, date: '2026-09-21', reason: 'monthly count', lines: [{ productId: lxFiber.id, state: 'full', counted: bookNow - 2 }] });
check(cnt.ok && cnt.lines[0].diff === -2 && cnt.moves[0].kind === 'count_loss', 'two fewer on the shelf than the book: a loss of 2 (' + (cnt.error || '') + ')');
check(scRow(scRep('2026-09-01', '2026-09-21'), lxFiber.id, 'full').ending === bookNow - 2, 'the book now matches the count');
check(call({ action: 'countInventory', token: adminTok, locationId: scLoc.id, date: '2026-09-21', lines: [{ productId: lxFiber.id, state: 'full', counted: bookNow + 5 }] }).error === 'reason_required', 'a difference needs a reason');
check(call({ action: 'countInventory', token: adminTok, locationId: scLoc.id, date: '2026-08-01', reason: 'x', lines: [{ productId: lxFiber.id, state: 'full', counted: 1 }] }).error === 'no_opening', 'nothing is counted before the opening count');
var same = call({ action: 'countInventory', token: adminTok, locationId: scLoc.id, date: '2026-09-21', lines: [{ productId: lxFiber.id, state: 'full', counted: bookNow - 2 }] });
check(same.ok && same.moves.length === 0, 'a count that agrees writes nothing');
// dated values: a cost raised today leaves an earlier period's value as it was
var vBefore = scRow(scRep('2026-09-01', '2026-09-21'), lxFiber.id, 'empty').unitCost;
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', id: lxFiber.id, data: { emptyCost: 999 } }).ok, 'the fiber cylinder cost changes today');
check(scRow(scRep('2026-09-01', '2026-09-21'), lxFiber.id, 'empty').unitCost === vBefore, 'September is still valued at the old cost (got ' + scRow(scRep('2026-09-01', '2026-09-21'), lxFiber.id, 'empty').unitCost + ')');
```
(The tests run with a fake "today" — check `todayRiyadh_` in the harness; if today is in September 2026 in the stub, move the cost change date with `setProductCost` style `from` instead, and assert the same thing.)

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**
  - Costing.gs: `noteProductCost_` gains a sibling `noteEmptyCost_(saved, before, userId)` writing `product_costs` rows with `productId: id + '#empty'` through `productCostFrom_`; `emptyCostOn_(p, date, hist)` reads `hist[p.id + '#empty']` like `costOfProduct_` reads `hist[p.id]`, falling back to `p.emptyCost`. `costOfProduct_` uses `emptyCostOn_` wherever it read `emptyCost`. `saveEntity_` (Admin.gs) calls `noteEmptyCost_` next to `noteProductCost_`, and `rateChanges_` already covers the field only if listed: add `emptyCost` to the product entry of `RATE_FIELDS_`.
  - Inventory.gs report: build `hist = costHistory_()` once; row `unitCost` = empty: `emptyCostOn_(p, to)`; full: `costOfProduct_(p, to) + emptyCostOn_(p, to)`; units: `costOfProduct_(p, to)`.
  - `actionCountInventory_`: `invLocFor_`; date checks; 1..100 lines; book per line from `actionInventoryReport_({dateFrom: date, dateTo: date, locationId}, user)` row's `ending` (row with `noOpening` or `openingDate > date` → `no_opening`); diff = counted − book (3 decimals); any diff ≠ 0 needs `reason`; write `count_gain`/`count_loss` with `qty = |diff|`, `book`, `counted`, note = reason, all under one lock (recompute the book inside the lock). Kinds join `INV_KINDS_` only on the server's accepted list for this action (not typed in the add form). `IN_` gains `countGain`; ending deducts `countLoss`.
  - Client: a "Count (جرد)" form: date, one row per stock line of the chosen branch with the book figure shown and a counted box; the result lists the differences. Strings ar/en/ur.
- [ ] **Step 4: Run** — pass. **Step 5: Commit** "LPG: counts book their difference; stock valued at its day's cost".

### Task 6: Alerts, the cylinder pool, and the branch sheet that differs

**Files:**
- Modify: `Inventory.gs` (`checkInventoryShort_` digest)
- Modify: `Collection.gs` (`checkStaleHandoffs_` calls it and returns `inventoryAlerts`)
- Modify: `index.html` (pool card; inventory nav badge from the live data; branch-sheet panel save not blocked by a mismatch; strings)
- Test: `tests/run.js` section `--- LPG: below zero alerts once a day; the pool adds up ---`

**Interfaces:**
- Produces: `checkInventoryShort_()` → number of branches alerted; emails each short branch's manager and its area manager once per branch per Riyadh day (script property `INV_ALERT_<locationId>` = date). Client `invPool_(rows, holdings)` → `[{productId, full, empty, withCustomers, total, newCylinders, bodySales, fullSold, buyBack, damaged}]` (one per cylinder item), pure, tested with `clientFn_`.

- [ ] **Step 1: Failing tests**

```js
console.log('--- LPG: below zero alerts once a day; the pool adds up ---');
var mailsBefore = ctx._debug.mails.length;
call({ action: 'importDailyEntries', token: adminTok, rows: [scLine({ sub: 'short-1', date: todayStr, productId: scReg.id, qty: 500, unitPrice: 45, cashSales: 22500 })] });
var n1 = ctx.checkInventoryShort_();
check(n1 >= 1 && ctx._debug.mails.length > mailsBefore, 'a branch below zero is mailed');
var mailsAfter = ctx._debug.mails.length;
check(ctx.checkInventoryShort_() === 0 && ctx._debug.mails.length === mailsAfter, 'once a day, not every run');
var invPool_ = clientFn_('invPool_');
var pool = invPool_([{ productId: 'p', state: 'full', cylinder: true, ending: 10, newCylinders: 3, damaged: 1 }, { productId: 'p', state: 'empty', cylinder: true, ending: 4, sales: 2, buyBack: 1 }], [{ productId: 'p', held: 5 }]);
check(pool[0].total === 19 && pool[0].withCustomers === 5, 'full 10 + empty 4 + 5 with customers = 19 cylinders');
```
(Find the harness's mail log name with `grep -n "mails\|sentMail" tests/stub-harness.js`, and the "today" helper used by other tests, and use those exact names.)

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — `checkInventoryShort_`: an admin-scope live report (`actionInventoryLive_` with a system user object `{role:'admin', id:'system'}`), group short rows by branch, skip a branch already alerted today, `sendMail_` to the branch store's manager and the area manager (`clusterManagerUserId`), body listing item, full/empty and how many short (Arabic + English, plain text); set the property. Call it at the end of `checkStaleHandoffs_` and return the count as `inventoryAlerts`. Client: `invPool_` (pure) and a "Cylinder pool" card on the inventory screen (per type: full, empty, with customers, total; and what changed it in the period); the nav item for المخزون shows a red dot when the live data has a short row (reuse the live card's last answer, no extra request). Branch sheet panel (around index.html:11434): a line that doesn't match no longer disables the save; the button text becomes "Save (system figures kept)" with a confirm listing the differing lines; only `needSetup` for unlinked cylinders still blocks. Strings ar/en/ur.
- [ ] **Step 4: Run** — pass. **Step 5: Commit** "LPG: below-zero alerts, cylinder pool, branch sheet saves despite a difference".

### Task 7: Browser check, guide, notes, deploy

**Files:**
- Modify: `tests/mock-backend-server.js` (seed: iron/fiber/wazfa/5 kg cylinder items with exchange and body-sale products, a cross-type product, a buy-back expense item, a deposit customer — made-up names)
- Modify: `tests/make-inventory-guide.js` (new chapters: cross-type exchange, boxes, new cylinders, deposits, buy-back, cars, transfers, counts, pool, alerts; the reviewer's four corrections; «فرع الملز»; example where the refill follows the exchanges)
- Modify: `CLAUDE.md` (section "LPG cylinder ledger (2026-10-05)")
- Output: `C:\Claude\bestgas-cash-collection\user-guide\inventory\دليل-المخزون.pdf` (never in the repo)

- [ ] **Release test (user, 2026-10-05: "once live, test everything, especially the inventory cycle and its integrations with sales and every other function") — run for EVERY release, not only the last.**
  - *Before deploy, on the mock server with the exact build to ship*, seeded with the live product names (PR-0001…PR-0014) and the الشفاء openings (2051 on the exchange item, 666 on the body-sale item), drive the client as admin, finance, area manager, branch manager, driver and deputy:
    - **Setup and sales:** run the setup proposal and apply. Then enter days by product line: cash, card, credit customer inside the lines (and credit over the lines refused), Souq Gas part, amount-only (flagged, not deducted), a cancelled day (units back).
    - **Area manager:** the area Excel through the deputy (approve; reject → correct → resend), and the branch daily sheet with its stock block saved despite a difference.
    - **Cylinder moves:** exchange, body sale, cross-type, Gasko refill in boxes, new cylinders, buy-back (cash and empty from one line), deposit out/back, linked transfer (and voiding one side voids both), car load → car sales → evening return (the driver owes the gap), and a count with a difference.
    - **Alerts:** a sale beyond stock flagged in the form, on save, on the day card and in the digest.
    - **Money:** handover amounts and `netCashOwed` identical before and after any stock move; the profit report's cost of goods dated (a cost change today leaves last month as it was).
    - **Screens:** Excel and PDF exports of the stock screen; every screen at 390px and desktop with no console error.
  - *After deploy, on live, read-only only* (never post test sales or moves on live; the system cannot delete them):
    - GET ping, an unauthenticated POST (`auth_required`), and `version.json` showing the new build.
    - Signed in as the user: the setup proposal matches the live counts. After the user confirms the setup, the الشفاء figures equal the predicted ones (iron full 598; iron empty 666 − 4 + exchanges since the count).
    - Every screen opens with no console error.
    - The dashboard's cash and handover totals equal the figures noted just before the deploy.
- [ ] **Step 1:** Restart the mock server (`node tests/mock-backend-server.js 8905`), sign in as admin, finance, area manager and branch manager, and exercise every new form; read the console for errors; screenshot each card at 390px and desktop.
- [ ] **Step 2:** `node tools/obfuscate.js` and `node tools/stamp-build.js`; full `node tests/run.js` green.
- [ ] **Step 3:** Final whole-branch review (superpowers:requesting-code-review), fix what it finds, re-run.
- [ ] **Step 4:** Commit; push to `origin main`; copy the .gs files into `..\apps-script` (`Code.gs → الرمز.js` etc.), `clasp push -f`, `clasp deploy -i AKfycbxgS7bhn4Nn0szYnKVRb6rjGEKumqCJkQ8jY2uNjDrf2wP2YQYgTvltLrwsbKviD7I -d "LPG cylinder ledger"`; GET ping and an unauthenticated POST (expects `auth_required`); confirm `version.json` live.
- [ ] **Step 5:** Regenerate the guide against the mock, render it, check every page.
