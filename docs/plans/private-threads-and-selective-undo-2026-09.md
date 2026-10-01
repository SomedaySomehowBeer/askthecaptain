# Private agent calls and selective undo

Status: owner-directed amendment, 30 September 2026, for review with the chat-first plan in
PR #214. Outcomes: **discuss work privately** and **reverse selected work changes without losing
other people's edits**. This refines D25, D29 and D33; it does not claim implementation.

## 1. Private threads and agent calls (R2/R4)

Private threads are participant-only. They do not enter background classification, summaries,
agent routing or agent memory. The same exclusion applies to their titles, pins, attachments,
read positions and other metadata. Linking a private thread to a shared record, tagging it, or
migrating a thread never broadens its audience.

A participant may explicitly `@` mention a named agent in a message. Code resolves the authored
mention to an available agent; plain quoted text, a pasted transcript or a model-generated
mention does not grant access. Only that calling message may be sent to the classifier and the
called agent. If the call is routed to another needed agent, the same message-only scope follows
it and stays within the ordinary chain budget and capability limits (D30).

This is a one-call grant, never membership of the private thread:

- No previous or subsequent messages, thread title, pins, thread summary, previous agent turns,
  or cached conversation context enter the call. No reply-to expansion, linked-message fetch,
  attachment extraction or retrieval can reconstruct the excluded history. A participant can
  deliberately put the necessary facts in the calling message itself.
- Missing context produces a request for clarification, not a history read. A later participant
  reply needs a fresh explicit mention and is a new message-only call. The agent's own reply does
  not restart classification or grant another call.
- A deterministic, narrowly scoped read supplies the calling message to the D2 infer step.
  Never make the agent a participant or bypass participant RLS to fetch the conversation. Code
  delivers any reply to the same private audience through the scoped call; the agent has no
  general read or send permission on the thread.
- Shared business-record reads/writes still need ordinary authorisation and the agent's fixed
  capabilities; a mention grants no new business permission and cannot act as the caller without
  D31's approval. Private history cannot be used as a source. An explicit request to act on a
  shared record may share the necessary facts supplied in that calling message, not the private
  thread or its identifiers. No automatic conversion into a public record thread is allowed.
- Queue payloads use opaque call IDs. Private call input, output, cause links and audit stay
  participant-scoped, including in versions, exports, diagnostics and workflow activity; shared
  record history must not expose a private source-message or thread ID to nonparticipants.
- Calls identify the invoking message revision and named agent, with retry-safe identity. Before
  execution and before delivering an effect, recheck the caller's membership/access and the
  message revision. An edited/deleted call or revoked access cancels queued work; retries cannot
  substitute newer text, replay effects or expand context. Already completed effects remain
  recorded under their normal visibility and reversal rules.

The classifier runs over messages in shared record/topic threads as specified by D33. Private
calls are the explicit exception above. R2 must preserve the boundary even before agents ship;
R4 must prove it before enabling any private invocation.

## 2. History records changes, not just snapshots (R3)

Keep full business-record snapshots for inspection, together with immutable, typed changes:
stable change ID, record ID, operation, field or stable child/relation ID, before and after values,
base/result revisions, actor, cause, time and change-set ID. A change set groups one action across
records; individual independent changes can be selected within it. Capture snapshots, changes,
audit and the business writes atomically. This is fixed domain data, not configurable fields.

Changes need provenance at the affected field/item level, so undo can distinguish an untouched
value from one changed away and later changed back. Equal current values alone are insufficient.
History keeps original changes and all reversals; nothing is rewritten or silently removed.

Versioned undo concerns business records, not credentials, sessions, grants, audit journals or
organisation deletion. Do not retain secrets in snapshots or restore access with undo. Private
record snapshots and changes follow the same visibility as their source. Storage, grants and
RLS for the change journal are part of the reviewed R3 migration contract, before implementation.

## 3. Select, preview, then reverse

1. A person selects earlier changes, whole change sets, or independent changes within them.
   The server checks present-day access and write permissions; historical authorship is not a
   permission grant. Each target must have recorded before/after data. Older records without it
   can have a labelled baseline snapshot, not invented historical changes.
2. Code constructs inverse operations against current state, in reverse causal order. It does
   not restore a whole old snapshot. Unselected independent later edits remain untouched.
3. The preview names the selected changes and shows current values, proposed results, affected
   records, conflicts, inseparable dependent changes and effects that cannot be reversed. It is
   read-only. A conflict never selects or overwrites additional changes automatically.
4. Applying the preview is an ordinary revision-checked write, with a durable client retry ID.
   Lock/recheck all affected records and dependencies in one transaction. If state or permission
   changed since preview, return a stale/conflict result and recompute; apply nothing. No signed
   confirmation token or separate generic approval layer is introduced.
5. A successful reversal appends a new change set, snapshots, audit and links to the changes it
   reverses. The whole selected operation commits atomically. A retried apply has the same result,
   not another reversal. Already-reversed changes are identified explicitly. Reversing a reversal
   uses these same rules, not a privileged redo path.

Undoing a date change must preserve a later owner change. If someone subsequently changed that
same date, the earlier date change conflicts, even if the value has since returned to the same
date. The person can include the dependent date changes in a new preview, or make a normal new
edit; the server never chooses silently. An unrelated later record revision requires a fresh
preview but does not inherently make the selected field impossible to reverse.

## 4. Domain rules still apply

- **Collections and relations:** undo by stable identity, never an array index or entire-list
  replacement. Removing a tag must not discard tags added later. Moving or removing a checklist
  item must account for subsequent edits and dependent work.
- **Creation/deletion:** reversing creation is not a cascade over later work. Surface references,
  later edits and dependent records. Offer only an authorised, valid inverse; content-clearing
  tombstones, retention rules and deletion guarantees cannot be bypassed by resurrection.
- **Atomic dependencies:** independent changes from a scan or batch may be cherry-picked.
  Coupled changes, such as a booking's start/end/setup occupancy, must satisfy their domain
  invariants together. Explain the required selection; never partially apply a coupled group.
- **Bookings:** validate pending and confirmed occupancy, setup/cleanup, maintenance, ownership
  and permissions against current state. A newly occupied slot blocks reversal atomically.
- **Stock:** an absolute count is not an additive movement. A later count conflicts with undo of
  an earlier count; never subtract a historical delta from today's quantity. Provider-owned
  quantities remain provider-owned and cannot be overwritten by history restoration.
- **External effects:** a sent message or completed provider operation cannot be unsent by local
  undo. Mark the affected changes irreversible and offer a separately authorised compensating
  action where supported. Independent local changes in the same set remain selectable. Pending
  actions can be cancelled only before dispatch wins the same concurrency boundary; undo cannot
  race a send or revive an old approval. A changed external action needs approval of its new exact
  content under D31.

A worksheet scan remains one change set with its retained source photo. The person may reverse
the whole scan or select independent changes; the photo and original history remain. Internal
scan processing needs no human approval; an effect meeting D31's third-party test follows D31.

## 5. Required implementation evidence

R2/R4 must prove with real Postgres and captured inference inputs that an unmentioned private
message produces no inference; an explicit mention exposes only the calling message; reply
links, retries, conflict reads and delegation never add history; agents cannot read private
messages through other endpoints; edited calls/access removal stop queued effects; and a
nonparticipant cannot discover private sources through audit, versions, exports or run activity.
No existing conversation is migrated (the staging chats were demo data; owner, 1 October 2026), so there is no audience to preserve.

R3 must prove independent-field and stable-item reversal, same-field conflicts (including a
value changed away and back), multiple selected changes, coupled dependencies, atomic failure,
stale previews, retry after a lost response, repeated undo/redo, cross-tenant and private-history
isolation, revoked permissions, booking conflicts and stock authority. External-dispatch races
need tests when that runtime arrives in R9. No skipped database test counts as passing.

The selection, preview, conflict and applied states need reviewed screen designs and Playwright
checks on the Expo export. The supplied prototype predates this refinement; its whole-snapshot
undo interactions, if present, do not supersede this contract. Neither the design export nor this
amendment is evidence of implemented privacy or undo.
