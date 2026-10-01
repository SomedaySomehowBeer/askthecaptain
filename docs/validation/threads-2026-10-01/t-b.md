# T-B — thread list and thread screen (1 October 2026)

Outcome: **discuss work**. Implements the client portion of the
[threads contract](../../plans/threads-2026-09.md) §§5–7 on main `ce7fe46` (rebased after #226), with the
[reviewed prototype](../../proposals/assets/captain-chat-first-2026-09-30/README.md) frames 1 and 3
inspected in Chromium. New-thread creation and tag editing follow in T-C.

The list reads fixed filters, whole-set group headings and cursor pages of at most 50 rows.
Rows appear under each attached tag; folding stores only tag IDs, best effort per device.
Files, People and search stay disabled. Equipment and Team pinned rows remain.

The thread holds its compact card above the scrolling messages and composer. Details, tags
and the equipment record link fold out. It loads the first unread by the contract's fetch
rule, renders oldest first, offers earlier/newer pages, displays tombstones and text links, and
advances reads only for displayed messages while visible/focused, at most every 15 seconds.
Message menus follow author/moderator powers. Pins never silently replace another pin; stars
are personal. Writes reconcile actual state; uncertain writes are not replayed automatically.

A pending send is saved in tab sessionStorage before its request, keyed by person, organisation
and thread. Unknown sends retain an immutable ID/body for manual retry; 429 retains the ID but
allows editing. Confirmed IDs clear the draft. Different people, explicit sign-out and thread
404s clear applicable pending data; an expired session preserves it for the same person. Other
organisation drafts stay hidden until that scope returns. No read history, thread titles or
thread IDs persist outside pending drafts. Storage failure prevents a new send.

Scope checks run before and after calls. Polls are one flight, 15 seconds, visible/focused only,
with a 10-minute idle stop and read backoff to 60 seconds. Retry-After is honoured up to five
minutes. Change-feed upserts keep the higher change sequence; only message sequences establish
gaps. Tombstoned pinned messages disappear immediately, even before their unpin change arrives.
Native thread transport is not enabled; its shell retains the explicit unavailable state.

## Assumed shapes (T-A not yet integrated)

The contract does not specify all JSON fields. These are explicit assumptions, not evidence
of T-A's payloads:

- List row `status` is string or null; the two facts are strings. `record.kind` and link `kind`
  are `task`, `booking`, `stock_item`. A group `key` is its tag UUID or `none`; optional owner is
  `{ userId, name }`, dates are nullable `YYYY-MM-DD`. Tags are strictly `{ id, name }`.
- Detail uses the top-level name `pins` from §6, holding one `{ id, messageId, pinnedBy,
  pinnedAt }` object or null (not an array). Participants are present only for private threads,
  with the inherited `{ userId, name, addedAt }` shape.
- Card is `{ kind, id, title, status, facts, body, notes? }`; nullable body/notes are plain text.
  Topic/private card IDs may be null. List rows and detail have no `links` field.
- Message/page/change shapes retain the old contract, renaming `conversationId`/`conversation`
  to `threadId`/`thread`; messages add `kind: 'message'`. Send/edit/delete return a message.
  Delete carries `expectedRevision` as a query parameter. Read returns `{ readPosition, unread }`;
  star returns `{ starred }`. Pin returns the four-field pin; unpin may return it or null.
- Pins carry no message sequence in §6. If their message is outside the loaded window, a tap
  checks one bounded change page from the beginning, then loads the matching message's window.
  If more than 100 changes precede it, the screen explicitly offers another tap to continue;
  there is no unbounded fetch loop or invented pin excerpt.

Re-check these parsers and pin navigation against T-A's real payloads when root reports it
merged. No implementation file in the parallel API worktree was read or changed.

The owner announced the #229 amendments (no links, no tag kind, thread wire names and
`thread_id_unavailable`) while T-B was finishing. Those are applied in the parsers/fixtures.
The fetched remote contract still had the old text at that point; re-read it once updated.
The checks below initially passed before the rebase and wire amendments; revalidation is running.

## Checks

Heavy work uses `flock /tmp/atc-build.lock`; validation/export/browser chains gate on more than
1500 MB available memory.

- Mobile typecheck and source boundary: passed.
- **389 mobile pure tests + 20 boundary/config tests**, no skips.
- SDK compatibility, Android backup configuration, fresh web/iOS/Android/harness exports,
  bundle boundary and canary guards: passed.
- **9 cookie-session tests** against disposable real Postgres, no skips.
- Playwright on the fresh export at **360/390/430 px**: grouped/folded/paged list, fixed filters,
  first unread, read to the end, fixed card, editable 429 draft, send/edit/delete/pin/star,
  persisted uncertain send, storage clearing, lost access and harness states passed.
  Existing account/passkey/member/equipment regressions run in the same suite.
  No page errors, overflow or unexpected external requests.

Screenshots: [360 list](t-b-360-list.png), [360 unread](t-b-360-unread.png),
[390 list](t-b-390-list.png), [390 unread](t-b-390-unread.png),
[430 list](t-b-430-list.png), [430 unread](t-b-430-unread.png).

Full logs: [checks](t-b-checks.log), [Postgres](t-b-postgres.log),
[exports](t-b-exports.log), [browser](t-b-browser.log).

## Not covered

Thread browser/API responses are synthetic and follow the assumptions above. Existing real
Postgres checks establish the reused session contract, not the new T-A routes. No new thread
API integration, hosted round trip, real business/private-thread data, inference, native device,
assistive technology or cross-browser evidence. No deployment, migration or merge.

R2 message edits/deletes deliberately follow the contract's content-free tombstone and
no-edit-history rules, with participant-scoped API audit; this client does not claim selective
business-record reversal. Version/card editing remains R3. T-C adds creation and thread tags.
