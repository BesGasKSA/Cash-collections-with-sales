# Best Gas Cash Collection & Approval System — working notes

Cash-reconciliation and handoff-approval system for Best Gas Carrier Co.,
built from `555.xlsx` (the "Architect"/"Example"/"Cycle" sheets describing
the driver/car → store-manager → cluster-manager → collector → bank chain).
Same architecture
as the standalone rental system in `Downloads/7777/` — a single `index.html`
client talking to a Google Apps Script backend, a Google Sheet as the
database — but a **separate, independent deployment**: its own Sheet, its
own Apps Script project, unrelated to rentals. Live since 2026-09-10; see
"Deploying" below for the script/deployment ids and the (much more
reliable) `clasp`-based redeploy procedure.

## Layout

```
BestGas-Cash-Collection/
├── index.html      the whole client — plain JS, ar/en/ur, RTL/LTR by language
├── Code.gs          sheet-as-db helpers, auth, doGet/doPost/route_
├── Collection.gs     entries, the handoff/confirm/dispute/deposit chain, reports,
│                      SLA stale-handoff escalation, large-amount second approval
├── Admin.gs          user management + full CRUD over the entity hierarchy
├── Reconciliation.gs bank statement import + auto/manual matching
├── Risk.gs            operational risk / complaint register
├── tests/
│   ├── stub-harness.js   rebuilds SpreadsheetApp/PropertiesService/etc. under
│   │                      Node's vm module so the real .gs files run unmodified
│   └── run.js             end-to-end trial run — node tests/run.js
└── CLAUDE.md         this file
```

## Entity hierarchy

**Naming note (2026-09-23):** the company's own hierarchy is
**KSA → City → Area → Branch → (the branch's Store **and** its Cars) →
Drivers**, and the branch manager is one person responsible for both the
store and the cars. Mapped onto this data model: a **branch is a `location`
row**, an **area is a `cluster` row**, and the branch manager is still
`store_manager` internally. The Arabic labels follow the company: فرع /
منطقة / مدير فرع / مدير منطقة, and the company reads الناقل الأفضل للغاز.
Zones are now labelled نطاق (optional grouping) so they stop colliding with
"area".

**Naming note (2026-09-13):** the UI now labels this "Area"/"Area Manager"
in all three languages (`role_cluster_manager`, `admin_clusters`,
`admin_clusterManager`, `handoff_perCluster`, etc. — every *translated
string value*), per the user's own job-title terminology. The underlying
data model, sheet name, and every internal identifier are still literally
`cluster`/`Cluster`/`clusterId`/`SHEETS.CLUSTERS` — only display text
changed, nothing structural. Don't be thrown by the mismatch when reading
code next to a screenshot.

```
Cluster ── clusterManagerUserId
  └── Location (city + name) ── collectorUserId, optional zoneId
        ├── Store  (one per location) ── storeManagerUserId
        │     └── POS machine(s) ── assignedUserId (an employee/driver)
        └── Car(s) ── driverUserId
              └── POS machine(s) ── assignedUserId

Zone (city + name) — pure geography, unrelated to the tree above
```

**Every link must name its person (2026-09-24).** `validateEntity_` refuses
to save an area without its `clusterManagerUserId` (`manager_required`), a
branch without the collector its cash goes to (`collector_required` — since
2026-09-27 collectors belong to branches, see below), a branch store without
`storeManagerUserId` (`manager_required`), a car without `driverUserId`
(`driver_required`), or a POS machine without `assignedUserId`
(`holder_required`). The person must also hold the matching role
(`wrong_role`), except that an **admin may stand in** on any link while the
real person is being hired (`userHasRole_`). `conflict_of_interest` is
checked before `wrong_role`, so the same person as manager and collector
still reports the conflict. Rows saved before this rule can still be
missing people. The home screen's **منطقتي / فرعي** panel
(`myOrgPanel_`) shows the area manager their area, its collectors, branches, and
each branch's manager, collector, cars/drivers and POS/holders. A branch manager sees
the same panel for their own branch, with the area manager above it. Any
missing link shows in red. Admin → Master data → **سلامة الربط** (`chainGaps_` / `renderAdminChain`) lists every gap company-wide: missing people, branches with no area or store, disabled users still assigned, and people in a chain role placed nowhere. Each gap has a button to the tab that fixes it, and the tab shows the gap count as a badge. **One area per area manager; collectors may serve many (changed 2026-09-29).** An area
manager runs one area and is never a branch collector (`user_in_other_area`, in
`validateEntity_`). A collector may serve branches in any number of areas, even all of
them: the user asked for it on 2026-09-29, replacing the 2026-09-24 one-area rule for
collectors. Handoffs already go branch by branch, so nothing downstream assumes one area.
Chain health (`gap_multiArea`) now flags only an area manager on two areas.

**Collectors belong to branches, not areas (2026-09-27).** The user asked
for one area to be served by two or more collectors, each area-manager
request going to the collector of the branch it came from.
`location.collectorUserId` is the link; `branchCollector_(locationId)`
(Collection.gs) resolves it, falling back to the area's legacy
`cluster.collectorUserId` for a row saved before the change. The client
mirrors it as `branchCollectorOf_`; `areaCollectors_` lists an area's
collectors.

- **Validation.** A branch needs an effective collector (`collector_required`)
  who holds the collector role (`wrong_role`), is not the area's manager
  (`conflict_of_interest`), and whose other branches all sit in this area —
  nor manages or legacy-collects another area (`user_in_other_area`). An area
  needs only its manager; a legacy collector on it stays optional. A store's
  manager can't be the branch's collector (`branchCollector_`).
- **Per-branch requests.** `createClusterHandoff_` writes one `pending_deputy`
  handoff per branch with ready cash (its confirmed `location_to_cluster`
  handoffs plus the area manager's own open entries there), each carrying
  `locationId` and `toUserId = branchCollector_`. Optional `req.locationId`
  sends one branch. Every branch is settled before anything is written, so a
  branch without a collector stops the whole request (`no_collector` with
  `locationId`); a branch whose ready cash nets to ≤ 0 is skipped and stays
  ready. Returns `{ok, handoff, handoffs}`.
- **CSV batches split the same way.** `actionDeputyApproveBatch_` writes one
  `pending` handoff per `perLocation` row to that branch's collector
  (`batch.resultHandoffIds`; `resultHandoffId` stays as the first). A branch
  whose day nets to nothing (banked directly) gets none: its entries stay
  consumed by the batch, and `listEntries` reads `deputy_approved` as
  `approved`, so they don't look stuck waiting.
- **In flight.** A branch's collector can't be replaced while its cash is on
  the way to them (`branchCollectorBusy_` → `person_holds_cash`). Handoffs
  made before the change have no `locationId`, so this guard can't see them;
  their `toUserId` is fixed and still receives them.
- **Alerts.** The four `escalate*_` functions add `collectorForHandoff_(h)`
  (the addressee of a `cluster_to_collector`, else the branch's collector)
  instead of the area's collector.
- **One-time migration.** `migrateBranchCollectors_` (Admin.gs) writes each
  area's collector onto its branches that have none, then clears it from the
  area — every branch keeps exactly the collector it had. `route_` runs it via
  `migrateBranchCollectorsOnce_` on the first authenticated request after the
  deploy (script property `MIGRATED_BRANCH_COLLECTORS`); audited as
  `migrate_branch_collector` / `migrate_area_collector_cleared`. Why clear the
  area: the area form has no collector field any more, so a leftover value
  would be invisible and uneditable, yet still block that collector from a
  branch in another area under the one-area rule.
- **UI.** The branch form has the collector field (required; `wireBranchCollector_`
  offers the chosen area's collectors plus unassigned ones). The area form has
  none; its list shows a virtual `collectors` column. The area card (`ac-card`)
  lists one row per branch — collector, ready amount, its own send button,
  waiting/returned state — plus "send every ready branch". The org panel, chain
  health (`gap_branchCollector`), profiles (`pf_collectors`,
  `pf_collectsBranches`), handoff cards (`ho-place`) and the deputy's batch rows
  all name the branch and its collector.

**System numbers, customers, cities, branch map (2026-09-28).**

- **Every record has a number** with its own prefix, assigned by the server on save and never
  editable or reused: BR branch, AR area, CT city, ZN zone, ST store, CR car, POS machine,
  PR product, INC/EXP items, CUS customer, EMP user (`CODE_PREFIX_`, `nextCode_(kind)`, a
  counter per kind in script property `SEQ_<kind>`). Records saved before this are numbered
  once (`backfillCodesOnce_`). `actionAdminSaveEntity_` holds the script lock for the whole
  save so the duplicate check and the new number see the same file (`writeRow` releases it).
- **Customers** (`customer`, sheet `customers`): name duplicates are caught on
  `normalizeName_` (alef/ya/ta marbuta/hamza seats, diacritics, tatweel, spacing, case —
  mirrored client-side as `normName_`). `adminImportCustomers` adds new names and reports
  skips; the Customers screen imports a pasted list or an Excel/CSV file (SheetJS from
  cdnjs, loaded on demand). A used customer cannot be deleted (`has_children`).
  **The company's customer list is not in this repo** (it is public): it ships as
  `CustomerSeed.js` (`var CUSTOMER_SEED_ = [...]`), created only in the Apps Script clasp
  folder, imported once by `seedCustomersOnce_` (flag `SEEDED_CUSTOMERS`).
- **Credit lines** name a registered customer: `settleCredit_` (run by `checkNonSalesFields_`
  for the form, the file import and the area batch) resolves `creditCustomerId`, or a
  number/name in `creditCustomer` from a file (`unknown_customer`, `invalid_customer` for a
  deactivated one), and checks optional `creditItems` [{productId, qty, unitPrice}] whose
  total becomes `creditSales` (a different amount → `credit_items_mismatch`; fixed prices
  → `price_locked`). `computeNet_` is unchanged: items only say what the credit was.
  `getSalesReport({customerId})`, and `byCustomer` totals credit per customer.
- **Cities** (`city`, sheet `cities`): seeded once with Saudi cities plus every city a
  branch or zone already names (`seedCitiesOnce_`); every city field is a picker
  (`cityPick` in `ENTITY_FIELDS`), still stored as the name.
- **One-time data jobs** (`runOneTimeMigrations_`: branch collectors, cities, customers,
  numbers) run from `route_` and also from `doGet`, so the deploy's own GET ping finishes
  them. They take no request input and each keeps its own flag.
- **Branch map** (`branchMapCard_` on a location profile): Leaflet 1.9.4 from cdnjs and
  OpenStreetMap tiles, loaded only there. **Trap:** inside this app `L` is the translations
  dictionary (`var L` in the app closure), so Leaflet must be used as `window.L` — plain
  `L.map` threw and the map showed its load-failure message. `parseLatLng_` reads pasted
  Google Maps links (place pin `!3d..!4d` first, then `@lat,lng`, `?q=`) or plain
  coordinates (Arabic digits too); `nearestZone_` offers the zone of the nearest located
  branch. Locations validate `lat`/`lng` (`invalid_coordinates`).
- **Cash calculations** read collections → total collected → deductions → total
  deductions → net everywhere (`cashCalcRows_`, `breakdownGrid`), both subtotals
  highlighted. The deputy's cards open with a bold branch → area → collector strip
  (`handoffRoute_`).

**Finance runs every module; users are the admin's (2026-09-29).** `requireManager_` (admin or finance) guards master data, imports, settings, archive and the stale trigger; `requireAdmin_` still guards creating, changing, resetting and inviting users. The client splits the old admin screen: **الإدارة** (admin + finance: chain health, master data, settings, audit) and **المستخدمون والصلاحيات** (admin only: users, permission matrix). `openProfile_("user")` is a no-op for non-admins.

**Transfers, الموازنات per device, customer prices, security (2026-09-28, evening).**
- **Customer bank transfers** (`bankTransferAmount`, one entry row per transfer, the form's
  amount-only lines): inside the typed sales figure like credit, so `computeNet_` deducts
  them (`bankTransfers` in every breakdown) and the الموازنة cash check subtracts them.
- **A الموازنة is one line per POS device with a photo.** The photo goes up first
  (`uploadEntryPhoto` → `entry_photos` sheet, one use, only by its uploader); the entry
  carries `directDepositPosId`/`directDepositPhotoId`, and the direct-deposit handoff gets
  `attachmentId` + `posId`. `checkDepositSlip_` runs after the other checks (reference,
  cash) and needs the device only where the branch has one. An admin's file import may skip
  the photo. `siblingCash_` now nets the other rows' deductions and الموازنات, so two
  lines cannot bank the same cash. "الموازنات" is the company's own word: do not rename it.
- **Credit is items only** in the form; files and the area batch may still send an amount.
- **Customer prices**: `customer.prices {productId: price}` beats the product's price,
  fixed or not, in `settleCredit_` (`price_locked` if different). Sent in meta to all roles.
- **Total sales = typed sales + card sales.** Credit is already inside the typed figure;
  `entrySalesTotal_` and the client's `entryAmt_().gross` used to add it a second time.
- **Security:** `forgotPassword` ignores the caller's `appUrl` (an invitation link could be
  sent to another site and the account taken); `inviteAppUrl_` accepts only the live app or
  localhost. A reset keeps the old password working; the temporary one lasts an hour
  (`resetPass`/`resetSalt`/`resetExpires`), 40 reset emails an hour at most. Slip types
  are limited to photos and PDF (`slipMime_`).
- **Testing trap:** the mock server loads the .gs files when it starts. Restart it after a
  backend change, or new actions answer "unknown".

**Sorting, counts, invitation (2026-09-28).**

- **Every table sorts by its headers** (`tsEnhance_` / `tableSortBy_`, attached by a
  MutationObserver like the designed dropdown): numbers, dates, Arabic text with numeric
  runs, empties last; rows whose cell count differs from the header (colspan totals)
  stay at the end; a redrawn table keeps its sort (`TSORT_` keyed by its header text).
  Tables that sort themselves (`sortableTable`, `th[data-key]`) are skipped. Card lists
  sort through `listFilters_`'s picker (`.sort(list, norm)`, newest/oldest/highest/lowest)
  and show "N of M" (`.count`); master-data lists have a sort picker (the only sort a
  phone card list has) and a live count while searching. Branches list the area manager.
- **Invitation email** (`sendInvitation_`, `inviteEmailHtml_`, `INVITE_COPY_`): written
  in the invitee's own language (ar/en/ur; `ROLE_NAMES_` has a third, Urdu, name), one
  button, the three steps, fluid (100% up to 560px, a fixed table only inside an Outlook
  conditional), no letter-spacing on Arabic, no em dashes. `inviteInfo` also returns
  `inviterName`.
- **Invitation page** (`renderAcceptInvite`, classes `inv2-*`): phone = brand band + card
  with the button in the first screen; desktop (>= 900px) = split screen with three
  role-specific lines (`inv2_does_<role>`). Step rail, live password checks, drawn tick on
  success, skeleton while loading; all motion off under `prefers-reduced-motion`.
  **Testing trap:** after the mock server restarts, a browser tab may have lost
  `bgc_apiUrl`; the page then silently asks the *live* backend, which answers "invalid"
  for a mock invitation token. Set `localStorage.bgc_apiUrl` before judging the page.

**Every master-data type is a screen, and every record has a profile
(2026-09-24).** `renderAdminEntity` is a type screen: count, search, an add
form that stays shut until asked for, and columns that resolve ids to names
(`fieldDisplay_`). Clicking a row, or a user, opens `renderAdminProfile`
(`adminProfile = {kind,id}`, `openProfile_`). The profile shows the record's
details editable in place (`entityForm_`, built through `entityFieldInput_`),
then its links as chips that open their own profiles (`relationsOf_`), then
its activity from `getSalesReport` (`activityFilter_`), then its change
history from the audit trail (rows whose `detail` is the record's id).
Products and collection/expense items gained an `active` switch. An inactive
one drops out of the entry screen's lists. **Trap, hit once:**
`entityFieldInput_` was called by the old edit panel but never defined (the
patch that added it failed half-way and wrote nothing), so every
master-data tab threw on its first row. Syntax checks cannot catch a missing
function, and `tests/run.js` never renders the client. Open every admin tab
in the browser after touching this code.

A POS machine's `ownerType`/`ownerId` points at either a store or a car —
a single car can carry more than one POS terminal, and a branch usually
has several. `daily_entries.sourceType` is `store` / `car` / `pos`, each
row belonging to exactly one node in this tree via `sourceId`.

**Cluster and Zone are two independent things — don't merge them.**
Cluster is an *employee's management assignment*: a cluster manager owns a
set of locations for the money-handoff chain (each location names its own
collector since 2026-09-27), and that set
doesn't have to share any geography. Zone is *pure geography* (Country is
implicit — KSA only, not modeled as an entity — City, then Zone, e.g.
"Riyadh — East") used only for admin/report filtering, with no manager or
collector of its own. A `location` optionally carries both a `clusterId`
(who it hands cash to) and a `zoneId` (where it sits on the map) —
independently, and either can be blank. Confirmed with the user 2026-09-12
after an initial wrong assumption that Zone should just replace Cluster.

## The formula (from `555.xlsx`, verified by `tests/run.js` against the
Example sheet's own numbers)

```
vatOnDelivery = (Σ deliveryFeeBankAmount / (1 + vatRate)) * vatRate
netCashOwed   = storeCash + Σ carCash + Σ posCash
              + Σ otherCash                 (collected, not sold)
              - Σ deliveryFeeBankAmount + vatOnDelivery
              - Σ expenseAmount             (paid out of the takings)
              - Σ directDepositAmount       (already banked at the source)
              - Σ creditSales               (in the sales figure, but no cash came in)
```

**Delivery fees apply to every source type, a branch store included
(2026-09-23).** They used to be car/pos-only on the grounds that "a branch
has nothing to deliver", which is simply not how the branches operate: the
branch sells with delivery too, and that fee is paid to the bank, not held
as cash. While the restriction stood, a branch's delivery line — typed on
the Entries screen or uploaded by an area manager — was accepted, stored,
and then silently dropped by `computeNet_`, so the branch was asked to hand
over cash it never held. If you are tempted to re-scope a money field by
source type, make sure the entry form, the CSV templates/parsers, and
`computeNet_` all agree, or the formula quietly disagrees with the form.

### Credit sales and delivery fees are deductions, not payment methods (2026-09-24)

A product line is paid in **cash or POS only**. **POS (card) sales are switched off by default (2026-09-27, `posSalesEnabled` in Settings):** while off, product lines show no payment picker (every line is cash), direct entry hides the POS box, and an area CSV row with `paymentMethod: pos` is refused. The server still accepts `posSales` for history and imports. POS *machines as a source* are a separate thing and are unaffected. Credit sales and delivery
fees each have their own lines section on the entry screen, as expenses do.
A delivery line carries `deliveryNote`. A credit line carries
`creditCustomer`, which the server requires (`customer_required`). The first
line of each section goes on the entry row, and every further line becomes a
sibling row (`extraMoneyRows_`). **Why:** a line tagged "credit"/"delivery"
used to put its amount into `creditSales`/`deliveryFeeBankAmount` *instead
of* `cashSales`, while `computeNet_` deducts both from a cash figure that is
meant to include them. The amount was taken off twice. The area-bulk CSV
follows the same rule: `paymentMethod` is `cash|pos`, plus
`deliveryFee,deliveryNote,creditSales,creditCustomer` columns. Filters split
the same way: **payment method** (`cash`/`pos`) and **movement type**
(`credit`/`delivery`/`other`/`expense`/`deposit`, `movementType` on
`getSalesReport`). The report still accepts the old combined values on
`paymentMethod` for a cached client.

### Money that moves at the source without being a sale (2026-09-23)

Three fields, all on `daily_entries`, all validated by one shared
`checkNonSalesFields_` (Collection.gs) used by the single-entry, CSV-import
and area-bulk paths alike:

| Field | Effect | Rules |
|---|---|---|
| `otherCash` + `otherCashItemId` + `otherCashReason` | **added** to `netCashOwed` | item must be an active row in `income_items`; the reason is mandatory |
| `expenseAmount` + `expenseItemId` + `expenseReason` | **deducted** | item must be an active row in `expense_items`; the reason is mandatory |
| `directDepositAmount` + `directDepositRef` | **deducted** | needs a bank reference, and can never exceed the cash that entry itself produced |

The items come from admin-kept master data (`SHEETS.INCOME_ITEMS` /
`SHEETS.EXPENSE_ITEMS`, the `income_item`/`expense_item` entity kinds) rather
than free text, so the report can group them; the *reason* is the free-text
part, and it is required because an unexplained amount on either side is
exactly what the approval chain exists to catch.

**A direct deposit is written as an ordinary `kind:'deposit'` handoff row**
(`recordDirectDeposit_`), marked `direct:true` with `sourceEntryIds` instead
of `sourceHandoffIds`. That was deliberate: bank reconciliation, the
"deposited" dashboard totals and the deposit document all already filter on
`kind === 'deposit'` in a dozen places, and inventing a `kind:'direct_deposit'`
would have meant finding and widening every one of them. The cash never
enters the handoff chain at all — `computeNet_` has already deducted it, so
only the remainder travels up. For an **area-manager bulk upload the deposit
row is created at Deputy approval, not at upload**, so a rejected batch
leaves no deposit behind.

**Products carry a price, optionally fixed** (`unitPrice`, `priceLocked`):
the entry form fills the line price from the product and makes it read-only
when locked, so a branch cannot sell at its own price. `priceLocked` without
a `unitPrice` is rejected — it would leave a read-only empty box nobody can
fill.

POS sales never enter this formula — card/bank payments carry no cash risk;
they're tracked (per machine, or per store/car if either carries its own
mounted terminal — a `store`/`car` entry's `posSales` field counts toward
`totals.posSales` and the per-product POS breakdown exactly like a dedicated
`pos` entry does, just without a separate pos_machines row; a store still
never has a delivery fee, that stays car/pos-only) for reconciliation and reporting
only. The entry form (`index.html`) also shows a read-only Location field
that auto-resolves from whichever store/car/pos is picked (`resolveLocationIdForSource_`)
so the person entering data can confirm where it will actually count.

**Credit sales are DEDUCTED from the cash owed (changed 2026-09-23).** The
branch enters the day's takings as one sales figure that *includes* what was
sold on credit, so the credit part has to come back out before anyone is
asked to hand cash over — the same treatment as an expense or a موازنة. It
was originally merely *excluded* from the formula, which is only correct if
the cash figure was typed net of credit, and that is not how the branches
report. `posSales` still behaves the old way: a card payment settles to the
bank on its own and was never part of the cash figure.

Historical note on the original design:

~~**Credit sales (added 2026-09-14) follow the exact same no-cash-risk pattern
as `posSales`**~~ — a fourth payment method (`creditSales`, alongside cash/POS/
delivery) available on every source type and in the product-level entry
mode's payment-method picker. `computeNet_`/`sumBreakdowns_` tally it in the
returned breakdown for visibility, but it never enters `netCashOwed`: no
money has actually moved for a sale on credit, so there is nothing yet to
hand up the collection chain. It *does* count toward every "gross sales"
number that isn't specifically the cash-owed figure — `entrySalesTotal_()`
(Collection.gs) is the one place that sums cash+POS+credit together, used by
the report's amountMin/Max filter and the daily trend; grep for it before
adding another gross-sales aggregation rather than re-deriving the same sum
inline. A credit sale also counts as "a sale" for `deliveryNeedsSale_` (see
below) — a delivery fee with a same-day credit sale and nothing else is
accepted, same as it would be with cash or POS.

## Who may enter, and who may report (changed 2026-09-23)

`checkEntryScope_` now has a `cluster_manager` branch: **an area manager
enters data for every branch in their own area** — its store, its cars and
its POS machines — because branches that cannot use the app themselves
report their day to them. This is a deliberate widening of what used to be
bulk-upload-only (behind the `areaManagerBulkUploadEnabled` toggle); the
bulk path and its Deputy approval still exist unchanged for uploading a
whole area at once. The client mirrors the same boundary in
`branchIdsForEntry_()` — if you change one, change both, or the pickers
offer sources the server then refuses.

`actionSalesReport_` also accepts `store_manager` now, scoped to their own
branch, and gained `clusterId`, `paymentMethod` and `driverUserId` filters.
Every filter narrows an already-scoped set, so a client that sends someone
else's branch id still gets only its own rows back. Note the knock-on:
`getDashboardAll` bundles the report, so a branch manager's bundle now
succeeds where it used to return `forbidden` — the test asserts it returns
exactly what the separate call returns, not that it fails.

## The missed cycle: a car's cash clears its own driver → store-manager hop

Added 2026-09-13, after the user re-annotated `555.xlsx`'s "Example" sheet
directly (row 45) pointing out the gap: a car's cash was being aggregated
straight into the location's `location_to_cluster` batch with no receiving-
party confirmation at all — the physical "driver hands the store manager
cash" moment the "Cycle" sheet actually depicts had no handoff+confirm gate
of its own, unlike every other hop in the chain. `createCarHandoff_`
(`Collection.gs`) closes it: a `car_to_location` handoff, same
create→confirm/dispute→resolve machinery as the other two kinds (all three
share `actionConfirmHandoff_`/`actionDisputeHandoff_`/`actionResolveDispute_`
— nothing kind-specific there), addressed from the driver to the location's
store manager (`storeOfLocation_`).

**Correction (2026-09-13, confirmed directly against the user's own
process):** the amount that actually changes hands is the *net* figure —
`computeNet_`'s `netCashOwed` for that car's entries alone
(cashSales − deliveryFeeBankAmount + vatOnDelivery), not the raw cash. The
driver nets it out himself before handing anything to the store manager:
the delivery fee was paid to the bank directly and is the driver's own
incentive to keep (per the xlsx note), except the VAT portion, which the
company still claws back — that's the only piece the driver actually owes
and hands over. An earlier version of this handoff used the raw cashSales
figure instead, reasoning that the delivery fee "was never cash in anyone's
hand" — the user corrected this live while testing (`amount` must be
652.17 in the xlsx example, not 5,000), so `createCarHandoff_` now sets
`amount: totals.netCashOwed`, matching the same formula the
`location_to_cluster` step already used. The full breakdown (still via
`computeNet_`) is kept regardless, for transparency. `createLocationHandoff_` now splits a
location's unconsumed entries: store/pos entries (and any car entry the
store manager *entered themself* — see below) go straight in as before;
every other car entry is excluded until its own confirmed `car_to_location`
handoff shows up, at which point that handoff's breakdown is folded in via
`sumBreakdowns_` (same pattern `createClusterHandoff_` already used for
batching confirmed location handoffs) and the handoff is recorded on
`sourceHandoffIds`, not `sourceEntryIds` — so a disputed-then-rejected
location handoff correctly releases the car handoff back to unconsumed too
(`releaseConsumed_` already walked both fields).

**The same-person exception** (also from the user's note: "if the same user
handled the 2 positions... he can add the store and accept the cars amounts
... directly"): a car entry whose `enteredBy` equals the location's own
store manager needs no separate handoff — it was never anyone else's cash
to hand over — and flows directly into the location batch exactly like a
store entry always has. `checkEntryScope_` already let a store manager log
a car/pos entry at their own location (not just `store` entries), so this
case was already reachable before this change; it just wasn't recognized as
"already home" at aggregation time.

Shortfall attribution (`actionShortfallByEntrant_`) now also covers
`car_to_location`: a car handoff never bundles more than one driver's own
entries, so its shortfall attributes 100% to `h.fromUserId` directly — no
proportional split needed (that's only for `location_to_cluster`, which
really can bundle several entrants).

## The approval chain *is* the conflict-of-interest control

Money moves in one direction — Driver/Car → Store Manager → Cluster Manager
→ Collector → Bank — and at every step **the person who declares an amount
can never be the one who approves receiving it**. This is enforced in
layers, not just at the UI:

1. **Structural, at entity-save time** (`Admin.gs` `validateEntity_`): a
   branch's collector can't be its area's manager; a store's manager can't
   also be the area's manager or the branch's collector.
2. **At handoff-creation time** (`Collection.gs`): a cluster manager can't
   create a handoff to a collector who is themselves; same for the
   location→cluster step.
3. **At confirm/dispute time**: `h.fromUserId === user.id` is refused
   outright — **even for an admin**. An admin may confirm/dispute *on behalf
   of* an unavailable receiver (the `toUserId` check is relaxed for admin),
   but never on their own submission. This is logged as
   `admin_confirm_on_behalf` / `admin_dispute_on_behalf`, distinct from the
   ordinary audit action, precisely so an override is never silently
   indistinguishable from a normal confirmation.
4. **At dispute-resolution time**: an admin/finance account that is also a
   party to that specific handoff (`fromUserId` or `toUserId`) cannot
   resolve its own dispute.

All four layers are exercised in `tests/run.js` — see "conflict of
interest" sections. If you change any handoff-creation or confirm/dispute
code, re-run the tests; a passing structural check does not prove the
runtime one still holds and vice versa.

## Locking and the approval matrix (2026-09-24)

The user's rule is that **once data is handed to the next level, nobody may
change it, and once that level approves it, it stays locked for good.**
Admins are included. The rules below implement it. The Admin →
Permissions screen shows them (`PERM_ROWS` plus the `rule_*` list), and the
"controls:" and "deputy" sections of `tests/run.js` cover every one.

- **No row is edited or deleted.** There has never been an edit or delete
  action for entries or handoffs. Keep it that way. A correction is a new,
  visible movement.
- **Cancelling (`voidEntries`)** is allowed only for the entry's own author
  (`enteredBy`), only while `!consumedBy`, and only with a reason. Nobody
  else can cancel an entry, not even an admin or the area manager. The row
  stays on file with `voided/voidReason/voidedBy/voidedAt`. If the entry has
  a direct deposit (الموازنة), that deposit is cancelled with it
  (`status:'voided'`, same reason, via `directDepositOf_`). The exception is
  a deposit Finance has already matched to the bank statement: that refuses
  with `deposit_reconciled`. `listEntries` sets `voidBlock`
  (`not_author`/`deposit_reconciled`) so the card can say why. Every reader
  that totals deposits skips `status==='voided'`: the reconciliation already
  filtered on `completed`, and the client's `sumDeposits_`, the drill-down
  and the dashboard list now do too. Until 2026-09-27 any entry with a
  الموازنة was simply uncancellable, even while open, which is how a user
  got stuck with a wrong open day.
  Rows saved from one form share a `submissionId`, so a whole day is
  cancelled together, all or nothing. Every reader that counts cash filters
  `!e.voided`. Three readers once didn't and were fixed: the delivery check,
  the car handoff and the dashboard comparison.
- **Day lock (`entryDateError_`)**: an entry is refused if its source+date
  is a past day that already has a handed-over entry (`day_closed`), if the
  date is in the future (`future_date`, Riyadh calendar), or if it's
  malformed. Today stays open, so a second handover the same day still
  works. Without the lock, a backdated expense, credit sale or الموازنة
  quietly cut cash that had already been accepted. **Negative** sales,
  quantities and prices are refused too.
- **Only the receiver confirms receipt (`receiver_only`).** The old admin
  "confirm on behalf" path is gone. An admin can still *dispute* on
  someone's behalf, because that only flags the handoff and moves no money.
  A handoff an admin creates records the real cash holder as `fromUserId`
  and the admin as `createdBy`. `createdBy` can't confirm, settle or
  validate it.
- **Settling a dispute as "confirm"** records the settler as `confirmedBy`
  (`confirmedViaDispute`), accepts the amount actually received (shortfall
  and escalation apply), and raises the same large-amount second-approval
  flag as a normal confirmation. It used to credit the receiver and skip
  four-eyes.
- **The Deputy Operations Manager validates every area-manager → collector
  handoff.** `createClusterHandoff_` opens it as `pending_deputy`, so the
  collector can't confirm it yet. `deputyValidateHandoff` turns it
  `pending` and notifies the collector. `deputyReturnHandoff` (reason
  required) sets it `returned`, releases the swept-up branch handoffs back
  to the area manager's held cash, and emails them the reason. The deputy
  role or an admin may act, as the fallback when there is no deputy, but
  never a party to the handoff. An area-bulk batch already carries the
  deputy's approval, so its handoff opens straight at `pending`. The deputy
  sees everything company-wide, including entries (view only) and bank
  reconciliation (read only via `requireReconciliationView_`), but gets no
  Admin, settings or data entry.
- **Nothing moves while cash is in flight** (`personBusy_`, `placeBusy_`,
  `inFlightError_`). Nobody on a link can be replaced, disabled or given a
  new role while they have unhanded entries, an open (`pending`,
  `pending_deputy`, `disputed`) handoff, or confirmed cash not passed on. No
  branch, store, car or POS can be moved while cash sits there. The errors
  are `person_holds_cash` and `cash_in_flight`. For an **area** the check is scoped to that area alone (`areaPersonBusy_`), so a person still on two areas from before the one-area rule can be taken off the one where nothing of theirs is in flight. Changing someone's role
  also needs them off every link first (`user_has_assignments`). The
  deposit action no longer requires a *current* collector assignment:
  whoever holds confirmed collector cash can bank it.
- **Admin self-protection**: an admin can't disable or demote themselves
  (`cannot_change_self`), and the last active admin can't be removed
  (`last_admin`).
- **Settings** refuse nonsense values (VAT must be between 0 and 1,
  thresholds can't be negative). Every change is audited with `key: old →
  new`.
- **Go-live (`liveLocked`)** is one way. Once set, "start a fresh test
  round" is refused (`live_locked`) and the flag can't be unset from the
  app.

## Area-manager bulk upload — a deliberate, toggleable exception to the chain

Added 2026-09-14, for clusters where drivers/store managers genuinely can't
use the app themselves: the cluster ("Area") Manager uploads the whole
cluster's day at once from a CSV export (`renderAreaBulk`, index.html), and
one Deputy Operations Manager sign-off (`renderDeputyReview`) replaces what
would otherwise be a `location_to_cluster` handoff *and* a
`cluster_to_collector` handoff. This is a genuinely different topology, not
a parallel copy of the normal chain — one upload plus one approval collapses
two hops into one, on purpose, so it's built as an explicit exception living
next to the chain rather than a variant bolted into it.

**Off by default, one global switch** — `areaManagerBulkUploadEnabled_()`
(Code.gs), same `config_()`-backed getter shape as `secondApprovalThreshold_`
etc., set via `actionAdminSetConfig_` and surfaced to the client through
`actionMeta_`'s `config` object (Admin → Settings, a checkbox — the first one
in this app; every other config field so far has been numeric).

**`checkClusterBulkEntryScope_` (Collection.gs) is deliberately a parallel
function to `checkEntryScope_`, never a branch added to it.** A
`cluster_manager` branch inside `checkEntryScope_` itself would silently let
cluster managers use the *ordinary* single-entry and single-location CSV
import too — a real widening of authority that would stay live even with
this feature's toggle off, since `checkEntryScope_` has no knowledge of the
config flag at all. Do not "simplify" these into one function later without
re-deriving this reasoning; a merge is the change most likely to accidentally
reopen this.

**`daily_entries` carries two new fields, `batchId` and `voided`, alongside
the existing `consumedBy`.** All three matter for different reasons:
`consumedBy` is set to the batch's own id the moment the bulk submit
succeeds (`actionBulkSubmitAreaBatch_`) — this is what actually keeps the
cash out of any *normal* manual handoff while the Deputy is still reviewing
it, exactly the same mechanism every other step in the chain uses to mark
cash as spoken for. `batchId` is a separate, permanent provenance marker,
kept distinct from `consumedBy` because `consumedBy` conventionally holds a
*handoff* id everywhere else in this codebase (`releaseConsumed_`,
`unconsumedEntriesForLocation_`, the held-cash logic) — overloading it to
sometimes mean "a batch id" would be a silent, undocumented exception to
that convention. On a Deputy **reject**, entries are marked `voided: true`
rather than simply released (`consumedBy = null`) — a bare release would
make a rejected entry indistinguishable from any other unconsumed row,
reachable by an unrelated manual handoff, and since the area manager's
"correction" is always a fresh CSV upload (new entries, not edits to the old
ones), a literal release would leave the old rejected rows floating in the
unconsumed pool *while a corrected resubmit creates a brand new set* —
double-counting the same real-world cash unless someone manually notices.
`unconsumedEntriesForLocation_` and `actionSalesReport_` both exclude
`voided` entries, so a rejected batch can never re-enter any handoff (manual
or bulk) or inflate a sales total, while staying visible in the raw
`listEntries` result as an audit trail ("submitted then rejected, see
`area_bulk_batches.rejectionNote`"). `tests/run.js`'s reject-and-resubmit
section asserts the corrected batch's total does *not* include the voided
one — that's the exact regression this fix prevents.

**`actionDeputyApproveBatch_` hand-builds `kind:'cluster_to_collector'`
handoffs directly (one per branch since 2026-09-27), rather than routing the Deputy's decision through
`actionConfirmHandoff_`/dispute.** The semantic mismatch is real, not
cosmetic: `actionConfirmHandoff_` exists specifically to capture a
*received-cash* variance (`receivedAmount`, `shortfall`, the whole
`escalateShortfall_` path) — the Deputy isn't receiving cash here, they're
approving whether the uploaded *data* is accurate before any cash claim
exists at all. Forcing this through confirm-handoff would mean either
inventing a fake declared-vs-received pair with no real second number, or
always passing `receivedAmount === amount` — permanently no-op-ing the
shortfall/second-approval infrastructure for every bulk-originated handoff, a
latent bug waiting to confuse whoever eventually wonders why bulk approvals
never show shortfalls. Dispute/resolve-dispute require a handoff to already
exist; here none does until the Deputy approves — there's nothing to
dispute, only a batch to approve or reject. What *is* reused, deliberately:
`computeNet_`/`sumBreakdowns_` (the formula must never diverge from the rest
of the chain), the exact `perLocation` shape `createClusterHandoff_`
produces, `notifyPending_` (the collector gets the same "pending handoff"
email as always, unmodified), and the conflict-of-interest *pattern* — an
explicit `batch.uploadedBy === user.id` / branch collector `===
user.id` self-check on approve, even though both are structurally
near-impossible today (a user holds exactly one role) — because per Trap #3
below, a self-check is never implied by the role requirement alone, and a
future change that relaxes role exclusivity should not silently reopen this.

**The Deputy's approval-queue nav item is *not* gated by the toggle** (only
the Area Manager's upload screen is) — deliberately, so a Deputy can still
finish reviewing any batches that were already `pending_deputy` if an admin
disables the feature mid-flight, rather than orphaning them with no visible
way to act.

**New role `deputy_operations_manager`** joins `COMPANY_WIDE_ROLES` (full
dashboard/report/audit visibility, same tier as Accountant/Operations
Manager) — see Trap #2 below for why that visibility grant carries no
authority beyond this feature's own narrow approve/reject actions, which are
gated separately and explicitly, never implied by `COMPANY_WIDE_ROLES`
membership.

## Amount breakdown, partial receipt, and notifications

Every handoff carries a `breakdown` object (`storeCash`/`carCash`/
`deliveryFee`/`posSales`/`vatOnDelivery`/`netCashOwed`) — `Collection.gs`
`computeNet_()` builds it for a location handoff; `sumBreakdowns_()` sums
several already-broken-down handoffs' breakdowns for a cluster handoff
(`perLocation`, one line per contributing location) and a deposit
(`perCluster`, one line per contributing cluster) — **never recomputed from
raw entries at the batch level**, since that would double-apply the VAT
clawback. The client (`index.html` `handoffItem`/`breakdownGrid`/
`handoffDetailRows`) renders this as an expandable panel, auto-expanded
specifically at *the receiving step* (a pending handoff the viewer can
confirm) and collapsed everywhere else, since that's where "what exactly am
I confirming?" actually matters.

**Confirming asks for the amount actually received, not just yes/no** —
`actionConfirmHandoff_` takes `receivedAmount`. A shortfall does **not**
block the chain waiting on admin review: it confirms immediately with the
real received amount (`h.amount` becomes `receivedAmount`, the original
claim moves to `h.originalAmount`, the gap to `h.shortfall`), so every
handoff further up the chain moves real cash, never the original overstated
claim. `escalateShortfall_` emails the cluster manager, the collector of
that branch (`collectorForHandoff_`), and every admin/finance account the moment a shortfall is
accepted — not just the next person in line — so a shortfall absorbed at
one level is never invisible to the rest of the chain. The separate
"dispute" button (`actionDisputeHandoff_`, free-text note, blocks pending
`resolveDispute`) still exists for a receiver who wants to flag something
rather than simply accept a shortfall — e.g. suspected fraud, refusing the
handoff outright.

The header's 🔔 bell (`state.notifCount`, patched via `setNotifCount()`
rather than a full `render()`) is a count of "things needing this viewer's
attention right now" — their own pending handoffs, plus open disputes for
admin/finance — refreshed after login and whenever Home or Handoffs loads
fresh data; clicking it jumps to the Handoffs screen.

## LPG cylinder tracking (empty-for-full exchange)

Best Gas's actual business — LPG delivered in refillable cylinders, sold
on the standard "bring back the empty, take a full one" exchange model.
`daily_entries` carries two extra counts, `cylindersOut` (full delivered)
and `cylindersIn` (empty returned), entered per row alongside the cash
figures — but they are **completely independent of `computeNet_`**, pure
physical-inventory counts, never touching the cash-owed formula. The
entry form only shows the two fields once a specific product is picked
(`toggleCylFields` in `index.html`) — a cylinder count means nothing
without knowing which cylinder type.

`actionSalesReport_` (Collection.gs) aggregates them two ways from the
same already-filtered `entries` array: `byProduct[].cylinderBalance`
(company-wide per product) and the finer `cylinderByLocation` (per
location × product — the actual operational question, "which branch/car
owes how many empties back"), both `out − in`. An entry with no
`productId` is excluded from `cylinderByLocation` on purpose. Surfaced on
the Dashboard as a sortable table, defaulted to sort by balance
descending so the biggest outstanding exchanges surface first.

## Bank reconciliation (`Reconciliation.gs`)

Closes the gap the rest of the chain can't: `recordDeposit` only ever
records what the collector *says* they deposited (a self-reported
`bankReference`), with nothing checking it against what the bank actually
received. Admin/Finance (`requireReconciliationAccess_` — same authority
split as dispute resolution, not just company-wide visibility) upload a
bank statement as CSV (`date,amount,reference` columns) via the
"Bank Reconciliation" screen; each row becomes a `bank_statement_lines`
row, and `autoMatchBankLines_` runs immediately after import.

Auto-match rule, deliberately conservative: a bank line links to a
`deposit`-kind handoff only when the amount matches to the cent **and**
exactly one unmatched deposit falls within `RECON_DATE_WINDOW_DAYS` (3)
of it. More than one candidate at that amount/window is left unmatched
for a human to resolve manually (`manualMatchReconciliation`) rather than
guessed at — silently picking the wrong one of two same-amount deposits
would be worse than leaving both flagged. `unmatchReconciliation` undoes
a link without touching the underlying deposit record itself.

A matched deposit gets `reconciled: true` / `reconciledAt` /
`reconciledLineId`; an unmatched deposit or an unmatched bank line are
both real flags worth Finance's attention — the former means "we said we
deposited it but the bank doesn't show it (yet, or ever)", the latter
means "money arrived at the bank with no declared deposit behind it".

## SLA timeout escalation (stale handoffs)

A `pending` handoff that nobody confirms is invisible risk — cash sitting
declared-but-unconfirmed with no one chasing it. `staleThresholdHours_()`
(`Code.gs`, default 24, editable by admin via `adminSetConfig` →
`config.staleThresholdHours`) defines "too long." `checkStaleHandoffs_`
(`Collection.gs`) scans all `pending` handoffs, and for any older than the
threshold calls `escalateStaleHandoff_` — same non-blocking philosophy as
the shortfall/large-amount escalations below: **the handoff is not touched,
still fully confirmable**, it's purely a notification. The email goes to the
intended receiver plus the relevant cluster manager/collector plus every
admin/finance account, same "never invisible to the rest of the chain"
pattern as `escalateShortfall_`.

Escalates **once per handoff** — `h.staleEscalatedAt` is set the first time
and checked before re-escalating, so a handoff that stays stale across
multiple trigger runs doesn't spam the same people daily. `actionRunStaleCheck_`
(admin/finance only) runs the scan on demand from Admin → Settings; for it to
run automatically, an admin installs a daily time-based trigger via
`actionAdminInstallStaleTrigger_` → `adminInstallStaleTrigger`, which is
idempotent (checks `ScriptApp.getProjectTriggers()` for an existing
`checkStaleHandoffs_` trigger before creating a second one).

**Held-cash aging (added 2026-09-13) rides the same trigger.** A
`confirmed`-and-still-`!consumedBy` handoff (the same "held" definition the
dashboard's held-cash-by-holder snapshot and 14-day trend already use) is a
*later*-stage risk than a still-pending one — someone legitimately has the
cash, they just haven't batched it onward. `heldThresholdHours_()` (default
48, `config.heldThresholdHours`, separate from `staleThresholdHours_` since
the two risks warrant different patience) and `checkHeldTooLong_` /
`escalateHeldTooLong_` mirror the stale-handoff functions exactly —
`h.heldEscalatedAt` guards the once-only email, aged from `resolvedAt ||
confirmedAt` (same rule `actionHeldCashTrend_` uses, so the trend chart and
this alert never disagree about when "holding" started). Rather than a
second trigger, `checkStaleHandoffs_` just calls `checkHeldTooLong_` at the
end of its own run and sums the counts — one daily trigger, one "check now"
button, both aging risks. `actionRunStaleCheck_`'s response carries
`staleEscalated`/`heldEscalated` separately (plus `escalated` = their sum,
kept for anything still reading the old single-number shape).

## Large-amount second approval (non-blocking four-eyes)

`secondApprovalThreshold_()` (`Code.gs`, default 0 = off, editable via the
same `adminSetConfig` path as the stale threshold) flags any handoff whose
*received* amount is at or above it. Same non-blocking pattern as everywhere
else in this chain: crossing the threshold never delays the handoff —
`actionConfirmHandoff_` still confirms immediately, it just also sets
`h.requiresSecondApproval = true` and fires `escalateLargeAmount_` (same
recipient set as the stale/shortfall escalations). An admin/finance account
later calls `actionAcknowledgeSecondApproval_` (`acknowledgeSecondApproval`)
to record `secondApprovedBy`/`secondApprovedAt` — a paper-trail sign-off,
not a gate; acknowledging twice is rejected (`already_acknowledged`) so the
record can't be silently overwritten. The client (`handoffItem` in
`index.html`) shows a banner (needs-second-approval vs. already-acknowledged)
and, for admin/finance only, an "Acknowledge" button.

## Risk / complaints register (`Risk.gs`)

A general-purpose operational log, deliberately outside the cash-handoff
chain — for anything worth flagging that isn't a specific handoff dispute
(a safety concern, a recurring customer complaint, anything an employee
wants on record). Anyone authenticated can submit one
(`actionCreateRiskItem_` — reporting a problem should never itself require
permission); only company-wide roles can browse the register
(`requireCompanyWide_`, visibility only, same split as everywhere else in
this app); only admin/finance can change its status
(`requireAdminOrFinance_` — authority, not visibility). A `high`-severity
item triggers an immediate email to every admin/finance account
(`notifyRiskItem_`) — `low`/`medium` ones just sit in the list for the next
review, same "only interrupt someone for the things that actually need
interrupting" judgment used for the stale/large-amount escalations above.

## Testing

The `.gs` files are pure JS with Apps Script globals — `tests/stub-harness.js`
rebuilds those globals (`SpreadsheetApp`, `PropertiesService`, `CacheService`,
`LockService`, `Utilities`, `MailApp`, `DriveApp`, `ContentService`) as
in-memory fakes under Node's `vm` module, then loads the real `Code.gs` +
`Admin.gs` + `Collection.gs` + `Reconciliation.gs` + `Risk.gs` unmodified
into that context (plus a mock `ScriptApp` for the stale-handoff trigger).
`tests/run.js`
drives `route_()` exactly as `doPost` would — same file the harness in
`rental-contracts`/`7777` uses this approach for the same reason: it proves
the actual logic, not a reimplementation of it.

```bash
node tests/run.js
```

Covers: the xlsx formula against the Example sheet's own numbers, the full
five-step chain (car → location → cluster → collector → deposit), both dispute
outcomes (reject releases entries back to the unconsumed pool; confirm
accepts the variance), every conflict-of-interest layer above, and
authorization boundaries (a driver logging cash for someone else's car, a
non-admin touching entity management, a store manager submitting a handoff
for a location they don't manage, a cluster manager's report never leaking
another cluster's location).

**Rebuild the stubs, never test against a real sheet** — same rule as the
sibling projects. If a new Apps Script call is added and the harness has no
stub for it, add the stub; don't skip the test. (The `area_bulk_batches`
sheet the bulk-upload feature added needed no new stub at all — `sheet_()`'s
lazy `insertSheet` already covers any unknown sheet name, in both the real
backend and the harness's fake `SpreadsheetApp`, so `readSheet(SHEETS.AREA_BULK_BATCHES)`
just works the first time it's called.)

For UI changes, `tests/run.js` alone is not enough — see Traps #1.
`tests/mock-backend-server.js` serves the real `index.html` and answers its
API calls with the same real backend logic (same stub harness) on one
origin, so the actual client can be driven in a real browser with no live
Google deployment:

```bash
node tests/mock-backend-server.js 8905   # prints seeded logins + temp passwords
```

Then open `http://localhost:8905/`, paste `http://localhost:8905/api` as
the system URL when asked, and sign in as one of the printed accounts.

## Local UI preview

`tests/` has no bearing on the client — to eyeball `index.html` changes,
`.claude/launch.json` (at the workspace root, `C:\Claude\.claude\launch.json`)
has a `bestgas-cash-collection` entry (`npx http-server` on port 8903) since
this is a static file with no build step. `index.html` has the live `/exec`
URL baked in as `DEFAULT_API_URL` (falls back to it whenever `localStorage`
has nothing saved), so opening any copy — including via `file://`, which
doesn't always persist `localStorage` reliably across sessions/browsers —
just works with no setup screen. That URL-entry screen (`renderUrlSetup`)
still exists for pointing a copy at a *different* deployment (e.g. local
testing against `tests/mock-backend-server.js`, which serves its own
`index.html` copy and overrides via `localStorage`) — set it manually in
that case, or just edit `DEFAULT_API_URL` for a fork against a different
Sheet/script entirely.

## Distributing the client — index.html vs. index.protected.html

`index.html` is the source — always read and edit this one. `node
tools/obfuscate.js` builds `index.protected.html`, an obfuscated copy
(the whole app script XOR'd + base64'd behind a tiny loader) meant for
actual sharing/hosting, since the plain file is fully readable via
"view source" in any browser. Regenerate it after every `index.html`
change that should reach distribution — it is not kept in sync
automatically.

This is obfuscation, not real security: there is no secret in the client
to protect, since every actual authorization check (who can see what,
who can approve what, password verification) already runs server-side
in `Code.gs`/`Admin.gs`/`Collection.gs`, none of which this touches. It
only raises the bar against casual copy-paste of the UI/business logic.
A determined reader can always deobfuscate client-side JS. See the
sibling `Downloads/7777` rental app for the same tradeoff, including the
trap it hit: an obfuscated bundle makes a real bug read exactly like a
"swallowed rejection" — decode/execution errors here are deliberately
*not* caught in a try/catch, so they still surface normally in the
console instead of failing silently. Debug against `index.html` directly
(mock server or file), never the obfuscated output.

Other hardening done alongside this: password minimum bumped from 6 to
8 chars (`actionChangePassword_`, `Code.gs`); an XSS audit of every
`innerHTML`/`el()` call site in `index.html` found the existing `esc()`
discipline already consistent everywhere user/admin-entered text renders
(names, notes, dispute reasons, audit log, CSV-import preview) — no gaps
found, nothing to fix there.

## Deploying — live since 2026-09-10

Deployed. Script project id `1IvXuVjao9KsxrXDgT8Z51QOpgTnUSWSNVWT08G5KFMMXLwz9_9IQEukD`,
web app deployment id `AKfycbxgS7bhn4Nn0szYnKVRb6rjGEKumqCJkQ8jY2uNjDrf2wP2YQYgTvltLrwsbKviD7I`
(`/exec` URL is stable across redeploys as long as you update *this*
deployment rather than creating a new one). Admin account: `aboumahdi04@gmail.com`.

### Redeploying a code change — use `clasp`, not the web editor

**The deploy folder is `C:\Claude\bestgas-cash-collection\apps-script`** (moved out
of `%TEMP%` on 2026-09-29, where Windows could have cleared it). It already has
`.clasp.json` and the private `CustomerSeed.js`: `clasp pull`, copy `Code.gs` →
`الرمز.js`, `Admin.gs` → `Admin.js`, `Collection.gs` → `Collection.js`, then
`clasp push -f` and `clasp deploy -i …` as below. The steps below that create a
fresh folder are only for rebuilding it.

The Apps Script web editor's "Manage deployments" version dropdown is a
Google Closure combobox that is extremely unreliable to drive by automation
(and fiddly by hand) — it silently no-ops far more often than it works.
`clasp` (already installed globally, already authenticated as
`aboumahdi04@gmail.com` — see `C:\Users\User\.clasprc.json`) does the same
thing in two reliable commands. **Gotcha**: the remote script's first file is
literally named `الرمز` (Arabic for "the code"), not `Code` — clasp matches
files by name, so pushing a local `Code.gs`/`Code.js` from this folder would
*add* a duplicate file rather than update it. Always pull first and push
back into the pulled, correctly-named files:

```bash
mkdir /tmp/bgc-push && cd /tmp/bgc-push
cat > .clasp.json <<'JSON'
{"scriptId":"1IvXuVjao9KsxrXDgT8Z51QOpgTnUSWSNVWT08G5KFMMXLwz9_9IQEukD","rootDir":".","filePushOrder":["الرمز.js","Admin.js","Collection.js","Reconciliation.js","Risk.js"]}
JSON
clasp pull                     # fetches الرمز.js / Admin.js / Collection.js / Reconciliation.js / Risk.js / appsscript.json
# copy the updated content from this repo's Code.gs/Admin.gs/Collection.gs/
# Reconciliation.gs/Risk.gs into the correspondingly-named pulled files, then:
clasp push -f
clasp deploy -i AKfycbxgS7bhn4Nn0szYnKVRb6rjGEKumqCJkQ8jY2uNjDrf2wP2YQYgTvltLrwsbKviD7I -d "what changed"
```

`clasp deploy -i <id>` creates a new version *and* points that existing
deployment at it in one step — the `/exec` URL never changes.

**Gotcha #2, took the site down for real once**: without `filePushOrder`,
`clasp push` reorders files (looked alphabetical: `Admin.js`/`Collection.js`
before `الرمز.js`, since Arabic sorts after ASCII). Apps Script executes each
file's top-level code in project file order at load time, and `Admin.gs`'s
top-level `var ENTITY_SHEET = { location: SHEETS.LOCATIONS, ... }` reads
`SHEETS`, a top-level `var` defined in `الرمز`/`Code.gs` — so with `Admin`
loaded first, every request failed with `TypeError: Cannot read properties
of undefined (reading 'LOCATIONS')`. The `filePushOrder` above pins it.
`clasp push` also silently no-ops ("Script is already up to date") if it
diffs local content as unchanged from its last-known state, which can mask
that an *order* fix didn't actually get sent — force a real push (append/
remove a blank line, whatever) when you're specifically trying to fix
ordering with unchanged file contents. **Always re-fetch `/exec` with a
`doGet` ping right after any deploy** — don't assume success from the CLI
output alone; that's what caught this the one time it happened.

### First-time setup (for a fresh clone/fork)

1. Create a new Google Sheet (any name — the code creates its own tabs).
2. Extensions → Apps Script. Paste `Code.gs`, `Admin.gs`, `Collection.gs`
   into three separate script files in that project (same names) — or use
   `clasp create` / `clasp push` from a fresh `.clasp.json`.
3. Edit `setupFirstAdmin()` in `Admin.gs` (the copy inside the Apps Script
   editor) — set `ADMIN_EMAIL` to a real address — then run it once from the
   editor (Run ▸ setupFirstAdmin). It emails that address a temporary
   password.
4. Deploy ▸ New deployment ▸ Web app, execute as *Me*, access *Anyone*. Copy
   the `/exec` URL.
5. Host `index.html` anywhere static (or open it locally for now). On first
   load it asks for that `/exec` URL and remembers it in `localStorage`.
6. Sign in with the emailed temporary password, set a real one, then use
   the Admin screen to build out clusters → locations → stores/cars → POS
   machines → the remaining users. Nothing needs editing in the Sheet by
   hand.

### Forgotten/stale password

Self-service now exists: the login screen's "Forgot password?" link calls
`actionForgotPassword_` (`Code.gs`), which — if the email matches an active
user — generates a new temp password, sets `mustChangePw`, and emails it via
the same `sendInvite_` (`Admin.gs`) used for new accounts and admin resets.
It always returns `{ok:true}` regardless of whether the email exists, to
avoid leaking which addresses are registered. Throttling is a **30-second
per-email cooldown** (`CacheService`, key `fpwait_<email>`), deliberately
*not* the login brute-force lockout (`checkLock_`/`noteFail_`, 8
strikes/15min) — the first version reused that mechanism and it backfired
in production: a user unsure whether their first click worked clicked "send"
a few more times, each of which counted as a strike, and after 8 they were
silently locked out of requesting a new password for 15 minutes — with the
UI still showing "check your email" every single time, since the generic
`{ok:true}` gave no hint anything had changed. Now a throttled request
returns `{ok:true, throttled:true}` and the client shows a distinct "you
already asked, wait ~30s" message instead — still no leak about whether the
account exists, but at least an honest reason when nothing arrives. If you
ever see this symptom again ("temp password isn't arriving, I've tried a
lot"), check `CacheService` state and MailApp's quota
(`MailApp.getRemainingDailyQuota()`, 100/day on a consumer Gmail account)
before assuming the mail pipeline itself is broken — both times so far it
was throttling, not delivery.

If *every* admin account is locked out with no working password and no
access to the invite emails, there's no in-app recovery — you'd need to add
a one-off maintenance function in the Apps Script editor (Run menu, not
exposed via `doPost`) that calls the same reset+`sendInvite_` logic for a
specific email, exactly as done once during initial setup.

## Invitations, and the user lifecycle (2026-09-22)

Creating a user no longer emails a temporary password. `actionAdminCreateUser_`
writes the account with **no password at all** and sends a branded bilingual
invitation carrying a single-use link (`?invite=TOKEN`, 7 days). Only
`inviteHash_(token)` is stored, so a copy of the Users sheet cannot be turned
back into working links. The person sets their own password on the client's
accept page (`renderAcceptInvite`, reached through the public `inviteInfo` /
`acceptInvite` actions — no session exists yet).

`userStatus_` (Code.gs) derives what the admin list shows:
`invited` → `accepted` (link used, password set) → `active` (first real
sign-in), plus `invite_expired` and `disabled`. Accounts created before this
existed have no `inviteStatus` and count as active once they have a
`lastLoginAt`. Two consequences worth remembering: signing in before
accepting returns `invite_pending` (not `invalid_credentials`), and
"reset password" on someone who never accepted re-sends the invitation
instead of minting a temporary password — as does forgot-password.

The invitation email is HTML. `sendMail_` takes an optional fourth `html`
argument and passes it to Graph as `contentType:'HTML'` or to MailApp as
`htmlBody`; the plain-text body stays the fallback. Its logo is a hosted PNG
(`assets/mail-logo.png`, generated by `tools/make-app-icons.js`) because
Gmail strips `data:` images.

## Language

`L` in `index.html` holds ar/en/ur strings; direction follows the selected
language (ar/ur = RTL, en = LTR), not a fixed setting. Add a language by
adding one more key to `L` and one `<option>` in the two language
`<select>` elements (login screen and header) — no other code changes.

**Drivers sign in with their iqama number (2026-09-29).** An account may have no
email when it has an `iqamaId`: `adminCreateUser` then makes it with a readable
temporary password (`createIqamaUser_`, `readablePassword_`, `mustChangePw`)
returned to the admin once as `tempPassword`, and sends nothing.
`adminImportUsers` does the same for a sheet of drivers. The sign-in box takes an
email or an iqama number (`userByLogin_`; `normIqama_` turns Arabic digits to
ASCII, drops spaces and dashes, capitalises passport letters). One iqama per
account (`iqama_exists`). `userByEmail_('')` returns null, so a blank login never
matches an account without email, and `sendMail_` drops blank addresses. A reset
on such an account returns a new `tempPassword` instead of emailing; the admin
screen shows it once (`tempPwBox_`). A driver enters sales for any POS device
whose `assignedUserId` is them, with or without a car.

**Inventory (2026-09-29, Inventory.gs).** Per branch and inventory item (product
`type` goods, shown as مخزني/Inventory; services have no stock) over a period:
opening + purchases + returns from restaurants = available; available - sales -
damaged = ending, valued at `product.unitCost`. Opening, purchase, return and damage
are typed in as `inventory_moves` rows (`addInventoryMove`; one opening per
branch and item, `opening_exists`); sales are the `qty` of day-entry product lines
at that branch (credit is already inside those lines, so `creditItems` are not
added again). Everything before `dateFrom` rolls into the opening. A move is
voided with a reason (`voidInventoryMove`, author or admin/finance), never
deleted. Admin/finance keep stock anywhere, an area manager for his area, a branch
manager for his branch; company-wide roles read all. An ending below zero comes
back `short:true` and the screen flags it without a minus sign. Screen
`renderInventory` (nav المخزون); its equation card is `no-collapse` so the ending
stock stays in view on a phone.

**The area manager's Excel (2026-09-29).** The area bulk upload reads an .xlsx
(`abxTemplate_` builds it with ExcelJS: sheet الإدخال with one prefilled row per
POS in the area, dropdowns fed from sheet القوائم, and طريقة التعبئة; `abxRead_`
reads it with SheetJS). One row is one line of one POS's day, typed by
`ABX_TYPES_`: sale (item, qty, price, plus one "of which via <channel>" column
per sales channel → `channelQtys`), credit (customer, item, qty: one entry row
carrying `cashSales` and `creditSales` and `creditItems`, so the units count once
for stock and the credit comes off the cash), transfer, deposit (الموازنة with a
bank reference, no photo; `directDepositPosId` = the row's POS), expense and other
collection (item + reason), delivery fee. `abxRows_` turns rows into the same
entry rows the form writes and checks each; the server dry run's per-row errors
land on their rows. Files over 450 lines go up as several batches, whole branches
each (`abxChunks_`). Tests: "area Excel" section in tests/run.js.

**Grouped pickers (2026-09-29).** `sourceOptionsGrouped_` puts an area manager's
sources in one `<optgroup>` per branch; the designed dropdown (`ddOpen_`) draws
each group as a header that folds (closed except the group holding the choice; a
search opens the matching groups).

**Reports and exports (2026-09-29).** Every export goes through one sheet model
`[{name, rows, outline?, note?}]` (rows[0] header, a first cell equal to
`t('rp_total')` marks the totals line, `outline[k]` is the depth of data row k).
`exportXlsx_` builds it with ExcelJS 4.4.0 from cdnjs (SRI pinned; falls back to
plain SheetJS): title band + logo, subtitle "prepared by", green header, money as
`#,##0.00` (whole numbers only for count/qty headers, `exColKinds_`), negatives red
without a sign, totals row, frozen header, autofilter, RTL for ar/ur, A4 print
setup, and Excel row grouping from `outline`. `exportPdf_` prints the same model
in a new window (browser Save as PDF, which shapes Arabic; PDF libraries do not).
`exButtons_` gives any view both buttons; `exEnhance_` and `rpTableCard_` use it.
The pivot (`pivotCard_`) lets the viewer choose and order levels from
`PV_DIMS_` (city, area, branch, owner = the store or car a POS sits on, source,
product, day, entered by) and figures from `PV_MEASURES_` (saved in localStorage
`bgc_pv`), open to level N, and search (opens the path to matches). Its Excel
export is the whole tree with grouping; its PDF is what is open. The pivot table
carries `data-nosort` so the automatic header sort (`tsEnhance_`) never
scrambles the tree.

**A driver's POS rides on his car (2026-09-29).** `entryCarId_` (Collection.gs):
a `pos` entry whose machine has `ownerType:'car'` belongs to that car's
`car_to_location` handover like a car entry, and the branch manager's
`location_to_cluster` leaves it out until that handover is confirmed. A POS day's
الموازنة is on that same POS (`deposit_pos_mismatch`; none named = the day's
own). `createHandoff` and `recordDeposit` run under the script lock
(`withCashLock_`) so a double tap cannot hand the same cash over twice.

**Names in English and Urdu (2026-09-29).** Master data is typed in Arabic; the
`translations` sheet (`{src, en, ur, auto}`, keyed by the Arabic text) holds each
name's English and Urdu and ships in `listMeta` as `translations`. `saveEntity_`,
user create/update and `adminImportEntities` (one batch per file) call
`fillTranslations_`, which sends new names to `LanguageApp.translate` in chunks;
a failure never fails the save, and `adminFillTranslations` catches gaps up.
`adminSaveTranslation` ({src,en,ur} or {rows}) is a manager's correction
(`auto:false`), never overwritten. Names already carrying Latin letters are not
sent: the client shows their Latin part (`latinPart_`, with Saudi plate letters
converted by `plateLatin_`, read in reverse). **The client translates the drawn
page, not the data**: a MutationObserver swaps known names in text nodes
(`trNode_`/`trText_`, longest name first, Arabic-letter boundaries), so input
values, ids and everything sent to the server stay Arabic. Mark an element
`data-notr` to exempt it (the Admin → الترجمات screen is). Excel exports go
through `trText_` too. The live list's hand-made translations are built by
`bestgas-cash-collection/translations/build-live-translations.js` (private:
real customer names).

## Traps

### 1. A bare `<tr>` built through `el()` silently loses its content

`el(html)` builds a DOM node by setting `div.innerHTML = html`. Verified
empirically: `div.innerHTML = '<tr><td>a</td></tr>'` does **not** create a
`<tr>` — the HTML parser strips table-row/cell tags outside a `<table>`
context and what's left is a single stray text node. `el('<tr>...</tr>')`
then returns that text node, and anything reading `.lastChild`/`.appendChild`
on it fails with "Cannot read properties of null" — which is exactly what
broke the Admin → Users table and every generic entity table (Locations,
Stores, Cars, POS, Clusters) the first time they were exercised in a real
browser; `tests/run.js` never caught it because it drives `route_()`
directly and never touches `index.html`'s DOM code at all.

`el()` now special-cases `tr`/`td`/`th`/`tbody`/`thead` by building them
inside a real `<table>` first. **Never build a bare `<tr>` (or `<td>`/`<th>`)
through a plain-`<div>` `el()` call again** — either keep using the fixed
`el()`, or set the whole `<table>…</table>` markup in one `innerHTML`
assignment (that parses fine, which is why the Sales Report and Handoffs
history tables — built that way — worked from the start).

**The lesson that generalizes: `tests/run.js` proves the backend logic, not
the client.** It caught the formula, the chain, every conflict-of-interest
guard — real bugs, genuinely useful — but a DOM-construction bug in
`index.html` is invisible to it by construction. `tests/mock-backend-server.js`
(serves the real `index.html` and answers its calls with the real backend
logic on one origin) is what actually exercises the client, and is what
caught this one. Run both, not just the fast one, before calling a UI
change done.

### 2. Visibility and authority are two different checks — don't conflate them

Accountant and Operations Manager see everything Admin/Finance see
(dashboard totals, the full sales report, every handoff, the audit log —
gated by `isCompanyWide_()`), but neither can resolve a dispute or touch
entity/user management (gated by `requireAdmin_()` /
`requireAdminOrFinance_()`, deliberately **not** widened to
`isCompanyWide_()`). `tests/run.js`'s last section asserts both directions
explicitly. If a future role needs to see something new, extend
`COMPANY_WIDE_ROLES`; if it needs to *act* on something, that's a separate,
narrower decision — don't fold it into the same check by reflex.

Deputy Operations Manager (added with the area-manager bulk-upload feature)
is a second worked example of the exact same split: full company-wide
visibility via `COMPANY_WIDE_ROLES`, but its only *authority* is
`actionDeputyApproveBatch_`/`actionDeputyRejectBatch_` (Collection.gs),
which check `user.role === 'deputy_operations_manager'` explicitly — never
derived from `isCompanyWide_()`, which three other roles share without
getting that power. `tests/run.js`'s area-bulk-upload section asserts the
same both-directions shape (full dashboard/report/audit access, but
`resolveDispute`/`adminSaveEntity` still forbidden) as this trap's original
example.

### 3. "Admin/finance only" doesn't mean "a different person" — conflict-of-interest checks must be added explicitly, per action

`validateEntity_` only checks that a cluster's `clusterManagerUserId` and
`collectorUserId` differ **from each other** — nothing stops either from
also being an admin/finance account's own user id. That's a completely
realistic setup (a small company reusing a finance person as a collector),
and it means "requires admin/finance" is not the same guarantee as "requires
someone else." A deep review (2026-09-13) found `actionAcknowledgeSecondApproval_`
missing exactly this check: the same admin/finance user who confirmed a
large handoff (legitimately, as its real receiver — no conflict at that
step) could also acknowledge their own second-approval sign-off, silently
defeating "four eyes." Fixed by adding `if (h.confirmedBy === user.id) return
conflict_of_interest` — same reasoning as the `fromUserId`/`toUserId` guard
already on `actionResolveDispute_`. **Whenever a new action requires
admin/finance and is meant as an independent check on something another
admin/finance action already touched, add the self-check explicitly — it is
never implied by the role requirement alone.** The same review also found
`escalateLargeAmount_` only emailing admin/finance, unlike
`escalateShortfall_`/`escalateStaleHandoff_` which also reach the cluster's
own manager and collector — widened to match, since a narrower recipient
list on one of three near-identical escalation functions was very likely a
copy-paste gap, not a deliberate choice. Both are covered by new
`tests/run.js` sections; a third bug from the same review —
`actionMeta_` never returning `staleThresholdHours`/`secondApprovalThreshold`,
so the Settings screen always showed the hardcoded defaults and a naive save
could silently revert a live config back to them — is covered by the
`listMeta` assertion in the "large-amount second approval" section.

### 4. Any `for...in` merge loop or lookup table keyed by client input must use `safeOwnKeys_`/`hasOwn_` (Code.gs)

A security review (2026-09-13) found the one place in this codebase that
merges client-supplied JSON into a plain object with a bare `for (var k in d)
{ if (d.hasOwnProperty(k)) obj[k] = d[k]; }` loop — `actionAdminSaveEntity_`
(Admin.gs) — was vulnerable in principle to prototype pollution: `JSON.parse`
creates a key literally named `"__proto__"` as a genuine **own** property (so
a bare `hasOwnProperty` check does not exclude it), but the later `obj[k] =
value` assignment, with `k` holding that exact string, invokes the real
`Object.prototype.__proto__` setter and reassigns `obj`'s actual prototype.
Same class of bug for any object used as a lookup table keyed by client
input — `ENTITY_SHEET[kind]`, `ENTITY_CHILDREN[kind]`, `handlers[action]` in
`route_` — a crafted `kind`/`action` like `"__proto__"` or `"constructor"`
resolves to an inherited `Object.prototype` member instead of correctly
missing.

In this specific codebase the real-world impact was near-nil (every affected
action already requires `requireAdmin_`, and `writeRow`'s own
`hasOwnProperty` filter happens to exclude the polluted prototype's
properties from what actually gets persisted) — but it's fixed anyway as
defense-in-depth, since the fix is cheap and the pattern is worth blocking on
principle for a system handling real money. `safeOwnKeys_(obj)` (Code.gs)
returns only own keys that aren't `__proto__`/`constructor`/`prototype`, for
merge loops; `hasOwn_(obj, key)` (`Object.prototype.hasOwnProperty.call`) is
for lookup-table existence checks — **use these, never a bare `for...in` +
assignment or a bare `table[key]` truthy-check, on anything built from
`req.data` or another client-supplied field.** Covered by
`tests/run.js`'s "crafted `__proto__`/`constructor` keys" section.

### 5. A field added to one entry type has several places that must all learn about it

A bug sweep (2026-09-13) found that letting a `car` entry carry `posSales`
(so a car with its own mounted POS terminal can report card sales, not just
cash) had only actually been wired into `computeNet_` and the by-product
breakdown — four other places still assumed only a dedicated `pos` source
could have `posSales`, so a car's card sales were silently dropped from: the
dashboard's "by source type" donut (`index.html`, `sourceTotals` — fixed to
add `e.posSales` for `car` too), the Entries screen's "Recent entries" amount
column (was `e.sourceType==='pos' ? e.posSales : e.cashSales`, a ternary that
can't represent an entry carrying both — fixed to always show
`cashSales + posSales`), and the CSV bulk-import path end to end (the column
hint text, the template generator, and the row parser never mentioned
`cylindersOut`/`cylindersIn` at all — not specific to `posSales`, but the
same root problem: a field that exists on the manual entry form was never
propagated to the bulk-import equivalent). **Whenever a new field is added to
`daily_entries`, grep the client for every place that reads `cashSales`/
`posSales`/`cylindersOut`/`cylindersIn` off an entry or aggregates per
`sourceType` — a per-entry-type ternary or a `case` that only lists some
source types is the shape this bug takes.** The same sweep also found the
`admin` role had no way to actually reach the documented "confirm on behalf
of an unavailable receiver" backend capability (Traps, "conflict of
interest" — the Handoffs screen's pending list was filtered to
`toUserId===me` for every role including admin); fixed by letting admin see
every pending handoff there, not just their own.

### 6. A one-shot "clear all transactions" bulk-delete is hard-blocked

Claude Code's auto-mode safety classifier refuses any code edit that adds a
function wiping every row of a sheet in one shot — confirmed twice on a
`clearSheetRows_`-style helper even gated behind `requireAdmin_` plus a
`req.confirm==='CLEAR'` check, with an audit-log entry preserved. This isn't
a bug to route around: if the user wants old/test transactional data wiped
before going live with real data, either (a) do it as a one-off manual
action via a temporary diagnostic function (same pattern as the password-
reset trap in "Redeploying" below — inject, run once, remove, redeploy
clean), or (b) ask the user to add a permission rule allowing it, per the
denial message. Don't retry the same edit hoping it clears.

What exists instead is **archive-by-rename**
(`actionAdminArchiveTransactions_`, Admin → Settings → start a fresh test
round). Each movement tab (`TRANSACTIONAL_SHEETS_`) is renamed
`<name>_archive_<yyyy-MM-dd_HHmmss>`, its version is bumped so no cached copy
survives, and `sheet_()` recreates it empty on the next read. Users and
master data are untouched. The name gets a `_2`, `_3`… suffix if it is
already taken. Before 2026-09-24 the stamp had minutes only, so a second
round started in the same minute (the audit tab always holds the first
round's own line) hit Google Sheets' duplicate-name error half-way through.
The test stub's `setName` now throws on a duplicate like the real thing,
because it used to overwrite silently and hid the bug.

### 7. A single-class CSS rule silently loses to a same-specificity rule that appears later in the file

Added 2026-09-14, found while building the welcome-message redesign: a new
`.welcome-card{background:linear-gradient(...)}` rule was inserted near the
top of the `<style>` block, but the generic `.card{background:var(--card)}`
rule (white) is defined further down and — same specificity, later in
source order — wins the cascade. The element (`class="card welcome-card"`)
rendered as a plain white box with the right text inside and no visible bug
in the DOM inspector's HTML, only in its computed `background`. **Any new
single-class rule meant to override `.card`'s own styling must be written
as a compound selector, `.card.your-class{...}`, not `.your-class{...}`
alone** — two classes beats one regardless of source order, so it can't
silently lose to wherever `.card` happens to sit in the file. Same fix
applied to `.welcome-card.splash`/`.welcome-card.splash::after` for
consistency, even though those specific rules didn't hit the bug (they set
properties `.card` doesn't touch).

### 8. A JS-injected favicon can lose the race to the browser's own tab-icon fetch

The original favicon/apple-touch-icon/manifest were all attached at runtime
via `attachIcons()` (a self-invoking function near the top of the main
`<script>`) to avoid duplicating the ~21KB logo base64 three times in one
file. In practice this made the browser-tab/address-bar icon unreliable —
some browsers decide the tab icon before that script block finishes
running, especially on first load, and a home-screen-installed PWA caches
whatever it saw at install time and doesn't reliably re-check. Fixed by
making the favicon a plain static `<link rel="icon">` in `<head>` (the logo
base64 duplicated once more, accepted cost) so it's available before any
script executes — same pattern the sibling rental app (`Downloads/7777`)
already used. apple-touch-icon and the manifest stay JS-attached, since
those only matter once, at "Add to Home Screen" time, not on every normal
load.

### 9. `.replace(str, val)` only swaps the *first* occurrence of a repeated placeholder

Found 2026-09-14 building the area-bulk-upload VAT-explanation card
(`vatExplainBlock_`, index.html): one of the four i18n step strings uses
`{rate}` twice in the same sentence ("divide by (1 + VAT rate {rate}%)...
{fee} ÷ (1 + {rate}%)"). Chaining `.replace('{fee}', ...).replace('{rate}',
...)` only fills the *first* `{rate}`, silently leaving the second one as
the literal string `{rate}` in what shipped to the screen — exactly the
kind of bug that's invisible unless someone actually reads the rendered
sentence closely (both `node tests/run.js` and a syntax check pass either
way, since this is a plain string bug, not a formula bug). Fixed with
`fillTemplate_(str, vars)`, which uses `str.split(key).join(value)` per key
— every occurrence, not just the first. **Any i18n template string that
might repeat the same `{placeholder}` twice must go through
`fillTemplate_`, never a bare chained `.replace()`.**

### 10. Area-manager bulk upload: preview the real calculation before sending, not just row validity

Added 2026-09-14, in response to the area manager needing to see the exact
computed breakdown (and specifically the VAT-on-delivery-fee reclaim, the
one formula in this system people ask about most) *before* committing to
send a batch to the Deputy — the CSV upload flow originally only showed
per-row validity status (valid/missing/not-found), never the resulting
`netCashOwed`/breakdown, so the area manager was approving numbers blind.

`actionBulkSubmitAreaBatch_` now takes `req.dryRun: true` — runs every
validation and computes the real `breakdown`/`perLocation` exactly as a
real submission would (same `computeNet_`/`sumBreakdowns_` calls, same
per-location grouping), but returns `{ok:true, dryRun:true, batch:{...}}`
without a single `writeRow` call — no entries, no `area_bulk_batches` row,
no email to the Deputy. The client (`renderAreaBulkPreview`, index.html)
calls this automatically the moment every row parses as valid, renders the
result with the same `breakdownGrid`/`handoffDetailRows` the Deputy screen
uses (so the area manager reviews literally the same view the Deputy will
see, not a reconstruction of it), then shows the real Submit button only
after that preview renders. **Deliberately not computed client-side**: a
JS reimplementation of `computeNet_` could drift from the server's version
over time (e.g. if the VAT formula or a payment-method rule changes on the
server and someone forgets the client copy) — the dry run guarantees the
preview and the eventual real submission always come from the exact same
code path. `tests/run.js`'s dry-run section asserts both halves of that
guarantee: a dry run writes nothing (no entries, no batch), and a real
submission with the identical payload right after computes the identical
figure the dry run already showed.

### 11. Area-manager bulk upload: product-level CSV rows, not one flat row per source per day

Added 2026-09-15, in response to the area manager needing to see *what was
actually sold* (product description, qty, unit price, subtotal, VAT 15%),
not just a source's flat day-total — the original CSV format had one row
per source per day with separate `cashSales`/`deliveryFee`/`posSales`/
`creditSales` columns all on that one row, and an optional single `product`
column that didn't actually break the amount down by product at all.

**No backend change was needed.** `actionBulkSubmitAreaBatch_` already
accepted `productId`/`qty`/`unitPrice` per row (Collection.gs:576-599) —
the same shape `actionImportEntries_` uses for `renderEntries`'s product
mode, where one product/service line becomes one `daily_entries` row. The
whole rework is client-side: `downloadAreaBulkCsvTemplate_` and the CSV
parser in `renderAreaBulk` (index.html) now read
`date,locationName,sourceType,sourceName,product,qty,unitPrice,paymentMethod,cylindersOut,cylindersIn,note`
— **one row = one product/service line**, `subtotal = qty * unitPrice`,
routed to the one flat field matching `paymentMethod` (cash/pos/delivery/
credit), exactly mirroring the product-mode submit logic already in
`renderEntries` (index.html:1966-1977). Multiple lines for the same
source/day are just multiple CSV rows now, the same way multiple product
lines in the Entries screen become multiple entries.

Validation gained the same rules product mode already enforces in the
regular Entries screen, applied per row: product must resolve
(`resolveProductByName_`), `qty > 0`, `unitPrice > 0`, `paymentMethod` one
of cash/pos/delivery/credit, and — matching `lineProductOptionsHtml_`'s
dropdown filtering exactly — a `delivery` payment method is rejected
outright for a `store` source and requires the resolved product's
`type === 'services'`. `deliveryNeedsSale_`'s batch-wide sibling-sale check
(Collection.gs:109) still applies unchanged: a delivery line still needs a
cash/pos/credit line for the same source+date somewhere in the batch (or
already on file), same rule flat-amount rows always followed — it's
evaluated per-row regardless of how many rows share a source/day now.

**The VAT-15% "deep detail" the area manager asked for is a client-side
display concern only, computed from the batch's own validated rows in the
dry-run preview (`productBreakdownBlock_`, index.html) — it does NOT feed
`computeNet_` and cannot change `netCashOwed`.** It groups the batch's rows
by product and shows qty/subtotal/base-excl-VAT/VAT-amount per product,
treating every line's price as VAT-inclusive (the normal Saudi retail-price
convention) and extracting `base = subtotal / (1 + vatRate)`. This is
deliberately informational for **every** product, goods included — the one
VAT figure that actually changes `netCashOwed` is still only the delivery
fee's VAT reclaim (`vatExplainBlock_`, unchanged, using the server's own
`b.deliveryFee`), per "The formula" above. A goods line's price simply
isn't VAT-adjusted anywhere in `computeNet_`, same as it never was before
this change — this rework only adds a transparency display, it never
touches the underlying cash formula.

`tests/mock-backend-server.js` seeds two products (`LPG Cylinder 12kg`,
type `goods`; `Delivery Fee`, type `services`) specifically so the area-bulk
product-level format has something real to resolve against — it previously
seeded none at all. `tests/run.js` gained a section proving the backend
action really does carry `productId`/`qty`/`unitPrice` through end to end
for the area-bulk path (it already did for the single-location product-mode
path), plus that the sibling-sale rule for delivery lines still works
batch-wide when the sale and the delivery fee are split across separate
product lines for the same source/date.

## Deliberately out of scope for this build

- No PWA/offline install or custom subdomain
- No free-form peer-to-peer transfers outside the defined chain
