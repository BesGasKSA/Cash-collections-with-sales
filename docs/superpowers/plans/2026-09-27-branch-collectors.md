# Branch Collectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link each collector to branches (locations) instead of areas (clusters), so one area can have several collectors and each area-manager request for a branch goes to that branch's collector.

**Architecture:** `location.collectorUserId` becomes the collector link; `branchCollector_(locationId)` resolves it, falling back to the legacy `cluster.collectorUserId` for rows saved before this change. The area manager's `cluster_to_collector` request is created per branch (one handoff per branch, `locationId` set), each still validated by the Deputy Operations Manager before its collector sees it. The area-bulk batch approval splits the same way.

**Tech Stack:** Google Apps Script (Code.gs, Admin.gs, Collection.gs), single-file client `index.html`, Node test harness `tests/run.js` + `tests/stub-harness.js`.

**Spec:** the user's request of 2026-09-27 ("link the collector to the branches directly instead of the areas ... every area manager request based on the branch level will send to specific collector") and the design stated in chat the same day.

## Global Constraints

- Arabic-first UI; every new string in ar / en / ur.
- One person, one area: a collector's branches all sit in one area; an area manager is never a collector.
- Nothing already handed over changes: in-flight guards stay, scoped to the branch for collector changes.
- Every area-manager → collector handoff is validated by the deputy (`pending_deputy`) before the collector sees it.
- Legacy rows keep working: a branch with no own collector uses its area's collector.

## Review Focus

- A branch saved in an area that has no legacy collector and no branch collector must be refused (`collector_required`), or its cash has nowhere to go.
- An area with two branches and two collectors: one request per branch, each to its own collector; collector B cannot confirm branch A's request (`receiver_only`).
- A collector moved from branch A to branch B while A's request is pending must be refused (`person_holds_cash`).
- Sending one branch must not sweep another branch's ready cash into the same request.
- CSV batch spanning two branches with two collectors must produce two handoffs, entries consumed by their own branch's handoff.

---

### Task 1: Collector on the branch (validation + resolution)

**Files:** Modify `Admin.gs` (`validateEntity_` location/cluster/store branches, `userAssignments_`, `inFlightError_`), `Collection.gs` (new `branchCollector_`), Test `tests/run.js`.

**Interfaces:** Produces `branchCollector_(locationId) -> userId|null` (location's `collectorUserId`, else its cluster's legacy `collectorUserId`).

- [ ] Write failing tests: area saves with only a manager; a branch without a collector in such an area → `collector_required`; branch with collector A saves; collector A on a branch of another area → `user_in_other_area`; a store manager equal to the branch collector → `conflict_of_interest`.
- [ ] Run `node tests/run.js` — expect those checks to FAIL.
- [ ] Implement: location requires an effective collector; collector role check; collector not an area manager anywhere, not a legacy area collector of another area, not collector of a branch in another area; cluster no longer requires a collector (keeps legacy value if present, still unique); store conflict uses `branchCollector_`.
- [ ] Run tests — PASS; commit.

### Task 2: Per-branch requests from the area manager

**Files:** Modify `Collection.gs` (`createClusterHandoff_`), Test `tests/run.js`.

**Interfaces:** `createHandoff({kind:'cluster_to_collector', clusterId, locationId?})` → `{ok, handoff, handoffs:[...]}`; each handoff has `locationId`, `toUserId = branchCollector_(locationId)`, `status:'pending_deputy'`.

- [ ] Failing tests: two branches, two collectors, both branch days confirmed by the area manager; send branch A only → one handoff to collector A with A's amount; send the rest → one handoff to collector B; deputy validates both; collector B confirming A → `receiver_only`; each collector confirms their own.
- [ ] Run — FAIL.
- [ ] Implement: group ready cash (confirmed `location_to_cluster` + area manager's own open entries) by branch; `req.locationId` limits to one branch; one handoff per branch with ready net > 0; `no_collector` if a branch has none.
- [ ] Run — PASS; commit.

### Task 3: CSV batch approval split per branch; escalation recipients

**Files:** Modify `Collection.gs` (`actionDeputyApproveBatch_`, the four `escalate*_` functions), Test `tests/run.js`.

- [ ] Failing test: batch spanning two branches with two collectors → deputy approval returns two handoffs, each to its branch collector, entries consumed by their own branch's handoff.
- [ ] Run — FAIL.
- [ ] Implement: one `pending` handoff per `perLocation` row; `batch.resultHandoffIds`; escalations add `collectorForHandoff_(h)`.
- [ ] Run — PASS; commit.

### Task 4: Client

**Files:** Modify `index.html`.

- [ ] Location spec: `collectorUserId` field (collectors only), column; required star. Cluster spec: no collector field; columns show branches.
- [ ] Area card: one row per branch with ready cash — branch, collector, amount, send button — plus "send all ready branches"; waiting/returned per branch.
- [ ] Org panel, chain health (`gap_branchCollector`), relations (location → collector; cluster → collectors), handoff card shows the branch, rules text (`rule_oneArea`), i18n ar/en/ur.
- [ ] Verify in the browser as area manager, deputy, both collectors, admin.

### Task 5: Docs, full suite, publish

- [ ] CLAUDE.md entity hierarchy + approval section; full `node tests/run.js`; obfuscate, stamp, push, clasp deploy, live ping.
