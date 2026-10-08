# H2 bookings and equipment by people: validation record (2026-10-08)

Workspace outcome: **allocate resources**. B-B of the [H2 contract](../../plans/bookings-and-equipment-2026-10.md)
(§3, §4): a new booking from the equipment schedule, "Make this a booking" on a topic, the Equipment screen, and the
Team row opening Members. The API side (migration 0049, `POST …/threads/:threadId/booking`) is B-A (#252).

## What was checked, and how

| Check | Where | Result |
|---|---|---|
| Typecheck | `pnpm check` | 8/8 tasks |
| Pure client tests (prefill, the new-booking form and write, the Equipment screen's parsers and writes, make-a-booking, the saver's per-screen refusal words) | `apps/mobile/src/resources/equipment/bookings.test.ts` (7) | pass; mobile 463 + 20 in all, 0 skipped |
| Real responses through the client's parsers (equipment add, rename with a stale refusal, archive, unarchive, a refused name; a new booking and its same-ID retry; its thread found in the Bookings list; the overlap refusal as the client maps it; the occupancy check naming the holder; topic to booking; a private thread and archived equipment refused) | `apps/api/src/threads/list.test.ts`, the H2 test, real Postgres | pass; api 262, 0 skipped |
| The rest of the workspace against Postgres | `pnpm test` | db 114, engine 20, steps 8, model 11, connectors 5; 0 failed, 0 skipped |
| Browser, production web export with synthetic contract-shaped answers, at 360, 390 and 430 and dark at 390 | `apps/e2e/scripts/mobile-shell-bookings-check.cjs`, run by `mobile-shell-ci.mjs` | 4 PASS lines; the whole suite 46 PASS lines, exit 0 |
| Side by side with the nearest reference, 390 px | `node apps/e2e/scripts/mockup-compare.mjs bookings-equipment-2026-10 …` | 15 images in [`compare/`](compare/) |

The browser check, at each width: the schedule's "New booking" opens `/equipment/new` with the equipment in view and the
day in view in its link and its fields; a slot another booking holds is named in the occupancy note and Make is
disabled; a free slot says so; an overlap the server refuses names its holder (re-read from the schedule) and keeps the
form; an uncertain answer locks the form until "Make again with the same ID", which sends the same booking id, change
set id and body (never by itself); success opens the new booking's thread. On a topic, "Make this a booking" sits under
the task form, replaces it, and is refused in words for archived equipment, then made on other equipment, after which
the card is the booking's editor. The Equipment screen adds equipment (a duplicate name refused in words), renames in
place, archives after a confirm ("Keep it" writes nothing), shows archived equipment and unarchives it; every write
carries the revision it read and a change set id. The Team row opens Members, whose way back is Threads. Each step
checks no horizontal overflow and that every control in the new forms is at least 44 by 44.

## Screens, side by side

New booking and the Equipment screen have no mockup; each is compared with its nearest board, as the contract says.
Fixture data is the checks' own, so names, dates and times differ from the mockups'.

| Screen | Image | Fixed | Remaining differences |
|---|---|---|---|
| Schedule with New booking (frame 5) | [schedule-new-booking](compare/schedule-new-booking.png) | "New booking" is the thread list's pill ("New thread": 48 pt, action green, plus, shadow), bottom right, so it reads the view in front of the person; the first version put it in the header, where reaching it scrolled the timeline to its top and the day in view was lost | Everything frame 5 draws that the app does not (the Fraunces page heading row with Hours/Days/Weeks beside it, the date heading with its arrows, the colour legend, pending bars) is the schedule's existing state from H1, unchanged here; the screenshot shows the timeline centred on today, so the header with "Manage equipment" is above the fold; the empty fixture shows no bars |
| Schedule, light and dark (frame 5, H1 pair re-run) | [equipment](compare/equipment.png), [equipment-dark](compare/equipment-dark.png) | the pill in both schemes | as H1 (harness fixture: loading and unread cells hatched) |
| New booking (nearest: board 2) | [new-booking](compare/new-booking.png) | board 2's fields in its order and two-column grid (Title; Equipment and Date; Start and End; Setup and Cleanup), its 44 pt fields with the drawn chevron, its green occupancy note with the same sentence, its primary and secondary buttons, its help line, all in the card; the page heading and crumb are the shell's | No mockup of its own: the page is a card on the schedule's page, not a thread card (a booking has no thread until it is made), so no status chip, Cancel this booking, History or composer; the note has no clock icon (board 2 draws one; the booking card has none either, since H1); "Ends on another day" is a quiet action board 2 does not draw (needed for bookings that span days); Make the booking replaces Save changes; Cancel leaves the screen |
| New booking, dark | [new-booking-dark](compare/new-booking-dark.png) | as light, in the dark tokens | as light |
| New booking refused for an overlap | [new-booking-overlap](compare/new-booking-overlap.png) | the warning note names the holder and its time; Make is the neutral off button; the refusal is said under the buttons, as the card editors do | as New booking |
| Topic: make this a booking (board 3 pattern) | [make-booking](compare/make-booking.png), [make-booking-dark](compare/make-booking-dark.png) | board 3's layout: the rule above, the 15 pt semibold heading, one muted sentence, the fields in board 2's grid, then the primary action and Cancel side by side | Board 3 draws only the task form; the booking's fields are board 2's, so the form is longer; "Ends on another day" as above; no clock icon in the note |
| Topic: make this a task (board 3, H1 pair re-run) | [topic-make-task](compare/topic-make-task.png) | — | one new line under the task form: the quiet "Make this a booking" action, which board 3 does not draw (the contract puts it beside Make this a task) |
| Equipment screen (nearest: frame 12) | [equipment-manage](compare/equipment-manage.png), [equipment-manage-dark](compare/equipment-manage-dark.png) | frame 12's list style, as the Members screen: the spaced-capital section label ("ACTIVE EQUIPMENT", "ARCHIVED EQUIPMENT"), one white card of rows split by hairlines, 13 pt bold names over 11 pt details, the Fraunces heading and crumb; the add form is a card like Members' "Invite someone" | No mockup: rows have no avatar tile (equipment has no initials or icon in the design system); Rename and Archive are the cards' quiet text actions (15 pt), larger than frame 12's 11 pt right-hand labels, to keep 44 pt targets; "Show archived" and Refresh sit above the list where frame 12 has nothing; frame 12's agents section is not equipment |
| Equipment screen, archive confirm | [equipment-manage-confirm](compare/equipment-manage-confirm.png) | the confirm is the booking card's cancel confirm (board 2): a warning note in the row, "Archive it" and "Keep it" | as above |
| Thread list, light and dark (frames 1 and 15) | [list-light](compare/list-light.png), [list-dark](compare/list-dark.png) | the Team row is now active: the pinned row's sage surface and ink label (was the muted, page-coloured unavailable row), its icon in sage ink | "Team" where frames 1 and 15 say "Team and agents" (agents are R5); the row's accessible name is "Team. Members and invitations"; otherwise as H1 |
| Members (frame 12, H1 pair re-run) | [members](compare/members.png) | — | as H1; from the Team row the crumb reads "Threads" (frame 12's), from Settings it stays "Settings" |

## Deviations from the contract, written into it in place (§3 "As built in B-B")

- "New booking" is a floating pill, not a header button, so the prefill is the view the person is looking at; the day
  is the first day mostly in view (the middle at the Hours scale).
- "Make this a booking" is a quiet action under the task form that swaps the form, rather than a second form beside it.
- The Team row's detail reads "Members and invitations"; Members' way back from it is Threads.

## Not covered

Hosted staging (B-C), native iOS and Android (the forms and screens use the web calls, as the card editors do: on a
native build without the web session they say the threads are unavailable), installed apps, assistive technology with a
screen reader. The browser checks are an approximation over synthetic answers; the real-API parser test is the server
evidence for the shapes.
