# Pending Actions: welcome popup, bell and home — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every user, on opening the app, sees a welcome popup listing every action waiting under their name, with one button per item that takes them to it; the bell and the home hero count exactly the same list.

**Architecture:** One server action `myPendingActions` builds the list for the signed-in user from data that already exists (handoffs, area batches, risk items, entries, chain gaps). The client shows it as a popup once per sign-in, uses its count for the bell (replacing the two hand-counted `setNotifCount(...)` sums), and lists it in the home hero instead of "Nothing needs your attention".

**Tech Stack:** Apps Script `.gs`, one-file client `index.html` (ar/en/ur), Node tests.

**Spec:** the user, 2026-10-05: "once the user opens, if he has any pending action under his name, a welcoming popup notification"; found while testing: home said "Nothing needs your attention" to an area manager whose request the deputy had returned.

## Global Constraints
- Read-only action: it changes nothing. Scoped exactly like the screens it points to (a person sees only what they may act on).
- Every string in ar, en and ur. No em dashes in copy. `fillTemplate_` for repeated placeholders.
- The popup is dismissable; it shows once per sign-in (`sessionStorage` key `bgc_pendShown_<userId>`), never again on every screen change; reduced motion respected.
- Made-up names in tests.

## The items (`kind`, who sees it, where the button goes)
| kind | who | condition | goes to |
|---|---|---|---|
| `confirm_receipt` | the handoff's `toUserId` | handoff `pending` | Handoffs, that row open |
| `deputy_validate` | deputy (or admin if no active deputy) | `cluster_to_collector` `pending_deputy` | Deputy approvals |
| `deputy_batch` | same | area batch `pending_deputy` | Deputy approvals |
| `returned_fix` | area manager (`fromUserId`) | handoff `returned`, no `resubmittedAs`/`supersededBy`, has `locationId` | Handoffs, correction panel open |
| `batch_rejected` | the batch's `uploadedBy` | batch `rejected`, not resubmitted | Area upload, "Correct and send again" |
| `send_ready` | area manager / branch manager | confirmed handoffs or own open entries ready to send (count + amount) | Handoffs |
| `car_handover` | driver | own open car entries not yet handed over | Handoffs |
| `dispute_open` | admin/finance (not a party) | handoff `disputed` | Handoffs |
| `second_approval` | admin/finance (not the confirmer) | `requiresSecondApproval` and not acknowledged | Handoffs |
| `deposit_due` | collector | confirmed collector cash not yet deposited (amount) | Handoffs, deposit form |
| `risk_high` | admin/finance | open `high` risk items | Risks |

Each item: `{kind, count, amount?, refId?, locationId?, since}`; the list is sorted oldest first within each kind, kinds in the table's order.

### Task 1: `myPendingActions` (server) + popup, bell and home (client)

**Files:** `Collection.gs` (new `actionMyPendingActions_` near the handoff readers), `Code.gs` (route `myPendingActions`; not in the response cache), `index.html` (popup `pendingPopup_`, `refreshNotifCount` uses the action, home hero list, strings), `tests/run.js` new section `--- every action waiting on a person is listed for them ---`.

- [ ] Tests first: build the cases with the run.js helpers (area manager whose request was returned → `returned_fix`; collector with a `pending` handoff → `confirm_receipt`; deputy with a `pending_deputy` request → `deputy_validate`; a rejected batch → `batch_rejected` for its uploader only; admin with a disputed handoff they are not party to → `dispute_open`; a party admin does not get it; a collector holding confirmed cash → `deposit_due` with its amount; a user with nothing → empty list). Assert counts, amounts and that nothing was written (sheet JSON before == after).
- [ ] Implement the action; route it; never cached.
- [ ] Client: after sign-in (and on reopening with a live session), call it once; if the list is not empty and not shown this sign-in, open a centered popup (bottom sheet on phones): greeting with the user's name, "You have N things waiting", one row per item (icon, sentence such as «طلب أعاده نائب مدير العمليات للتصحيح — فرع العليا» / "A request the deputy sent back for correction: Olaya", amount when there is one, a "Go" button). "Go" closes the popup and opens the target (for `returned_fix` open the area card's correction panel: set `FIX_OPEN_` to the handoff id before going to Handoffs). A "Later" button closes it. The bell count = the list's total; clicking the bell reopens the popup. The home hero lists the same items (up to 4, then "and N more") instead of "Nothing needs your attention", which shows only when the list is empty.
- [ ] Browser check on the mock server (port 8908): area manager with a returned request, deputy, collector, admin; 390px and desktop; no console errors.
- [ ] `node tests/run.js` green; commit.
