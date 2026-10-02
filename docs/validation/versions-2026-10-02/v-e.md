# R3 V-E: history, selective undo and make-a-task — validation record (2026-10-02)

Workspace outcome: **manage shared work** — see a record's history and undo the changes you pick without losing anyone's
later work. Contract: [versions and undo](../../plans/versions-and-undo-2026-10.md) §4, §5, §6, §8 (V-E). Designs (D14,
owner-reviewed): [captain-history-undo-2026-10-02](../../proposals/assets/captain-history-undo-2026-10-02/README.md) boards 3
(Topic) and 5–11 (History, Selected, Preview, Conflict, Blocked, Stale, Applied). Builds on [V-D](v-d.md).

## What changed

- **History** (`apps/mobile/src/app/threads/[id]/history.tsx`, `src/threads/history/`): the thread's detail says whose history
  it is (a task, a booking, a stock item, or the thread itself for a topic's or private thread's own tags, record kind
  `thread`). The back link names the record and returns to its thread. Change sets newest first, each with the actor's
  initials and name, the time in the organisation's zone ("Today, 9:12 am", "Thu 1 Oct, 4:40 pm") and "· Undo" for a
  reversal. Each change is worded by `wordChanges` in `src/threads/wording.ts`, the same code as its change line (V-D), as a
  sentence. States as drawn: tickable (a real checkbox); "Changed since" (still tickable, with when the field changed again);
  "Undone" (no tick box; by whom and when); "Can't undo" (no tick box; the reason per code, `record_created` worded per kind:
  "Cancel or complete it instead.", "Cancel the booking instead.", "Archive the item instead."). Coupled groups are one entry
  (a booking's time, a task's status with its completion, a stock count). "Show earlier changes" follows the cursor; the last
  page's row says when history starts, and "See the task as it was then" opens a read-only view of that version's snapshot.
  The bar once anything is ticked: "n changes ticked", Clear, Preview undo. `?changeSet=` (from a change line) brings that
  change set into view, loading earlier pages if needed.
- **Preview sheet** (`PreviewSheet.tsx`, react-native-web's `Modal`: `role="dialog"`, `aria-modal`, labelled by its title,
  focus kept inside, Escape closes): per entry its name, Now and After; what stays untouched ("…including Tom’s change of
  owner today."); "This is added to History as a new change. Nothing is erased, and you can undo it too."; Cancel and
  "Undo n changes". A conflict: who changed it from what to what and when, the explanation, "Also undo the change of <day>.
  The due date goes back to <value>." (adds the later change ids the API names and previews again) and "Set the due date
  yourself instead" (back to the thread, card unfolded for editing); the undo button stays disabled (neutral pair) until the
  preview is applicable. `needs`: says it was saved with other changes and offers "Also tick the rest of this change".
  Blocked: every reason code in §4 has a sentence; `slot_taken` names the booking, its owner and its time on the equipment,
  with "Open the equipment schedule"; `already_current` says there is nothing to undo; an unknown code gets an honest generic
  sentence (parsed as an open code, never a crash).
- **Apply** (`controller.ts`): one `POST …/reversals` with a new client id, the ticked change ids and the preview's basis. An
  uncertain answer keeps the id and body, locks the sheet ("Undo again" with the same id, or "Check History"), and stores only
  `{ id, changeIds, basis }` in session storage under the person and organisation; a later visit offers it again ("Undo again",
  "Check", "Forget") until History shows its change set. Never retried by itself. `409 stale_preview`: "Nothing was undone",
  who moved what, the fresh preview in place and History reloaded; the button becomes what still applies ("Undo the tag
  only"), sent with the fresh basis and a new id. Success closes the sheet, reloads History with the new change set at the top
  and the reversed changes "Undone", and says "n changes undone. The thread shows it as a change too."; the thread's change
  feed brings the reversal's line. 429 keeps the sheet with its wait (the same id is reused for the same body); 404 is "This
  thread is no longer available."; `change_set_id_unavailable` and other refusals are said in words.
- **Client plumbing**: a refusal's extra body (beyond `ok`, `code`, `error`, `field`) is now kept as `detail` on the client's
  refused outcome (`src/api/failure.ts`, `src/auth/contracts.ts`) and on the thread calls' error result, so the stale preview
  reaches the screen. Only `stale_preview` carries one today.
- **Entry points**: the clock button in the thread header (`thread-history`), "History" in the unfolded card
  (`thread-history-link`), and every change line (now a link; `historyRoute()` completed). The two helper lines V-D left out are
  back: "Saved together as one change. You can undo it from History." and "The time, setup and cleanup are saved as one change
  and undone together."
- **Make this a task** (board 3; `src/threads/cards/MakeTask.tsx`, `make-task.ts`): on a topic's unfolded card only (never a
  private or record thread): heading, sentence, Owner (members, default you), Due (optional), "Make this a task", Cancel. One
  `POST …/threads/:id/task` with `expectedRevision` and a client `changeSetId`, the card writes' uncertain-write rules; the
  answer must be this thread, now kind `record` on a task. The same thread then reloads as the task's thread. Refusals in
  words: `owner_invalid`, `thread_is_record` (and the thread reloads), `thread_not_topic`, a stale revision.
- **Wording**: a reversal's field changes read "changed the due date back from …" (board 11) in History and in its change line.
  September is written "Sep" (some browsers' CLDR gives "Sept").
- **Strict parsers** (`src/threads/history/parse.ts`): history pages (identity, newest-first order, the start marker only on the
  last page, entry shapes, coupled groups whose values are objects of exactly their fields, states with their companions,
  reversal links only in reversal change sets), versions, previews (every selected id answered, `applicable` consistent,
  nothing proposed while undecided), applies (the id and ids sent, cause `reversal`) and the stale body. Unknown keys refuse.

## Checks

| Check | Result |
|---|---|
| `pnpm --dir apps/mobile check` (tsc and the boundary guard) | pass |
| `pnpm --dir apps/mobile test` | 447 + 20 pass, 0 fail, 0 skipped |
| Web export and harness export; `check-boundary.mjs dist/web --harness-export dist-harness` | pass |
| `apps/e2e/scripts/mobile-shell-ci.mjs` (the whole browser suite) | 39 PASS lines (V-D's 35, plus History at 360, 390 and 430 and its dark run at 390), 0 failures, 0 skipped |
| `apps/api/src/threads/list.test.ts` on real Postgres | 13 pass, 0 skipped |
| `apps/api` typecheck | pass |

New and changed tests:

- `src/threads/history/history.test.ts` (8): the parsers' refusals (fourteen bad history pages, bad previews, applies and
  stale bodies) and acceptances (a coupled booking time, `needs`, `slot_taken` detail, an unknown reason code); the refusal
  `detail` mapping; History's wording against the change line's ("…back from…" in both), a one-field coupled status, a booking
  time, a stock count with its unit, every irreversible and blocked code, values (a tag's presence, a time range, not
  decided), the stale alert and button, untouched, the start row, the route; the pending-undo store (only id, ids and basis;
  per person and organisation; unknown shapes dropped; cleared for another person and on sign-out); the controller: load,
  tick, a conflict that never applies, "also undo", one apply with the preview's basis; an uncertain apply with an explicit
  same-id retry, refusal to dismiss, reconciliation by History and recovery from storage; a stale answer then what still
  applies with the fresh basis and a new id, a 429 that keeps the id and waits, a late answer from an old scope dropped; the
  make-a-task body and answer check.
- `apps/api/src/threads/list.test.ts`, new test: real history pages of two to the start, worded; a version; a conflict preview
  and the pair that applies; a stale apply whose real 409 body goes through the client's own mapping into `parseStale`; the
  History controller over the real API (load, tick a tag, preview, apply; one change set at the top, the tag "reversed", the
  change line in the thread); a booking moved whose old slot was taken (blocked `slot_taken`, worded); a topic's own tag
  history (kind `thread`); topic to task through `parseMadeTask`; a private thread's `thread_not_topic` refusal.
- `apps/e2e/scripts/mobile-shell-history-check.cjs` (new), at 360, 390 and 430 on the production export, with a synthetic
  API that keeps a small journal and applies §4's rules (slots, live later changes, coupled groups, a reversal undoing the
  earliest selected change), the page clock fixed at Fri 2 Oct 2026, 9:40 am in Sydney: entering History from a change line
  (opens at its change set), every state with its note, paging and the version; ticking, the bar and Clear; the preview with
  all reversible (the labelled dialog, six Tabs that stay inside it, Escape); a conflict, disabled until "also undo" makes it
  applicable; "Set the due date yourself instead" returning to the unfolded card; the card's History link and the clock; a
  stale apply ("Nothing was undone", what moved, "Undo the tag only" with the fresh basis and a new id); success (one request,
  the new change set on top with "· Undo", the reversed changes "Undone", the notice, both reversals' change lines in the
  thread); an undo of the undo; an uncertain apply (no automatic retry over 1.2 s, only `{ id, changeIds, basis }` in session
  storage under the person, organisation and thread, Escape refused, an in-sheet retry and a retry after a reload with the same
  id and body, then reconciled and cleared); a booking's coupled time blocked by a booking holding the slot, and "Open the
  equipment schedule"; a topic's own tag history; make-a-task with an `owner_invalid` refusal then success (two requests, new
  ids, the thread reloads as a task's with its creation line); a non-participant opening a private thread's History (not
  available; no history request). Touch targets of at least 44 px on every button, link, input and select in History, the bar,
  the sheet and make-a-task, tick rows at least 44 px high, no horizontal overflow; eleven harness states (`threads-history`,
  its bar and preview, `-failed`, `-empty`, `-conflict`, `-booking`, `-stale`, `-applied`, `-recovered`, `threads-topic-task`).
  At 390 the dark scheme: History with ticks, the preview and the conflict sheet.
- Updated: `mobile-shell-cards-check.cjs` (the restored helper line), `mobile-shell-threads-check.cjs` (a topic's fold now
  shows "Make this a task" instead of "No further details."), `mobile-shell-check.cjs` (runs the new check).

## Screenshots (synthetic data)

| | |
|---|---|
| History (board 5) | [390](v-e/390-history-states.png), [390 earlier page and start](v-e/390-history-states-earlier.png), [360](v-e/360-history-states.png) |
| As it was then | [390-history-version](v-e/390-history-version.png) |
| Two ticked (board 6) | [390](v-e/390-history-selected.png), [dark](v-e/390-dark-history-selected.png) |
| Preview (board 7) | [390](v-e/390-history-preview.png), [430](v-e/430-history-preview.png), [dark](v-e/390-dark-history-preview.png) |
| Conflict (board 8) | [390](v-e/390-history-conflict.png), [after "also undo"](v-e/390-history-conflict-resolved.png), [dark](v-e/390-dark-history-conflict.png) |
| Slot taken (board 9) | [390](v-e/390-history-blocked.png), [430](v-e/430-history-blocked.png) |
| Stale (board 10) | [390](v-e/390-history-stale.png), [360](v-e/360-history-stale.png) |
| Applied (board 11) | [390-history-applied](v-e/390-history-applied.png) |
| Uncertain undo | [390-history-uncertain](v-e/390-history-uncertain.png) |
| Make this a task (board 3) | [390-history-make-task](v-e/390-history-make-task.png) |

## Where the build differs from the designs, and why

- **Shared wording.** A change reads as its change line does (the brief's rule), so board 9's "Moved the booking from Thu 8
  Oct, 8:00 am to 12:00 pm, to Fri 9 Oct, …" is "Changed the time from Thu 8 Oct, 8:00 am–12:00 pm to Fri 9 Oct, 1:00 pm–5:00
  pm", and "Made this booking" is "Booked Summer lager canning run". The preview's Now/After use the board's "1:00 pm to 5:00
  pm".
- **"Today" rather than "this morning"** in the untouched note, and "tick Tom’s change" rather than "his change" in the stale
  note: the client knows the day and the name, not a part of the day or a pronoun.
- **The History link** sits beside "Change tags" in the card's tag row on every kind of card; board 2 puts it beside "Cancel this
  booking".
- **A change set opened from a change line** gets an action-coloured border (not drawn) so it can be found.
- **Not drawn, built in the shell's style:** the read-only "as it was then" view (a list of the version's main fields, steps and
  tags), the uncertain and recovered undo states, the failed preview, loading and empty History.
- **A reload after an undo shows the first page only** (the API's 20 change sets, or three in the synthetic API); earlier
  pages are one "Show earlier changes" away.
- **"No further details."** is no longer shown on a topic's fold, where board 3 draws the make-a-task form instead.
- System fonts replace Fraunces and Inter; borders use the `line` token; change-line times keep the device's format
  ("7:32 AM") as V-D does, while History uses "9:12 am" in the organisation's zone.

## API behaviour worth knowing (no API change made)

- `409 stale_preview` carries the fresh preview and `moved` in the error body. The client's generic failure mapping kept only
  the code, so this PR keeps a refusal's extra body as `detail` (client only).
- A coupled group with one member (a task's status alone) still has object values (`{ status: … }`); the parser treats coupling
  by record kind and field, not by member count.
- History names people and tags (`names`) but not steps; a step's field change carries no row. History reads the task
  (`GET …/tasks/:id`) to name steps, as the card does.
- `POST …/threads/:id/task` gives its change set only in the `Change-Set-Id` header; the client confirms an uncertain make-a-task
  by the creation's change line, as the other card writes do.
- `/equipment` has no deep link to a booking or a time, so "Open the equipment schedule" opens the schedule as it is.

## Not covered

- Hosted staging, production, and any API other than the throwaway Postgres in `list.test.ts`.
- Native iOS and Android: the History rows' pressable checkboxes, the native `Modal` sheet and the make-a-task controls are
  type-checked and bundled but not rendered on a device or simulator.
- Assistive technology: roles, labels, the dialog's labelling, focus containment and Escape are checked in the DOM only; no
  screen reader was used.
- A 429 on preview or apply and a `needs` preview are covered by unit tests and the parsers, not by a browser check; the screen ticks
  whole entries, so a `needs` arises only when a conflict's later changes are part of a coupled group.
- The "as it was then" view is read-only and minimal; it is not a design-reviewed screen.
