# Captain workspace delivery plan

Status: adopted with the plan amendment in #116 (merged 24 September 2026); sequence from the
product proposal merged in #114.
Outcomes: **manage shared work** and **understand and follow up**.

The [product proposal](../proposals/2026-09-22-captain-and-pip.md) defines the intended
Captain/Pip split. This plan turns that direction into reviewable slices. The adopted [plan](../plan.md)
(D1–D26) reconciles the product/navigation/design decisions; this sequence does not itself migrate
production or require Pip before Captain is useful. Production remains paused; [operational status](../runbooks/paused.md) records the owner’s staging-only authorisation (at most one machine per app).

The [next batch and assignments](captain-next-batch-2026-09-25.md) records delivered service-failure
recovery, then prioritises the scope cleanup, genuine standalone work, Work details, saved views
and linked chat, with Expo foundation work alongside subsequent contracts. It adds acceptance detail without declaring any remaining slice complete.

## Where this stands (26 September 2026)

| Slice | State |
|---|---|
| 0. Architecture proof | Built as a fictional harness; web checks and bundle exports pass locally and in the new `client-proof` CI check ([#120](https://github.com/SomedaySomehowBeer/askthecaptain/pull/120)). Native-device acceptance has not been run. |
| 1. Reviewed amendments | Original amendment merged in #116; its assistant-retention assumptions are corrected by the 25 September audit. Scope cleanup is now required. |
| 2. Client and work foundation | In progress: task/tag API merged in #117. Web now has the three-tab shell, grouped view lists, real filtered Work and task creation. Tag creation/renaming and individual task tag editing are now available. Private saved Work views are delivered in #153/#154. `apps/mobile` and native acceptance remain; this does not complete slice 2. |
| 3. Equipment scheduling | First API increment: equipment, maintenance/reservations, database overlap enforcement, revisions, cancellation and bounded occupancy reads. The [contract](equipment-reservations-2026-09.md) defines the integrity boundary. Web timeline and catalogue/create/edit/cancel controls are implemented, with browser checks against real Postgres. Native clients and real-device gestures remain pending; this does not complete slice 3. |
| 4–7 | Not started. Chat, files, mobile builds and Pip integration are designs, not code. |
| Pip | Separate product, tracked in [#119](https://github.com/SomedaySomehowBeer/askthecaptain/issues/119); no Captain slice waits for it. |

Slice numbers are this plan's own; the old assistant phases 0–5 are linked from the historical
reference index, not an active second sequence.
Production stays paused through every slice. Staging may be resumed when needed under the one-machine-per-app limit; the local web checks do not require it.

The equipment API increment proceeds against the delivered task/project foundation with private
saved views now delivered; native clients remain open. Its scheduling integrity does not depend on those clients;
the first-customer release still requires the full slices 2–4 acceptance evidence.

## First web foundation increment

- `/` opens `/work`: your open tasks, with visible owner, status, project and tag filters in the URL.
  Pagination preserves the filter; selected lookup values survive partial read failures.
- `/work/new` creates a task with an optional project. The [Work record increment](work-record-pages-2026-09.md)
  shipped in #138 replaces Commitments links with bounded task, project and recurring-work pages,
  including cancelled-task details, revisions and searchable selectors.
- Work, Chat and Resources have grouped `/views` lists. Tab route/filter state is remembered for
  this browser session, scoped to person and organisation. Full scroll/native stack restoration
  remains an acceptance item; this is not saved-view persistence.
- Former Today, Inbox, Calendar and Notes routes are retired. Inventory at `/resources/inventory`
  uses counted-stock controls; contacts, connections and account Settings remain available.
  The Work record increment (#138) removed the remaining Commitments forms and overview API.
- Chat and Files & assets are explicitly unavailable. No fictional records, free-equipment
  assertions or create actions for unimplemented capabilities are exposed.
- Saved filters and native integration remain subsequent work.

## Web tag-controls increment

Work views now opens `/work/tags` for creating and renaming shared labels. Work task rows open
`/work/tasks/:taskId/tags` to add/remove one label at a time. Both catalogues are paginated; a
single-task read reports confirmed assignments without loading every work record. Renames retain
stable IDs and update existing Work filters and assignments. Empty, invalid, unavailable and failed
states are explicit; confirmed writes refresh the source data. Tag deletion, inheritance, project
tagging and saved-view persistence remain outside this increment. No migration or dependency is
introduced. This advances **manage shared work** and remains part of delivery slice 2.

## Web equipment increment

Resources views opens `/resources/equipment`: a continuous 14-day timeline by default, with
Hours/Days/Weeks scales, focal zoom, horizontal equipment arrows and explicit 1/7/14/28-day
windows. Eight equipment columns load at a time. Setup, cleanup and maintenance all occupy the
same schedule; work filters cannot remove another project's occupancy. Incomplete or failed reads
say availability is unknown. Short intervals remain inspectable in the list below the timeline.
The green plus reserves the selected equipment. Manage equipment adds, renames, archives and
restores the catalogue; individual reservation pages have edit/cancel controls rather than a plus.

Forms display the organisation timezone, reject nonexistent local times and require an explicit
occurrence for repeated hours. Saves are confirmed only by the API. Conflicts retain typed values;
stale edits require reloading. An uncertain create is read by its stable request ID before retry,
so a lost response cannot create a second booking. Cancelled records remain readable.

This is the Next.js web increment, not an Expo release. Touch pointer pan and stepped pinch have
browser-handler coverage; native momentum, real iPhone/Android gestures and device performance
remain acceptance work. See [reproducible browser checks](workspace-web-validation-2026-09.md).

## Outcome and first usable release

A team member creates a project, adds a task with an owner and tags, reserves equipment,
discusses the work in its linked conversation, and completes the task. Another member sees
the same records and changes on web or iOS. Work defaults to Assigned to you; Work, Chat and
Resources each retain their own navigation state and grouped view list. Production, Marketing,
Sales and Admin/reporting are tags, never separate stores or permission boundaries.

Equipment scheduling is in this first release. Confirmed bookings, maintenance and turnaround
occupy the same timeline. A work filter cannot hide another project's resource occupancy.
Neither an offline client nor a conflicting request can display an unconfirmed booking as booked.

This is a complete first-customer workflow, not the full feature set in every mockup. Search,
advanced file review, automated summaries, reporting and Pip integration follow it. Inventory, Xero and recurring business tasks remain valid scope. Their access belongs in
Resources/Work, independently of the old assistant screens.

## Starting point

Repository inspection on 23 September found:

| Capability | Starting point | Required work |
|---|---|---|
| Web | `apps/web`, Next.js; current five-tab product | New workspace shell, desktop layouts, shared-record routes and states |
| Mobile | Expo named in the plan; no `apps/mobile` implementation | App shell, authentication, secure session handling, links, push, device builds |
| Projects/tasks | API, ownership, due dates, statuses, recurring series, evidence | Tags, saved filters, shared view queries, relevant schema/API amendments |
| Access and audit | Tenant context, RLS, membership, audited writes | Extend to each new table and relationship; test access revocation |
| Equipment | Interactive fictional HTML timeline only | Resources, intervals, availability, reservations and transactional conflict enforcement |
| Chat | Fictional shared-message mockups only | Conversations, membership, messages, record links, delivery/reconnect and notifications |
| Files/DAM | Proposal and mockups; generic evidence links exist | Provider-backed assets, versions, metadata, access and version-qualified links |
| Stock and Xero | Counted inventory and Xero connection/sync/read services | Reuse and expose through Resources/project links; preserve source and freshness |
| Workflows/inference | Server runtime and validated infer steps | Chat summaries and business workflows after their source records exist |

Existence of code is not an assertion that every production integration is configured or healthy.

## Client architecture to validate

- Captain iOS and Android: React Native with Expo **development builds**.
- Captain web: retain Next.js initially; build desktop views with keyboard, mouse and browser
  navigation in mind. A wide layout can keep the view list, work and detail visible together.
- One API and database remain authoritative. No direct client database access. Scheduled business
  inference remains on the server and does not depend on a device being awake.
- Share client-safe types/contracts, validation, date/filter/interval logic and design tokens.
  Share UI where it improves maintenance; timeline gestures, navigation and keyboard handling
  can have platform implementations. Server packages, secrets and database code never enter clients.
- Pip is a separate Apple application; native Apple development is the working preference.
  Its model, Siri, Reminders and Focus proofs have their own gates, tracked in issue [#119](https://github.com/SomedaySomehowBeer/askthecaptain/issues/119).
  Private Cloud Compute is available to eligible apps on supported devices (managed entitlement,
  daily quota); it still needs a device to issue the request, so it is no substitute for Captain's
  server-side scheduled inference ([Apple PCC documentation](https://developer.apple.com/documentation/FoundationModels/adding-server-side-intelligence-with-private-cloud-compute/), checked 24 September). No Captain milestone waits
  for those proofs, and no unsupported Apple capability is assumed by Captain's API.

Expo also supports web. The bounded proof exercises its universal route as an alternative,
not as a decision to replace Next.js. Compare implementation complexity, desktop accessibility,
interaction quality and measured performance before choosing how much UI to share. Current
Next.js server components are not automatically reusable in a native client.

Sources checked 23 September 2026: [Expo web](https://docs.expo.dev/workflow/web/),
[platform modules](https://docs.expo.dev/router/advanced/platform-specific-modules/),
[Next.js boundary](https://docs.expo.dev/guides/using-nextjs/),
[custom native code](https://docs.expo.dev/workflow/customizing/).

## Ordered delivery slices

Each numbered slice can contain small PRs, one migration per PR. A schema change and its RLS,
role checks, audit writes and real-Postgres integration tests ship together.

| Slice | Deliverable | Exit evidence / dependency |
|---|---|---|
| 0. Architecture proof | Isolated Expo timeline/chat client and browser comparison; shared deterministic geometry and message identity | Reproducible checks plus explicit native-device gaps; no production route or data changes |
| 1. Reviewed amendments | Reconcile workspace scope, design authority and connector ownership; correct legacy retention assumptions; approve client architecture after slice 0 | One documented authority per record; clear design authority and scope; code inventory distinguished from unknown live data |
| 2. Client and work foundation | iOS development build and responsive web shell, authenticated API access, project/task/owner/tags, grouped and saved views | Real project/task edit visible in both clients; access revoked correctly; deep links and back/tab state work |
| 3. Equipment scheduling | Equipment, time ranges, unavailable periods and reservations linked to work; create/change/cancel controls | Two concurrent overlapping saves cannot both confirm; cleanup/setup conflicts, DST/date boundaries, permission and stale-update tests pass |
| 4. Linked chat | Conversation membership, messages, links to task/project, shared pins, latest-six inline view and full chat | One message identity everywhere; reconnect/retry does not duplicate; pagination, unread state and restricted access verified |
| First-customer release | Slices 2–4 together, native/browser notifications and operational release checks | Two people complete the end-to-end workflow on web and iOS; affected real records handled explicitly; rollback/forward recovery verified |
| 5. Business context | Files/DAM versions and provider links; stock and Xero views/project associations; search | Original files remain provider-held; version identity/access tested; stock remains counted; Xero stays accounting authority |
| 6. Assistance | Source-linked conversation summaries, remaining business workflows; ordinary authenticated Pip integration API | D2 validation, cut-off/source IDs, invalidation, budget/failure states; Pip retries safe and scope revocable |
| 7. Broader release | Android release, expanded reporting and remaining approved views | Android build/smoke checks run from the early slices; full device matrix and store preparation before release |

Run Android compilation/smoke checks during mobile development, even while shipping iOS first.
Do not defer discoveries about Android layout, keyboard and navigation until slice 7. No dates
or effort estimates are committed without evidence for the affected contract and native acceptance risks.

## Backend contracts to settle before screens depend on them

**Equipment.** Store instants with an organisation display timezone. Define exclusive equipment,
booking status and half-open occupied ranges `[start, end)` including setup/cleanup. Database
constraints or equivalent transaction-level locking must prevent concurrent confirmed overlaps
for the same equipment, including maintenance. An edit validates its replacement interval
atomically; a failed edit preserves the original reservation. Distinguish unavailable, unloaded
and free time. Define cancellation, revision checks and bounded range queries. Conflicts must be
reported even where access permits only an anonymous “Unavailable” label for the other booking.
UI overlap previews are advisory; they do not prove booking safety.

**Chat.** Conversations and record links have stable identities. Shared pins reference original
messages and are permission-checked/audited; stars are personal conversation bookmarks. The
inline view selects the latest six chronological messages plus pins; it is not another chat.
Set rules for edits/deletion, participants, read position, pagination and thread replies. Use
client request IDs for retry-safe sends, reconcile with server IDs, and recover missed messages
from a cursor after reconnect. Choose the smallest transport meeting this need in the API design;
no new realtime service is assumed. Push is a hint to fetch authorised state, not a source of truth.

**Files.** A project may link an asset; review messages can anchor to a particular version.
Provider permissions and Captain access are both relevant. Record metadata and source identities;
retain no attachment bytes under D13. Review status is an explicit record operation, never inferred
from a reaction. Settle provider preview/thumbnail handling and retention before implementing it.

**Mobile sessions and notifications.** Adapt the existing sign-in/passkey flow deliberately for
native clients, including secure session storage, revocation, deep-link return and sign-out.
Existing web push is not native push. Add native registration/delivery and unread preferences
with the same access checks; test expired tokens, denied permission and links to revoked records.

**Offline.** Initial target: cached reading and preserved unsent chat/form drafts, visibly marked stale or
pending. Never claim a message sent or an equipment reservation confirmed before server acceptance.
Specify what cache is removed on sign-out/revocation. Full offline edits and conflict merging are
outside the first release unless real first-customer use requires them.

## Scope cleanup and affected records

The [implementation inventory](captain-workspace-migration-inventory-2026-09.md) records legacy
code dependencies, not known useful customer data. Correct the scope before extending old
screens: remove assistant navigation and runtime; remove Obligations as the required storage
home; make Work task/project/series detail usable without Commitments. Details are sequenced in
the [next batch](captain-next-batch-2026-09-25.md). No retirement depends on Pip, a replacement
mailbox, or a speculative live-data migration. An actual data-affecting change must identify its
specific records/references and handling; this audit itself does not delete data or disable jobs.

Do not copy credentials/mail history into Pip. Do not duplicate task state or series generators.
A redirect may resolve an old link to its Work record; it must not preserve the old app as a
parallel place to work. Business reminders and counted stock must work without Google mail or
reply-drafting prerequisites. Finished product may be counted in Captain when no provider owns
that quantity. The launch walkthrough must demonstrate fewer places to check.

## Proof scope and acceptance ledger

The [isolated client proof](../proposals/assets/captain-client-proof-2026-09-23/README.md) is
fictional, local-only and disposable. It evaluates client rendering and shared logic. Its local
message actions are not multi-user chat; its overlap calculation is not database enforcement.
No paid build service, deployment, provider credential or production data is required.

| Question | Required proof before architecture acceptance |
|---|---|
| Timeline | Continuous intervals at Hours/Days/Weeks, selection and focal time retained on zoom, equipment horizontal scroll, unloaded boundary labels and inspectable short/conflicting intervals |
| Touch/desktop | Real iPhone pinch/pan; Android smoke; desktop keyboard/mouse; controls work without gestures; scroll axes/headers remain aligned |
| Chat | Long list rendering, shared pins/latest six, visible composer with software keyboard, older-history paging and preserved reading position |
| Client sharing | Common deterministic logic, explicit platform exceptions; compare Expo web against existing browser baseline and a representative Next.js implementation before any web replacement |
| Performance | Record device/build/data size and actual frame/interaction behaviour; synthetic Chromium checks or successful exports cannot establish native smoothness |
| Navigation | Native back gesture, per-tab restoration, browser URL/history and deep links in the foundation slice |
| Accessibility | Keyboard focus, screen reader labels/order, text scaling, contrast and reduced motion in real clients |
| Scheduling integrity | Real-Postgres concurrent create/edit/cancel and cross-tenant/access tests in slice 3 |

Gate result can be “keep Expo mobile and Next.js web”, “share more UI through Expo web”, or
“revise the problematic native component”. Failure of one gesture implementation does not
justify rewriting the backend. Record the evidence and remaining limitations before proceeding.
