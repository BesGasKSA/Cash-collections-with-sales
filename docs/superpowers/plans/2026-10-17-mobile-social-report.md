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
