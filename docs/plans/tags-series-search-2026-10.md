# Tags, recurring work and search: the H4 contract

Status: root contract, 8 October 2026, under the owner's people-first order (rebuild plan §4, H4). Outcome:
**manage shared work** — a person keeps the tags (projects included), sets up recurring work, and finds a thread,
from the one client. It also clears the last H1 leftover: the equipment schedule's header.

## 1. What a person can do when H4 is done

- Keep tags: see them all, add one, rename it, give it an owner and dates (which is what makes it a project, D7),
  archive and restore it. Open a tag's details from its group heading on the thread list.
- Make a task recur: from a task's card, "Repeat this task" creates a recurring series from it (monthly, quarterly,
  yearly, weekdays or every n months; the anchor date; days before or after the period's end it falls due; owner;
  evidence required; the task's tags). An occurrence's card shows its series and opens it to edit or pause.
- Search threads: the list's search field finds threads by title and by message text the person can see, in the
  same rows as the list, with the matching text in the preview line.
- Use the equipment schedule as frame 5 draws it: the heading, Hours / Days / Weeks, a date stepper with "Today is
  …", and the legend (Confirmed, Cleaning; Pending joins in R5).

## 2. API

Existing: `GET/POST …/tags`, `PATCH …/tags/:tagId` (name, ownerId, startsOn, endsOn, archived, expectedRevision);
`POST …/series`, `PATCH …/series/:seriesId` (title, body, ownerId, evidenceRequired, recurrence, everyMonths, anchor,
dueOffsetDays, paused, tagIds), `GET …/series`, `GET …/series/:seriesId`; the task payload's `seriesId`. All
journalled.

New: `GET …/threads?q=<text>&filter=&limit≤50` — search within the list's visibility: a thread matches when its title
or a live message body visible to the caller matches (Postgres full-text search, `english`, on `threads.title` and
`thread_messages.body` through the existing policies, so a private thread's messages match only for its
participants), ordered by rank then activity; the row gains `match: { kind: 'title' | 'message', excerpt }` with the
matching text highlighted by `«»` around the terms; no `groups`; no cursor beyond `limit` in H4 (say "Show more
results" is not offered). A query shorter than 2 characters is a 400. No new table; an expression index on
`to_tsvector('english', body)` for `thread_messages` and on the title for `threads` if the planner needs them
(migration 0050, additive).

As built in T-A (8 October 2026):

- **Search.** `q` is trimmed; fewer than 2 characters is `400 query_too_short`, more than 200 or with `after` is
  `400 invalid_request`. The words are the runs of letters and digits in `q` (at most 8), each a prefix
  (`word:*`, joined by `&`), so a word being typed matches (`ferm` finds "Fermenter" and "Fermentation") and nothing a
  person types is read as `tsquery` syntax; a `q` with no word left, or only stop words, matches nothing. The
  candidates are the filter's visible threads (the list's own `filtered` query, through the threads policy); messages
  are live ordinary ones (`kind = 'message'`, not deleted; change lines never match) read through `thread_messages`'
  policy. A non-participant's answer for a private thread's words is exactly the answer for words nobody wrote. The
  answer is `{ filter, q, available, threads: [row & { match }] }` with no `groups` and no `nextCursor`;
  `files`/`people` answer `available: false` and no rows. `match` is `{ kind, excerpt, authorName }`: a title match
  shows the whole title (`kind: 'title'`, `authorName: null`), otherwise the best-ranked matching message's
  `ts_headline` (one fragment, 6 to 18 words) with its author. Every matching term is between `«` and `»`; a title or
  body's own `«` and `»` become `"` first, so every mark is the search's. Rank: a title match is weighed `A`, a
  message `D` (`ts_rank`), the greater wins, then activity, then id.
- **Migration 0050 is not added.** Measured on 8 October with 200 threads and 3,000 messages: search answers in about
  190–450 ms, the plain list in about 500–600 ms (both dominated by the per-thread unread and card computation).
  `EXPLAIN ANALYZE` as the runtime role shows a sequential scan of `thread_messages` even with a GIN index on
  `to_tsvector('english', body)` and a word that matches no row: row security's policy (`thread_visible(thread_id)`)
  must run before a non-leakproof operator, and `@@` (`ts_match_vq`) is not leakproof, so the index cannot be used
  under forced row security. As the table owner (no row security) the same query uses a bitmap index scan. An index
  would cost writes and help nothing, so none is added; a later increment that needs faster search revisits this
  (a stored `tsvector` column, or a security-definer search over ids the caller can see).
- **Archived tags have no heading.** A list row's `tags` are its live tags (the ones it is grouped by), and Other holds
  the threads with no live tag; the thread detail and card still list every attached tag. Restoring the tag brings
  the heading back.
- **Tag counts.** `GET …/tags?counts=true` adds `threads` to each tag: the threads the caller can see that carry it
  (counted through `thread_tags`' policy, so a private thread counts only for its participants). Without `counts` the
  page is unchanged. `GET …/tags/:tagId` reads one tag with its `threads` count (404 when unknown or another tenant's).
- **Repeat this task.** `POST …/series` takes an optional `fromTask: { id, expectedRevision }`: in the same change
  set the task becomes the series' occurrence for the period it falls in (today's period, or the series' first when
  it starts later), keeping its own title, due date and tags, so the routine never makes a second copy of it, and its
  card's `seriesId` names the series. A stale revision is `409 stale_revision`, a step `400 task_is_step`, a task
  already in a series `409 task_in_series`, a cancelled task `409 task_cancelled`. Later occurrences are created by
  the routine as before, with the series' owner and tags.

## 3. Client

- **Tags** `/tags` from "Manage tags" in the list's filter row overflow and from a tag group heading's long-press
  or chevron menu: the list (name; owner and dates when set; thread count), "Add a tag", and a tag's details screen
  `/tags/[id]` with name, owner (members), starts, ends, archive/restore with a confirm step; each write
  revision-checked with a `changeSetId`. Style: the Equipment screen (H2) and the task card's fields.
- **Repeat this task** on a task card's fold-out (not on a step, not on an occurrence): a form in place (recurrence,
  every n months when custom, anchor date, due offset, owner, evidence required) → `POST …/series` with the task's
  title, body and tags; success shows "Repeats …" on the card. An occurrence's card shows "Part of <series title> ·
  Edit the series" opening `/series/[id]` with the same fields plus Pause / Resume; revision-checked.
- **Search** in the list's header: the field becomes live; typing (≥ 2 characters, debounced) replaces the grouped
  list with result rows and "n results" / "No threads match"; clearing returns to the list; the preview line shows
  the match excerpt. Honest states; the same polling stops while searching.
- **Schedule header** per prototype frame 5: Fraunces heading "Equipment", the Hours / Days / Weeks segmented
  control (the existing scales), the date stepper ‹ day › with "Today is …" under it, the legend; "Manage equipment"
  and "New booking" stay. The timeline opens with the heading in view (today's column scrolled into view, not the
  heading scrolled out).
- Fidelity: frame 5 for the schedule; frame 1 for search results and the tag group heading; the Equipment screen
  for Tags; board 1 for forms. Compare every changed screen with `apps/e2e/scripts/mockup-compare.mjs` and record
  the differences. Both colour schemes; 360/390/430; honest states; real controls with labels.

As built in T-B (8 October 2026):

- **Search.** The header's magnifier (frame 1) opens a labelled field under the header; it searches after 300 ms
  without typing once there are 2 characters (at most 200), for the filter chosen (changing the filter searches
  again). Results replace the pinned rows and the groups: "n results" in the group-heading face, or "No threads
  match"; at most 50, with "Showing the best 50" when full. A title match marks the words in the title and keeps the
  latest message as the preview; a message match puts that message's excerpt, "Name: …", in the preview line. Marked
  words are bold on a sage tint. Clear (or the magnifier again) closes the field and the list returns as it was; the
  list's 15-second polling does not run while results are shown. Failures say so with Try again; a 429 waits.
- **Tags.** "Manage tags" is in a ⋯ menu at the end of the filter row; a tag heading has its own ⋯ menu (and a
  long-press) with "Tag details" and "Manage tags". `/tags` lists active tags (owner, dates, "n threads" from
  `GET …/tags?counts=true`, the threads the person can see) with "Show archived", and "Add a tag" opens a form in
  place (name, owner, starts, ends). `/tags/[id]` saves name, owner and dates as one change; Archive and Restore each
  need a confirm step and are offered only with no unsaved edits.
- **Repeat this task.** On a top-level task's unfolded card (steps have no card; a task already in a series shows
  "Part of <series> · Edit the series" instead). The form opens monthly, from the first day of the month the task is
  due in (or today's month), due as many days before that month's end as the task is due, with the task's owner and
  evidence rule; it says which period the task becomes and that it keeps the task's tags. The write is
  `POST …/series` with `fromTask` (T-A), so the task itself is that period's occurrence; afterwards the card says
  "Repeats monthly from 1 Oct 2026, due 10 days before the period ends." and "Part of … · Edit the series", which
  stays after a reload. `/series/[id]` edits the title and the same rule fields (one change), and Pause / Resume (its
  own change, offered with no unsaved edits); "changes apply to occurrences made from now on".
- **Schedule header.** The heading, the scale control, the stepper and the key are fixed above the timeline, so the
  heading is in view when the screen opens and the timeline under it opens on now (time runs down the timeline and
  equipment runs across, so "today in view" is the vertical position). The heading is "Equipment" (was "Equipment
  schedule"). "Today is …" under the day is the Today control (`equipment-today`). ‹ and › move the middle of the view
  to the next day's midday (a week on Weeks) and are disabled outside the loaded dates (Earlier or Later dates move
  them). The key is Confirmed, Maintenance (drawn differently, so named) and Cleaning; a booking's setup and cleaning
  time are drawn as their own pale blocks ("Cleaning to 3:30 pm"), the booking's bar holds its own time and its
  "6:00 am to 2:00 pm". Hours label the axis "6 am", a day's first hour names the day. "Manage equipment", Refresh,
  the zone, notices and what hatching means are above the names row in the scrolling part; "New booking" floats as
  before.

## 4. Tests

Real Postgres: search matches title and visible message text only (a non-participant never matches a private
thread's messages, nor learns it exists), ranking, the excerpt, the 2-character floor, the filter combined with
`q`; series created from a task carries its tags and owner and the occurrence links back; tag archive hides its
group. Client: pure tests for the forms, debounce and result rows; the real-API parser test extended; Playwright at
360/390/430 for tags (add, rename, owner and dates, archive, the group heading), repeat a task and edit the series,
search (results, no match, clear), the schedule header (scale switch, stepper); dark screenshots. Validation
record under `docs/validation/tags-series-search-2026-10/`.

## 5. Pull requests

| PR | Delivers |
|---|---|
| T-A | Search in the thread list API (and migration 0050 if needed), tests |
| T-B | Client: Tags screens, Repeat this task and series editing, search, the schedule header; comparisons |
| T-C | Staging release record |
