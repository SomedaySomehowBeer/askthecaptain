# Versions and undo: the R3 contract

Status: **adopted, 2 October 2026**: the owner accepted all five recommendations in §0. Increment R3 of the
[chat-first rebuild](chat-first-rebuild-2026-09.md). Outcome: **manage shared work** — a person can
see what changed on a record, who changed it and why, and reverse the changes they pick without losing
anyone's later work. Implements D29 and the rules of the
[selective-undo contract](private-threads-and-selective-undo-2026-09.md) §2–§5, which stay the
authority for behaviour; this document fixes storage, the API, the screens and the order of work.
It does not implement agents or message causes (R4), pending or approval (R5), or external effects (R9).

## 0. Decisions (owner, 2 October 2026: all five as recommended)

These five shape the increment. The owner accepted each recommendation; the rest of the document follows them.

1. **The database writes the journal, not each service.** Triggers on the business tables record
   every change, and refuse a write that arrives without a change set. Nothing can forget to
   journal, the same way no service can forget a record's thread. *Recommended.* The alternative
   is a helper each service calls, which is easier to read and easier to miss.
2. **A change set is the audit record for a business write.** Today each business write also
   inserts an `audit_events` row. With a journal that row says nothing the change set does not.
   *Recommended:* business writes stop writing `audit_events`; it keeps sign-in, membership,
   connection, export and deletion events. AGENTS.md is amended in the contract PR.
3. **R3 includes editing from the card.** The Expo client cannot change a record today, so there
   is nothing to undo. R3 adds the edits a person makes most: a task's title, status, owner, due
   date and steps; a booking's time and cancel; a stock count. *Recommended.*
4. **"Make this a task" on a topic's card, by hand, in R3.** Captain will do this from R4. Until
   then the client has no way to make a task or a booking at all. The operation is the same one
   Captain will call, and creation has to be journalled anyway. *Recommended for a task only;*
   bookings and stock items are created from their own screens later (R5, R6).
5. **Screen designs before client code.** The prototype's History frame predates selective undo.
   Root draws the card-editing, history, selection, preview, conflict and applied states for the
   owner's review before V-D and V-E start. V-B and V-C do not wait for them.

## 1. What a person can do when R3 is done

- Edit a task, a booking or a stock count from its thread's card. Each edit appears in the thread as
  a change line, worded by code: "Maya changed the due date from Fri 2 Oct to Tue 6 Oct".
- Open History from the card: every change set on the record, newest first, with who, when and
  what caused it.
- Tick one or more changes, or a whole change set, and see a preview: the value now, the value
  after, anything that conflicts, anything that must be reversed together, anything that cannot
  be reversed and why.
- Apply the preview. It either all applies as a new change set, or nothing does and the preview
  is recomputed. History is never rewritten.

## 2. Storage (migration 0047)

Three tables, all with `organisation_id`, composite keys, forced row security `to captain_runtime,
app`, and select grants on all three plus insert on `change_sets` only (built in V-B: `record_changes` and
`record_versions` are written by the journal's definer triggers alone): nothing in them is ever updated or deleted by
the runtime.

**`change_sets`** — one per action.

| Column | Notes |
|---|---|
| `id uuid pk` | The client's retry id for a person's write; a deterministic id from a workflow step's idempotency key; server uuidv7 otherwise. A retried write with the same id returns the first result (§5) |
| `actor_id` | The membership that acted; null for a system routine |
| `actor_kind` | `person`, `workflow`, `system` (R4 adds `agent`) |
| `cause_kind`, `cause_id` | `request` (the request id), `workflow_run` (the run id), `routine` (a system routine with no run, by name: `series.materialise`), `reversal` (the change set it reverses from), `baseline` (the migration). R4 adds `message` with the private-source rule of the amendment §1 |
| `request_id`, `fingerprint`, `created_xact`, `created_at` | The fingerprint is sha256 of the normalised request, for the retry rule; `created_xact` holds one change set per organisation per transaction |

**`record_changes`** — one per changed field or item, immutable.

| Column | Notes |
|---|---|
| `id uuid pk`, `change_set_id` | |
| `record_kind`, `record_id` | `task`, `reservation`, `stock_item`, `series`, `equipment`, `tag`, `thread` |
| `operation` | `create`, `update`, `remove`, `attach`, `detach` |
| `field` | The field's fixed name for an update; null otherwise |
| `item_kind`, `item_id` | A stable child or relation: a step, an evidence row, a tag on a thread. Null for the record's own fields |
| `before`, `after jsonb` | Typed values; a removed item's `before` is its full row, so it can be restored |
| `base_revision`, `result_revision` | The record's revision in its previous version (null when this change set created it) and at commit. A thread tag moves the thread's revision, not its record's, so a tag-only change set has `base = result` |
| `reverses_change_id` | Set on a reversal's changes: the earliest selected change of the same slot (§4). Filled at commit by 0048's trigger from the links the reversal names in `app.reverses`; in a reversal change set every change must be linked, outside one none is |

**`record_versions`** — `(record_kind, record_id, revision, change_set_id, snapshot jsonb)`: the full
row after the write, with its steps, evidence and tags, for inspection, unique per record per change set (two versions
may share a revision after a tag-only change). Never restored wholesale. A removed record's last version is its row
just before removal, marked `removed`. Stock items gain a `revision` (0047), moved on every update like the other records'.

Access is one predicate, `record_visible(kind, id)`, used by every policy: active membership for
the work records, and `thread_visible` for `thread`. A narrowed record policy narrows its history
with it.

**How rows get there.** The API opens the change set with `change_set_open(...)`, which inserts it and sets
`app.change_set_id` in the transaction beside `app.user_id` (one change set per organisation per transaction).
`after insert or update or delete` triggers on `tasks`, `task_series`, `evidence`, `equipment`,
`equipment_reservations`, `stock_items`, `tags`, `thread_tags` and `task_series_tags` do the rest: an immediate
`journal_guard` refuses a write with no change set of this transaction, and a deferred constraint trigger,
`journal_capture`, runs at commit for each row event, compares old and new for the fixed list of fields per table
(`journal_fields()`, mirrored in `packages/db/src/versions.ts`) and writes the change rows, then the record's one
version and its one change line. Deferring to commit is what makes one version per record per change set and the
final result revision exact. Fields that are bookkeeping (`updated_at`, `revision`, the derived booking occupancy,
counters) are not changes. A step is its task's item; evidence is its task's item; a thread tag is an item of the
thread's record, or of the thread itself for a topic or private thread; a series tag is an item of its series. Two
writes need no change set and are not journalled: rows removed with their organisation, and an update that only
clears a deleted member's attribution (an account or membership deletion's `on delete set null`).

**Baseline.** The migration writes one `baseline` change set per organisation and one version per
existing record at its current revision. It invents no changes: history starts here, and the
screen says so.

**Retired with this.** The business `audit_events` inserts (decision 2). The stocktake's
idempotency check, which reads `audit_events` by key, becomes the change set's retry id (the reorder task); its count
observation, which writes no record, checks the run's own step journal instead. Xero's sync state, also read from
`audit_events`, moves to a small `xero_sync_state` table, filled by 0047 from each connection's latest sync event and
its latest completed sync since it was last connected; the audit rows stay as history.

## 3. Change lines in the thread

A change set that touches a record with a thread adds one `thread_messages` row of kind `change`
to that thread, in the same transaction: no body, a `change_set_id`, the next `seq`, the change set's actor as
author (none for the system). The R2 guard is replaced to allow it from the journal trigger only. The client words the
line from the changes (code, never a model): the message payload carries `changeSetId` and `change` (actor kind, id
and name, cause kind, and that change set's changes to this thread's record, field names in camelCase). Change lines
move the thread's activity time; the list's excerpt stays the latest message. Owner decision, 3 October 2026, so a
burst of edits reads as one line and one unread:

1. **Runs fold.** In the thread, consecutive change lines with no ordinary message between them (a tombstone counts as
   one; a gap in loaded `seq` also ends a run) show as one folded line: the newest change worded in full, then "and N
   earlier changes" ("and 1 earlier change"), then the actors when more than one acted ("by Maya and Tom"), and the
   dates the run spans when it crosses days instead of the time. Tapping it unfolds the run in place, each line as
   before with its link to History; a run of one shows as one line. Folding is presentation only: ordering, gaps, the
   unread marker's message and the change feed are unchanged. When the first unread is a later line of a run, that run
   shows unfolded so the marker sits on its line; when it is the run's first line, the folded line carries the marker.
2. **Unread counts a run as one.** The server's `unread` (thread detail, list rows, the read answer) counts each unread
   live ordinary message by someone else as 1 and each run of consecutive unread change lines holding a line by
   someone else as 1. Any ordinary message splits a run (a deleted one too, though it counts 0); the read position
   starts one. The caller's own lines count 0. The cap (51) still applies; `needsYou` keeps its rule.
3. **System creation lines are quiet.** A line whose change set's actor kind is `system` and whose changes to the
   thread's record are the record's `create` and only what was created or attached with it (a series occurrence's tags,
   journalled in the same change set) counts 0 toward unread and is never the client's first unread. It still shows
   in the thread and still moves the thread's activity time. A later system change that is not a creation (a tag the
   system attaches afterwards) counts as any other line.
A change set that touches three records adds one line to each thread. Editing, deleting or pinning a change line is
refused (`409 change_line_immutable`).

## 4. Reversal

Behaviour is the amendment's §3 and §4. Mechanically:

- **A change is reversible** when it is the latest change to its field or item on its record, it
  is not already reversed, its operation has an inverse below, and the person may write the
  record today.
- **A later change to the same field or item is a conflict**, named in the preview with the later
  changes' ids, even when the value has since returned. The person may add those to the selection;
  the result is then the earliest selected `before`. Nothing is added for them.
- **Coupled fields** are fixed in code and reverse together or not at all: a booking's equipment,
  start, end, setup and cleanup; a task's status with its completion fields; a stock item's count
  with when and by whom. The preview says which changes must be added.
- **Inverses.** update → set the field to `before`. attach ↔ detach. remove → restore the item
  from `before`, when nothing has replaced it. create of a step or evidence → remove, when it has
  no later changes. create of a record → not reversible in R3; the preview says to cancel or
  complete it instead. A stock count → the previous count, only when no later count exists.
  A booking change → only when the earlier slot is free now, checked by the same no-overlap rule.
- **Not reversible, with the reason shown:** provider-owned quantities; anything a later
  increment marks as an external effect; a change whose record or tag no longer exists.

As built in V-C (`apps/api/src/versions/model.ts` holds the rules as pure functions):

- **Slots.** A change's *slot* is a record field, an item's existence (a step, an evidence row, a tag on a thread or a
  series) or an item's field. A later change of the same slot is a conflict; for an item's existence, any later change on
  that item is. Server change ids are uuidv7, so their order is the journal's.
- **Entries.** History and the preview show *entries*: one change, or the coupled group written together in one change
  set, with `field` set to the group's name (`time` for a booking's equipment, start, end, setup and cleanup; `status`
  for a task's or step's status with `completedBy` and `completedAt`; `count` for a stock item's count with `countedAt`
  and `countedBy`) and `before`/`after` as objects of the group's fields. An entry carries all its `changeIds`; selecting
  only some of them is the state `needs` with the others. A group's fields reverse together; a later change of one of
  them conflicts with the whole entry.
- **Reversed.** A reversal's change names (in `reverses_change_id`) the *earliest* selected change of its slot. Every
  change of that slot from there up to the reversal had to be selected with it, so all of them are reported `reversed`
  by that reversal. Later changes that are themselves reversed are not conflicts; the reversal that undid them is.
  Reversing a reversal is an ordinary reversal of its changes.
- **Irreversible reason codes** (the client words them): `record_created` (say cancel or complete instead),
  `record_removed`, `record_gone`, `item_gone` (the step or evidence, or the step evidence was on, no longer exists),
  `tag_gone` (the tag itself was deleted), `became_task` (a topic thread's own tag history after the topic became a task:
  its tags are now the task's). Reserved and never written yet: `provider_owned` (no provider quantity is a journalled
  record: Shopify levels are not in the journal at all) and `external_effect` (R9).
- **Blocked** (preview only: history allows it, the records now do not) with a reason code, from the same domain rules
  as the ordinary writes: `slot_taken` (with `detail`: the blocking booking's id, title, owner and occupied times),
  `invalid_time`, `equipment_archived`, `reservation_cancelled` (a cancelled booking's time changes only with the
  cancel undone), `evidence_required`, `step_has_evidence`, `evidence_kind_retired`, `owner_inactive`,
  `task_unavailable`, `tag_archived`, `stock_archived`, `stock_unit_counted`, `supplier_unavailable`, `name_taken`,
  `tag_dates_invalid`, `recurrence_invalid`, `equipment_in_use`, and `already_current`: the result would be the value
  already there (a value changed away and back, both selected), so there is nothing to undo.
- **Inverse writes.** Fields are set to the earliest selected `before`, in one statement per record with the record's
  own bookkeeping (revision, occupancy, `updated_at`); a step or evidence is deleted, or restored with its stored row
  and id; a thread tag goes through the thread-tag helper (revision, chat audit), a series tag directly. An item write
  moves its task or series on. A series edit's occurrences are not rematerialised by a reversal; the series routine
  catches up as for any edit made while it was paused.

## 5. API

- Every existing business write takes an optional `changeSetId` (a UUID) and returns it, in the body and in the
  `Change-Set-Id` header (a thread tag write in the header only, so the thread detail keeps its shape). A retry
  with the same id and the same content returns the first result: the record the change set made or changed, read
  as it is now (a count returns the observation it recorded; added evidence its row as attached); nothing is stored
  beside the change set. Different content, another person or another write is `409 change_set_id_unavailable`.
- `GET …/history/:recordKind/:recordId?before=<cursor>&limit≤50` → change sets, newest first, each
  with its actor, cause, time and changes; each change carries `state`: `reversible`, `conflict`,
  `needs` (with the change ids), `irreversible` (with a reason code) or `reversed` (with the
  reversing change set).
- `GET …/history/:recordKind/:recordId/versions/:revision` → the snapshot.
- `POST …/reversals/preview { changeIds }` → read-only. Per change: current value, proposed
  value, state. Plus `basis`: the `{ recordKind, recordId, revision }` list it was computed on.
- `POST …/reversals { id, changeIds, basis }` → locks the records, recomputes, and applies only
  if every selected change is reversible and every basis revision still holds. Otherwise
  `409 stale_preview` with the new preview and nothing written. Success returns the new change
  set. The same `id` again returns the same change set.
- No signed token and no separate approval layer (D29).

Shapes as built in V-C (`apps/api/src/versions/service.ts` has the types). `:recordKind` is one of `task`,
`reservation`, `stock_item`, `series`, `equipment`, `tag`, `thread` (a topic or private thread's own tags); anything
else is `400`. An unknown, foreign or hidden record or change is the generic `404 not_found`, the same body whether or
not it exists: a private thread's history is its participants' alone, and a stranger, another tenant or a removed member
learns nothing.

- **History** `{ record: { kind, id, revision, exists }, changeSets, nextCursor, start, names }`. `limit` defaults to 20,
  at most 50; `before` is the previous page's opaque `nextCursor` (over the change set's time, then id). Each change set
  is `{ id, actor: { kind, id, name }, causeKind, reversesChangeSetId, createdAt, changes }` (`reversesChangeSetId`, for a
  reversal, is the change set of the earliest change it reversed). Each change (entry, §4) is `{ id, changeIds,
  recordKind, recordId, operation, field, fields, itemKind, itemId, before, after, reverses, state, … }` with, by state:
  `conflict` → `later: [{ id, changeSetId, actor, at, field, before, after }]` (the later changes still in effect, the
  ones to add); `irreversible` → `reason`; `reversed` → `reversedBy: { changeId, changeSetId, actor, at }`. Field names
  are camelCase; a field's value is as stored (dates `YYYY-MM-DD`, times ISO with offset, counts decimal strings); an
  item's create, remove, attach or detach has `field: null` and its row. `start` comes with the last page only:
  `{ kind: 'baseline' | 'created' | 'first_change', changeSetId, at, revision }` (the baseline row links to the version
  at that revision). `names: { people: { id: name }, tags: { id: name } }` covers the people (owners, completers,
  counters) and tags the page mentions; a deleted tag keeps its last name.
- **Version** `{ recordKind, recordId, revision, changeSetId, createdAt, removed, snapshot }`: the latest version at that
  revision (a tag-only change keeps the revision).
- **Preview** `{ changes, basis, applicable, names }`, at most 50 change ids. Each change is an entry as above plus `now`
  and `proposed` (both shaped like `after`; an item's is its row or null when absent; `proposed` is null when nothing is
  decided: a conflict, `needs`, irreversible or reversed). States add `needs` → `needs: [changeId]` and `blocked` →
  `reason` (§4) with `detail` for `slot_taken`. `applicable` is true when every change is `reversible`. `basis` is sorted
  by record; a record's `revision` is its own (a thread tag moves the thread's revision, not the record's), the thread's
  for `thread`, null for a record that is gone.
- **Apply** `201 { changeSet, reversed }` with the `Change-Set-Id` header: the new change set as history shows it, across
  every record it touched, and the selected change ids. A retry with the same `id`, person and body answers the same; the
  same `id` for anything else is `409 change_set_id_unavailable`. A refusal is `409 { code: 'stale_preview', preview,
  moved }`: the preview recomputed under the locks, and the basis entries whose revision moved. It is also the answer when
  the submitted preview was not applicable. Locks are taken in a fixed order: the person's membership, then equipment
  (a booking's current and any earlier equipment), bookings, tasks, stock items, series, threads, then tags.

## 6. Client

- **Card editing** (decision 3): the fold-out's fields become editable in place for a task, a
  booking and a stock count, each save a revision-checked write with a retry id, with the
  uncertain-write rules the thread composer already has.
- **Make this a task** (decision 4): on a topic's card. The topic's thread becomes the task's
  thread; the first message stays where it is. API (V-C): `POST …/threads/:threadId/task { expectedRevision, ownerId?,
  due?, changeSetId? }` answers with the thread detail (kind `record`, the card on the new task, its tags) and the
  task's change set in the `Change-Set-Id` header, as the other thread writes. The task's title is the thread's, its body
  empty, its status open; the thread keeps its id, messages and tags and moves its revision once, and no second thread is
  made (migration 0048's `thread_make_task`). Journalled as the task's creation, so not reversible (`record_created`);
  the task's history starts there. A private thread is `400 thread_not_topic`, a record's thread `409 thread_is_record`,
  a stale revision `409 stale_revision`, an owner who is not an active member `400 owner_invalid`.
- **Change lines** in the thread, tappable to that change set in History.
- **History** at `/threads/[id]/history`: change sets with their changes; tick boxes on reversible
  changes; conflicts and required companions explained inline; a baseline row at the end.
- **Preview** as a sheet over History: now → after for each selected change; what blocks it;
  Apply. A stale result replaces the preview and says what moved.
- States, widths and honest copy as R2. Designs first (decision 5).

## 7. Tests and evidence

Real Postgres, none skipped. The amendment's §5 list is the minimum: independent fields and
stable items; same-field conflict including a value changed away and back; several selected
changes; coupled booking and count groups; atomic failure; stale preview; retry after a lost
response; undo then undo of the undo; cross-tenant and private-thread isolation of history;
revoked permission; a booking slot taken since; stock authority. Plus: a write with no change set
is refused by the database; the baseline invents no changes; a change line appears in each
affected thread and nowhere else; the stocktake and Xero moves keep their behaviour.
Client: pure tests for wording change lines and preview states; Playwright on the export at
360, 390 and 430 px for edit, history, select, preview with a conflict, apply, and a stale apply.

## 8. Pull requests

| PR | Delivers |
|---|---|
| V-A | This contract and the plan and AGENTS amendments. The screen designs are reviewed separately and gate only V-D and V-E |
| V-B | Migration 0047: the three tables, triggers, baseline; every write path sets a change set; change lines; audit and state-store retirements. Built as above; the deviations from the first draft are named in its pull request |
| V-C | History and reversal API; topic to task; migration 0048 (reversal links, `thread_make_task`) |
| V-D | Client: card editing, make-a-task, change lines |
| V-E | Client: history, selection, preview, apply |
| V-F | Staging release record |

Each names the outcome, links this contract and lists what is not covered. Nothing deploys to
production.
