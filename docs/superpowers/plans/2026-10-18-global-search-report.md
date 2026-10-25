# Search everything: report (2026-10-18, finished 2026-10-25)

Branch `global-search`, worktree `app-search`. Not pushed, not deployed.

## 1. Evidence: how search works in a web notes app (REA)

### Target

- **First choice, Standard Notes** (`app.standardnotes.com`; works without an account).
  `rea analyze-web-bundle` ran out of memory twice, at a 4 GB and then a 14 GB Node heap,
  after 45 minutes. No evidence came out of it, so it was dropped.
- **Used instead: TiddlyWiki 5.4.1** (`tiddlywiki.com`), "a non-linear personal web
  notebook". It is public, needs no sign-in, and its search runs entirely in the page.
  Nothing was signed into and nothing was written to the site.

### REA runs (own headless Chrome, own CDP port)

| Step | Command | Evidence id | Result |
|---|---|---|---|
| Bundle | `rea analyze-web-bundle` | `ev_c09cefd5…7663042` | 1 script captured (boot, 25,449 bytes). The 377 core modules are evaluated from the page's tiddler store, so CDP never reports them as page scripts |
| Page | `rea inspect-web-page --include-script-sources` | `ev_3f9bd928…33e581` | same one script |
| Export | `rea export-web-scripts` | `ev_0f3661eb…f80f401` | `tw-export/files/isolated/source-1-93dcae….js` + `manifest.json` |
| Modules | read-only `Runtime.evaluate` of `$tw.wiki` (types `application/javascript`) written as files | n/a | 377 modules, `tw-src/` |
| App | `rea analyze-javascript-application tw-src` | `ev_d3aa51ac…05fccf6a` | 378 files parsed, 205,817 AST nodes, 1,251 findings, 0 parse failures |
| UI | read-only dump of the wikitext and config tiddlers behind search | n/a | `tw-ui/` (index.json) |

Paths are under the session scratchpad, `…/scratchpad/rea/`: `tw-bundle.json`,
`tw-page.json`, `tw-export.json`, `tw-app.json` (172 MB), `tw-src/`, `tw-ui/`.
`trace-application-feature` needs the whole Evidence record inline, and at 172 MB that was
not practical. So the search path was followed by reading the files REA parsed.

### What the shipped code does

The facts below are **observed** in the shipped code. The quotes are short excerpts only.

- **Tokenising and matching:** `core/modules/wiki.js`, `exports.search(text, options)`.
  - **Modes:** `literal`, `whitespace`, `regexp`, `some`, and the default `words`. Its doc comment says words mode "matches if all tokens are found, regardless of adjacency or ordering".
  - **Words mode:** the query is split on whitespace (`text.split(/[^\S\xA0]+/)`). Each term becomes its own case-insensitive regexp (flag `"i"`, or `"^"` when `anchored`), and a tiddler matches only when every regexp is found in some field.
  - **Fields searched:** title, tags and text by default.
- **Filter operator:** `core/modules/filters/search.js`, `exports.search`. It maps suffix flags (`some`, `literal`, `anchored`, `words`, a field list) onto those options.
- **Ranking:** none by score. `$:/core/ui/DefaultSearchResultList` shows two groups, "Title matches" before "All matches":
  - `first-search-filter` = `[!is[system]search:title<userInput>sort[title]limit[250]]`
  - `second-search-filter` = `[!is[system]search<userInput>sort[title]limit[250]]`

  So the ranking is title hits first, then alphabetical, capped at 250 per group.
- **As-you-type and debounce:** results are driven straight from the input tiddler (`$:/temp/search/input`), with `filterMinLength={{$:/config/Search/MinLength}}` set to **3**. Below that, a "too short" message shows. No debounce: the word "debounce" appears only in `widgets/scrollable.js`. This was a bounded search over all 377 modules.
- **Keyboard:** the `$:/core/macros/keyboard-driven-input` procedure wraps the input in a `<$keyboard>` widget. The shortcuts are:
  - `input-up` = Up and `input-down` = Down move a selection (`selectionStateTitle`) through both result groups.
  - `input-accept` = Enter opens the selected item, and `input-accept-variant` = ctrl-Enter is its variant.
  - `input-cancel` = Escape clears the search.
- **Global shortcuts:** `$:/config/shortcuts/sidebar-search` = `ctrl-shift-F` focuses the sidebar box (`tm-focus-selector .tc-search input`). `advanced-search` = `ctrl-shift-A`, and `alt-Enter` opens Advanced Search.
- **Filters, chips and tabs:** result lists are tabs tagged `$:/tags/SearchResults`, with `set-next-input-tab` and `change-input-tab` cycling them from the keyboard. Advanced Search has Standard, System, Shadows and Filter tabs.
- **Highlighting:** none in the sidebar results. This was a bounded check of the result templates. Highlighting exists only in the separate `dynannotate` plugin.
- **Recent searches:** none were found in the core (bounded). The current query is kept in `$:/temp/search` only.
- **Diacritics and normalisation:** none. Matching is a case-insensitive regexp only, so Arabic hamza, ta marbuta or diacritic variants would not match each other.

### What we took, and what we changed on purpose

| Notes app (observed) | Cash app (design choice) |
|---|---|
| words mode: every token must match, any order | same: every query word must be found (`gsTextScore_`) |
| case-insensitive regexp, no normalisation | `normalizeName_`: alef, ya, ta marbuta, hamza seats, diacritics, tatweel, case. Arabic digits are read as digits |
| title group before body group, then A–Z | a score: exact 100, prefix 80, word start 60, inside 35. Numbers: exact 100, same sequence with or without the prefix 95, tail 92. Amount within ±0.01 is 85. Groups by type, newest first on ties |
| no debounce, minimum 3 characters | 220 ms debounce, a later answer always wins (sequence number), answers cached per query and type, no minimum length (a transaction's short number like `45` is a real query) |
| Up/Down/Enter/Esc via `keyboard-driven-input` | same keys, plus Ctrl+Home/End, `aria-activedescendant` on a combobox/listbox |
| ctrl-shift-F focuses the search | Ctrl/Cmd+K toggles the palette, `/` opens it when no field has focus, plus a top-bar search icon |
| result tabs per kind | a chip row per type with counts. A chip asks the server for more of that type |
| no highlight | the matched part is wrapped in `<mark>`, mapped back letter by letter through the same normalisation |
| no recent searches | the last 8 queries per person and device (`localStorage bgc_gsRecent_<userId>`) |

## 2. What was built

- **Server** (`Collection.gs`, end): `actionGlobalSearch_({q, types, limit})`, route `globalSearch` (`Code.gs`), read-only. It is not in the response cache.
  - **Scope uses the screens' own functions.** To make that possible, `actionListEntries_` and `actionListHandoffs_` were refactored onto `entriesScope_(user)` and `handoffsScope_(user)`. Their behaviour is unchanged.
    - **Entries:** `entriesScope_`.
    - **Handovers and deposits:** `handoffsScope_`, plus the area requests `collectionsScope_` lets the person follow. A collector's "holder" comes from `followRequest_`.
    - **Customers:** only for company-wide roles, as the Customers screen is.
    - **Places:** inside their own reach. That is all for company-wide roles, the areas from `clusterManagerOwnsCluster_` (so the active area applies), a collector's `branchCollector_` branches, and a branch manager's or driver's own branch.
    - **Products:** admin and finance.
    - **Users:** admin only.
  - **What is matched:**
    - **Entries:** txNo, the customer code, branch, city, source, customer, the person who entered it, and the amounts. One hit is returned per numbered day.
    - **Handovers:** number, people, area, branch and amounts.
    - **Deposits:** the number. The bank reference is matched and returned only to company-wide roles or the depositor, as Collections already does.
    - **Latin names:** match through the `translations` sheet.
- **Client** (`index.html`):
  - `gsOpen_`, `gsRender_`, `gsKey_`, `gsHighlight_`, `gsGo_` and their helpers. The styles are self-contained `.gs-*` rules, with compound selectors where they override.
  - The server's `globalSearch` is added to `READ_ACTIONS`.
  - Every string is in ar, en and ur (`gs_*`).
  - **Phone:** a full-screen sheet.
  - **Desktop:** a centred palette.
  - **Opening a result:**
    - an entry opens its transaction document;
    - a handover or deposit opens its document, and an area request outside the person's handovers opens Collections;
    - a customer opens the Customers page;
    - a product, user, branch, area or city opens its admin profile for admin and finance. Anyone else gets that place's days in the shared pivot drawer.
- **Tests** (`tests/run.js`, "global search", written first and seen failing):
  - Arabic variants (hamza and ta marbuta, diacritics), and a Latin name through translations.
  - A txNo with the prefix, without it, without separators, and its short number.
  - An exact number ranks first.
  - Amounts: `1,234.50`, `1234.51` and Arabic digits match; three cents off does not.
  - A deposit by its bank reference.
  - Type filter.
  - Scope: an area manager never gets another area's entry, request, deposit or branch. A collector gets only his own request and no entries. A branch manager gets his branch only.
  - Client checks: READ_ACTIONS, highlight via `normName_`, the keys, no bare `<tr>`, strings in three languages.

## 3. Checks

- `TZ=UTC node tests/run.js`: **3086 passed, 0 failed** (after merging main `b4d2376`).
- Browser check on the mock server (`node tests/mock-backend-server.js 8925`, own headless Chrome):
  - **Runs:** en, ar and ur, each at 390×844 and 1280×860, signed in as the test-only admin account.
  - **Opening:** the phone opened from the top-bar icon, the desktop with Ctrl+K. Focus landed in the field each time.
  - **Results:**
    - "DAY" returned 4 entries with the prefix marked.
    - ArrowDown moved the selection.
    - "malaz" found the branch.
    - "1850" found the entry with the amount marked.
  - **Enter:** closed the palette and opened the entry's document drawer.
  - **Layout:** no horizontal scroll at 390px.
  - **Errors:** no JavaScript exceptions or `console.error`. The only log errors are the existing warm-up `GET /api` (`warmUp_`), which the mock server does not serve.
- Both servers I started (mock 8925, Chrome 9461) were stopped afterwards.

## 4. Review fixes (2026-10-25)

- Sign-out resets the palette (`gsReset_` in `logout()`): the overlay is removed at once, the query, answers and cache are forgotten. Cached answers are keyed by person, active area and type (`gsKeyOf_`), and any successful write empties the cache. Checked in headless Chrome: admin searches, signs out with the palette open, the sign-in page has no overlay, the next person opens an empty palette.
- A Collections-only request is found only when `followRequest_` follows it (a voided or cut-over one is not), for every role.
- A branch manager or driver also reaches the branch of a POS they hold.
- Tab and Shift+Tab stay inside the palette; Esc closes it from any element in it.
- An entry whose full row is not available says so instead of opening an empty document.
- Area and collector lookups are worked out once per request (`entriesScope_` too).
- Tests: 3093 passed, 0 failed.

## 5. Concerns

- **No server index.** Each search reads entries, handovers, users, places and translations. They come from the per-request sheet memo and CacheService, but a large `daily_entries` sheet scanned per keystroke (after the 220 ms debounce) costs Apps Script time. If it is slow live, cache a compact search index per data version.
- **Entry amounts:** only the gross figure and its parts are matched. The net to hand over is not, because it would need `computeNet_` per entry.
- **Area managers' Collections path:** a request outside their own handovers opens the Collections screen, not the request itself. `colOpenDoc_` only opens handovers the person is part of.
- **Not rebuilt:** `index.protected.html` and `version.json` are untouched. Run the build step when merging.
- **Shared browser pane:** early on (2026-10-19), before the instruction to use only my own tabs, the shared browser pane's existing tab was pointed at my mock server once. Its buffer also showed failed requests to `localhost:8923`, which may be another session's tab. Every check after that ran in my own headless Chrome.
