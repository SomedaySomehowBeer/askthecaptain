# Threads: the R2 contract

Status: **delivered to staging on 2 October 2026** ([release record](../validation/threads-2026-10-01/release.md)); root contract, 30 September 2026, for increment R2 of the
[chat-first rebuild](chat-first-rebuild-2026-09.md). Outcome: **discuss work** — every record has one
thread, the app is one list of threads, and a person can start a topic by writing its first message.
Implements D27, D28, D7 (projects are tags) and the migration half of D25 (decision 3 of the rebuild plan). It does not
implement versions (R3), the classifier or agents (R4), pending or approval cards (R5), files (R7)
or worksheets (R8); it leaves room for them without carrying anything for them.

The [linked-chat contract](linked-chat-2026-09.md) specified the private conversations that ship
today in migrations 0042/0043 (#169/#171/#173/#174). This contract replaces it. Where a rule below is
the same as linked chat, it says "as before" and the earlier section is the reference; where it is
silent, the earlier rule does not carry over.

## 1. Settled by the plan

- Every record — task, booking, stock item — has one thread (D27). A conversation with no
  record is a topic. Private threads between people stay participant-only (D25).
- **A project is a tag** (D7, amended in this PR): a name, and optionally an owner and dates.
  Nothing else is declared; a tag has no kind, no thread of its own and no planning task. Tasks
  and bookings have no project parent; a thread carries any number of tags, and the thread is the
  unit that is grouped. R2 makes this true in the schema, because the list is grouped by tag and
  keeping a `projects` table for one more increment would mean a second migration over the
  thread tables.
- A record thread is visible to whoever can see the record. Today every active member sees every
  record, because the record policies are member-wide; the thread policy reads the record's
  visibility through one function, so narrowing a record later narrows its thread with no thread
  change.
- One list, newest activity first, grouped by tag, fixed filters, pinned rows, no tabs (D28).
- Messages oldest to newest; a thread opens at the first unread, or at the newest (D28).
- The card is small: title, status, two facts side by side; everything else behind a fold-out.
- A new thread is an empty composer: the first message creates the topic (D33).
- Private threads never enter classification, summaries or agent routing (D25, amendment §1).
  R2 ships no inference at all, and proves the boundary structurally (§9).
- Pins, stars and read positions carry over (D25), with pins narrowed (owner's review, 1 October):
  a pin is visible to everyone who can see the thread, so only an owner or admin sets one, and a
  thread has at most one. A star is visible only to the person who set it. The latest-six item
  panel and its "conversations for this task" reads do not carry over.
- **The existing staging chats are demo data and are not kept** (owner's decision, 1 October 2026).
  0046 drops the 0042/0043 tables without copying them; two message stores would be a carry-over
  (rebuild plan decision 3), and so would a copy step for rows nobody needs. Nothing in the
  0042/0043 tables is production data: production has never run them.

## 2. Scope and non-goals

In R2:

- Migration `0046_threads.sql`: projects become tags; tags move onto threads; the thread tables,
  their policies and guards; backfilled record threads for existing tasks, bookings and stock
  items; and the 0042/0043 tables, `projects`, `task_tags` and every `project_id` column dropped
  in the same transaction.
- API: `/v1/organisations/:id/threads…` replacing `…/conversations…`; `/tags` gaining owner and
  dates; task, series and booking payloads losing `projectId`; the list with
  filters and tag groups; thread detail with its card; messages, sends, edits, deletes, pins, stars, read
  positions and the change feed, as before; topic creation from a first message; private creation
  and membership, as before.
- Client: the thread list, the thread screen with card and composer, the new-thread screen, and
  private creation from it.

Not in R2, and nothing here pre-builds it:

- Change lines from versions, approval cards, mentions, agents, Captain's messages (R3–R6). The
  message `kind` column exists so R3 can add change lines without altering the table; R2 writes
  and accepts only `message`.
- Files and People as populated filters (R7; companies and contacts get threads then). The two
  filter chips are listed and disabled with an honest hint.
- Summaries, notifications, Web Push for messages, native transport. Polling as before.
- Moving a message between threads, thread archive, search.

## 3. Tables

All tables carry `organisation_id`, composite foreign keys, forced row security with policies
`to captain_runtime, app`, and one `before insert or update` guard trigger per table, as in 0042.
Grants are select/insert/update only where a row is mutable; nothing is deletable by the runtime
except stars and thread tags (removing a tag deletes its `thread_tags` row). The two migration preconditions of 0042 (owner bypasses RLS; the runtime
role is safe) are repeated.

**`tags`** (amended). Columns added: `owner_id` (membership, nullable), `starts_on date` and
`ends_on date` (nullable, `ends_on >= starts_on`), `archived_at`, `revision` with the
`work_revision_bump` trigger, and `created_by`. That is the whole difference between Production
and Summer lager launch: the second has an owner and dates. The unique name per organisation
stays; names may be up to 120 characters (was 60), so every project name becomes a tag unchanged. The `projects` table is dropped; its `description`, `stages`, brief and proposal columns
and `system_kind` are not carried (0038 already removed the last system project; the release gate
in §8 reports how many projects hold a description, so the owner can copy any that matter into
a thread first).

**`thread_tags`** — `(thread_id, tag_id, attached_by, attached_at)` on **every** thread. This is
the one place a tag is attached to anything: a task's tags are its thread's tags, a booking's
project is a tag on its thread, a topic's tags are its own. `task_tags` is dropped after
its rows move. Deleting a tag removes its attachments; archiving keeps them. Removing a tag from a
thread deletes its row, so `thread_tags` is deletable by the runtime.

**`task_series_tags`** — `(series_id, tag_id)`: a series has no thread, and each occurrence it
creates receives the series' tags on the occurrence's thread, in the same transaction as the
task (the series materialiser does this in code; the record-thread trigger has already made the
thread). Replaces `task_series.project_id`.

**`threads`**

| Column | Notes |
|---|---|
| `id uuid pk` | Client UUID for topic and private threads (create retry, as before); server uuidv7 for record threads |
| `kind text` | `record`, `topic`, `private` |
| `task_id`, `reservation_id`, `stock_item_id` | Exactly one non-null when `kind = 'record'`, all null otherwise; composite foreign keys with `on delete cascade`; a unique index per column, so a record has at most one thread |
| `title text` | Topic and private threads only, 1–80 trimmed characters; null for record threads, whose title is the record's at read time |
| `create_fingerprint bytea` | Topic and private threads; as before, over `{ title, participantIds, firstMessageId }` |
| `created_by uuid` | Attribution only |
| `last_seq`, `last_change`, `last_message_at`, `revision` | As before |
| `created_at` | |

A task step (a task with `parent_id`) has no thread of its own; it is part of its task's thread.
A task's place is fixed when it is created: the step trigger refuses turning a top-level task into
a step or a step into a top-level task, since only one of them has a thread.
An `after insert` trigger on `tasks` (top-level only), `equipment_reservations` and
`stock_items` inserts the record thread in the same transaction, so the invariant "every record has
one thread" holds in the database and no service can forget it. The trigger is security invoker;
the thread insert policy allows a member to insert a record thread whose record is visible.

**`thread_participants`** — private threads only (the guard refuses any other kind). Columns and
transitions as `conversation_participants` in 0042/0043, including `read_start_seq`.

**`thread_messages`** — as `messages` in 0042/0043 plus `kind text not null default 'message'
check (kind in ('message', 'change', 'approval'))`. The R2 guard refuses any insert whose kind is
not `message`; R3 and R5 replace that guard when they write the other kinds.

**`thread_pins`** — as `message_pins` with `thread_id`, and one change: the partial unique index is
on `(thread_id) where unpinned_at is null`, so a thread has at most one live pin. The guard refuses
an insert by anyone whose membership role is not `owner` or `admin`. A pin references the message
id and never copies its text. Pinning a tombstone is refused.

**`thread_stars`**, **`thread_reads`** — as `conversation_stars` and `conversation_reads`, renamed,
with `thread_id`. Both are personal: the policies let a person read and write only rows whose
`user_id` is their own.

**`chat_audit_events`** keeps its name (D25 names it) and gains `thread_id` in place of
`conversation_id`. Every thread write is recorded here, for record and topic threads too; the
select policy is `thread_visible(thread_id)`, so a private thread's rows stay participant-scoped
and a shared thread's rows are readable by members. The tenant-wide `audit_events` receives no
thread or message identifier. Because the table is recreated empty, no conversation names are
kept: creating and renaming a thread are `chat.thread_created` and `chat.thread_updated`, tags add
`chat.tag_added` and `chat.tag_removed`, and the other actions are as before. Tag creation and edits stay in the tenant-wide
`audit_events`, as today; attaching a tag to a private thread is a thread write and goes here.

## 4. Access

Access is row level security on every table, as everywhere else in the schema. The policies call
one predicate, `thread_visible(thread_id uuid) returns boolean`, rather than repeating the test
in each of them, for two reasons: Postgres refuses a policy on `thread_participants` that selects
from `thread_participants` ("infinite recursion detected in policy"), so the participant check
has to live in a `security definer` function that reads the rows without re-entering their
policy, as `chat_participant` did in 0042; and eight tables share the same test, which one
definition keeps from drifting. The function is `stable`, takes no user argument, and reads the
caller's identity from the transaction's `app.user_id` and `app.organisation_id` settings like
every other policy.

It returns true when the caller has an active membership in the thread's organisation and
either the thread is `record` or `topic`, or the thread is `private` and the caller is an active
participant. **An active participant** is a person with a row in `thread_participants` for that
thread whose `state` is `active`: the creator gets one when the private thread is created, and
so does each person named in `participantIds`; a participant with the power to add people (the
creator, or an owner or admin participant) adds later ones; the row's state becomes `left` when
the person leaves or `removed` when removed, and from then on they are not a participant and the
thread is invisible to them, messages included. A record thread's visibility is its record's:
today that is active membership, because every record policy is member-wide; a migration that
narrows a record's policy must amend this function in the same file, and the access test in §9
fails until it does.

**A system routine** (a transaction with no person, such as the series materialiser) has no
membership, so `thread_visible` is false for it. The policies add one narrow allowance: with no
person in the transaction, record threads and their tags are readable and taggable, and a record
thread may be inserted by its record's trigger; messages, participants, pins, audit, topics and
private threads stay out of reach. Because chat audit records the person acting, tags the routine
attaches are recorded as `tagIds` on the occurrence's `task.materialised` row in `audit_events`
(task and tag ids only, never a thread id); when a person creates or edits a series, the same
attachment is their audited thread write.

Powers, for private threads: any participant sends and stars; the author edits and deletes; an
owner or admin participant deletes any message, pins and unpins; the creator and owners/admins
manage participants. For record and topic threads: any member sends, stars and tags; the author
edits and deletes; an owner or admin deletes any message, pins and unpins. Pinning is a role
power in R2; when R5 brings grantable privileges, pinning joins them. A private thread with no
owner or admin participant therefore has no pin until then. Renaming a topic: any member, with
`expectedRevision`. Attaching or removing a tag on a private thread: any participant; the tag's
name is then visible to participants only through the thread, and the tag's own listing never
counts or names private threads.

## 5. Identity, ordering and writes

As before (linked chat §4, §5, §6, §8, §9.4 and §9.5): client UUIDs and fingerprints for creates
and sends, dense `seq` and per-thread `change_seq` under the thread lock held to commit, revisions
on every mutable row, `expectedRevision` on every update, conflicts mapped to 409 only by exact
constraint name, and the change feed. Wire names follow the thread: messages carry `threadId`,
message pages and the change feed answer under a `thread` key, a read answers
`{ readPosition, unread }`, and an id held elsewhere is `409 thread_id_unavailable`. The
differences:

- **Topic creation is one request with the first message.** `POST …/threads` with
  `{ id, kind: 'topic', message: { id, body } }` creates the thread and its first message in one
  transaction; `seq` is 1, the title is the body's first line trimmed to 80 characters (the
  person can rename it), and the fingerprint covers the message id. A retry with the same ids and
  an equal fingerprint returns 200 and the current thread. `kind: 'private'` takes
  `{ id, title, participantIds, message? }`: the first message is optional there.
- **Tags** are added and removed with `POST/DELETE …/threads/:threadId/tags/:tagId`, each with
  `expectedRevision`, on any thread. The task and booking write routes lose `projectId` and gain
  nothing: tagging is a thread write, and the task tag routes `PUT/DELETE …/tasks/:id/tags/:tagId`
  are retired. A task's `tags` in its payload are read through its thread. Task and series bodies
  are strict, so a retired `projectId` is a 400, not silently ignored.
- **Series** take `tagIds` on create and update and return them; absent on update keeps them.
  Each new occurrence receives them on its thread (§3); existing occurrences keep their own.
- **Tags.** `POST …/tags { name, ownerId?, startsOn?, endsOn? }` and `PATCH …/tags/:tagId`
  (name, owner, dates, archive), which needs `expectedRevision`. `/v1/organisations/:id/projects…` and
  `…/projects/:projectId/reservations` are retired; the latter becomes
  `…/tags/:tagId/reservations` with the same query and shape.
- **Bookings.** A reservation's create and update inputs replace `projectId` with `tagIds`
  (attached to its thread in the same transaction). On a replace, `tagIds` absent keeps the
  thread's tags; present, the thread carries exactly those. The rule that a linked task's project must
  equal the booking's project is gone: a booking may carry tags its task does not.

## 6. Reads

**`GET …/threads`** — the list. Query: `filter` (`all`, `needs_you`, `tasks`, `bookings`,
`stock`, `records`; `files` and `people` are accepted and return an empty page with
`available: false`), `after` (an opaque cursor over `(last_message_at desc nulls last, id desc)`),
`limit` ≤ 50. One read-only snapshot returns:

```
{ filter, available, threads: [row], nextCursor, groups: [{ key, label, threads, needsYou }] }
```

- A `row` is `{ id, kind, title, record: { kind, id } | null, facts: [string, string], status,
  lastMessageAt, lastMessage: { authorName, excerpt } | null, unread, needsYou, starred,
  tags: [{ id, name }] }`. `excerpt` is the latest
  live message's first 120 characters; a private thread's excerpt is included only for participants,
  which the policy guarantees. `facts` are the two card facts below, always two strings, with
  these fallbacks: `No owner`, `No due date`, `Not counted`, `Never counted`, `Former member`
  for a deleted creator, `N people` for a private thread's count, and `''` as a topic's second
  fact. A booking's start is a UTC ISO timestamp; a counted date is the organisation's date.
- `needsYou` is true when `unread > 0`, or the thread's record is a task the caller owns that is
  not done or cancelled, or a booking the caller owns while it is confirmed and has not ended
  (bookings have no done state). Mentions join this in R4.
- `groups` is the heading summary over the **whole** filtered set, not the page: one entry per
  tag that any visible thread carries, plus `{ key: 'none', label: 'Other' }` for untagged
  threads, at most 100 entries by thread count (Other included in the 100), each with its thread count, its `needsYou` count
  and the tag's `owner` and `startsOn`/`endsOn` when it has them, for the heading. The client groups the loaded rows under these headings; a thread with several
  tags appears under each. Headings' counts are exact because they come from the same snapshot.
- `unread` is capped at 51, as before. A person's read position on a record or topic thread with
  no read row is 0: the whole thread is unread until they open it, which is the correct state for a
  thread they have never seen.

**`GET …/threads/:threadId`** — `{ thread: { id, kind, title, revision, lastSeq, lastChange,
readPosition, unread, starred, createdAt }, card, tags, participants, pin }`.
`participants` is present for private threads only. `pin` is the one live pin, `{ id, messageId,
pinnedBy, pinnedAt }`, or null. `GET …/pins` is retired; the change feed still carries pin
changes as before.

**`card`** by record kind, all computed by code from the record row:

| Record | Title | Status | The two facts |
|---|---|---|---|
| task | title | `status` | owner name, due date |
| booking | reservation title | `status` (`kind` maintenance shows as status) | equipment name, start |
| stock item | name | counted / not counted | count with unit, counted date |
| topic, private | title | — | created by, participant count (private) |

The fold-out holds the rest: the record's body or notes, all tags, and "Open the
record" for the record's own screen where one exists (equipment for
bookings; the Work screens are retired, so a task's fold-out shows its fields read-only until R3's
card editing).

**Messages, changes, pin, read** — `GET …/messages` with exactly one of `latest`, `after`,
`before` (≤ 100), `GET …/changes` and `POST …/read` as before. `POST …/pin { messageId }` sets
the thread's pin and answers `409 pin_exists` when one is live (unpin first; nothing is replaced
silently); `DELETE …/pin` clears it. Both are owner/admin only and audited as before.

## 7. Client

Routes: `/` (the list), `/threads/new`, `/threads/[id]`. The equipment schedule and settings stay
as they are. Everything is the Expo client; there is no other surface.

**The list.** Header, search placeholder (disabled, as now), the filter row with Files and People
disabled, the two pinned rows, then groups. A group heading shows the label, its thread count and
its needs-you count, and folds; the fold state is per device (`localStorage` / AsyncStorage,
best-effort). A row is one dense block: title and time on the first line; the two facts on the
second; the latest message on one line, prefixed with the author's first name; an unread count
pip when `needsYou`. Rows load 50 at a time with a "Show more" row. Poll every 15 s while visible
and focused, as before. "New thread" is a fixed button at the bottom right.

**The thread.** The card stays at the top and does not scroll; its chevron opens the fold-out
in place. The pinned message, when there is one, sits directly under the card as one line with a
pin mark; tapping it scrolls to the message. Messages render oldest first. On open, the client fetches `latest=50`; if `unread > 50`
it fetches `after=readPosition-1` instead, so the first unread is on screen, and shows one "Show
n earlier messages" row above the first loaded message that loads 50 more each time. The list
scrolls to the first unread message and marks it with a thin line; with nothing unread it opens
at the newest. The composer sits at the bottom: multi-line, send on button, the send retry and
locked-draft rules as before. A message shows author, time, body with links, "edited" and
"Message deleted". Long-press or a small menu offers edit, delete, pin and unpin within the
powers above; the menu shows only what the person may do. Tombstones, gaps and revision changes behave as before.

**New thread.** The composer and nothing else, focused on open. Send creates the topic and
navigates to it. A "Private" toggle reveals a member picker (from `GET …/members`) and a title
field; then send creates a private thread with that first message.

**States.** Every screen has the shell's loading, empty, failed and 429/backoff states, with
honest copy from `copy.ts`. Lost access is a 404 and the thread screen says the thread is no
longer available.

**Widths.** 360, 390 and 430 px; the list keeps one column; nothing overflows horizontally.

## 8. Migration and release

`0046_threads.sql` runs in one transaction:

1. Preconditions as 0042. Lock all eight 0042/0043 tables, `projects` and `task_tags` in access
   exclusive mode with a 30 s lock timeout, and the four record tables, `tags` and `saved_views` in
   share row exclusive mode. Two refusals stop the migration with nothing changed: two projects in
   an organisation whose names differ only by case or surrounding spaces (they cannot both become
   tags), and a `task_tags` row on a step (a step has no thread to carry it, so the count in step 4
   would fail). The owner renames or detaches first.
2. Drop the 0042/0043 tables and functions (step 5's notice first), because `chat_audit_events`
   keeps its name and its new shape must be created after the old table goes; one transaction, so
   the order is invisible. Then create the tables, functions, triggers, policies and grants above.
3. Projects become tags. For each project: if a tag with the same name (case-insensitive)
   exists, it takes the project's owner, dates and `archived_at` and keeps its id; otherwise a
   tag is created with the project's id, name, owner, `created_by`, `created_at` and
   `archived_at`. Counts: projects in equals tags written or updated.
4. Backfill record threads: one per top-level task, reservation and stock item,
   with `last_message_at` null. Then move tags onto threads: every `task_tags` row becomes a
   `thread_tags` row on the task's thread; every `tasks.project_id` and
   `equipment_reservations.project_id` becomes a `thread_tags` row on that record's thread;
   every `task_series.project_id` becomes a `task_series_tags` row. Each source count must equal
   the rows written (a task tagged with its own project twice counts once).
5. The 0042/0043 tables and functions go with their rows (`raise notice` with the row counts
   first, so the migration log records what went; done in step 2). Then drop `task_tags`, the three `project_id` columns
   with their constraints and indexes, and `projects`. No cascade. The migration invents no
   records. `chat_audit_events` is recreated empty with the new shape rather than altered.

Rollback is an image at or before the current main plus the Neon branch taken before the release,
which the release record names (it matters for the projects and tags, not the chats). The release
runs with HTTP stopped, as 0045 did.

**Gate before release (rebuild plan decision 7):** a read-only count of `projects` (and how many
have a non-empty description), `task_tags` and the rows holding a `project_id` in tasks, series
and reservations, on the staging machine, printed as status only (no bodies, no titles), recorded in the validation
folder. Ryan or root runs it; the increment is not released until it is recorded.

The rate-limit policy `chat changes` keys on the new path prefix; its limit and window do not
change. `x-captain-client` and the cookie session are unchanged.

## 9. Tests and evidence

Real Postgres, no skipped database test:

- Policy parity for every new table (`schema-policy.test.ts`).
- Access: a member sees a record and topic thread and its messages; a removed member sees 404; a
  non-participant sees 404 for a private thread, its messages, pins, tags, audit rows and
  change feed; the record's own screen never reveals a private thread.
- Migration: fixture rows in the 0042/0043 tables are gone after 0046 and the tables do not
  exist; the five tables' absence and the new tables' presence are asserted by name.
- Record threads: inserting a task, reservation and stock item creates exactly one thread each; a
  tag and a step create none; deleting the record deletes the thread.
- Projects to tags: fixture projects (one sharing a name with an existing tag, one archived),
  tasks with and without a project, a task tagged with its own project's namesake tag, a series
  and a reservation with a project, all migrate with the expected `thread_tags` and
  `task_series_tags` rows and no duplicate; counts match; the equipment overlap rule is
  untouched.
- Tags: owner and dates are optional and independent; `ends_on` before `starts_on` is refused;
  archive keeps attachments; a series occurrence receives the series' tags.
- Topic creation: one transaction, seq 1, title derivation, retry 200, mismatch 409.
- List: filters, cursor stability across a new message, `groups` counts versus rows, the
  100-heading cap, `needsYou` rules, unread cap, excerpt exclusion for a private thread.
- Pins: a member's pin is refused and an owner's accepted; a second live pin is 409; unpin then
  pin works; deleting the pinned message unpins it in the same transaction.
- Counters, retries, edits, deletes, stars, reads and the change feed: the existing chat tests
  moved to the new paths, not rewritten.
- Boundary: a script test asserts that `thread_messages`, `thread_participants` and
  `chat_audit_events` are referenced only from `apps/api/src/threads/`, so
  no other module can read private messages; R4 builds its inference boundary on this.

Client: pure tests for row and card derivation, grouping, first-unread positioning and the
composer state machine; harness scenarios for each state; Playwright on the export at the three
widths: the grouped list with a fold, opening a thread at the first unread and reading to the end,
sending a message, creating a topic from the new-thread screen, and a private thread invisible to a
second scripted person. A validation record under `docs/validation/threads-2026-10-…/`.

## 10. Pull requests

| PR | Delivers | Retires |
|---|---|---|
| T-A `feat(threads): projects as tags, thread model, migration and API` | 0046, `apps/api/src/threads/`, owner and dates on tags in `apps/api/src/tags/`, list/detail/messages/topic/private routes, rate policy, tests; reviewed as two commits (projects → tags; threads) | `apps/api/src/chat/`, `/conversations` and `/projects` routes, `projectId` on tasks/series/bookings, the task/project "conversations" reads |
| T-B `feat(client): thread list and thread screen` | `/`, `/threads/[id]`, card, composer, polling, checks | the empty list state |
| T-C `feat(client): new thread and private threads` | `/threads/new`, private creation, tags on topic and private threads, checks | — |
| T-D `docs(threads): record the staging release` | validation record, `paused.md`, the linked-chat contracts marked historical | — |

T-A is root's or an assigned Claude agent's; T-B and T-C go to Codex after R2a (#221); T-B may
start on T-A's branch once its API tests pass. Each PR names the outcome, links this contract,
lists checks with counts and states what is not covered.
