# Linked chat: contract and PR sequence

Status: **adopted, pending merge of its plan PR** (revision 5), 26 September 2026. That PR applies
the §11 amendments to `AGENTS.md` and `docs/plan.md`, and adoption takes effect when it merges.
There is still no code, and no tables or migrations exist.

Peer reviews r3 and r4 and root's concurrence are incorporated:
- **Counters.** Per-column rules. A send moves only `last_seq` and `last_change`; `revision` moves
  only for metadata, participant and link changes.
- **Leave audit.** Its audit row is written before the access-ending change, atomically.
- **ID collisions.** Every exact ID-collision constraint, including the composite organisation-plus-ID
  keys, maps to the generic "unavailable" `409`. Unknown constraints never do.

This contract is adopted by a **separate plan PR** (not #159), which applies the §11 AGENTS and
plan amendments. Chat code starts only after that PR merges. The remaining items in §17 are PR B
execution gates, proven by tests on real Postgres; none is a precondition for adoption. Outcome: **discuss work** (plan §2). Authority: D6, D7, D11,
D13, D14, D23 and D25; plan §5 ("Chat" row) and §10; the
[next-batch checklist](captain-next-batch-2026-09-25.md); and the reviewed
[mobile mockups](../proposals/assets/captain-mobile-2026-09-22/README.md).

**Summary.** A conversation is a private group of explicitly named, active organisation members.
It can be linked to tasks and projects. It holds plain-text messages with retry-safe identities and
a single per-conversation order. Shared pins, personal stars and read positions come next, then the
web. Transport is bounded polling within the current rate limits. There is no new service, process,
dependency, realtime transport, rate-limit relaxation, runtime RLS bypass or inference. Summaries
stay "Summary unavailable" until a separate D2 contract exists. Every person's write is checked **in
the database**, by RLS plus row-transition triggers (§9). The service repeats the checks only to
give good error messages.

## 1. Settled product choices (root)

- **Participants and history.** Participants are explicit. Adding someone shares the full history,
  and the add control discloses this before confirming. There is no automatic "General" or everyone
  conversation, and no orphan recovery.
- **Deferred.** Tasks from messages.
- **Moderation.** An organisation owner or admin **who is a participant** may remove participants
  and **tombstone** other people's messages. They can never edit another person's text.
- **Removal from the organisation** ends participation. Reactivating the membership restores
  nothing; only an explicit re-add by a participant does.
- **Export.** No elevated or complete chat export.
- **Later slices.** Edits arrive in PR C.
- **Pins.** All live pins are always visible above the recent messages.
- **Polling** stays within the current limits, with explicit 429 handling. Measure before changing
  any limit.

## 2. Scope and non-goals

In order:
1. Conversations, participants, messages and task/project links (PR B).
2. Pins, stars, read positions and edits (PR C).
3. Web (PR D).

Out of scope until separately adopted:
- **Excluded features:** file-version links (after the Files contract), threads, reactions,
  mentions, attachments, search, mute, chat push notifications, native client work, tasks from
  messages, everyone conversations.
- **Summaries:** any summary or model call.

Mockup controls without a contract do not appear. Summary areas say "Summary unavailable", and
snippets are labelled as latest-message excerpts. A message, pin or star never changes work.

## 3. Audience and powers

- **Access** needs an active participant row and an `active` organisation membership. Without both,
  nothing is visible: not the conversation's existence, title, participants, links, messages, pins,
  unread count or chat audit. This includes owners, admins and export.
- **Create** (§6, §9): any active member. Creating grants no lasting power. Once the creator has
  left or been removed, they have no access.
- **Add** (up to 50 participants in total), **leave**, **remove others** and **tombstone others'
  messages** each follow the rules in §1 and are enforced by §9's transition rules.
- **Orphans.** A conversation with no active participants is unreachable and kept until the
  organisation is deleted. Archived or finished work may be linked.

## 4. Identity, ordering and revisions

| Record | Identity | Mutable state |
|---|---|---|
| Conversation | Client UUID; immutable `create_fingerprint` | `title`; counters; `revision` |
| Participant | `(conversation_id, user_id)` | `state` active/left/removed, `ended_at` |
| Link | Server uuidv7; unique per target | Created or removed |
| Message | Client UUID; immutable `seq`; `sent_body_sha256` kept while live | `body` (author edit), tombstone fields, `revision`, `change_seq` |
| Pin (PR C) | Server uuidv7; at most one live pin per message | `unpinned_at/by`, `change_seq` |

- **Counters.** The conversation row holds `last_seq` and `last_change`, and the service advances
  them first under the conversation lock:
  - a send takes `seq = last_seq + 1`, which is dense, gap-free and immutable;
  - every message or pin mutation takes a fresh `change_seq = last_change + 1`.

  Triggers check that the values written equal the conversation's new counters (§9).
- **Conversation writes.** Title, add, remove, leave, link and unlink all require
  `expectedRevision`. A mismatch is `409 stale_revision` with no write. After an uncertain result the
  client re-reads: if the intended state holds, the write is done; otherwise the person chooses
  again. Nothing retries automatically.
- **Message writes.** Edit and delete require the message's `expectedRevision`.
- **Create retry.** The fingerprint is `sha256` of the normalised original
  `{ title, participantIds sorted, links sorted }`.
  - The same ID, from the same creator while still an active participant, with an equal fingerprint
    gets `200` and the **current** conversation.
  - Anything else gets `409 conversation_id_unavailable`.
- **Send retry.** The same ID, author and conversation, with an equal hash of the original
  normalised body, gets `200` and the current message, even after an edit. Deletion clears the hash,
  so a retry after deletion is `409`. Hidden or foreign IDs get the same `409`.
- **Mapping conflicts to 409s.** Conflicts map to these errors **only by exact constraint name**
  (§9). Any other unique violation stays a `500`.
- **Web.** Pending creates and sends persist in tab sessionStorage before sending, scoped by user and
  organisation, and stay locked until reconciled (#154).

## 5. Messages

- **Body.** Plain text, 1–4,000 code points, at most 16 KB UTF-8, trimmed at the ends. Rendered as
  text, with URLs auto-linked on display only.
- **Delete** (the author, or a participant who is an owner or admin).
  - It makes a content-free tombstone: the body and hash are cleared; `deleted_at`, `deleted_by`, a
    new `revision` and a new `change_seq` are set; `id`, `seq`, `created_at` and author are kept.
  - It displays as "Message deleted".
  - Any live pin on it is unpinned in the same transaction, with the **next** `change_seq`.
  - A second delete is 404.
- **Edit** (PR C). The **author only**, with `expectedRevision`. It changes the body and sets
  `edited_at`, and keeps no history. A moderator can never change another person's body except to
  tombstone it.
- **Leaving** never deletes messages.

## 6. Lock order

**Global order**, for every path that touches chat or memberships:
1. `memberships` rows for every affected person, **sorted by `user_id`**, one statement each, taken
   in the **final** mode at first acquisition, so a lock is never upgraded:
   - `for share` for people whose membership row does not change;
   - `for no key update` for a membership row the transaction will update (its status or role).
     This is the mode the `UPDATE` itself takes, and it does not block unrelated inserts that
     reference the row, such as equipment reservations.
2. `conversations` rows, sorted by `id`, `for update`.
3. Participant rows.
4. Message rows.
5. Pin rows.

Nothing locks a membership after a conversation.

- **Create.** Lock the caller and **every named participant** (`for share`, sorted) first. Then call
  the bootstrap (§9); its own lock on the caller is already held. **Only if it returns `created`**,
  add the named participants and links in the same transaction. When it returns `matched`, the
  service reads and returns the current conversation and writes nothing. When it returns
  `unavailable`, the result is a `409`.
- **Send.** The sender's membership (share), then the conversation, then insert.
- **Add.** The actor's and targets' memberships (share, sorted), then the conversation. Every target
  must be active, otherwise `400 participant_unavailable` (atomic). The participant cap is checked
  under the conversation lock.
- **Remove or leave.** The actor (share) and target (share: the membership itself does not change),
  sorted, then the conversation.
- **`OrganisationService.remove`**, refactored in PR B:
  1. Lock the actor `for share` and the target `for no key update`, sorted by `user_id`. When
     someone removes themselves, that is one row, `for no key update`. When the target is an owner,
     also lock the other active owner rows `for share` in the same sorted sequence.
  2. Re-validate under those locks: the actor is active, their **current** role permits the removal
     (or it is self-removal), the target is active, and the owner and last-owner rules hold. A
     concurrent demotion or removal that committed first gives `403` or `404`.
  3. `update memberships set status = 'removed'`.
  4. `select chat_end_membership(target)`.
  5. The existing `membership.removed` row in `audit_events`, with no chat data.
- **`setRole`** follows the same sorted order and modes: the target is `for no key update` because
  its role changes, and the actor is `for share`.

## 7. Links, both ways, without leaks

- **Link.** An active participant, with `expectedRevision`, may link a task or project in the same
  organisation, up to 10 links. Links use composite foreign keys to `tasks(organisation_id, id)` and
  `projects(organisation_id, id)`; both unique keys exist (0002_commitments.sql). They are
  `on delete cascade`.
- **Chat to work.** Detail shows each link's kind, ID, current title and state.
- **Work to chat.** `…/tasks/:id/conversations` and `…/projects/:id/conversations` return only the
  caller's active conversations: at most 20, with no count or hint about others. Work payloads gain
  no chat fields.

## 8. Reads, change feed and convergence

- **Display pages.** `GET …/messages` takes exactly one of `latest=n`, `after=seq` or `before=seq`
  (limit up to 100). It returns
  `{ conversation: { id, revision, lastSeq, lastChange }, messages, hasMore }` from one statement
  snapshot. Tombstones come back with a null body.
- **Sync.** `GET …/changes?after=<n>&limit=<≤100>` runs in one read-only snapshot and returns
  `{ conversation: { id, revision, lastSeq, highWater }, changes, next, complete }`.
  - Each change is either `{ changeSeq, kind: 'message', message }` or
    `{ changeSeq, kind: 'pin', pin }`.
  - The query selects rows with `after < change_seq ≤ highWater` in `change_seq` order, fetching
    `limit + 1`.
  - `next` is the last delivered change when there are more, otherwise `highWater`.
  - `change_seq` is assigned under a lock held until commit, so nothing above the cursor is ever
    skipped.
- **Convergence, not exactly-once delivery.** A row edited between pages reappears at a higher
  number. The client upserts by entity ID, keeping the higher `changeSeq`. After `complete = true`,
  its copy equals the server's state at that snapshot.
- **Delete and unpin.** The unpin is always numbered after the tombstone. A pin whose message is
  known locally to be deleted is **never rendered**, even before the pin's unpin change arrives. No
  single response needs to carry both.
- **Gaps and metadata.** Gaps are detected only in message `seq`. A change of `revision` makes the
  client refetch conversation detail.
- **Lost access** returns 404 everywhere. A pending send is confirmed only when its ID appears.

## 9. Database security: functions, policies and transition triggers

### 9.1 Migration preconditions

- **Owner check.** The migration first asserts that its owner is `rolsuper` or `rolbypassrls`, and
  aborts otherwise (the 0038 pattern). Under forced RLS, a definer function owned by a non-bypassing
  owner would itself be filtered.
- **Function hardening.** Every function below is created with
  `set search_path = pg_catalog, public, pg_temp`, then `revoke all … from public`. Only the three
  callable functions are `grant execute … to app`.
- **`app` stays non-bypassing** (`rolbypassrls = false`, already tested by `schema-policy.test.ts`).
- **No broader bypass** and no hosted-infrastructure change.

### 9.2 Callable definer functions (the only elevated paths)

1. **`chat_participant(conversation_id uuid) → boolean`** (stable). True only when:
   - the organisation is `current_organisation_id()`;
   - the user is `current_user_id()`;
   - the participant row is `active`;
   - the membership is `active`.

   It takes no user argument.
2. **`chat_create_conversation(id uuid, title text, fingerprint bytea) → text`**, the bootstrap.
   - **Checks and locks.** The caller must be an active member of the current organisation. It
     locks the caller's membership `for share`; this is a no-op after §6's create locks. It
     validates the title (1–80 characters trimmed) and the fingerprint (32 bytes).
   - **New ID.** It runs `insert into conversations … on conflict (id) do nothing`, inserts exactly
     one participant row for the caller only, writes `chat.conversation_created` to chat audit, and
     returns `created`.
   - **Existing ID.** If the insert did nothing, it returns `matched` only when the row belongs to
     this organisation, was created by the caller, the caller is still an active participant, and
     the fingerprint is equal. In every other case it returns `unavailable`, and never reveals
     which.
   - **Limits.** It never touches another person's row, and never updates an existing
     conversation.
3. **`chat_end_membership(target uuid) → void`.**
   - **Caller.** The caller is an active owner or admin of the current organisation, or is `target`
     (leaving the organisation).
   - **Target.** `target`'s membership there must already be `removed`.
   - **Locks.** Its first step locks, in `user_id` order, the caller `for share` and the target
     `for no key update`. When the caller is the target, it takes only the target, `for no key
     update`. These are exactly the modes the service already holds, so no lock is upgraded.
   - **Effect.** It then locks the target's active conversations in `id` order, sets their
     participant rows to `removed`, bumps each revision, and writes one `chat.participant_removed`
     chat-audit row each, with `actor_id` = the caller.
   - **Result.** It returns nothing, so no count reaches a non-participant caller.

### 9.3 RLS policies (all `to app`)

`P(x)` means `chat_participant(x)`. `org` means `organisation_id = current_organisation_id()`. `me`
means `current_user_id()`.

| Table | select | insert with check | update using / check | delete | Grants |
|---|---|---|---|---|---|
| `conversations` | `org and P(id)` | none (bootstrap only) | `org and P(id)` / `org` | none | select, update |
| `conversation_participants` | `org and P(conversation_id)` | `org and P(conversation_id) and added_by = me` | `org and P(conversation_id)` / `org` | none | select, insert, update |
| `conversation_links` | `org and P(conversation_id)` | `org and P(conversation_id) and linked_by = me` | none | `org and P(conversation_id)` | select, insert, delete |
| `messages` | `org and P(conversation_id)` | `org and P(conversation_id) and author_id = me` | `org and P(conversation_id)` / `org` | none | select, insert, update |
| `chat_audit_events` | `org and P(conversation_id) and (not personal or actor_id = me)` | `org and P(conversation_id) and actor_id = me` | none | none | select, insert |
| `message_pins` (C) | `org and P(conversation_id)` | `org and P(conversation_id) and pinned_by = me` | `org and P(conversation_id)` / `org` | none | select, insert, update |
| `conversation_stars` (C) | `org and P(conversation_id) and user_id = me` | same | none | same | select, insert, delete |
| `conversation_reads` (C) | `org and P(conversation_id) and user_id = me` | same | same / `org and user_id = me` | none | select, insert, update |

- **Why update checks only `org`.** Updates use a participation `using` clause on the old row plus
  an `org`-only `with check`. The new-row participation check would refuse a person's own leave.
  **Everything else about an update is decided by the transition triggers in §9.4.**
- **Audit before losing access.** The `chat_audit_events` insert policy requires the writer to be a
  participant. So any write that ends the **actor's own** access (leaving) inserts its audit row
  **before** the participant row changes, in the same transaction. If the state change then fails,
  the audit row rolls back with it. If the audit insert fails, the leave is never attempted.
  Removals of *other* people are audited after the change, because the actor stays a participant.
  `chat_end_membership` writes as the definer, so its order does not matter.
- **No existence oracle.** Every insert naming a `conversation_id` passes `P(conversation_id)` in
  its `with check` before any foreign key is checked. A nonexistent conversation and an existing
  inaccessible one therefore fail identically.

### 9.4 Row-transition triggers (enforced in the database for every role)

Each table gets one `before insert or update` trigger function. These functions are `security
invoker` and not callable by `app`: they are revoked from public and not granted. They compare `old`
and `new` and **raise `check_violation`** for anything not listed. They read only rows the current
role can already see: `memberships` of the current organisation, and the locked conversation row.
The shared predicates are:
- `admin(me)`: `me` has an active membership in the organisation with role owner or admin;
- `active(u)`: `u` has an active membership in the organisation;
- `gone(u)`: no membership row for `(organisation_id, u)` exists any more.

**Rule A, attribution nulling, on every chat table.** An update whose **only** changes are
attribution columns moving from a value to `null`, each satisfying `gone(old value)`, is allowed on
any row, including tombstones, unpinned pins and chat-audit rows.
- **What it covers.** This is exactly the referential `on delete set null (x)` action. It needs no
  participant or caller check.
- **The attribution columns** are `created_by`, `added_by`, `linked_by`, `author_id`,
  `deleted_by`, `pinned_by`, `unpinned_by` and `actor_id`.
- **No bumps.** Rule A updates **skip** the revision bump and change no counter or `change_seq`,
  because nothing visible changed except the "Former member" label.
- **Evaluated first.** The revision-bump logic is part of the same trigger function, so it cannot
  run before or without this check.

**`messages`:**
- **Insert:**
  - `author_id = me`, and `active(me)`;
  - `seq` and `change_seq` equal the conversation's current `last_seq` and `last_change`, which the
    service has just advanced;
  - body and hash are both present, and no tombstone fields are set.
- **Author edit** (PR C). The old row is live and `me = old.author_id`. Only `body`, `edited_at`,
  `revision` and `change_seq` change. `revision` becomes old + 1 and `change_seq` equals the
  conversation's current `last_change`. The hash does not change.
- **Tombstone.** The old row is live, and either `me = old.author_id` or `admin(me)`.
  - The new row has `body = null`, `sent_body_sha256 = null`, `deleted_at` set, `deleted_by = me`,
    `revision` = old + 1, and `change_seq` equal to the conversation's current `last_change`.
  - Nothing else changes. In particular, a moderator cannot put any text in `body`.
- **Anything else** is refused, including any change to `id`, `organisation_id`,
  `conversation_id`, `seq`, `created_at`, or `author_id` other than Rule A. Any update to a
  tombstone other than Rule A is refused.

**`conversation_participants`:**
- **Insert (add).**
  - `state = 'active'`, `added_by = me`, `active(user_id)`;
  - either the caller is already an active participant (checked by the RLS `with check`), or this
    is the bootstrap row. The bootstrap row is the only case where the function inserts as the
    owner, and the trigger still runs. It requires all of:
    - the row's `user_id = me`;
    - the conversation's `created_by = me`;
    - no participant rows exist yet for that conversation.
- **Active → left.** Only when `user_id = me`. It sets `ended_at`.
- **Active → removed.** Allowed in either of two cases:
  - `user_id <> me` and `admin(me)`: an admin who is a participant, because RLS `using` requires
    participation;
  - `not active(user_id)` and the target's membership status is `removed`: the
    `chat_end_membership` path. This case cannot hurt, because that person has already lost
    access.
- **Left or removed → active (re-add).** Only when `user_id <> me`, `active(user_id)` and
  `added_by = me`. The caller must be an active participant (RLS `using`). This is the only way back
  in: an explicit add by a participant, never through reactivating a membership.
- **Anything else** is refused, including changes to the conversation, organisation or user.

**`conversations`:**
- `create_fingerprint`, `id`, `organisation_id` and `created_at` are fixed; `created_by` changes
  only through Rule A.
- **Per column, per update statement:**
  - `last_seq` is either unchanged or `old + 1`;
  - `last_change` is either unchanged or `old + 1`;
  - `revision` is either unchanged or `old + 1`;
  - `last_message_at` never decreases.
- **What each change may move:**
  - A **send** moves only `last_seq`, `last_change` and `last_message_at`. `revision` stays unchanged.
  - A message **edit or tombstone**, or a **pin or unpin**, moves only `last_change`.
  - A **metadata change** (title), **participant change** (add, leave, remove, and the
    `chat_end_membership` update) or **link change** moves `revision` by exactly 1, and moves neither
    `last_seq` nor `last_change`.

  An update that combines the two groups (message counters with `revision`) is refused. So
  `revision`, which makes clients refetch detail (§8), moves only for metadata, participant and
  link changes.
- Only the counters, `revision`, `title` (1–80) and `last_message_at` may change.

**`conversation_links`:** there is no update path except Rule A.

**`chat_audit_events`:** there is no update except Rule A, and no delete path for `app`.

**`message_pins`** (C):
- **Insert.** `pinned_by = me`, the message is live, and `change_seq` equals the conversation's
  current `last_change`.
- **Live → unpinned.** `unpinned_by = me` and `unpinned_at` are set, with a fresh `change_seq`. Any
  participant may unpin, as the product requires.
- **After unpinning,** only Rule A applies.

**`conversation_reads`** (C): `last_read_seq` only increases. **`conversation_stars`**: insert and
delete only.

**Conflicts (item 6).** They map by exact constraint name only:
- **Conversation ID collisions:** `conversations_pkey` and the composite
  `conversations_organisation_id_id_key`.
  - The bootstrap uses `on conflict (id) do nothing`. A concurrent insert of the same ID by another
    person, in the same or another organisation, can still raise a unique violation on the
    non-arbiter composite key.
  - The bootstrap therefore catches a `unique_violation` on **either** of these exact names and
    returns `unavailable`, which the service maps to `409 conversation_id_unavailable`.
    Its PL/pgSQL exception block is a subtransaction, preserving the caller transaction.
- **Message ID collisions:** `messages_pkey` and the composite `messages_organisation_id_id_key`.
  The composite key exists as the target of the pin foreign keys.
  - An empty result from `insert … on conflict (id) do nothing returning`, or a unique violation on
    either of these exact names, is handled the same way. The service first checks the caller's own
    row under the conversation lock (an identical retry returns `200`), and otherwise returns
    `409 message_id_unavailable`. Catch a unique violation inside a savepoint, or retry the lookup
    in a fresh transaction; never query a transaction left aborted by the failed insert. Prefer
    a savepoint; a fresh transaction must reacquire the §6 membership and conversation locks.
- Every generic `409` has the same body, whoever holds the ID.
- `message_pins_live_message` (the partial unique index on live pins): `409 message_already_pinned`.
- `conversation_links_target` (unique on conversation and target): `409 link_exists`.

Every other unique violation, including `messages_conversation_seq`,
`messages_conversation_change` and any constraint not named here, is a `500`, because it means a
bug. Unknown constraint names are never mapped to a `409`.

## 10. Audit (participant-scoped) and export

- **Where chat is audited.** Chat writes never write to the tenant-wide `audit_events`. Every chat
  write, including stars and read advances, writes exactly one row to `chat_audit_events` in the
  same transaction. The row holds IDs and counters only. It is append-only, with only Rule A
  nulling. A leave writes its audit row **before** the participant row changes (§9.3).
- **Actions** are `chat.conversation_created` / `_updated`, `chat.participant_added` / `_removed` /
  `_left`, `chat.link_added` / `_removed`, `chat.message_sent` / `_edited` / `_deleted`,
  `chat.pin_added` / `_removed`. The personal actions are `chat.star_set` / `_cleared` and
  `chat.read_advanced` (read advances are sent at most once per 15 s, and only when they move
  forward).
- **Who sees it.** Participants see the shared rows; only the actor sees their personal rows. The
  existing `membership.removed` row in `audit_events` carries no chat data.
- **Export** is owner or admin, as today. RLS limits every chat table to the exporter's own
  conversations and personal rows.
- **Deletion.** Organisation deletion cascades, and chat tables are left out of `rowCounts`.
- **Files.** `apps/api/src/organisations/lifecycle.ts` changes in PR B:
  - the `uncounted` set gains every chat table: `conversations`, `conversation_participants`,
    `conversation_links`, `messages`, `chat_audit_events`, then `message_pins`,
    `conversation_stars` and `conversation_reads` in PR C;
  - the export header `notes` gains: "Chat tables hold only conversations the exporting person
    participates in, and only that person's stars and read positions; other members' conversations
    are not exported, so this is not a complete chat backup."
  - No `exportOnly` filter is needed: content-free tombstones are exported as tombstones.
- **Root's documents.** The privacy notice and export documentation need matching chat lines (item
  8).

## 11. Required plan and AGENTS amendment (blocking adoption)

Root accepts participant-scoped, append-only chat audit, and §9's database security has been
peer-reviewed through r4. The adopting plan PR (PR A, not #159) applies the following amendments,
which take effect when it merges:
- **AGENTS.md**, "Writes are plain writes": replace "and recorded in `audit_events`" with "and
  recorded in `audit_events`, except private chat records (D25), which are recorded in the
  participant-scoped, append-only `chat_audit_events` so audit never reveals a private conversation
  to nonparticipants". The rule that writes are role-checked inside RLS is **unchanged**, and chat
  satisfies it through §9.3 and §9.4.
- **plan.md §5**, "Workflow/inference/audit" row: add "Private chat writes are audited in
  participant-scoped `chat_audit_events` (D25)."
- **plan.md D25**: append "Chat writes, including personal stars and read positions, are audited in
  the participant-scoped `chat_audit_events`; the tenant-wide `audit_events` receives no chat
  identifiers."
- **plan.md §5**, "Chat" row: link this contract and name the tables `conversations`,
  `conversation_participants`, `conversation_links`, `messages`, `chat_audit_events`,
  `message_pins`, `conversation_stars` and `conversation_reads`.

D4 needs no change: it governs workflows, and this contract adds no workflow chat writes.

## 12. Account and organisation deletion

- **Attribution columns** use
  `(organisation_id, x) references memberships(organisation_id, user_id) on delete set null (x)`.
  That form needs PostgreSQL 15 or later. Migrations already use native `uuidv7()`, which means
  PostgreSQL 18 on CI and staging. Neon's version is confirmed at PR B.
- **Account deletion.** `users` rows are deleted, which cascades to their `memberships`.
  - Participant, star and read rows cascade and are deleted.
  - All attribution columns elsewhere are nulled by referential updates. Rule A (§9.4) admits
    those updates on live rows, tombstones, unpinned pins and audit rows alike, without revision
    bumps.
- **Organisation deletion.** The organisation row cascades to memberships and to every chat table.
  Whatever order PostgreSQL runs these in, each step succeeds:
  - a chat row already deleted by the organisation cascade needs no nulling;
  - a chat row nulled first satisfies Rule A, because its membership is gone;
  - its own cascade then deletes it.

  No trigger blocks a delete. The transition triggers are `before insert or update` only, and
  `app` holds no `delete` on protected tables.
- **Display.** A null author shows as "Former member".

## 13. Pins, stars and read positions (PR C)

- **Pins.**
  - Any participant may pin or unpin, up to **50 live pins**, one per message.
  - A pin references the message ID and never copies its text.
  - `GET …/pins` returns every live pin in one snapshot.
  - The web renders **every live pin** above the recent messages, with no collapsing. Pins are keyed
    by message ID, and each message appears once in the stream.
- **Stars** are personal and idempotent, audited as personal, and hidden while the person is not
  participating.
- **Read position.**
  - `POST …/read { seq }` stores `max(stored, min(seq, last_seq))`.
  - It is sent only by the full chat, for a message it has displayed while visible.
  - It starts at the conversation's `last_seq` on create, add and re-add, set in the same
    transaction. The PR C migration backfills every active participant.
  - Unread is live messages by others above the read position, shown capped as "50+". There are no
    read receipts.

## 14. Transport within current limits

These limits are **not relaxed**, and no trusted header or bypass is assumed:
- **per IP: 300/min**, shared by every web user, because all calls come from the web machine;
- **per organisation: 1,200/min**;
- **per user: 600/min.**

A poll costs two requests: the session read and the chat read.

- **Full chat.** Polls every **15 s**, only in the visible, focused tab. When the tab is hidden it
  stops, then makes one catch-up request on return. It also stops after 10 minutes idle. Only one
  poll runs per tab.
- **Item panels.** Load once, then only a manual "Check for new messages".
- **429.** The web honours `Retry-After` (PR D adds it to `ApiError`), capped at 5 minutes. A
  write that gets a 429 was **not processed**: the draft keeps its ID and stays editable, and
  nothing retries automatically.
- **Other failures.** Reads back off to at most 60 s. A write with an unclear result stays pending
  and locked.
- **Scope.** Server actions carry the page's user and organisation scope and verify it (#154). A
  mismatch stops polling and offers a reload.
- **Capacity and writes.** About 12 concurrently visible chats fit within the shared per-IP budget.
  PR D measures this on staging. There is one new write policy, `chat writes`, at 30 per minute per
  user per organisation.

## 15. PR sequence and files

- **PR A (docs).** A separate plan PR by root: this contract plus the §11 amendments. It is not part
  of #159, and chat code starts only after it merges.
- **PR B, migration `0041_chat_core.sql`** (the number is checked at implementation), with files:
  - Migration and schema:
    - `packages/db/migrations/0041_chat_core.sql`: tables, the owner check, the §9.2 functions, the
      §9.3 policies, the §9.4 triggers and the grants;
    - `packages/db/src/chat-schema.ts`: the Drizzle description.
  - Services and routes:
    - `apps/api/src/chat/service.ts` and `apps/api/src/chat/routes.ts`, registered in
      `apps/api/src/app.ts`, plus the `chat writes` rate policy in `apps/api/src/ratelimit.ts`;
    - `apps/api/src/organisations/service.ts`: the `remove` and `setRole` lock refactor (§6);
    - `apps/api/src/organisations/lifecycle.ts`: `uncounted` entries and the export note (§10).
  - Tests: `packages/db/test/chat.test.ts`, `apps/api/src/chat/chat.test.ts`, and additions to the
    organisation service tests.
  - Routes:
    - `GET` and `POST /conversations`;
    - `GET` and `PATCH /conversations/:cid`;
    - `POST /conversations/:cid/participants` and
      `DELETE /conversations/:cid/participants/:userId`;
    - `POST /conversations/:cid/links` and `DELETE /conversations/:cid/links/:linkId`;
    - `GET /conversations/:cid/messages` and `GET /conversations/:cid/changes`;
    - `POST /conversations/:cid/messages` and `DELETE /conversations/:cid/messages/:mid`;
    - `GET /tasks/:taskId/conversations` and `GET /projects/:projectId/conversations`.

    Unknown, foreign and inaccessible IDs return an identical 404.
- **PR C, migration `0042_chat_personal_pins.sql`.**
  - Tables: pins, stars and reads with their policies and triggers, plus the read backfill.
  - Endpoints: pins, star, read, and message edit.
  - `lifecycle.ts` gains the three new tables in `uncounted`.
- **PR D (web).** The Chat views, the full conversation and item panels (every live pin above the
  latest six), pending, scope and 429 states, and Playwright checks.
- **Later**, each contracted separately: files, notifications, native client, tasks from messages,
  summaries, threads, reactions, mentions and attachments.

## 16. Tests

All run against real Postgres as `app` (DB and API), plus the browser.

- **Deletion with tombstones (1).**
  - Delete the account of a person who authored messages, deleted others' messages, unpinned pins,
    and has audit rows. The delete succeeds, only attribution columns become null, and revisions
    and `change_seq` are unchanged.
  - Delete an organisation that contains live messages, tombstones, unpinned pins and chat audit.
    Everything is removed and no trigger error occurs.
- **DB-enforced transitions (2)**, by direct SQL as `app`, bypassing the service:
  - A participant cannot:
    - change another person's message body (neither the author's live text nor a tombstone);
    - tombstone another person's message unless they are an owner or admin;
    - set `deleted_by` to someone else;
    - change `seq`, the author or the conversation.
  - A moderator tombstone succeeds, but a moderator update that also sets `body` fails.
  - Participant rows:
    - a member cannot set another person's row to `left` or `removed`;
    - an admin participant can remove others;
    - nobody can reactivate a row for an inactive member;
    - after the membership is reactivated, the row stays `removed` until a participant explicitly
      re-adds the person.
  - Inserts: the counters must match, or the insert fails; a participant row for someone else by a
    non-participant is refused; a direct `insert into conversations` is refused.
- **Create lock order (3).**
  - A create naming several people, racing an organisation removal of one of them, finishes under a
    `lock_timeout`: the create is either atomic with everyone, or refused as
    `participant_unavailable`.
  - A `matched` retry adds nothing.
- **End-membership locks (4).**
  - Two concurrent organisation removals by the same admin, of different targets whose
    conversations overlap, both finish under `lock_timeout`.
  - Self-removal takes one row.
  - The function refuses a member caller, an active target and another tenant.
  - It returns nothing, and the calling admin can read none of the rows it wrote.
- **Counter rules (r4 item 1).**
  - A send leaves `revision` unchanged and moves `last_seq` and `last_change` by exactly 1.
  - An edit, tombstone, pin or unpin moves only `last_change`.
  - Title, add, leave, remove, end-membership and link changes move only `revision`.
  - Direct SQL as `app` that moves a counter by 2, lowers one, or combines message counters with
    `revision` is refused.
- **Leave audit order (r4 item 2).**
  - A leave commits exactly one `chat.participant_left` audit row, written before the state change.
  - Forcing the participant update to fail, after the audit insert in the same transaction, rolls
    back both: no audit row, and still active.
  - A leave attempted by someone who is no longer a participant writes nothing.
- **Same ID from different people at once (r4 item 3).**
  - Two people in the same organisation, and in different organisations, concurrently create a
    conversation with the same client ID.
  - The same again for sending a message with the same client ID into conversations they each
    participate in.
  - In every case exactly one succeeds, and the other gets the generic `409` (never a `500`),
    with an identical body and no content.
- **Also:**
  - identical 404s and the no-oracle insert error;
  - constraint-name mapping: a forced unique error on an unnamed constraint is a `500`;
  - dense `seq` under concurrent sends;
  - cap races;
  - stale-revision replays;
  - create and send retry after edits;
  - no resurrection;
  - change-feed convergence across edited pages, and a delete/unpin split across pages;
  - read start positions and the backfill;
  - 429 handling;
  - scope-switch stop;
  - audit privacy, including personal rows;
  - export shows only the exporter's conversations and notes the rest are excluded, and `rowCounts`
    omits chat.

## 17. Remaining items

**Adoption.** The §11 amendment is applied in the adopting plan PR (PR A); adoption completes when
that PR merges. §9 has been peer-reviewed through r4.

**PR B execution gates.** Each is proven by a test or a recorded check before PR B merges. None is
an open design question.
1. **Migration owner can bypass RLS.** The 0041 owner assertion must pass on CI and staging. The same
   check already passed there when 0038 was applied, so no new permission is expected. If it failed,
   the migration would abort cleanly and nothing would change.
2. **Neon's PostgreSQL version.** Confirm at PR B that it is 15 or later. CI and staging are
   already PostgreSQL 18, since migrations use native `uuidv7()`.
3. **Trigger reads of `memberships`.** The §9.4 triggers run as the invoker, `app`. They read
   `memberships` under its tenant RLS, and the conversation row under chat RLS. PR B must test that
   every allowed transition sees the rows it needs: for example, a leave, where the RLS participation
   check on the new row would fail but the trigger reads only memberships and the conversation.
   It must also test that Rule A runs correctly under the table owner during cascades.
4. **Race behaviour.** The same-ID race tests (§16), the lock-order tests under `lock_timeout`, and
   the leave-audit rollback test must pass on real Postgres.

**Accepted limitation.** Capacity past about 12 concurrently visible chats under the shared per-IP
bucket. This is accepted for the first customer and measured on staging in PR D. Any change to the
limits is a separate operations decision.

Closed in revisions 4 and 5:
- the counter rules;
- the leave-audit order;
- the composite-key collision mapping;
- the tasks/projects unique keys, which exist (0002_commitments.sql);
- the create lock order;
- the end-membership lock modes;
- attribution versus the tombstone and revision triggers;
- DB-enforced authorship, moderation and participant transitions;
- lifecycle files;
- exact conflict constraints.
