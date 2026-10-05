# Returned Area Handover: Correct and Send Again — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the Deputy Operations Manager returns an area manager's handover to the collector ("returned for correction"), the area manager corrects it from the returned request itself and sends it back to the deputy as a new version that carries the history, the reason and what changed.

**Architecture:** Nothing is edited in place (CLAUDE.md "Locking"). The returned handoff stays `returned`; the resend is a new `cluster_to_collector` handoff opened `pending_deputy` by `createClusterHandoff_` with `resubmitOf` = the returned id, `revision` = old + 1, `correctionNote`, and `history` (each earlier version: amount, perLocation lines, reason, returned by/at). The returned row gets `resubmittedAs`. The area manager's own entries are corrected the existing way (void with a reason + a new entry); this plan adds the screen that leads there and the link between versions.

**Tech Stack:** Apps Script `.gs`, one-file client `index.html` (ar/en/ur), Node tests `tests/run.js` + `tests/stub-harness.js`.

**Spec:** the user, 2026-10-05: "when the deputy sent the request back to the area manager please enable the area manager to be able to edit on the request and send it back to the deputy again." CLAUDE.md sections "Collectors belong to branches" (per-branch requests, `createClusterHandoff_`), "Locking and the approval matrix" (deputy validate/return), "A rejected area batch is corrected, not rebuilt" (the same idea for batches: revision, history).

## Global Constraints

- No entry or handover row is edited or deleted; a correction is a void with a reason plus a new row.
- Only the returned request's own area manager (its `fromUserId`), or an admin standing in, may resend it; nobody resends a request twice (`already_resubmitted`); only a `returned` request can be resent (`not_returned`).
- A resend still opens `pending_deputy` and goes through the deputy, who sees the version and the reason; the deputy may never be a party (existing `deputyHandoffGuard_`).
- Per-branch requests stay per branch (one handoff per branch since 2026-09-27); a returned branch request is resent for that branch.
- Every new string in ar, en and ur; every refusal its own code with three messages in `ERROR_KEYS_`.
- Never a bare `<tr>` through `el()`; compound `.card.x` selectors; `fillTemplate_` for repeated placeholders.
- Tests use made-up names only.

## Review Focus

1. Resending after the area manager voided one of his own entries in that branch: the new amount excludes the voided entry and includes its replacement; the old version keeps its old amount.
2. A resend where the branch now nets to zero or less: refused `nothing_ready` (nothing to send), the returned request stays resendable.
3. The deputy returns version 2 again: version 3 carries both earlier versions in `history`.
4. An unrelated new request for the same branch sent normally (not as a resend) while a returned one exists: allowed, and the returned one then can't be resent (`superseded`) because its cash went in the new one.
5. A collector who changed since the return: the resend goes to the branch's current collector (`branchCollector_`), shown on the screen.

---

### Task 1: Server — resend a returned request as its next version

**Files:** `Collection.gs` (`createClusterHandoff_` ~line 1070; `actionDeputyReturnHandoff_` ~1710; a new `resubmitInfo_`), `Code.gs` (route nothing new: the resend goes through `createHandoff` with `resubmitOf`), `index.html` `ERROR_KEYS_` messages only, `tests/run.js` new section `--- a returned area request is corrected and sent again ---` next to the existing deputy validate/return tests (grep `deputyReturnHandoff` in run.js).

**Interfaces:**
- `createHandoff {kind:'cluster_to_collector', clusterId, locationId, resubmitOf, correctionNote}` → `{ok, handoff, handoffs}`; `resubmitOf` requires `locationId` equal to the returned request's `locationId` (or, for an old request without `locationId`, none); `correctionNote` required (1..1000 chars) with `resubmitOf`.
- New handoff fields: `resubmitOf`, `revision` (returned's `revision || 1` + 1), `correctionNote`, `history: [{revision, amount, perLocation, returnReason, returnedBy, returnedAt, correctionNote}]` (the returned one's own history + itself).
- Returned handoff gains `resubmittedAs` (new id) — the only field written on it; status stays `returned`.
- Errors: `not_returned`, `already_resubmitted`, `superseded` (the returned one's branch handovers/entries are already consumed by another request), `note_required`, `nothing_ready` (existing behaviour when the branch nets ≤ 0 — reuse its code if one exists, else add), `forbidden`.
- When a normal (non-resend) request consumes the cash a returned one released, mark that returned one `supersededBy` so the screen stops offering the resend.

- [ ] Tests first (made-up area, branch, collector, deputy, area manager; reuse the run.js helpers already used by the deputy return tests): area manager enters an own entry (cash 1000) at the branch, sends → `pending_deputy`; deputy returns with reason "wrong amount" → status `returned`, cash released; resend without note → `note_required`; area manager voids his entry (reason "typo") and enters 900; resend with `resubmitOf`, note "corrected to 900" → ok, new handoff `pending_deputy`, amount 900, `revision` 2, `history[0].amount` 1000 and `history[0].returnReason` "wrong amount"; returned row has `resubmittedAs` and still `returned` with amount 1000; resend the same again → `already_resubmitted`; deputy returns v2 → resend v3 → `history.length` 2; a second area manager → `forbidden`; deputy validates v3 → `pending` to the collector as before; Review-focus tests 2, 4, 5.
- [ ] Run `node tests/run.js` → the new checks fail.
- [ ] Implement in `createClusterHandoff_`: when `req.resubmitOf` is set, load it (`getById_(SHEETS.HANDOFFS, …)`), check kind/status/fromUserId (or admin), `resubmittedAs`, `supersededBy`, branch match, note; then build the branch request exactly as the normal path does for that `locationId`, add the version fields, write it, set `resubmittedAs` on the old one, audit `area_handoff_resubmit`, `notifyDeputyPendingHandoff_` (subject says it is a correction). In the normal path, after writing, mark any `returned` request of the same branch and area manager with no `resubmittedAs` as `supersededBy`.
- [ ] All green; commit "A returned area request is corrected and sent again as its next version".

### Task 2: Client — the correction screen and the deputy's view

**Files:** `index.html` (area card `paintArea_` ~12284; handoff card `handoffItem` ~12015; deputy screen `renderDeputyReview` ~11731; `L` strings ar/en/ur), `tests/run.js` only if a pure client helper is added (load with `clientFn_`).

- [ ] On the area manager's handovers screen, a returned request (status `returned`, `fromUserId` = me, no `resubmittedAs`/`supersededBy`) shows a **«تصحيح وإعادة الإرسال / Correct and send again / درست کر کے دوبارہ بھیجیں»** button (also on the branch row of the area card where "returned" shows today). It opens a panel `#hoFix` inside that row:
  - the deputy's reason, who returned it and when, the version number, the original amount;
  - the branch's lines as the request carried them (`perLocation` / breakdown via `brkParts_` + `cashCalcRows_` — never a new copy of the formula);
  - the area manager's own open entries at that branch for the request's dates, each with **«إلغاء وتصحيح»**: asks the reason (prefilled "تصحيح بعد إعادة النائب: <reason>"), calls `voidEntries`, then opens the entry screen preset to that branch, source and date (reuse the entry screen's draft/preset mechanism; if none exists, set `state` fields the entry screen reads on open);
  - the amount the branch would send now (the same figure the area card shows), refreshed after any change;
  - a required note box «ما الذي صححته؟ / What did you correct? / آپ نے کیا درست کیا؟»;
  - **«إرسال إلى نائب مدير العمليات»** → `createHandoff` with `resubmitOf`, `locationId`, `correctionNote`; on success the row shows "version N sent to the deputy".
- [ ] The deputy's card (`renderDeputyReview` and the handover row) for a request with `revision > 1` shows a strip: «النسخة N — صُحّحت بعد: <last returnReason>», the area manager's note, and per branch the old amount → new amount; a «السجل / History» fold lists every earlier version (amount, reason, who, when, note).
- [ ] The handovers list shows a returned request that was resent as "returned · resent as version N" (no button), and one superseded as "returned · sent again in a new request".
- [ ] Browser check on the mock server (`node tests/mock-backend-server.js 8905`; restart it after backend edits): as area manager send → as deputy return → as area manager correct (void + re-enter) and resend → as deputy see version 2 with history → validate. Read the console for errors. Phone width 390px and desktop.
- [ ] `node tests/run.js` green; commit "Correct and send again: the returned request's screen and the deputy's view of versions".
