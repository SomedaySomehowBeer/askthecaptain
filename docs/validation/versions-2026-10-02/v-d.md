# R3 V-D: change lines and card editing — validation record (2026-10-02)

Workspace outcome: **manage shared work** — edit a task, a booking or a stock count from its thread and see every
change in the thread. Contract: [versions and undo](../../plans/versions-and-undo-2026-10.md) §3, §5, §6, §8 (V-D).
Designs (D14, owner-reviewed): [captain-history-undo-2026-10-02](../../proposals/assets/captain-history-undo-2026-10-02/README.md)
boards 1 (Main), 2 (Booking) and 4 (Lines). Not in V-D: "Make this a task", History, selection, preview (V-E).

## What changed

- **Parser** (`apps/mobile/src/threads/parse.ts`): a message of kind `change` is read strictly — no body, never edited
  or deleted, a `changeSetId`, and its `change` (actor kind, id and name; cause kind; time; up to 50 changes; `truncated`).
  Each change follows the database's shape rules (an update names a camelCase field; a create or attach has only
  `after`, a row; a remove or detach only `before`; attach and detach are tag items; a value is at most 20 000 JSON
  characters). Any other kind (an approval card, R5), actor kind or cause kind is still refused with its page.
- **Wording** (`src/threads/wording.ts`, pure): one sentence per change line, worded by code with the actor's first
  name ("Captain" for the system, "Tom’s workflow" for a workflow, "A former member" without a name). Every field of
  `journalFields` has its own phrase; coupled fields share one (a booking's start, end, setup and cleanup; a task's or
  step's status with its completion fields; a count with when and by whom); steps and tags of one kind merge ("ticked
  4 steps"); `truncated` ends "and more"; an unknown field says "changed the …" and never throws. Ids are named only
  from what the screen loaded (members, the thread's and the organisation's tags, the task's steps, the rows a change
  carries); otherwise "another member", "a tag", "a step".
- **Thread** (`src/app/threads/[id].tsx`, `src/threads/ChangeLine.tsx`): a change line is one row in the thread's
  order, with day dividers, gaps and the first-unread marker like a message; no menu; focusable, with the full wording
  and time as its label. `historyRoute()` is the V-E seam (returns null until `/threads/[id]/history` exists). A change
  line in the change feed rereads the card; `refresh()` does after a card write.
- **Card** (`src/threads/RecordCard.tsx`, `src/threads/cards/*`): the fold-out of a task, booking or stock item is its
  editor. Dates on the card read as people say them ("Thu 8 Oct"). Tag chips stay on the card; the existing
  revision-checked tag controls open from "Change tags".
  - Task (board 1): Title, Status (Open / In progress / Done), Owner (active members), Due; one "Save changes" sends
    only the changed fields as one PATCH with one client change set id and the task's revision; Cancel restores.
    Steps: a real checkbox saves at once as its own PATCH; "Add a step" posts one with the task's revision.
  - Booking (board 2): Title, Equipment (read-only, see below), Date, Start, End (and End date for a booking that
    spans days), Setup, Cleanup; the note says what the booking will hold and whether that time is free, read from the
    equipment's schedule; an overlap refusal (`409 reservation_conflict`) says so and the note then names what holds
    the slot; "Cancel this booking" asks first. Times are in the organisation's zone.
  - Stock: Count and an optional Note, "Save count" (the task card's pattern; not drawn).
  - Every write (`cards/saver.ts`): an uncertain answer keeps the id and exact body and locks the form until "Save
    again" (same id, same body) or "Discard"; never retried by itself; a change line carrying the id confirms it.
    429 keeps the form editable with its wait. 409 `stale_revision` reloads and says so. 404 is the thread's existing
    "This thread is no longer available." Documented refusal codes are said in words.
- **Tokens**: the designs' warning pair and neutral pair in both palettes, in the contrast test.

| Pair | Light | Ratio | Dark | Ratio |
|---|---|---|---|---|
| warningText on warning | `#6b4a0c` on `#fbe8c4` | 6.68 | `#f3d08a` on `#3a2c10` | 9.18 |
| warningText on card | `#6b4a0c` on `#ffffff` | 8.05 | `#f3d08a` on `#17231c` | 10.98 |
| neutralText on neutral | `#434a44` on `#e4e8e1` | 7.36 | `#cfd6d0` on `#2a312c` | 9.01 |
| body on needsYou (an ok note) | `#1f3a2c` on `#e9f2e4` | 10.76 | `#e6ede4` on `#1a2c21` | 12.34 |

`warningLine` is `#b98a2b` / `#8a6a2a` (a border, not text).

## Checks

| Check | Result |
|---|---|
| `pnpm --dir apps/mobile check` (tsc and the boundary guard) | pass |
| `pnpm --dir apps/mobile test` | 439 + 20 pass, 0 fail, 0 skipped |
| Web export and harness export; `check-boundary.mjs dist/web --harness-export dist-harness` | pass |
| `apps/e2e/scripts/mobile-shell-ci.mjs` (the whole browser suite) | 35 PASS lines, 0 failures, 0 skipped (360, 390, 430, 1280) |
| `apps/api/src/threads/list.test.ts` on real Postgres | 12 pass, 0 skipped |

New and changed tests:

- `src/threads/wording.test.ts` (8): the three reviewed lines exactly; creation, removal, steps, evidence, tags, a task
  status with its completion fields and step cascade; booking time as one phrase; stock counts; actors, empty,
  truncated and unknown fields; date and time formatting; **the mirror**: reads `packages/db/src/versions.ts` as text
  and fails when `journalFields` gains or loses a field the client does not word (the client may not import across the
  boundary); strict change-line parsing.
- `src/threads/cards/cards.test.ts` (8): the saver (uncertain then explicit same-id retry; confirm by change line;
  discard; 429; stale; lost; refusals and a new id after one), the forms (only changed fields; booking plan in the
  zone, a skipped daylight-saving time, occupancy words), count validation, record parsers, names.
- `src/threads/threads.test.ts`: a change line in the feed rereads the card, a refresh does, a line has no menu.
- `src/theme/tokens.test.ts`: the new tokens and pairs.
- `apps/api/src/threads/list.test.ts`: the earlier assertion that the client **refuses** a change line is flipped (it
  parses in a page and in the change feed). A new test drives real writes — a task edit (title, owner, due in one
  change set with the client's id), a step added and ticked, a tag, a booking moved and cancelled, a stock count —
  through the Expo parsers, the card's record parsers and the wording, and asserts the exact sentences; it also
  compares `wordedFields` with the real `journalFields`.
- `apps/e2e/scripts/mobile-shell-cards-check.cjs`, at 360, 390 and 430 on the production export with synthetic API
  answers: a thread with change lines (wording, order among messages, the unread marker on a line, no menu, label);
  a task save (one PATCH, exactly the changed fields, one change set id, the line appears through the feed, the card's
  facts update); a stale-revision save (nothing saved, the newer task shown and said); an uncertain save then an
  explicit retry with the same id and body (no automatic retry over 1.2 s); ticking a step (one PATCH, own id); a
  booking (occupancy note, a disabled equipment control, an overlap refusal naming the holder, a save in the zone, a
  cancel with its confirm step); a stock count (validation, one POST, the line with its unit); touch targets of at
  least 44 px on every input, select and button in each editor; no horizontal overflow; seven harness states
  (`threads-lines`, `threads-card-task`, `-task-failed`, `-booking`, `-booking-cancelled`, `-stock`, `-stock-archived`).
  At 390 also the dark scheme's editing card. `mobile-shell-create-check.cjs` opens "Change tags" before the tag
  controls.

## Screenshots (synthetic data)

| | |
|---|---|
| Thread with change lines | [390-cards-lines](v-d/390-cards-lines.png) |
| Task card, editing | [390](v-d/390-cards-task-open.png), [360](v-d/360-cards-task-open.png), [dark](v-d/390-dark-cards-task-editing.png) |
| Stale revision | [390-cards-task-stale](v-d/390-cards-task-stale.png) |
| Uncertain save | [390-cards-task-uncertain](v-d/390-cards-task-uncertain.png) |
| Step ticked | [390-cards-task-step](v-d/390-cards-task-step.png) |
| Booking card, editing | [390](v-d/390-cards-booking-open.png), [430](v-d/430-cards-booking-open.png) |
| Overlap refusal | [390-cards-booking-overlap](v-d/390-cards-booking-overlap.png) |
| Cancel this booking | [390-cards-booking-cancel](v-d/390-cards-booking-cancel.png) |
| Stock count | [open](v-d/390-cards-stock-open.png), [saved](v-d/390-cards-stock-saved.png) |

## Where the build differs from the designs, and why

- **Equipment is read-only.** `PATCH …/equipment/:equipmentId/reservations/:id` (apps/api/src/equipment/service.ts
  `replaceReservation`) has no equipment field and updates `where equipment_id = :equipmentId`, so a booking cannot
  move to other equipment. The control is shown disabled with "Moving a booking to other equipment is not available
  yet. Cancel it and book the other equipment instead."
- **Helper lines without undo.** The boards say "You can undo it from History" and "…undone together". History and
  undo are V-E, so the lines say "Saved together as one change." and "The time, setup and cleanup are saved as one
  change." until V-E ships.
- **No History link or header clock button**, and change lines open nothing yet (V-E).
- **The booking card's heading** is the record's title ("Summer lager canning run"); board 2 heads it "Canning line,
  Thu 8 Oct". The API's card title is the record's title.
- **Browser controls** format dates and times in the browser's locale (for example 10/08/2026, 08:00 AM) where the
  boards draw "Thu 8 Oct 2026" and "8:00 am"; system fonts replace Fraunces and Inter (as the app does everywhere);
  control borders use the `line` token rather than the boards' `#c6d2c1`; times in change lines follow the messages'
  device format ("2:40 PM").
- **Tags**: the chips are on the card as drawn; the R2 tag controls stay, behind "Change tags".
- **A booking ending on a later day** shows an End date field; an end at or before the start on one day is refused
  in words rather than read as the next day.
- **Provider-owned quantities.** The stock API has no provider-owned quantity: every stock item is counted in Captain
  (`stock_items` and the card's fold carry no quantity authority). There is
  nothing to show read-only for that reason; an archived item is read-only with "Restore it before counting it."

## Not covered

- Hosted staging, production, and any real API other than the throwaway Postgres in `list.test.ts`.
- Native iOS and Android: the selects, date, time and checkbox controls have React Native fallbacks (radio buttons,
  text fields, a pressable checkbox) that are type-checked and bundled but not rendered on a device or simulator.
- Assistive technology: labels, roles and focus are set and checked in the DOM only; no screen reader was used.
- 429 and lost access on a card write are covered by the saver's unit tests, not by a browser check.
- "Make this a task" (decision 4), History, selection, preview and apply (V-E).
