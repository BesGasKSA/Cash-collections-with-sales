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
