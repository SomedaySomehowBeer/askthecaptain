# Captain workspace delivery plan

Status: adopted with the plan amendment in #116 (merged 24 September 2026); sequence from the
product proposal merged in #114.
Jobs advanced: **own commitments** and **brief and answer**.

The [product proposal](../proposals/2026-09-22-captain-and-pip.md) defines the intended
Captain/Pip split. This plan turns that direction into reviewable slices. The adopted [plan](../plan.md)
(D1–D25) reconciles the product/navigation/design decisions; this sequence does not itself migrate
production or require Pip before Captain is useful. Production remains paused; [operational status](../runbooks/paused.md) records the owner’s staging-only authorisation (at most one machine per app).

## Where this stands (24 September 2026)

| Slice | State |
|---|---|
| 0. Architecture proof | Built as a fictional harness; web checks and bundle exports pass locally and in the new `client-proof` CI check ([#120](https://github.com/SomedaySomehowBeer/askthecaptain/pull/120)). Native-device acceptance has not been run. |
| 1. Reviewed amendments | Done: plan D1–D25 and the migration inventory merged in #116. |
| 2. Client and work foundation | In progress: task/tag API merged in #117. Web now has the three-tab shell, grouped view lists, real filtered Work and task creation. Tag creation/renaming and individual task tag editing are now available. Saved views and `apps/mobile` remain; this does not complete slice 2. |
| 3–7 | Not started. Equipment, chat, files, mobile builds and Pip integration are designs, not code. |
| Pip | Separate product, tracked in [#119](https://github.com/SomedaySomehowBeer/askthecaptain/issues/119); no Captain slice waits for it. |

Slice numbers are this plan's own; they are unrelated to the historical phases 0–5 in plan §11.
Production stays paused through every slice. Staging may be resumed when needed under the one-machine-per-app limit; the local web checks do not require it.

## First web foundation increment

- `/` opens `/work`: your open tasks, with visible owner, status, project and tag filters in the URL.
  Pagination preserves the filter; selected lookup values survive partial read failures.
- `/work/new` creates through the existing authenticated task API. Task links open the existing
  Commitments record, revealing completed tasks where necessary. Cancelled rows are readable but explicitly have no
  detail page in this increment.
- Work, Chat and Resources have grouped `/views` lists. Tab route/filter state is remembered for
  this browser session, scoped to person and organisation. Full scroll/native stack restoration
  remains an acceptance item; this is not saved-view persistence.
- `/today` retains the former landing page. Existing Inbox, Calendar, Commitments, Notes, stock,
  contacts, connections and Settings remain reachable. Inventory at `/resources/inventory` reuses the existing counted-stock controls while retaining
  Resources navigation; the legacy Commitments stock section remains available.
- Chat and Files & assets are explicitly unavailable. No fictional records, free-equipment
  assertions or create actions for unimplemented capabilities are exposed.
- Project/member labels currently come from existing overview APIs; a smaller lookup endpoint,
  saved filters and native integration are subsequent work.

## Web tag-controls increment

Work views now opens `/work/tags` for creating and renaming shared labels. Work task rows open
`/work/tasks/:taskId/tags` to add/remove one label at a time. Both catalogues are paginated; a
single-task read reports confirmed assignments without loading every work record. Renames retain
stable IDs and update existing Work filters and assignments. Empty, invalid, unavailable and failed
states are explicit; confirmed writes refresh the source data. Tag deletion, inheritance, project
tagging and saved-view persistence remain outside this increment. No migration or dependency is
introduced. This advances **own commitments** and remains part of delivery slice 2.

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
advanced file review, automated summaries, reporting and Pip integration follow it. Existing
inventory, Xero and recurring obligations remain accessible until their replacement views work.

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
| 1. Reviewed amendments | Reconcile D1/D7/D11/D14/D23, connector ownership and retained data; approve client architecture after slice 0 | One documented authority per record; clear design authority and scope; migration inventory reviewed |
| 2. Client and work foundation | iOS development build and responsive web shell, authenticated API access, project/task/owner/tags, grouped and saved views | Real project/task edit visible in both clients; access revoked correctly; deep links and back/tab state work |
| 3. Equipment scheduling | Equipment, time ranges, unavailable periods and reservations linked to work; create/change/cancel controls | Two concurrent overlapping saves cannot both confirm; cleanup/setup conflicts, DST/date boundaries, permission and stale-update tests pass |
| 4. Linked chat | Conversation membership, messages, links to task/project, shared pins, latest-six inline view and full chat | One message identity everywhere; reconnect/retry does not duplicate; pagination, unread state and restricted access verified |
| First-customer release | Slices 2–4 together, native/browser notifications and operational migration | Two people complete the end-to-end workflow on web and iOS; existing work preserved; rollback rehearsed |
| 5. Business context | Files/DAM versions and provider links; stock and Xero views/project associations; search | Original files remain provider-held; version identity/access tested; stock remains counted; Xero stays accounting authority |
| 6. Assistance | Source-linked conversation summaries, remaining business workflows; ordinary authenticated Pip integration API | D2 validation, cut-off/source IDs, invalidation, budget/failure states; Pip retries safe and scope revocable |
| 7. Broader release | Android release, expanded reporting and remaining approved views | Android build/smoke checks run from the early slices; full device matrix and store preparation before release |

Run Android compilation/smoke checks during mobile development, even while shipping iOS first.
Do not defer discoveries about Android layout, keyboard and navigation until slice 7. No dates
or effort estimates are committed until slice 0 and the schema/migration inventory narrow the risks.

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

**Offline.** Initial target: cached reading and preserved unsent drafts, visibly marked stale or
pending. Never claim a message sent or an equipment reservation confirmed before server acceptance.
Specify what cache is removed on sign-out/revocation. Full offline edits and conflict merging are
outside the first release unless real first-customer use requires them.

## Migration and simplification

The [code-based migration inventory](captain-workspace-migration-inventory-2026-09.md) records
known stores and unresolved live-data questions. It proposes conservative retention while new
capabilities are added. Before retiring existing runtime behaviour, inventory projects/tasks/series, notes and evidence, mail,
outbox drafts, vectors, connections, enabled workflows, notifications and audit records. For each,
record authority after the split, preserve/migrate/archive disposition, retention and rollback.
Keep stable IDs or an explicit mapping so existing evidence links survive. Do not copy credentials
or mail history into Pip as a migration shortcut. Owners explicitly reconnect personal providers.

Keep useful existing capabilities reachable while replacement views are introduced. Retire a
personal-assistant workflow only after its replacement is usable and its stored data disposition
is agreed. Do not run two schedulers for the same commitment. The launch walkthrough must show
fewer places to check and no duplicate task completion or competing project state.

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
