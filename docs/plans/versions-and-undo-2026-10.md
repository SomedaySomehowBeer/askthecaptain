# Versions and undo: the R3 contract

Status: root draft, 2 October 2026, for the owner's review. Increment R3 of the
[chat-first rebuild](chat-first-rebuild-2026-09.md). Outcome: **manage shared work** — a person can
see what changed on a record, who changed it and why, and reverse the changes they pick without losing
anyone's later work. Implements D29 and the rules of the
[selective-undo contract](private-threads-and-selective-undo-2026-09.md) §2–§5, which stay the
authority for behaviour; this document fixes storage, the API, the screens and the order of work.
It does not implement agents or message causes (R4), pending or approval (R5), or external effects (R9).

## 0. Decisions for the owner

These five shape the increment. Each has a recommendation; the rest of the document assumes it.

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
   Root draws the history, selection, preview, conflict and applied states for review, as a
   canvas beside the prototype, before V-D and V-E start.

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
app`, and select/insert grants only: nothing in them is ever updated or deleted by the runtime.

**`change_sets`** — one per action.

| Column | Notes |
|---|---|
| `id uuid pk` | The client's retry id for a person's write; server uuidv7 otherwise. A retried write with the same id returns the first result |
| `actor_id` | The membership that acted; null for a system routine |
| `actor_kind` | `person`, `workflow`, `system` (R4 adds `agent`) |
| `cause_kind`, `cause_id` | `request` (the request id), `workflow_run`, `reversal` (the change set it reverses from), `baseline` (the migration). R4 adds `message` with the private-source rule of the amendment §1 |
| `request_id`, `created_at` | |

**`record_changes`** — one per changed field or item, immutable.

| Column | Notes |
|---|---|
| `id uuid pk`, `change_set_id` | |
| `record_kind`, `record_id` | `task`, `reservation`, `stock_item`, `series`, `equipment`, `tag`, `thread` |
| `operation` | `create`, `update`, `remove`, `attach`, `detach` |
| `field` | The field's fixed name for an update; null otherwise |
| `item_kind`, `item_id` | A stable child or relation: a step, an evidence row, a tag on a thread. Null for the record's own fields |
| `before`, `after jsonb` | Typed values; a removed item's `before` is its full row, so it can be restored |
| `base_revision`, `result_revision` | The record's revision before and after |
| `reverses_change_id` | Set on a reversal's changes |

**`record_versions`** — `(record_kind, record_id, revision, change_set_id, snapshot jsonb)`: the full
row after the write, with its steps, evidence and tags, for inspection. Never restored wholesale.

Access is one predicate, `record_visible(kind, id)`, used by every policy: active membership for
the work records, and `thread_visible` for `thread`. A narrowed record policy narrows its history
with it.

**How rows get there.** The API sets `app.change_set_id` in the transaction, beside
`app.user_id`, after inserting the change set. `after insert or update or delete` triggers on
`tasks`, `task_series`, `evidence`, `equipment`, `equipment_reservations`, `stock_items`, `tags`,
`thread_tags` and `task_series_tags` compare old and new for a fixed list of fields per table and
write the change rows and the version. A write to any of those tables with no change set raises.
Fields that are bookkeeping (`updated_at`, `revision`, counters) are not changes. A step is its
task's item; evidence is its task's item; a thread tag is an item of the thread's record, or of
the thread itself for a topic or private thread.

**Baseline.** The migration writes one `baseline` change set per organisation and one version per
existing record at its current revision. It invents no changes: history starts here, and the
screen says so.

**Retired with this.** The business `audit_events` inserts (decision 2). The stocktake's
idempotency check, which reads `audit_events` by key, becomes the change set's retry id. Xero's
sync state, also read from `audit_events`, moves to a small `xero_sync_state` table.

## 3. Change lines in the thread

A change set that touches a record with a thread adds one `thread_messages` row of kind `change`
to that thread, in the same transaction: no body, a `change_set_id`, the next `seq`. The R2 guard
is replaced to allow it from the journal trigger only. The client words the line from the changes
(code, never a model). Change lines count as unread activity by others. A change set that touches
three records adds one line to each thread. Editing or deleting a change line is refused.

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

## 5. API

- Every existing business write takes an optional `changeSetId` (a UUID) and returns it. A retry
  with the same id and the same content returns the first result; different content is
  `409 change_set_id_unavailable`.
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

## 6. Client

- **Card editing** (decision 3): the fold-out's fields become editable in place for a task, a
  booking and a stock count, each save a revision-checked write with a retry id, with the
  uncertain-write rules the thread composer already has.
- **Make this a task** (decision 4): on a topic's card. The topic's thread becomes the task's
  thread; the first message stays where it is.
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
| V-A | This contract, the plan and AGENTS amendments, and the reviewed screen designs |
| V-B | Migration 0047: the three tables, triggers, baseline; every write path sets a change set; change lines; audit and state-store retirements |
| V-C | History and reversal API |
| V-D | Client: card editing, make-a-task, change lines |
| V-E | Client: history, selection, preview, apply |
| V-F | Staging release record |

Each names the outcome, links this contract and lists what is not covered. Nothing deploys to
production.
