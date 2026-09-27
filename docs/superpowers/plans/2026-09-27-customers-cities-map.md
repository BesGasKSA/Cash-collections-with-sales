# Credit Customers, City Lists, Deputy Emphasis and Branch Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Credit sales pick a registered customer (auto-numbered, duplicate-proof, seeded from the user's list) and can be recorded per product; cities are picked from a list; the deputy sees branch/area/collector in bold; a branch profile has a map pin that suggests its zone — all mobile-first.

**Architecture:** Two new master-data kinds, `customer` and `city`, on the existing `validateEntity_` / `adminSaveEntity` / `renderAdminEntity` rails. A credit line keeps writing `creditSales` + `creditCustomer` (name snapshot) and gains `creditCustomerId` and optional `creditItems`; `computeNet_` is untouched. The map is Leaflet 1.9.4 from cdnjs, lazy-loaded only on a branch profile, tiles from OpenStreetMap.

**Tech Stack:** Apps Script (Code.gs, Admin.gs, Collection.gs), single-file `index.html`, Node test harness `tests/run.js`.

**Spec:** the user's message of 2026-09-27 (customer list `ورقة عمل Microsoft Excel جديد (12).xlsx`, 63 rows, 62 unique names in column C).

## Global Constraints

- The GitHub repo is public: customer names never go into the repo. They ship in `CustomerSeed.js`, which exists only in the Apps Script project (clasp folder), plus a local CSV in `Downloads/BestGas-Customers/`.
- Customer code format `CUS-0001`, assigned by the server, never editable, never reused.
- Duplicate test uses a normalised name: trim, collapse spaces, drop tatweel and diacritics, أ/إ/آ→ا, ى→ي, ة→ه, spaces around `-` removed, Latin lower-cased.
- `computeNet_` and the credit-deduction rule stay exactly as they are (the sales figure includes credit sales; the credit section deducts them).
- Arabic-first; every string in ar / en / ur. Mobile (375px) is the primary layout: no horizontal scroll, 44px tap targets.
- One-time seeds (customers, cities) run from `route_` behind script-property flags, like `migrateBranchCollectorsOnce_`.

## Review Focus

- The same customer typed with different spacing or alef/ya/ta-marbuta forms must be refused as a duplicate, naming the existing code.
- A credit line whose items don't add up to the amount sent: the server derives `creditSales` from the items and refuses a mismatch (`credit_items_mismatch`).
- A deactivated customer chosen from a stale screen → `invalid_customer`; an unknown CSV customer → the row is refused (area batch: whole batch refused).
- Deleting a customer that has credit history → refused (`in_use`); deactivating works.
- Pasted locations: `…/@24.7136,46.6753,15z`, `…?q=24.7136,46.6753`, `24.7136, 46.6753` parse; text without coordinates says so; coordinates outside ±90/±180 are refused by the server (`invalid_coordinates`).

---

### Task 1: Customers and cities on the server

**Files:** Modify `Code.gs` (SHEETS, `route_` hook), `Admin.gs` (`ENTITY_SHEET`, `validateEntity_`, save action numbering, delete guard, `actionMeta_`, import action, seeds), Test `tests/run.js`.

**Interfaces — produces:**
- `normalizeName_(s) -> string`
- `nextCustomerCode_() -> 'CUS-0001'…` (call inside the script lock)
- `findCustomer_(text) -> customer|null` — by code (case-insensitive) or normalised name
- `adminImportCustomers({rows:[{name, city?, phone?}]}) -> {ok, created:[customer], skipped:[{row, name, code, reason:'duplicate'|'invalid_input'}]}`
- `seedCustomersOnce_()` (uses a global `CUSTOMER_SEED_` array only if defined), `seedCitiesOnce_()`
- `meta.customers`, `meta.cities`

- [ ] Failing tests: saving `{kind:'customer', data:{name:'Al-Rashid Trading'}}` returns `entity.code === 'CUS-0001'`; the next is `CUS-0002`; an edit that sends `code:'X'` keeps the code; `'  al-rashid   trading '` → `duplicate_customer` with `code`; an Arabic pair `مؤسسة واحة الملامة` / `موسسة  واحه الملامه` → duplicate; import of 3 rows where one repeats → 2 created, 1 skipped with the existing code; a customer used on an entry can't be deleted (`in_use`); `city` saves, a second `الرياض` → `duplicate_city`; `seedCitiesOnce_` adds the default list plus existing location cities once; `CUSTOMER_SEED_` defined in the test context → `seedCustomersOnce_` imports it once, a second call adds nothing; `listMeta` carries both lists; location `lat: 95` → `invalid_coordinates`.
- [ ] Run — FAIL. Implement. Run — PASS. Commit.

### Task 2: Credit lines name a registered customer, and may list products

**Files:** Modify `Collection.gs` (`checkNonSalesFields_`, `nonSalesFields_`, `getSalesReport` customer filter), Test `tests/run.js` (existing free-text fixtures become registered customers).

**Interfaces — produces:** entry fields `creditCustomerId`, `creditCustomer` (name snapshot), `creditItems: [{productId, qty, unitPrice, amount}]`; `getSalesReport({customerId})`.

- [ ] Failing tests: credit with `creditCustomerId` saves and snapshots the name; with the code `CUS-0001` or the exact name in `creditCustomer` it resolves (CSV path); an unknown name → `unknown_customer`; an inactive customer → `invalid_customer`; `creditItems` [{cylinder, qty 3, unitPrice 20}] with `creditSales: 60` saves and derives 60; sent with `creditSales: 70` → `credit_items_mismatch`; a price-locked product at another price → `price_locked`; an unknown product → `invalid_product`; `computeNet_` of that entry is unchanged vs amount-only; `getSalesReport({customerId})` returns only that customer's rows.
- [ ] Run — FAIL. Implement. Run — PASS. Commit.

### Task 3: Client — searchable picker, customers and cities screens, city dropdowns

**Files:** Modify `index.html` (`ddOpen_` search, `ENTITY_FIELDS.customer/city`, `KIND_TAB_`, `entityFieldInput_` city picker, customers import card, profile relations/activity, i18n).

- [ ] Picker gets a search box when it holds more than 8 options (filters as you type, normalised like the server).
- [ ] Customers screen: code shown read-only, list columns code/name/city/phone/active; import card (paste a list or choose a CSV) with a preview that flags duplicates before sending.
- [ ] Cities screen; every `city` field (branch, zone, customer) is a picker of city names that keeps a legacy value.
- [ ] Verify every admin tab in the browser (CLAUDE.md trap: syntax checks can't see a missing function).

### Task 4: Client — credit lines with customer picker and item-wise option

**Files:** Modify `index.html` (credit block in `renderEntries`, `extraMoneyRows_`, `firstMoneyFields_`, section confirm, entry cards, area CSV preview/template text).

- [ ] Each credit line: customer picker (active customers, searchable), a two-way switch مبلغ / أصناف; items mode shows product lines (product, qty, unit price; locked prices read-only) and totals them into the line amount.
- [ ] Rows carry `creditCustomerId` + `creditItems`; entry cards show `CUS-0007 · name` and the items.
- [ ] Verify at 375px in the browser: add two credit lines, one per mode, save, read back.

### Task 5: Deputy card emphasis

**Files:** Modify `index.html` (`handoffItem`, deputy batch rows, CSS).

- [ ] A `cluster_to_collector` card shows a route strip: **branch** · **area** → **collector**, bold, tinted; batch rows show **branch** → **collector** bold.

### Task 6: Branch map on the profile

**Files:** Modify `Admin.gs` (location `lat`/`lng` validation — done in Task 1), `index.html` (map card on the location profile, `parseLatLng_`, `nearestZone_`, lazy Leaflet loader).

**Interfaces — produces:** `parseLatLng_(text) -> {lat, lng}|null`; `nearestZone_(lat, lng, locations, selfId) -> {zoneId, locationId, km}|null`.

- [ ] Map card: pin (tap or drag), "موقعي الحالي", paste link/coordinates, other branches as dots (same zone highlighted), suggested zone from the nearest located branch with one-tap apply, open in Google Maps, save.
- [ ] Verify in the browser at 375px; tiles load; save round-trips.

### Task 7: Docs, seeds, suite, publish

- [ ] CLAUDE.md sections; mock server seeds customers, cities and coordinates; full suite; stamp, obfuscate, push; create `CustomerSeed.js` in the clasp folder only (62 names), clasp push + deploy; live ping; local CSV copy for the user.

### Task 8: Sorting everywhere, area manager on branches, counts that follow filters (added 2026-09-28)

**Spec:** the user's follow-up of 2026-09-28: "sorting function in all reports and screens", "for branches screen i need to see the area manager name", "the filters and numbers of results reflect with the filter".

- [ ] One shared sorter for every table the app draws (tap a header: ascending, again: descending; numbers, dates and Arabic text each compare correctly; the arrow shows the direction). Card lists get a sort picker.
- [ ] Branches list: an area-manager column (from the branch's area).
- [ ] Every list with a search or filter shows "N of M" that updates as the filter changes; report tables show their row count for the current filters.
- [ ] Verify in the browser: every admin tab, the report screen, the entries list, at 375px.

### Task 1b: A system number with a prefix on every record (added 2026-09-28)

BR branch, AR area, CT city, ZN zone, ST store, CR car, POS machine, PR product, INC collection item, EXP expense item, CUS customer, EMP user. Assigned on save, never editable, never reused (SEQ_<kind> counters); records saved before numbering are numbered once (`backfillCodesOnce_`). The one-time data jobs also run on the unauthenticated GET ping, so the deploy's own check finishes them.

### Task 9: Invitation redesign, mobile first (added 2026-09-28)

The invitation email and the page it opens (set your password) redesigned for a phone, using the design skills.
