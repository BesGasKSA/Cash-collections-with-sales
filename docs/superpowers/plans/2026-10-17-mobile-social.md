# Mobile app redesign: Instagram / Snapchat / Facebook patterns — plan

**Ask (the user, 2026-10-17):** "Redesign the mobile app to be like Snapchat, Facebook and Instagram, using all the skills available and the reverse-engineering method." The same app, the same data and rules: only the phone experience (≤ 768px) changes. Desktop keeps its sidebar layout.

**Method:** use the reverse-engineering skill on the three apps' public UI patterns (screenshots, design write-ups, Material/Apple HIG parallels) and record, per pattern, what it is, why it works and how it maps here. Use ui-ux-pro-max, motion-system, color-system, data-visualization, accessibility-audit, aesthetic-usability, verification-before-completion. Brand stays: green #4D6D51, cream #F2EEE4, the logo.

## Patterns to bring over, mapped to this app
1. **Bottom tab bar (Instagram/Facebook):** 5 icons with labels, role-aware: Home, Handovers (or Entries for a branch), a centre **+ create** button (new entry / send / deposit — what this role does most), Collections or Reports, and Profile/More (the rest of the menu as a sheet). Active tab: filled icon + dot; badges for what waits. Safe-area aware, hides on scroll down, shows on scroll up.
2. **Stories row (Instagram/Snapchat):** a horizontal row of circles at the top of Home — one per thing waiting on the person (pendingActions kinds: to receive, to validate, returned, deposit due, disputes…) with a coloured ring for unseen/urgent and a count. Tapping opens a full-screen **story viewer**: one card per item (amount, branch, who, age, the action buttons), tap right/left to move, swipe down to close, progress bars on top, auto-advance off (money needs a decision).
3. **Feed (Facebook/Instagram):** Home's body becomes a vertical feed of cards: the key figures card, the cash-flow story of the day, recent handovers as posts (avatar of the sender, "sent 3,200 to Mazen · 2 h", status chip, tap to open, long-press for quick actions), deposits with the slip photo as the post image, milestones ("all of Riyadh banked today"). Pull-to-refresh with a branded spinner; skeleton cards while loading; infinite "load more".
4. **Snapchat-style camera entry for slips:** the deposit and الموازنة slip capture opens a full-screen camera-first sheet (big shutter, gallery thumb, flash toggle where supported) — reuse the slip upload flow being built on branch `deposit-slip` (merge main first; coordinate, do not duplicate its server code).
5. **Bottom sheets everywhere (all three):** filters, menus, confirmations and pickers open as draggable sheets with a grab handle, snap points (half/full), swipe-down to close, backdrop dim — replacing centred dialogs on phones. The existing dropdown/date picker already use a bottom sheet on phones: unify the look.
6. **Profile screen (Instagram):** avatar + name + role, three counters (sent / received / banked this month), and a grid of the person's recent handovers or entries; settings and language inside.
7. **Gestures and haptics:** swipe a handover card left/right to reveal quick actions (receive / report a problem) where the role allows; double-tap is NOT used for money; `navigator.vibrate` short ticks on success where supported.
8. **Notifications:** an activity screen like Instagram's (today / this week / earlier), grouped, with avatars and the action inline — replaces the popup on phones (keeps the bell's data source `myPendingActions`).
9. **Motion:** shared-element style transitions between a card and its detail (FLIP with transform/opacity), tab switches that cross-fade and slide 8px, ripple/press scale 0.97, story ring rotation on load; all off under prefers-reduced-motion.

## Rules
- Phones only (≤ 768px); tablets/desktop unchanged. No server change unless a field is truly missing.
- Every role keeps exactly the screens and actions it has now (navItemsForRole_ stays the source of truth); nothing new is allowed that the server would refuse.
- Every string in ar/en/ur; RTL mirrors (tab order, swipe directions, story navigation).
- Tap targets ≥ 44px, contrast AA, focus visible, screen-reader labels on icon-only buttons.
- No bare `<tr>` through `el()`; compound `.card.x` selectors; `fillTemplate_`/`colFill_` for repeated placeholders.
- Performance: no layout thrash on scroll (passive listeners, transform-only), images lazy.

## Steps
- [ ] Reverse-engineering notes (patterns table) in the report.
- [ ] Shell: bottom tab bar + More sheet + hide-on-scroll; role-aware create button.
- [ ] Home: stories row + story viewer; feed cards; pull-to-refresh.
- [ ] Bottom-sheet component; move phone dialogs/filters onto it.
- [ ] Activity (notifications) screen; profile screen.
- [ ] Gestures, haptics, motion.
- [ ] Browser check on the mock server at 390×844 as admin, collector, area manager, branch manager, driver, deputy; en/ar/ur; screenshots before/after; no console errors.
- [ ] `TZ=UTC node tests/run.js` green; commit; report `docs/superpowers/plans/2026-10-17-mobile-social-report.md`.
