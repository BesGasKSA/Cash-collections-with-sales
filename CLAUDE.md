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
├── Collection.gs     entries, the handoff/confirm/dispute/deposit chain, reports
├── Admin.gs          user management + full CRUD over the entity hierarchy
├── tests/
│   ├── stub-harness.js   rebuilds SpreadsheetApp/PropertiesService/etc. under
│   │                      Node's vm module so the real .gs files run unmodified
│   └── run.js             end-to-end trial run — node tests/run.js
└── CLAUDE.md         this file
```

## Entity hierarchy

```
Cluster ── clusterManagerUserId, collectorUserId
  └── Location (city + name)
        ├── Store  (one per location) ── storeManagerUserId
        │     └── POS machine(s) ── assignedUserId (an employee/driver)
        └── Car(s) ── driverUserId
              └── POS machine(s) ── assignedUserId
```

A POS machine's `ownerType`/`ownerId` points at either a store or a car —
a single car can carry more than one POS terminal, and a branch usually
has several. `daily_entries.sourceType` is `store` / `car` / `pos`, each
row belonging to exactly one node in this tree via `sourceId`.

## The formula (from `555.xlsx`, verified by `tests/run.js` against the
Example sheet's own numbers)

```
vatOnDelivery = (Σ carDeliveryFeeBankAmount / (1 + vatRate)) * vatRate
netCashOwed   = storeCash + Σ carCash - Σ carDeliveryFeeBankAmount + vatOnDelivery
```

POS sales never enter this formula — card/bank payments carry no cash risk;
they're tracked (per machine) for reconciliation and reporting only.

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

## Testing

The `.gs` files are pure JS with Apps Script globals — `tests/stub-harness.js`
rebuilds those globals (`SpreadsheetApp`, `PropertiesService`, `CacheService`,
`LockService`, `Utilities`, `MailApp`, `DriveApp`, `ContentService`) as
in-memory fakes under Node's `vm` module, then loads the real `Code.gs` +
`Admin.gs` + `Collection.gs` unmodified into that context. `tests/run.js`
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
{"scriptId":"1IvXuVjao9KsxrXDgT8Z51QOpgTnUSWSNVWT08G5KFMMXLwz9_9IQEukD","rootDir":".","filePushOrder":["الرمز.js","Admin.js","Collection.js"]}
JSON
clasp pull                     # fetches الرمز.js / Admin.js / Collection.js / appsscript.json
# copy the updated content from this repo's Code.gs/Admin.gs/Collection.gs
# into the correspondingly-named pulled files, then:
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

## Deliberately out of scope for this build

- No client-side obfuscation / white-labeling of the Google backend (unlike
  `7777`, which hides that it's Apps Script — this system has no reason to)
- No PWA/offline install or custom subdomain
- No free-form peer-to-peer transfers outside the defined chain
