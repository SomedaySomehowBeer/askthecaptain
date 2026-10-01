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

## Assumed shapes and merged API reconciliation

Main `b9b09fb` (#229) was merged into the branch. The merged `threads/service.ts`,
`routes.ts`, `list.test.ts`, `threads.test.ts` and tags service were inspected. The earlier
ambiguities are now resolved:

- No list/detail `links`; tags are exactly `{ id, name }`. Detail's live pin key is `pin`.
- Record kind is `stock`, alongside `task` and `booking`.
- Group owner is `{ id, name: string | null }`, with nullable owner/dates on every group.
- Card is `{ record, title, status, facts, fold }`. Each record's fold is validated against
  its actual fields; topic/private folds have `createdBy` and `open: null`. Booking folds
  identify the equipment link. Unknown fold fields and retired card shapes are rejected.
- Pin POST/DELETE return the full pin row (thread, change sequence and unpin metadata),
  while detail carries the compact live pin. These use separate strict parsers.
- Messages/pages/change feed use `threadId`/`thread`; read replies use `readPosition`.
  Message DELETE's expectedRevision query and raw message mutation replies were confirmed.

A new real-Postgres test feeds the actual API JSON through the Expo parsers for task, booking,
stock, topic and private cards, owned tag groups, message edits/tombstones, pins, stars, reads
and changes. It also checks a nonparticipant's 404 and absence from their parsed list.
No implementation file in the parallel API worktree was read or changed.

The remaining navigation limitation is explicit: the compact pin has no message sequence.
An unloaded pin is found through one bounded change page per tap; after 100 changes, another
tap may be needed. No unbounded fetch loop or invented pin excerpt is used.

## Checks

Heavy work uses `flock /tmp/atc-build.lock`; validation/export/browser chains gate on more than
1500 MB available memory.

- Mobile typecheck and source boundary: passed.
- **402 mobile pure tests + 20 boundary/config tests**, no skips.
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

Browser responses are synthetic, aligned with the merged API. The new Postgres check exercises
real thread endpoints and client parsing; it is not a hosted browser round trip. No real
business/private-thread data, inference, native device,
assistive technology or cross-browser evidence. No deployment, migration or merge.

R2 message edits/deletes deliberately follow the contract's content-free tombstone and
no-edit-history rules, with participant-scoped API audit; this client does not claim selective
business-record reversal. Version/card editing remains R3. T-C adds creation and thread tags.
