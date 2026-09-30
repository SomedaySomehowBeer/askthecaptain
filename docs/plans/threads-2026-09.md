# Threads: the R2 contract

Status: root contract, 30 September 2026, for increment R2 of the
[chat-first rebuild](chat-first-rebuild-2026-09.md). Outcome: **discuss work** — every record has one
thread, the app is one list of threads, and a person can start a topic by writing its first message.
Implements D27, D28 and the migration half of D25 (decision 3 of the rebuild plan). It does not
implement versions (R3), the classifier or agents (R4), pending or approval cards (R5), files (R7)
or worksheets (R8); it leaves room for them without carrying anything for them.

The [linked-chat contract](linked-chat-2026-09.md) specified the private conversations that ship
today in migrations 0042/0043 (#169/#171/#173/#174). This contract replaces it. Where a rule below is
the same as linked chat, it says "as before" and the earlier section is the reference; where it is
silent, the earlier rule does not carry over.

## 1. Settled by the plan

- Every record — task, project, booking, stock item — has one thread (D27). A conversation with no
  record is a topic. Private threads between people stay participant-only (D25).
- A record thread is visible to whoever can see the record. Today every active member sees every
  record, because the record policies are member-wide; the thread policy reads the record's
  visibility through one function, so narrowing a record later narrows its thread with no thread
  change.
- One list, newest activity first, grouped by tag, fixed filters, pinned rows, no tabs (D28).
- Messages oldest to newest; a thread opens at the first unread, or at the newest (D28).
- The card is small: title, status, two facts side by side; everything else behind a fold-out.
- A new thread is an empty composer: the first message creates the topic (D33).
- Private threads never enter classification, summaries or agent routing; the migration never
  broadens an existing conversation's audience (D25, amendment §1). R2 ships no inference at all,
  and proves the boundary structurally (§9).
- Shared pins and personal stars and read positions carry over (D25). The latest-six item panel and
  its "conversations for this task" reads do not.
- Retire the 0042/0043 tables after migrating staging data; two message stores would be a
  carry-over (rebuild plan decision 3).

## 2. Scope and non-goals

In R2:

- Migration `0046_threads.sql`: the thread tables, their policies and guards, backfilled record
  threads for existing tasks, projects, bookings and stock items, the private conversations
  copied across, and the 0042/0043 tables dropped in the same transaction.
- API: `/v1/organisations/:id/threads…` replacing `…/conversations…`; the list with filters and
  tag groups; thread detail with its card; messages, sends, edits, deletes, pins, stars, read
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
- Projects as tags (D7). R2 groups a task or booking thread under its project's name as well as
  its tags, so the list reads as the prototype does; the schema change that makes a project a
  tag belongs with the legacy work fields in R4.
- Moving a message between threads, thread archive, search.

## 3. Tables

All tables carry `organisation_id`, composite foreign keys, forced row security with policies
`to captain_runtime, app`, and one `before insert or update` guard trigger per table, as in 0042.
Grants are select/insert/update only where a row is mutable; nothing is deletable by the runtime
except stars and reads. The two migration preconditions of 0042 (owner bypasses RLS; the runtime
role is safe) are repeated.

**`threads`**

| Column | Notes |
|---|---|
| `id uuid pk` | Client UUID for topic and private threads (create retry, as before); server uuidv7 for record threads |
| `kind text` | `record`, `topic`, `private` |
| `task_id`, `project_id`, `reservation_id`, `stock_item_id` | Exactly one non-null when `kind = 'record'`, all null otherwise; composite foreign keys with `on delete cascade`; a unique index per column, so a record has at most one thread |
| `title text` | Topic and private threads only, 1–80 trimmed characters; null for record threads, whose title is the record's at read time |
| `create_fingerprint bytea` | Topic and private threads; as before, over `{ title, participantIds, firstMessageId }` |
| `created_by uuid` | Attribution only |
| `last_seq`, `last_change`, `last_message_at`, `revision` | As before |
| `created_at` | |

A task step (a task with `parent_id`) has no thread of its own; it is part of its task's thread.
An `after insert` trigger on `tasks` (top-level only), `projects`, `equipment_reservations` and
`stock_items` inserts the record thread in the same transaction, so the invariant "every record has
one thread" holds in the database and no service can forget it. The trigger is security invoker;
the thread insert policy allows a member to insert a record thread whose record is visible.

**`thread_participants`** — private threads only (the guard refuses any other kind). Columns and
transitions as `conversation_participants` in 0042/0043, including `read_start_seq`.

**`thread_links`** — a private or topic thread may point at one or more records (`task_id`,
`project_id`, `reservation_id`, `stock_item_id`, exactly one per row). It is shown as a chip on the
thread's row and card and never makes the thread visible from the record. Record threads have no
rows here. Existing `conversation_links` are copied across.

**`thread_tags`** — `(thread_id, tag_id, attached_by, attached_at)` for topic and private threads
only. Record threads group by their record: a task by its `task_tags` plus its project, a booking
by its project, a project by itself, a stock item under no tag.

**`thread_messages`** — as `messages` in 0042/0043 plus `kind text not null default 'message'
check (kind in ('message', 'change', 'approval'))`. The R2 guard refuses any insert whose kind is
not `message`; R3 and R5 replace that guard when they write the other kinds.

**`thread_pins`**, **`thread_stars`**, **`thread_reads`** — as `message_pins`, `conversation_stars`
and `conversation_reads`, renamed, with `thread_id`.

**`chat_audit_events`** keeps its name (D25 names it) and gains `thread_id` in place of
`conversation_id`. Every thread write is recorded here, for record and topic threads too; the
select policy is `thread_visible(thread_id)`, so a private thread's rows stay participant-scoped
and a shared thread's rows are readable by members. The tenant-wide `audit_events` receives no
thread or message identifier. Actions gain `chat.thread_created`, `chat.tag_added`,
`chat.tag_removed` and lose nothing.

## 4. Access

One definer function, `thread_visible(thread_id uuid) returns boolean`, replaces
`chat_participant`: true when the caller has an active membership in the thread's organisation
and either the thread is `record` or `topic`, or the thread is `private` and the caller is an
active participant. Every policy on the tables above uses it, so there is one place to read. A
record thread's visibility is its record's: today that is active membership, because every record
policy is member-wide; a migration that narrows a record's policy must amend this function in the
same file, and the access test in §9 fails until it does.

Powers, as before for private threads: any participant sends, pins and stars; the author edits and
deletes; an owner or admin participant deletes; the creator and owners/admins manage
participants. For record and topic threads: any member sends, pins, stars and tags; the author
edits and deletes; an owner or admin deletes any message. Renaming a topic: any member, with
`expectedRevision`.

## 5. Identity, ordering and writes

As before (linked chat §4, §5, §6, §8, §9.4 and §9.5): client UUIDs and fingerprints for creates
and sends, dense `seq` and per-thread `change_seq` under the thread lock held to commit, revisions
on every mutable row, `expectedRevision` on every update, conflicts mapped to 409 only by exact
constraint name, and the change feed. Two differences:

- **Topic creation is one request with the first message.** `POST …/threads` with
  `{ id, kind: 'topic', message: { id, body } }` creates the thread and its first message in one
  transaction; `seq` is 1, the title is the body's first line trimmed to 80 characters (the
  person can rename it), and the fingerprint covers the message id. A retry with the same ids and
  an equal fingerprint returns 200 and the current thread. `kind: 'private'` takes
  `{ id, title, participantIds, message? }`: the first message is optional there.
- **Tags** are added and removed with `POST/DELETE …/threads/:threadId/tags/:tagId`, each with
  `expectedRevision`, on topic and private threads only. A record thread's tags are changed on
  the record, as today.

## 6. Reads

**`GET …/threads`** — the list. Query: `filter` (`all`, `needs_you`, `tasks`, `bookings`,
`stock`, `records`; `files` and `people` are accepted and return an empty page with
`available: false`), `after` (an opaque cursor over `(last_message_at desc nulls last, id)`),
`limit` ≤ 50. One read-only snapshot returns:

```
{ filter, available, threads: [row], nextCursor, groups: [{ key, label, threads, needsYou }] }
```

- A `row` is `{ id, kind, title, record: { kind, id } | null, facts: [string, string], status,
  lastMessageAt, lastMessage: { authorName, excerpt } | null, unread, needsYou, starred,
  tags: [{ id, name }], project: { id, name } | null, links: [...] }`. `excerpt` is the latest
  live message's first 120 characters; a private thread's excerpt is included only for participants,
  which the policy guarantees. `facts` are the two card facts (§7).
- `needsYou` is true when `unread > 0`, or the thread's record is a task or booking the caller
  owns that is not done or cancelled. Mentions join this in R4.
- `groups` is the heading summary over the **whole** filtered set, not the page: one entry per tag
  and per project that any visible thread carries, plus `{ key: 'none', label: 'Other' }` for
  threads with neither, at most 100 entries by thread count, each with its thread count and its
  `needsYou` count. The client groups the loaded rows under these headings; a thread with several
  tags appears under each. Headings' counts are exact because they come from the same snapshot.
- `unread` is capped at 51, as before. A person's read position on a record or topic thread with
  no read row is 0: the whole thread is unread until they open it, which is the correct state for a
  thread they have never seen.

**`GET …/threads/:threadId`** — `{ thread: { id, kind, title, revision, lastSeq, lastChange,
readPosition, unread, starred, createdAt }, card, tags, project, links, participants, pins }`.
`participants` is present for private threads only. `pins` are live pins with their message ids.

**`card`** by record kind, all computed by code from the record row:

| Record | Title | Status | The two facts |
|---|---|---|---|
| task | title | `status` | owner name, due date |
| project | name | `state` | owner name, dates when the project has them, otherwise task counts |
| booking | reservation title | `status` (`kind` maintenance shows as status) | equipment name, start |
| stock item | name | counted / not counted | count with unit, counted date |
| topic, private | title | — | created by, participant count (private) |

The fold-out holds the rest: the record's body or notes, all tags, links, pins, and "Open the
record" for the record's own screen where one exists (equipment for bookings; the Work screens
are retired, so a task's fold-out shows its fields read-only until R3's card editing).

**Messages, changes, pins, read** — `GET …/messages` with exactly one of `latest`, `after`,
`before` (≤ 100), `GET …/changes`, `GET …/pins`, `POST …/read`, as before.

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

**The thread.** The card is pinned at the top and does not scroll; its chevron opens the fold-out
in place. Messages render oldest first. On open, the client fetches `latest=50`; if `unread > 50`
it fetches `after=readPosition-1` instead, so the first unread is on screen, and shows one "Show
n earlier messages" row above the first loaded message that loads 50 more each time. The list
scrolls to the first unread message and marks it with a thin line; with nothing unread it opens
at the newest. The composer sits at the bottom: multi-line, send on button, the send retry and
locked-draft rules as before. A message shows author, time, body with links, "edited" and
"Message deleted". Long-press or a small menu offers edit, delete, pin, unpin within the powers
above. Tombstones, gaps and revision changes behave as before.

**New thread.** The composer and nothing else, focused on open. Send creates the topic and
navigates to it. A "Private" toggle reveals a member picker (from `GET …/members`) and a title
field; then send creates a private thread with that first message.

**States.** Every screen has the shell's loading, empty, failed and 429/backoff states, with
honest copy from `copy.ts`. Lost access is a 404 and the thread screen says the thread is no
longer available.

**Widths.** 360, 390 and 430 px; the list keeps one column; nothing overflows horizontally.

## 8. Migration and release

`0046_threads.sql` runs in one transaction:

1. Preconditions as 0042. Lock the five 0042/0043 tables in access exclusive mode with a 30 s
   lock timeout, and the four record tables in share row exclusive mode.
2. Create the tables, functions, triggers, policies and grants above.
3. Backfill record threads: one per top-level task, project, reservation and stock item, with
   `last_message_at` null.
4. Copy conversations → threads (`kind = 'private'`, ids, titles, fingerprints, counters,
   timestamps kept), participants, links, messages (all `kind = 'message'`), pins, stars, reads,
   and `chat_audit_events` rows (re-pointed). Counts before and after must match per table, or the
   migration raises and nothing is dropped.
5. Drop the 0042/0043 tables and functions. No cascade.

Rollback is an image at or before the current main plus a restore of the 0042 data from the
pre-migration snapshot; the release record names the Neon branch or dump taken first. The release
runs with HTTP stopped, as 0045 did.

**Gate before release (rebuild plan decision 7):** a read-only count of the five 0042/0043 tables
on the staging machine, printed as status only (no bodies, no titles), recorded in the validation
folder. Ryan or root runs it; the increment is not released until it is recorded.

The rate-limit policy `chat changes` keys on the new path prefix; its limit and window do not
change. `x-captain-client` and the cookie session are unchanged.

## 9. Tests and evidence

Real Postgres, no skipped database test:

- Policy parity for every new table (`schema-policy.test.ts`).
- Access: a member sees a record and topic thread and its messages; a removed member sees 404; a
  non-participant sees 404 for a private thread, its messages, pins, links, tags, audit rows and
  change feed; the record's own screen never reveals a private thread linked to it.
- Migration: fixture rows in the 0042/0043 tables (two private conversations, one linked to a
  task, with pins, stars, reads and audit) survive 0046 with the same ids, seqs, audience and
  read baselines; a non-participant still cannot see them; counts match; a deliberate count
  mismatch aborts with nothing dropped.
- Record threads: inserting a task, project, reservation and stock item creates exactly one thread
  each; a step creates none; deleting the record deletes the thread.
- Topic creation: one transaction, seq 1, title derivation, retry 200, mismatch 409.
- List: filters, cursor stability across a new message, `groups` counts versus rows, the
  100-heading cap, `needsYou` rules, unread cap, excerpt exclusion for a private thread.
- Counters, retries, edits, deletes, pins, stars, reads and the change feed: the existing chat
  tests moved to the new paths, not rewritten.
- Boundary: a script test asserts that `thread_messages`, `thread_participants` and
  `chat_audit_events` are referenced only from `apps/api/src/threads/` and the migration test, so
  no other module can read private messages; R4 builds its inference boundary on this.

Client: pure tests for row and card derivation, grouping, first-unread positioning and the
composer state machine; harness scenarios for each state; Playwright on the export at the three
widths: the grouped list with a fold, opening a thread at the first unread and reading to the end,
sending a message, creating a topic from the new-thread screen, and a private thread invisible to a
second scripted person. A validation record under `docs/validation/threads-2026-10-…/`.

## 10. Pull requests

| PR | Delivers | Retires |
|---|---|---|
| T-A `feat(threads): thread model, migration and API` | 0046, `apps/api/src/threads/`, list/detail/messages/topic/private routes, rate policy, tests | `apps/api/src/chat/`, `/conversations` routes, the task/project "conversations" reads |
| T-B `feat(client): thread list and thread screen` | `/`, `/threads/[id]`, card, composer, polling, checks | the empty list state |
| T-C `feat(client): new thread and private threads` | `/threads/new`, private creation, tags on topic and private threads, checks | — |
| T-D `docs(threads): record the staging release` | validation record, `paused.md`, the linked-chat contracts marked historical | — |

T-A is root's or an assigned Claude agent's; T-B and T-C go to Codex after R2a (#221); T-B may
start on T-A's branch once its API tests pass. Each PR names the outcome, links this contract,
lists checks with counts and states what is not covered.
