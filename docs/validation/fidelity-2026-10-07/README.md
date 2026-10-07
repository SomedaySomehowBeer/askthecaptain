# H1 fidelity: the client against the reviewed mockups — validation record (2026-10-07)

Workspace outcome: manage shared work / discuss work. The owner tested the client on his phone and said it had drifted
visually from the mockups. This pass brings every screen that has a mockup back to it, under D14: the
[chat-first prototype](../../proposals/assets/captain-chat-first-2026-09-30/README.md) (frames 1, 2, 3, 5, 12, 13,
15, 16) and the [R3 history-and-undo screens](../../proposals/assets/captain-history-undo-2026-10-02/README.md).
Presentation only: no behaviour, route, storage or API change; every test id, label and state is kept.

## How the images were made

`node apps/e2e/scripts/mockup-compare.mjs fidelity-2026-10-07` (new; documented in
[apps/mobile/README.md "Local checks"](../../../apps/mobile/README.md)). The app side is the production and harness
web exports at 390 px, driven by the browser suite's own check modules with their synthetic API answers; the harness
controls are hidden from the screenshots. The mockup side is the prototype's frames rendered from `index.html`, and
the R3 `.dc.html` screens with `captain.css` and the vendored fonts (the dark R3 pairs swap the light tokens of
`tokens.ts` for the dark ones, as the R3 README says to). The fixtures are the checks' own, so names, times and
counts differ from the mockups' Tidewater data; compare the drawing, not the data.

[`compare-before/`](compare-before/) keeps ten of the same pairs rendered from `main` (01afcc7) before this change.

## Type

Fraunces SemiBold (headings, card, group and sheet titles) and Inter Regular, SemiBold and Bold (everything else),
SIL Open Font License 1.1, vendored in `apps/mobile/assets/fonts/` with each `OFL.txt`; provenance and the exact
instancing in [apps/mobile/README.md "Fonts"](../../../apps/mobile/README.md). Loaded with `expo-font` (new
dependency, allowlisted). On the web the page draws at once in the fallback and each face swaps in; native waits the
moment the local files take. Every text style gets its face from its weight in `themedStyles`.

Scale measured from the mockups (points; `src/theme/tokens.ts` `type`):

| Token | Size / line | Face | Source |
|---|---|---|---|
| `heading` | 22 / 28 | Fraunces 600 | frames 1, 2, 5, 12 `.title` |
| `pageHeading` | 26 / 32 | Fraunces 600 | R3 `.h1` (History) |
| `cardTitle` | 19 / 24 | Fraunces 600 | R3 `.card-title` |
| `sheetTitle` | 21 / 27 | Fraunces 600 | R3 `.sheet-title` |
| `groupTitle` | 15 / 20 | Fraunces 600 | frame 1 `.gname` |
| `body` | 15 / 21 | Inter 400 | R3 `.screen` (messages, fields) |
| `rowTitle` | 13 / 17 | Inter 700 | frame 1 `.row-title` (650 renders as 700) |
| `rowDetail` | 11 / 15 | Inter 600 | frame 1 `.facts` |
| `rowLast` | 12 / 17 | Inter 400 | frame 1 `.last` |
| `small` | 13 / 18 | Inter 400 | R3 `.change`, `.muted`, `.note` |
| `label`, `meta`, `chip` | 12 | Inter 400 / 400 / 600 | R3 `.field label`, `.time`, `.chip` |
| `tiny` | 10 | Inter 400 / 700 | frame 1 `.time`, `.gmeta`, `.count` |
| `section` | 11 | Inter 700, spaced capitals | frame 12 "PEOPLE" |

Where the two sources draw the same screen at different scales (frame 3 at 13 pt, R3 Lines at 15 pt), the thread,
its card and History follow R3, the later reviewed drawing; the list, new thread, equipment and team follow the
prototype.

## Screens, side by side

| Screen | Image | Fixed | Remaining |
|---|---|---|---|
| Thread list, light (frame 1) | [list-light](compare/list-light.png) | Fraunces heading in the header row; 30 pt initials avatar (was a figure); search glyph in ink; filter chips 26 pt inside 44 pt targets, ink when chosen; pinned views equal width, pin border; Fraunces group titles, 10 pt meta, action pips; rows 10 pt corners, 26 pt tile, 13/11/12 pt lines, pending facts in amber; times "10:00 am"; pill "New thread" with plus and shadow; 10 pt list gutter | Organisation name kept small under the heading (the app has several organisations; frame 1 has one); filter counts ("All 15") and "Team and agents" are behaviour/copy the app does not have; search is disabled, so muted |
| Thread list, dark (frame 15) | [list-dark](compare/list-dark.png) | as light, in the dark tokens | as light |
| New thread (frame 2) | [new-thread](compare/new-thread.png) | 12 pt crumb with small chevron; Fraunces heading; composer card with the field border; themed focus ring (was black); Private drawn as a switch | Camera and microphone buttons and the arrow Send are not built (Send keeps its word); the hint copy is the app's; Private row is the app's own |
| Task thread, light (frame 3) | [thread-light](compare/thread-light.png) | R3 header (15 pt back link, 36 pt avatar, History and star); Fraunces card title on two lines; facts 15 pt semibold; messages edge to edge on white with 54 pt rule; 15 pt names and bodies; day labels; green Unread rule; R3 composer | Agent messages, approval buttons and grouped change cards (frame 3) are later increments; frame 3's denser 13 pt scale is superseded by R3 Lines |
| Task thread, dark (frame 16) | [thread-dark](compare/thread-dark.png) | as light | as light |
| Thread with change lines (R3 Lines) | [lines](compare/lines.png) | pencil icon; 54 pt indent; 13 pt muted with values in body semibold; times lower-case | — |
| Folded runs (R3 Lines) | [folded-run](compare/folded-run.png) | a folded run is drawn as a change line (same indent, pencil, type) | R3 draws lines one by one; folding is the owner's later rule (3 Oct) |
| Task card, editing (R3 Main) | [task-editing](compare/task-editing.png), [dark](compare/task-editing-dark.png) | card grows to its content and scrolls with the thread (no inner scroll); fields with the R3 border and focus ring; select with a drawn chevron and no platform chrome; the date shown as "Thu 8 Oct 2026" over the browser's own date input; segmented status; disabled Save in the neutral pair; underlined History link | "Discard edits" keeps its label (owner, 7 October); the date input shows the browser's own fields while focused; "Change tags" is the app's |
| Booking card, editing (R3 Booking) | [booking](compare/booking.png), [cancel](compare/booking-cancel.png) | as the task card; times as "8:00 am"; "Cancel this booking" now visible without an inner scroll | occupancy note has no clock icon; the equipment field is disabled (moving is not built); "Open the record" is the app's |
| Topic: make this a task (R3 Topic) | [topic-make-task](compare/topic-make-task.png) | Fraunces title on two lines; R3 fields; empty date reads "Choose a date" | "Change tags" vs "Add a tag" (copy) |
| History, light (R3 History) | [history-light](compare/history-light.png) | R3 header without search; Fraunces 26 pt heading; values worded plainly as drawn (they were bold); 12 pt list gutter | the change set opened from a line keeps its green outline (a state R3 does not draw) |
| History with ticks, dark | [history-dark](compare/history-dark.png) | as light | checkboxes follow the dark colour scheme |
| Selection (R3 Selected) | [selected](compare/selected.png) | as History | — |
| Preview (R3 Preview), dark | [preview](compare/preview.png), [dark](compare/preview-dark.png) | Fraunces sheet title; R3 now/after rows | note glyph is a text tick |
| Conflict (R3 Conflict) | [conflict](compare/conflict.png) | as Preview | — |
| Blocked (R3 Blocked) | [blocked](compare/blocked.png) | as Preview; disabled Undo in the neutral pair | — |
| Stale (R3 Stale) | [stale](compare/stale.png) | as Preview | — |
| Applied (R3 Applied) | [applied](compare/applied.png) | as History | — |
| Equipment schedule (frame 5), dark | [equipment](compare/equipment.png), [dark](compare/equipment-dark.png) | segmented scale card with sage selection; column header band; 11 pt bold names; bars with 8 pt corners and the green left edge | the app's schedule is a day-per-row view that opens scrolled to today, so the heading, scale and legend sit above it in the scroll; frame 5's hours view, date stepper and pending hatch are not built |
| Account (frames 12, 13) | [settings](compare/settings.png) | the person as a Team row with initials; organisation with the role on the right; R3 buttons (12 pt corners, field border); spaced-capital "Passkeys" section | frame 13 is an agent profile; agents are not built |
| Members (frame 12) | [members](compare/members.png) | initials avatar, 13 pt bold name over 11 pt email; spaced-capital sections; R3 buttons | role controls stay explicit buttons; agents list and "Add an agent" are not built |

## Platform and font limits

- Fraunces is one static instance at optical size 20; the prototype's browser sets the optical size per font size,
  so the 26 pt History heading is slightly heavier and the 15 pt group titles slightly lighter than drawn.
- Inter 650 and 550 in the prototype render as 700 and 600, as the prototype's own browser does with these faces.
- Icons are drawn with views (no SVG dependency): the History clock, pencil and star are close to, not exactly, the
  drawn strokes.
- Native (iOS, Android) rendering of the faces, the date and select controls, and focus rings is not verified here;
  native keeps its text inputs and chip choices for dates, times and selects.

## Checks

| Check | Result |
|---|---|
| `pnpm --dir apps/mobile check` (typecheck and client boundary guard) | pass |
| `pnpm --dir apps/mobile test` | 456 + 20 pass, 0 fail, 0 skipped (the contrast tests for both palettes included; new pair: page on body, the chosen filter chip, 11.20 light / 14.94 dark) |
| web, harness, iOS and Android exports; `expo install --check` | pass |
| `node apps/e2e/scripts/mobile-shell-ci.mjs` (360, 390, 430, 1280 px) | exit 0, 42 PASS lines, no failures |
| `node apps/e2e/scripts/mockup-compare.mjs fidelity-2026-10-07` | 25 side-by-side images |

Checks changed only where a control's look changed: the design check's row corner (12 → 10 px), chosen filter colour
(now the ink chip inside the 44 px target, which it also measures), message rule (48/12 → 54/16 px) and card height
(≤ 110 → ≤ 130 px for a two-line Fraunces title); the dark check reads the filter chip's own surface. The checks'
pass-through of exported files now ignores a page closed with a file in flight (a font swapping in), which otherwise
crashed the route handler.

## Not covered

Native devices and assistive technology; the hosted staging client; screens without a mockup (welcome, organisation
choice, notifications, invitations, the passkey step-up), which take the fonts and buttons but were not compared.
