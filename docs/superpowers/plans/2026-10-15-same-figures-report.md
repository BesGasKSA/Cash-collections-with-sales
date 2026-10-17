# Same date, same figures: report (2026-10-15)

Branch `same-figures` (worktree `app-same`). Nothing pushed, deployed or run through clasp.
Skills used: systematic-debugging, test-driven-development, data-validation (the add-up-to-the-cent checks), verification-before-completion.

## The cause

Entries, the sales report and the dashboard's net filtered **entries by `date`**. The dashboard handover figures
(`filterHandoffs_`), Collections (`colCompute_`), the Handoffs filter, pivot and analysis, the collector pivot and
the Deputy screen filtered **handovers by `createdAt`**, which is the day the cash was handed over. Live data showed
the effect: on 13 Oct there were 216 entry lines (770,186.57 cash). 26 of them were handed over on the 13th and 190 on
the 14th.

## Inventory (before, then after)

| Screen | Figure | What it sums | Date field before | After |
|---|---|---|---|---|
| Entries | Net cash, sales, deductions | `entryAmt_` over the entries | entry `date` | entry `date`; now also Deposited, Remaining and where the cash is, from `cohortSum_` |
| Dashboard | Sales, card, direct, deductions, net | `report.totals` (computeNet_) | entry `date` | entry `date`, drawn from `report.cohort` as one top-to-bottom sum |
| Dashboard | Deposited / Remaining | collector deposits in the filtered handovers | handover `createdAt`, with deposits apportioned | the part of the period's entries that reached the bank (`entryCohort_`) |
| Dashboard | Held, pending, disputed, by hop, where is the cash | handovers | handover `createdAt` (`filterHandoffs_`) | `handoffDate` (`hoDay_`) |
| Dashboard | Held-cash trend | holding windows | real days (a timeline) | unchanged, a deliberate timeline |
| Handoffs | List filter, analysis tiles, by day, pivot "day" | handovers at every hop | `createdAt.slice(0,10)` (a UTC day) | `hoDay_(h)` |
| Collections | Handed over to collectors, Deposited, With collectors | area requests followed to the bank | request `createdAt` | `hoDay_(r)` (`handoffDate` from collectionsData) |
| Collector home / Handoffs | Collector pivot (to collect, held, deposited) | area requests | request `createdAt`; deposits by deposit date | request `hoDay_`; a deposit counts on its request's day |
| Deputy approvals | Request and batch date filter | requests, area batches | `createdAt` | `hoDay_` (batches now carry `handoffDate`) |
| Sales report | Net and every total | entries | entry `date` | unchanged; also returns `cohort` |
| Shortfall report | Shortfalls by entrant | hops in the filter | `createdAt` | `handoffDate` (through `filterHandoffs_`) |

## Browser check (mock server, 2026-10-13 and 2026-10-14)

Seeded: 13th branch 500; 14th car 300 (received 290) and branch 1,000; all sent on the 15th in one chain, received by
the collector and deposited (1,790).

| Screen (filter 14th) | Figure |
|---|---|
| Entries | Net cash to hand over 1,300.00 · Deposited 1,290.00 · Remaining 10.00 (received short 10) |
| Dashboard | Sales 1,300.00 − card 0 − direct 0 − deductions 0 + other 0 = Net 1,300.00 − Deposited 1,290.00 = Remaining 10.00 (short 10.00) |
| Sales report | Net cash to hand over 1,300.00 |
| Handoffs | 3 handovers, 3,870.00 over every hop (290 + 1,790 + 1,790); deposit 1,790.00 |
| Collections | Handed over to collectors 1,790.00 · Deposited 1,790.00 · With collectors 0.00 |
| Deputy | the request shows on the 14th, nothing on the 15th |
| Dashboard (filter 13th) | Net 500.00 − Deposited 500.00 = Remaining 0.00 |

Handoffs and Collections show 1,790 on the 14th because that handover carries the 13th's 500 too and counts on its
latest day; both screens say so in a note. en, ar and ur at 390 px and desktop: no horizontal scroll, no script errors.
The only console errors are the mock server's 404 on `GET /api` (it answers POST only) and Chrome's vibrate block.

## Tests

`TZ=UTC node tests/run.js`: 2705 passed, 0 failed. New blocks:
- "the same date gives the same figures on every screen": entries of the 12th and 13th handed over on the 14th with a
  car hop received short. Entries net = dashboard net; dashboard requests = Collections = Handoffs (request hop) =
  server date filter; the difference to Entries is exactly the labelled stages; the collector pivot and the batches
  follow the same day. It failed first (14 failures), then passed.
- "the key figures come from the entries of the period": five branches, one per stage, a deposit on the 14th, one
  short receipt. For the 13th: deposited 1,150 (not the deposit's 1,650), short 10, and 70 / 150 / 400 / 600 / 700 /
  800 by stage, adding up to the cent; the card lines add up to the net to the cent; the sales report and the Entries
  screen (`cohortSum_`) give the same figures.

## Left

- A handover that carries several days still counts on its latest day on Handoffs and Collections. Splitting it by
  entry date would make those screens match Entries exactly too, but it goes against the agreed rule.
- `listEntries` now runs `computeNet_` once per visible entry. That is fine for a few thousand rows; worth timing on live.
- `index.protected.html` was not rebuilt.

## Review fixes and drawers as pivots (2026-10-17)

- Cents shared by largest remainder: the cohort net equals the report net to the cent. Before the fix, three
  10.00 delivery fees gave 273.90 against 273.91.
- Settled area batches sit on their own line, outside Remaining. A receipt corrected down is scaled.
- The dashboard has one Deposited figure. Tile, statement and equation all drill by stage.
- Every dashboard drawer is a city > area > branch > source > day > transaction pivot.
- Browser check (mock, all dates and 2026-10-16), card vs drawer: Total sales 8,852.00 / 8,852.00, Net
  8,852.00 / 8,852.00, Deposited 1,790.00 / 1,790.00, Remaining 7,062.00 / 7,062.00, Branch to area
  7,052.00 / 7,052.00, Received short 10.00 / 10.00, Held 7,052.00 / 7,052.00, Deposits tile 1,790.00 /
  1,790.00. On the 16th: 1,300 / 1,290 / 10, every line equal to its drawer. Arabic at 390 px: no
  horizontal scroll. A transaction opens its document.
- Found while checking: a missing bracket stopped the whole page from starting, and the unit tests did not
  see it. Fixed, and `tests/run.js` now compiles the page's script.
- Main's comparison screen summed per-entry cents (121,482.90 against the report's 121,482.91). It now rounds
  once. It still has its own deposited rule, without the short scaling; moving it onto `cohortAlloc_` would
  make it match the key figures exactly.
