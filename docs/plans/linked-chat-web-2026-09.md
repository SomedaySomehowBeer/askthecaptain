# Linked chat web delivery — 27 September 2026

Status: adopted by this reviewed plan amendment, after core API #169 and personal state/pins #171.
Outcome: **discuss work** (D25), following D6/D11/D14. This defines the web implementation;
none of these screens is delivered by adopting this plan. Linked-chat storage/behaviour remains
in the [main contract](linked-chat-2026-09.md). Two Claude Opus reviews and root's decisions are
incorporated below.

Sources: contract §1–§8, §13–§16; mockups `docs/proposals/assets/captain-mobile-2026-09-22/` (chat-views, conversation,
task-chat, project-chat, shared-chat-overview); current web (`apps/web/src/app/chat/{page,views/page,layout}.tsx`
placeholders, `components/{ViewGroup,TabBar,Page}.tsx`, `lib/api.ts`, Work's saved-views patterns
`work/{pending-create,view-actions,saved-views}.ts`); e2e scripts (`apps/e2e/scripts/*-check.cjs`).

## 0. Product decisions

- **No global badge or aggregate counts:** no tab badge, conversation totals on views/chips, or total
  derived from `lastSeq`. Per-conversation unread (1–50 or "50+"), real link counts and the live pin count remain visible.
- **Item panels have an inline composer.** It shares the full thread's pending-send key for that conversation, so a
  send started in either place is the same pending record. A panel **never** advances the read position.
- **Several linked conversations:** the most recently active *accessible* one is expanded; the others are listed.
- **Omitted entirely** (no disabled controls): search, reactions, threads/replies, formatting, mentions, attachments.
- **Naming:** no group or heading is called "Inbox" (legacy Captain scope). The group is **Conversations**.

## 1. Screens

- **Chat views** (`/chat/views`, one page left per D11). Group **Conversations**: All, Unread, Starred. Group **Linked
  to work**: Linked, Not linked. Each view is a `(filter, linked)` pair (§3 A1); no aggregate counts.
- **Conversation list** (`/chat?filter=…&linked=…`): newest activity first, keyset "More". Row: title, first link chip
  ("+n" when more), labelled latest-message excerpt ("Latest message · Ryan: …", or "Message deleted"), time, star,
  and an unread marker (1–50, or "50+" at the API's cap of 51, never a sum). All / Unread / Starred
  chips change `filter` while preserving `linked`, with no aggregate counts. Preserve the mockup's
  **About the work** and **Team conversations** groups: each has its own filtered query and cursor;
  a linked-only view shows only its matching group. View links do not replace these list groups.
  No generated-summary card appears: use labelled latest-message excerpts. The green "+" opens
  New conversation from both the view list and conversation list, never an individual thread.
- **New conversation** (`/chat/new`): title, people (picker from `GET /members`, readable by every member), optional
  task/project links (reuse `WorkPicker`). Create id + payload are written to tab sessionStorage **before** sending
  (as `work/pending-create.ts`), locked until reconciled; `conversation_id_unavailable` requires an explicit "start
  again".
- **Full thread** (`/chat/[conversationId]`): breadcrumb (Chat / conversation), header (title, people, link chips to
  Work, star), **every live pin** above the stream (keyed by message id; a pin whose message is known deleted is never
  rendered), messages by `seq` with day separators in the organisation's timezone and alternating row backgrounds,
  "Message deleted", "Former member" (only when attribution was deleted), "edited". Composer: plain text, 4,000 code
  points; pending sends persisted per conversation with their client ids, locked until the id appears; retry = same id
  and body. Message menu: Edit (author), Delete (author, or owner/admin participant), Pin/Unpin (anyone). "Earlier
  messages" via `before=`; "Go to message" from a pin loads `after=seq-1` when needed. **No floating action button.**
- **Details** (`/chat/[conversationId]/details`): rename; people (add with the "shares the full history" disclosure,
  remove for owner/admin, leave); links (add/remove). All with `expectedRevision`.
- **Item panels** (task `work/tasks/[taskId]`, project `work/projects/[projectId]`): "Chat" section from
  `…/tasks|projects/:id/conversations` (≤20). The most recently active accessible conversation shows all live pins,
  the latest six messages, the inline composer and "Open chat"; the rest are listed. Load once, then a manual "Check
  for new messages". The heading is "Latest messages", with no invented total; no summary card is shown.

## 2. States, transport and writes (contract §14)

- **Scope.** Server actions carry `{ userId, organisationId }` and refuse a mismatch before any call (as
  `view-actions.ts` `scopedSession`). A mismatch stops polling and offers a reload; nothing is sent.
- **Polling.** Full thread only: `changes?after=` every 15 s while visible and focused, one scheduler per tab, one
  catch-up on return, stops after 10 min idle; read failures back off to 60 s. Each scheduled tick
  fetches at most one bounded changes page; incomplete catch-up remains visibly in progress until
  later ticks complete it. Hidden/blurred states stop further fetches. Panels never poll.
- **429.** Every action result carries a structured `retryAfter: number | null` (seconds, from the header, capped at
  300 by the web). `lib/api.ts` `ApiError` gains `retryAfter`. A write that got 429 was not processed: the draft or
  intent keeps its id, stays editable, and nothing retries automatically; the UI shows when to try again.
- **Sends and creates** (client id): an unclear result stays pending and locked; the same id and body are retried by the person,
  a send clears when its ID appears or its successful response confirms it; a create clears on a successful
  created/matched result. A 409 unavailable ID or invalid body keeps the text for an explicit new-ID retry or discard.
- **Uncertain other writes** (rename, add/remove/leave, link/unlink, edit, delete, pin/unpin, star): the
  control locks; the action re-reads the intended state (detail, message, pins or star) and reports "done" if it holds;
  otherwise it shows what is current and offers a manual retry. Never an automatic retry. A stale revision shows the
  current state and asks the person to choose again.
- **Convergence.** Upsert by entity ID keeping the higher `changeSeq`; a `revision` change refetches
  detail; gaps are detected only by `seq`. A pin change whose message is absent triggers a bounded
  `GET /pins` refresh. Reconcile an uncertain edit/delete with `messages?after=<seq-1>&limit=1`,
  stars with detail, and pins with `GET /pins`. For independently fetched message/pin snapshots,
  start the change cursor at the smaller `lastChange`, then catch up before claiming current state.
  Changes below the loaded message window update the cache without creating holes in the visible
  stream; new messages above the window append in sequence.
- **Read position.** `POST read` at most once per 15 s, only from the full thread, for the highest message displayed
  while visible (IntersectionObserver), only when it moves forward. Never from a panel, list or background poll.
  A failed or rate-limited advance does not lock the composer or retry automatically; a later
  displayed-message advance supersedes it, respecting the throttle and Retry-After.
- **Designed states** for list, thread, details and panels: loading (skeleton), empty ("No conversations yet" / "No
  messages yet" / "Nothing starred"), error (read failed, with retry and request id), rate-limited (time to wait), and
  **access lost** (404 anywhere: "This conversation is not available to you", polling stops, pending records for it
  are cleared as below).
- **Pending lifecycle.** One pending send per conversation, shared by panel and thread; no extra
  send queue. Records contain IDs, the person's draft and necessary create selections only,
  scoped to user/organisation/conversation in tab sessionStorage. A 429 keeps the same ID and an editable
  draft; a 5xx, timeout or network failure keeps it locked until reconciled. Stale-revision forms
  retain editable text and show current state. Clear on confirmed completion, explicit discard,
  access loss (404) for that conversation, sign-out or a different signed-in user. Another organisation's
  records for the same user stay hidden and are restored only when that scope returns; switching
  organisation never sends or silently deletes them. Malformed records are discarded.
- **UI limits.** Explain and enforce 49 other people at create, 20 per add request, 50 participants
  total, 10 links and 50 live pins. Map server error codes to actionable states. Shared pins keep
  original message IDs; their block may show the actual live pin count. The message stream has one
  row per message ID. Exact write methods remain those listed in the main contract §15.

## 3. Bounded API amendments (before web code; apps/api chat only)

No change to limits, lock order or write behaviour; write responses gain the same author-name projection as reads.

- **A1 Composable views, filtered before pagination.** `GET /conversations?filter=all|unread|starred&linked=true|false`
  (`linked` omitted = either). Both filters sit in the WHERE of the keyset query; unread uses `EXISTS` (a live message
  by someone else above the caller's effective position), not the capped count. Each view pages independently: the
  cursor binds `filter` and `linked`, and a cursor used with a different pair is `400 invalid_request`. A legacy
  two-element cursor (activity key, id) is accepted only for the default view (`filter=all`, `linked` omitted).
- **A2 Pins hydrate their message** in the same snapshot, at most 50: `pins[].message` is the ordinary `Message`
  payload plus `authorName`, including edits. Live pins refer to live messages; deleting a message unpins it atomically.
- **A3 Author names.** Messages (pages, changes, pins) carry `authorName`. It is null **only** when the attribution was
  deleted (account or membership-row deletion nulls `author_id`); a person who left or whose
  membership status became removed keeps their name.
- **A4 List and work-to-chat rows** (only those) gain `latest = { seq, authorName, excerpt, deleted }` for the
  highest-`seq` message, the excerpt cut to ≤160 **code points in SQL**, and `linkSummary = { first: { kind, targetId, title } |
  null, count }` with `first` ordered by `created_at, id`. The distinct field name preserves
  detail's existing `links` array unchanged.
- **Tests:** each view and `linked` value across several pages; switching view with a cursor → 400; the legacy cursor
  accepted only for the default view; crafted/garbage cursors → 400; unread `EXISTS` agrees with the capped count;
  pins hydration including an edited message outside the latest page, and deletion removing its live pin; names kept after leave/status removal, null after account deletion and direct membership-row
  deletion; excerpt
  of a tombstone and of a 4,000-code-point astral body cut at 160 code points.

## 4. Tests

- **Web unit** (node:test, pure modules): pending create/send storage (scope, shape, lock, clearing on 404/sign-out/
  user change; another organisation's pending record hidden and restored); poll scheduler (visible/focused only, idle stop, 60 s backoff,
  Retry-After cap, single loop); change merge (upsert, higher `changeSeq` wins, pin on a known tombstone hidden);
  unread marker ("50+" at 51, never a sum); body limits; uncertain-write reconciliation mapping.
- **Browser** (`apps/e2e/scripts/chat-check.cjs`; real API + disposable Postgres; two signed-in people; the opt-in
  fixture rate-limit clock only for bulk setup and the 429 case):
  - create with people and links; send/receive via polling; edit, delete, pin, unpin;
  - a task panel shows every pin plus the latest six; its inline composer's pending send is the same record the full
    thread shows; the panel never advances reads;
  - views: All/Unread/Starred × Linked/Not linked paging, separate About the work/Team cursors;
    an invalid cursor in the URL shows the error state;
  - pending send survives reload and reconciles; an uncertain non-send write locks, re-reads, and offers manual retry;
  - 429 keeps the draft/ID editable; network failure keeps it locked; organisation switching hides/restores
    a pending send and stops polling without sending under the wrong scope;
  - access lost (removed from the conversation) shows the designed state and clears that conversation's pending
    records; empty, loading and error states render;
  - captures at 360/390/430/1440 px with assertions: compact tab bar, alternating message rows, breadcrumbs, header
    (title, people, links, star), pins above the stream, no floating action button on an individual chat, no global badge or aggregate
    count (per-conversation unread/link counts appear), and no "total" derived from `lastSeq`.

## 5. Delivery order and ownership

First land the bounded A1–A4 read API amendments with regression coverage. This is a separate
reviewed PR with no migration, new dependency or UI. Then implement the web client against its
settled response types. The thread/panel agent may prepare the client interfaces and browser
fixtures while the read API is reviewed, but publishes no placeholder interaction as complete.
Root coordinates serial checks, peer review and staging release; agents do not run builds,
commit, merge or deploy. The existing Herdr monitor remains active and never answers approvals.

For web implementation, the two existing agents own disjoint files:

- **Agent 1: API amendments, data layer, list.** `apps/api/src/chat/{service,routes}.ts` and `chat.test.ts` (A1–A4);
  `apps/web/src/lib/api.ts` (`retryAfter`); new `apps/web/src/app/chat/{types,actions,pending,poll,feed}.ts` and
  their tests; `app/chat/{page,views/page,new/*}.tsx`; list styles. Lands `types.ts` and `actions.ts` signatures first.
- **Agent 2: thread, details, panels, browser.** `app/chat/[conversationId]/**` (thread, details), `components/chat/*`
  (MessageList, Composer, PinsBlock, MessageMenu, ItemChatPanel), the Chat sections in `work/tasks/[taskId]/page.tsx`
  and `work/projects/[projectId]/page.tsx`, thread styles, `apps/e2e/scripts/chat-check.cjs`, validation captures.
  Consumes Agent 1's types and actions; neither edits the other's files.

## 6. Acceptance and release boundary

Every touched page passes the real-API two-person browser checks above. A localhost fixture pass
is not hosted acceptance: record staging results and any missing hosted signed-in session separately.
Measure the §14 polling budget before claiming multi-user capacity; never relax rate limits to hide
an inefficient client. A feature is usable only once both API and web are released and checked.
No native delivery, inferred summary, files or notifications are claimed by this slice.
