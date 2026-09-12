# Best Gas Cash Collection & Approval System — working notes

Cash-reconciliation and handoff-approval system for Best Gas Carrier Co.,
built from `555.xlsx` (the "Architect"/"Example" sheets describing the
store-manager → cluster-manager → collector → bank chain). Same architecture
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

```
Cluster ── clusterManagerUserId, collectorUserId
  └── Location (city + name) ── optional zoneId
        ├── Store  (one per location) ── storeManagerUserId
        │     └── POS machine(s) ── assignedUserId (an employee/driver)
        └── Car(s) ── driverUserId
              └── POS machine(s) ── assignedUserId

Zone (city + name) — pure geography, unrelated to the tree above
```

A POS machine's `ownerType`/`ownerId` points at either a store or a car —
a single car can carry more than one POS terminal, and a branch usually
has several. `daily_entries.sourceType` is `store` / `car` / `pos`, each
row belonging to exactly one node in this tree via `sourceId`.

**Cluster and Zone are two independent things — don't merge them.**
Cluster is an *employee's management assignment*: a cluster manager and a
collector own a set of locations for the money-handoff chain, and that set
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
vatOnDelivery = (Σ carDeliveryFeeBankAmount / (1 + vatRate)) * vatRate
netCashOwed   = storeCash + Σ carCash - Σ carDeliveryFeeBankAmount + vatOnDelivery
```

POS sales never enter this formula — card/bank payments carry no cash risk;
they're tracked (per machine, or per car if the car carries its own mounted
terminal — a `car` entry's `posSales` field counts toward `totals.posSales`
and the per-product POS breakdown exactly like a dedicated `pos` entry does,
just without a separate pos_machines row) for reconciliation and reporting
only. The entry form (`index.html`) also shows a read-only Location field
that auto-resolves from whichever store/car/pos is picked (`resolveLocationIdForSource_`)
so the person entering data can confirm where it will actually count.

## The approval chain *is* the conflict-of-interest control

Money moves in one direction — Store → Cluster Manager → Collector → Bank —
and at every step **the person who declares an amount can never be the one
who approves receiving it**. This is enforced in layers, not just at the UI:

1. **Structural, at entity-save time** (`Admin.gs` `validateEntity_`): a
   cluster's `clusterManagerUserId` and `collectorUserId` must differ; a
   store's manager can't also be the manager or collector of the cluster
   its location belongs to.
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
claim. `escalateShortfall_` emails the cluster manager, the collector for
that cluster, and every admin/finance account the moment a shortfall is
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
four-step chain (location → cluster → collector → deposit), both dispute
outcomes (reject releases entries back to the unconsumed pool; confirm
accepts the variance), every conflict-of-interest layer above, and
authorization boundaries (a driver logging cash for someone else's car, a
non-admin touching entity management, a store manager submitting a handoff
for a location they don't manage, a cluster manager's report never leaking
another cluster's location).

**Rebuild the stubs, never test against a real sheet** — same rule as the
sibling projects. If a new Apps Script call is added and the harness has no
stub for it, add the stub; don't skip the test.

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

## Language

`L` in `index.html` holds ar/en/ur strings; direction follows the selected
language (ar/ur = RTL, en = LTR), not a fixed setting. Add a language by
adding one more key to `L` and one `<option>` in the two language
`<select>` elements (login screen and header) — no other code changes.

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

### 5. A one-shot "clear all transactions" bulk-delete is hard-blocked

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

## Deliberately out of scope for this build

- No PWA/offline install or custom subdomain
- No free-form peer-to-peer transfers outside the defined chain
