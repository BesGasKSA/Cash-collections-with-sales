# Mobile app redesign (Instagram / Snapchat / Facebook): report

Branch `mobile-social` (worktree `app-mob`). This covers phones only (≤ 768px); tablets and desktop are unchanged (checked at 1280px: the sidebar is shown, and no tab bar, stories, feed or activity sheet appear). There is no server change.

## Skills used
- **reverse-engineering**: benchmark mode on public UI material. See the patterns table below.
- **ui-ux-pro-max**: priorities applied were accessibility, then touch, then navigation (≤ 5 tabs), then motion. Its search script was not run because there is no Python on this machine, so its built-in priority table was used instead.
- **motion-system**: tokens `--ms-fast` 120ms, `--ms-norm` 200ms, `--ms-mod` 300ms and `--ms-slow` 420ms, with standard, decelerate, accelerate and spring easings. Exits are faster than entries. Staggers are 40–60ms. Everything is switched off under `prefers-reduced-motion`.
- **color-system**: brand green #4D6D51 and cream #F2EEE4 (cream on green is 5:1). Ring tones per kind are receive (green to gold), review (teal), send (green), bank (blue to green), fix (amber) and problem (rose). Rings are decorative only: a sentence always says what each item is.
- **aesthetic-usability**: one spacing and radius scale (16/18/22/26). Money decisions are never hidden behind the look: there is no auto-advance, no double-tap and no swipe that moves money.
- **accessibility-audit**: a JS scan found every new button at 44 × 44px or larger. Icon-only buttons carry `aria-label`. Dialogs use `aria-modal`. Focus moves into each sheet and returns to its opener. Focus outlines are visible. Toasts are `role=status` or `role=alert`. The bell's label carries the count.
- **data-visualization**: the profile has three month counters with share bars (one series, labelled and scaled from zero). The feed amount is a direct label, not a chart.
- **verification-before-completion**: the evidence is below.

## Reverse-engineering: patterns table (observed = public UI; mapped = here)
| Pattern (source) | Observed | Why it works | Mapped here |
|---|---|---|---|
| Bottom tab bar with centre create (Instagram, Facebook) | 5 icon+label tabs; filled icon + dot for active; centre "+" | Thumb reach; the one primary action is always one tap away | `msTabBar_`: Home, the role's list (Entries for a branch, else Handovers), **+**, Dashboard or Collections, Profile. Floating glass bar that hides on scroll down and returns on scroll up. Badges are cream on green |
| Create sheet (Instagram "+", Snapchat) | "+" opens a short chooser of what can be made | One entry point and no hunting | `msCreateActions_`: only the role's own forms (new day, send cash, deposit, validate, area upload, report a problem). Every item opens an existing screen or form |
| Stories row (Instagram, Snapchat) | Ringed circles at the top; a gradient ring means unseen | Shows what is new at a glance, by group | `msStoriesPaint_`: a "You" circle (create), then one circle per waiting kind from `myPendingActions` with a count. The ring is grey once seen (sessionStorage) and turns in once on load |
| Story viewer (Instagram, Snapchat) | Full screen, progress bars, tap sides to move, swipe down to close | Focus on one item at a time | `msStoryOpen_`: one card per waiting item (amount, place, age, one action). Side taps are mirrored in RTL. **No auto-advance**, because money needs a decision |
| Feed of posts (Facebook, Instagram) | Avatar + name + time header, media body, action row | A familiar way to read "what happened" | `msFeed_`: recent handovers as posts (sender → receiver, age, status chip, amount as the "media", slip tag). "Load more" in 8s. Skeleton cards while loading |
| Swipe actions (Instagram DMs, mail apps) | Swipe a row to reveal actions | Fast for repeat work | A post swipe shows Open, or Receive when it is addressed to you. Receive opens the existing confirm row, so no money moves on a swipe |
| Pull to refresh (all three) | Pull at the top, spinner, reload | Expected on phones | Home only. The brand emblem turns, then the screen redraws and `myPendingActions` is forced |
| Activity / notifications (Instagram) | Grouped list (New / Today / Earlier), avatars, inline action | Replaces modal alerts | `actOpen_`: bottom sheet with a grab handle, Now / Today / Earlier from `since`, ringed avatar per kind, amount chip, age, one verb button. "All caught up" pops with sparks |
| Brand badge (Instagram, Facebook) | Count badge on the bell/tab | Draws the eye without alarm | Cream on green with a white keyline. It pulses once when the count rises. The plain red is gone |
| Stacked toasts (iOS, Instagram) | Small cards under the top bar | Non-blocking feedback | `msToast_`: up to 3, newest first, icon circle, tap or flick up to dismiss, with a vibration tick |
| Bottom sheets (all three) | Grab handle, drag down, dimmed backdrop | Reachable and dismissable with one hand | `msSheet_` and `msSheetDrag_` serve create, profile and activity. The existing drawer, pickers and popups already became phone sheets earlier |
| Profile (Instagram) | Avatar, three counters, grid of posts | Self-summary at a glance | `msProfileOpen_`: avatar ring, name and role, Sent / Received / Banked this month (with counts and bars), a 3×3 grid of recent handovers, every screen of the role, language, sign out |
| Camera-first capture (Snapchat) | Full-screen camera, big shutter, gallery thumb, flash | Capture is the fastest way to attach | `msCamOpen_`: the slip field's camera and retake buttons open a full-screen camera (a live view where allowed, flash where the phone has a torch). The photo goes into `slipField_`'s own camera input and its change event fires, so the deposit-slip upload flow is unchanged |
| Motion (all three) | Spring pops, cross-fades, short slides | Spatial continuity | Tab switch fades and rises 8px, press scale .94–.97, ring turn, sheet rise, story card slide. Transform and opacity only, and all off under reduced motion |

Observed vs inferred: the rows above come from the apps' public screens and design write-ups (observed behaviour). How they map here is our own design. No assets were copied.

## What changed (index.html only)
- **Notifications** (commit b1fce01, published separately). On phones `pendOpen_` opens the activity sheet. `pendRow_` returns the activity row, so the home hero uses it too. `setNotifCount` pulses the brand badge and labels the bell. `showToast_` stacks toasts.
- **Shell, stories, feed, profile, camera** (commit 10c8ece). `renderShell` builds `msTabBar_` instead of `buildBottomSwitcher_` on phones, adds `#msStories` and the pull-to-refresh emblem above Home, and drawHome ends with `msFeed_`. The 701–768px range drops the tablet icon rail for the phone layout. Docked bars (`.e-dock`, the download bar) sit above the floating tab bar.
- `navItemsForRole_` is untouched and every tab, create item and profile tile comes from it. The deputy gets Validate and Report but no New day. The collector gets Deposit and Report. The driver and branch manager get New day, Send and Report. The admin gets New day, Deposit (via Handovers), Validate and Report.
- The collection-report functions were not edited.
- CSS lives in one block ("phone social layer") before `</style>`. Its selectors are prefixed `:root body` where they must beat the Facebook layer, and there are no bare single-class overrides of `.card`.

## Verification
- `TZ=UTC node tests/run.js`: 2866 passed, 0 failed after the notifications merge, and 2891 passed, 0 failed after merging main 222cd64. The inline-script compile test passed.
- Mock server on 8923 (test logins), with pending items seeded through the API (`createHandoff` area → collector, then `deputyValidateHandoff`).
- At 390×844 these were checked: admin, collector, area manager, branch manager, driver and deputy in en/ar/ur. For each, the tab labels, create-sheet items, stories, activity sheet, RTL direction and 44px targets were checked. The story viewer was checked in Arabic (bars and side taps mirror). The camera sheet ran with the camera blocked, so the fallback path was used. A synthetic photo went through "Use photo" into `slipField_`, which reported "Slip attached".
- No JS console errors. The only console errors were two 404s for `GET /api` (the app's warm-up ping, which the mock server does not serve; this happened before this work).
- Desktop at 1280px: sidebar present, and none of the phone layer appears.
- Screenshots are in `.superpowers/mobile/` (ignored by git): `before-deputy-en-home.jpg`, `before-deputy-en-notifications.jpg`, and `after-*` for admin, collector, area manager, branch manager, driver and deputy in en/ar/ur (activity, caught-up, toast, home, feed, story, create, profile).

## Concerns
- The shared Browser pane was being driven by other builders at the same time (tabs re-navigated to their servers), so some screenshots were retaken. A few show mid-animation frames.
- The live camera view and flash could not be exercised here because camera access is blocked in the pane. They need one check on a real phone.
- `ur` and `ar` names show the mock's `UR:`/`AR:` translation prefixes. That is mock data, not this change.
- The hero's waiting list is hidden on phones because the stories row and the activity sheet replace it. The hero still shows the count and "View all".
- The profile counters are computed client-side from `listHandoffs` (this month by created/confirmed date), so they cover only what that list returns for the role.

---

# v2 (2026-10-18 / 19): top bar, Gregorian date, tab bar edges, redesign across every screen, bug sweep

## Skills used (v2)
reverse-engineering (benchmark below), ui-ux-pro-max (priority table; there is no Python here for its search script), motion-system, color-system, aesthetic-usability, accessibility-audit, design-system (one token layer), frontend-design (no all-caps labels; the large title is each screen's one bold element), impeccable (spacing rhythm and states), verification-before-completion.

## Benchmark: pattern, source, how it is applied here
| Pattern | Source | Applied here |
|---|---|---|
| Large title that collapses into the bar on scroll | Apple HIG (navigation bars), iOS Settings and Wallet | `.ms-lt` opens every phone screen. The bar's small title fades in once the large one scrolls under it (`msLtCheck_`) |
| Date under the title | Monzo and Revolut home, iOS Calendar | Today's Gregorian date in the app's language (`ar-SA-u-ca-gregory-nu-latn`, `en-US`, `ur-PK`), plus the area for an area manager. The Hijri date stays in the hero |
| Floating tab bar with an active capsule | Material 3 navigation bar (active indicator), Revolut, Cash App | A hairline border, a light top edge, a layered shadow and deeper glass. A capsule sits behind the active icon and the label is bold |
| Cards inset on a soft page | Monzo, Revolut, Al Rajhi, STC Pay | Cards have a 12px gutter, one 20px radius, one elevation and 16px padding. Tiles are white with their colour on the icon |
| Sticky section headers | Apple HIG grouped lists, Material 3 lists | `.sec-title` sticks under the bar on frosted glass |
| Rows as cards | Revolut transactions, Instagram activity | `.list-item` rows are 16px-radius cards |
| Skeletons, not blocking spinners | Facebook, Instagram, Cash App | Shimmer on every `.sk`. On phones a data load shows a thin top bar instead of the full-screen loading overlay, which is now kept only for saves |
| Pull to refresh | All of them | Every phone screen, but never while a form is in progress |
| Back walks back | Android system back, Material 3 predictive back | Back closes the open sheet, viewer, drawer or camera first, then returns through the screens visited |
| Keyboard-aware layout | iOS and Android form guidance | The tab bar steps aside while the keyboard is up, and the focused field is scrolled into view |
| 44px targets | Apple HIG 44pt, Material 48dp | Every phone button and sortable header is at least 44px |
| One type and spacing scale | Material 3 type scale, the Meta design system | 4-pt spacing; type 12/13.5/15/17/22/30; radius 12/16/20; two elevations (`--ms-*` tokens) |
| Sentence-case labels | Material 3 writing guidance | No all-caps on a phone screen |

## Bugs found by the sweep and how each was fixed
| # | Bug | Fix |
|---|---|---|
| 1 | The bar title was cut to ~92px on most phone screens (admin, English: 10 of 17 titles) | Large title, collapsing two-line small title, area pill reduced to its badge |
| 2 | The Gregorian date was hidden on phones (the Facebook layer hid `.tb-title .sub`) | Shown under the large title in the app's language |
| 3 | About 30 places with tap targets under 44px (chips 33px, toggles 28, sort arrows 20, row buttons 29, a details link 16, segmented tabs 36, admin tabs 38, sortable headers 30) | Every phone button and sortable header is at least 44px |
| 4 | Android Back left the app from any screen, even with a sheet open | History entries per screen. Back closes the top overlay first, and a guard entry keeps the first Back in the app |
| 5 | The keyboard covered the focused field, and the tab bar sat over it | `html.ms-kb` hides the tab bar while the keyboard is up, and the field scrolls into view |
| 6 | Console error "Blocked call to navigator.vibrate" on every screen change | `goScreen_` uses `msBuzz_`, which waits for a real tap |
| 7 | "ResizeObserver loop completed" error on Entries, Handoffs, Collections and Sales Report | The date-picker label, trend chart and day board now redraw on the next frame |
| 8 | The entry dock and the download bar sat under the floating tab bar | Moved above it |
| 9 | The full-screen loading overlay covered the page on every read | Reads show the top bar; saves keep the overlay so a double tap cannot send twice |
| 10 | Crossing 768px (a rotation or resize) kept the old layout | A check on the change event and on resize redraws whenever the layout and the width disagree |
| 11 | The admin tabs extended 4px past the screen on each side | Their margins were reset |
| 12 | Pull to refresh only on Home | Every screen, but never on a form in progress, a focused field or a slip upload |
| 13 | All-caps labels ("LAST HANDOVER") | Sentence case on phones |

## Sweep
- **Coverage:** every phone screen of admin, collector, area manager, branch manager, driver and deputy, in en, ar and ur, at 390px, through the scripted audit `.superpowers/audit.js`.
- **What it flags:** top-bar overflow, clipped large titles, sideways scroll, elements off the screen outside scroll containers, buttons under 44px, and console and runtime errors.
- **Final result:** clean on every screen for all six roles. The sortable dashboard headers (30px wide) were fixed after the last run and not re-swept. The mock server's own `GET /api` 404 predates this work.
- **Top bar widths:** 360, 375 and 414px also checked.
- **Desktop:** 1280px is unchanged.

## Tests and commits
- `TZ=UTC node tests/run.js`: 3041 passed, 0 failed.
- `12a0f85`: top bar, Gregorian date and tab bar edges, merged with main as `45e330e`.
- `0644aa1`: v2 tokens, cards, sticky headers, 44px targets, Back button, keyboard, pull to refresh. Merged with main 3fd5938 as `84ab3d8`, which keeps IBM Plex Sans Arabic / Cairo for `--font-ar`.
- The last commit on the branch holds the ResizeObserver and header fixes and this report.

## Concerns (v2)
- **iOS edge swipe:** iOS Safari's edge swipe belongs to the browser. Back handling covers the Android Back button and the browser's back.
- **Keyboard detection:** it relies on `visualViewport`, which is present on current iOS and Android browsers.
- **Shared browser pane:** other sessions moved it between tabs during testing. The audits ran in my own tab, with the viewport re-checked before each run.
