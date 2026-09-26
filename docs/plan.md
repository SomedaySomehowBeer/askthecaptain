# Ask The Captain — product and engineering plan

**Status:** adopted workspace direction (#114/#116), corrected by the 25 September scope audit.
This is the source of truth for Captain. Decisions in §13 change through reviewed pull requests.
The [delivery plan](plans/captain-workspace-delivery-2026-09.md) separates implemented capabilities
from targets. The [audit](plans/captain-scope-audit-2026-09-25.md) records the correction and issue
coverage; the [implementation inventory](plans/captain-workspace-migration-inventory-2026-09.md)
records legacy dependencies still to remove. Neither is evidence of useful live customer data.
Staging is authorised with at most one machine per app; production remains paused. Actual releases
are recorded in [paused.md](runbooks/paused.md).

## 1. What Captain is

Captain is the shared project and work system for a small business. It owns projects, tasks,
recurring work, accountable owners, equipment reservations, simple inventory, and conversations
and evidence around that work. **Work, Chat and Resources** are views of the same records.
Production, Marketing, Sales and Admin/reporting are flat tags; projects and people can span them.
The first customer is a small brewery; its vocabulary is record names, not a custom domain model.

**Pip is a separate personal assistant on Apple devices.** It helps with mail, reply drafts,
personal calendars, reminders, private attachment search, Focus and personal catch-ups. Captain
is useful without Pip. Pip reads/writes business records through the person's ordinary authenticated,
role-checked Captain API; it does not duplicate business task state into Reminders.
Xero owns accounting. Email and file providers hold originals. Captain holds deliberately shared
business evidence and source links. Business schedules and inference run on Captain's server,
independent of whether a device is awake. Pip's Apple capabilities have separate proof gates in
[#119](https://github.com/SomedaySomehowBeer/askthecaptain/issues/119).

**The old assistant is not part of the target product.** Today, Inbox/Outbox, Commitments and the
Obligations system project are legacy implementation, not alternative names for the workspace.
Personal calendar preparation, mailbox triage, reply drafting and mail-driven project discovery
are not Captain delivery requirements. Retirement does not wait for Pip or a replacement mailbox.
Ordinary recurring business tasks, due dates, equipment schedules and business summaries remain.

The initial scope audit did not count live records. A later read-only staging inventory and the
owner’s explicit permission to delete old-version data are recorded in the
[optional-project/reset contract](plans/optional-work-projects-2026-09.md). Do not turn legacy
records into a requirement to preserve old screens or behaviour. Reusing a
valid service or stable record identity is different from keeping its old product surface. A change
that actually affects stored records must establish those specific dependencies and its handling;
the authorised staging reset removes old-version content rather than converting it into workspace records.

## 2. The work Captain serves

Name the concrete workspace outcome in every PR; the old six assistant jobs are no longer an
eligibility test for new work.

- **Manage shared work:** projects, standalone tasks, recurring work, owners, tags and progress.
- **Allocate resources:** equipment, maintenance, setup/cleanup and conflict-safe scheduling.
- **Discuss work:** shared conversations linked to records, shared pins and personal stars.
- **Manage business context:** counted stock, provider-held files/DAM, counterparties and Xero links.
- **Understand and follow up:** source-linked business summaries, questions and task reminders
  using authorised shared records and server workflows.

Legacy workflow job numbers can remain historical identifiers until their definitions are retired
or replaced. They confer no product scope; do not rename their old duties as “business equivalents”
and carry them all forward. Captain can flag an overdue invoice; Pip or the person's email app
handles correspondence. Captain does not need an Inbox/Outbox to be useful.

## 3. Principles

- **Data-only inference:** only an `infer` step calls a language model, with an instruction,
  labelled input and output schema. Validate output before deterministic code uses it. No model
  tools, writes or credentials. Generated prose is allowed inside a validated result with sources.
- **Ordinary writes:** a person's write is role-checked in RLS and audited. A workflow acts as
  its enabling person. No signed request, confirmation token or generic approval layer.
- **No autonomous correspondence:** workflows never send external mail. Existing legacy outbox
  safety remains until that path is removed; it does not require a new Captain mail product.
- **Tenant isolation:** forced RLS on every tenant table; the runtime role cannot bypass it.
  The [runtime-role repair](plans/runtime-database-role-2026-09.md) introduces SQL-created
  `captain_runtime`, explicit grants and live startup/readiness checks; hosted activation is a
  separately recorded credential operation.
- **Traceable effects:** audit writes and journal workflow steps, with explicit retry/idempotency
  boundaries. No credentials in model input, diagnostics or queue payloads.
- **Honest states:** distinguish empty, loading, failed, unavailable, stale and unconfirmed data.
  A failed read is not an empty day; an incomplete equipment read never establishes free time.
- **Small surface:** three tabs, one authoritative record per task/project/conversation, no
  configurable entity types, custom fields, units/conversions or process definitions.

## 4. Architecture

A pnpm/Turborepo monorepo, TypeScript throughout.

| Path | What |
|---|---|
| `apps/api` | Hono HTTP API: auth, routes over services, webhooks, health |
| `apps/web` | Next.js; server components read the API. Work/Chat/Resources web client; legacy navigation still present is cleanup debt, not target scope |
| `apps/e2e` | Playwright deployment smoke suite (deploy workflow, currently paused) and isolated browser regression in CI |
| `apps/mobile` | Planned React Native/Expo development-build client for iOS and Android; not in the repository yet; native-device acceptance precedes release |
| `packages/db` | Drizzle schema, hand-written SQL migrations, RLS policies, typed queries |
| `packages/connectors` | Xero and Shopify business adapters; legacy Google mail/calendar adapters pending retirement; sign-in remains separate |
| `packages/steps` | the step catalog (§6) and the workflow definitions that compose it |
| `packages/engine` | durable workflow execution: pg-boss and a small typed runner in the API process |
| `packages/model` | the inference client: provider adapter, structured output, budgets, usage |
| `packages/retrieval` | unused embedding client and legacy index code pending deletion; ingestion is retired (D21) |
| `infra/embed` | former stateless mail/note embedding service, stopped with autostart off; deployment assets pending removal (D21) |
| `packages/ui` | design tokens and shared components |
| `infra` | OpenTofu for Neon, Cloudflare and monitoring; the inference Sprite's bootstrap files, which the API uploads when an owner sets up a subscription |

**Clients.** Retain Next.js web and use Expo for iOS/Android as the implementation direction.
Share client-safe contracts, deterministic date/filter/interval logic and tokens. Keep native
navigation/gesture/keyboard code platform-appropriate. The isolated proof in #114 has passing
web checks and native bundle exports, not native-device acceptance. Do not replace Next.js or
claim a signed native build from that evidence. Browser and device access use the same API;
never bundle server credentials, database access or model secrets into a client. New shared
packages/dependencies are named in the slice that introduces them, not added speculatively.

**Hosting.** Fly.io in Sydney for the API and web; Neon Postgres; Cloudflare DNS; GitHub Actions
for CI and deploy. The checked-in DNS records are not proxied through Cloudflare; they do not
establish Cloudflare edge TLS processing. One data environment: a single Neon branch and compute, and the
Fly apps that serve app.askthecaptain.app. The automatic deploy/smoke workflow is disabled;
current staging releases are manual from reviewed, merged code under the operational record. A second
database waits for a second customer (D17).

The checked-in configuration and 23 September pause record identify the serving pair under D17 as
`askthecaptain-api-staging` and `askthecaptain-web-staging`; `app.askthecaptain.app`, the apex and
`www` are configured to point at the web app and `api-staging.askthecaptain.app` at the API.
A dormant pair, `askthecaptain-api` and `askthecaptain-web`, is retained; `api.askthecaptain.app`
points at the production API. The pause record dates its last promotion to 2026-09-05.
`askthecaptain-embed` is the former D21 mail/note embedding service; it is stopped with autostart off
following the retirement release. On 25 September staging API/web moved to #135/#136 (merge
`d11fcdf`, identical image-source tree `7b77ba9`), with one machine per app. The owner-authorised
legacy-data reset completed before migrations 0037/0038. Sign-in/configuration and truthful
spending totals remain; old assistant content is not migrated into workspace tasks.
Production remains stopped, and GitHub's `deploy` and `backup` workflows remain disabled.
The [operational record](runbooks/paused.md) records health checks, limitations and the deployment
procedure; configuration alone is not a live availability check.

**Durable execution (D19).** Use **pg-boss with a small Captain runner** in the existing
application process and Postgres. The bounded D10 inbox-triage spike ran both pg-boss and
self-hosted Restate through retries, delayed events, timeouts and incident journals. Both
needed destination idempotency at the boundary where a write committed before its completion
was recorded; Restate's simpler waits did not justify another service for the first customer.
[The decision and evidence](plans/engine-decision-2026-09.md) record the comparison and its limits.

Definitions remain engine-neutral (§6). Runs and steps use Captain's tenant-scoped journal;
queue jobs carry opaque run identifiers, with no mail, prompts or credentials. Worker business
access uses the enabling person's tenant context and the non-bypassing runtime role (D4, D6).
pg-boss owns platform queue metadata; its idempotent installer runs after database migrations in
the API release step, using the migration-owner connection. The runbook retains an operator
fallback; the running API never installs or upgrades the schema.
Local effects and completion records must be atomic where possible, otherwise destination
idempotency or reconciliation is required. Queue delivery is not a generic exactly-once
external-write guarantee. D5 still forbids workflow mail sending; it does not retain correspondence in Captain.

`packages/engine` is the production runner in the API process (`WORKFLOWS_DISABLED=1` stops it).
A catalogue registry binds service/connector handlers; uninstalled handlers keep the corresponding
workflow unavailable. Run snapshots pin definitions, parameters and enabling people. Local writes
and journal completion share a transaction; provider intent precedes I/O, with idempotency or
reconciliation in the adapter. The legacy mail-sync trigger and `mail.synced` enqueue path are removed. Await deadlines and event wake-ups are also atomic with journal/destination
state. Membership checks, actionable inference pauses, Resume, cancellation and named retry
exhaustion are part of the runner. No separate engine service is provisioned.

Daily/weekly schedules use the organisation's timezone and a persisted next run, replacing it on
first delivery; each queue payload contains only a run id. A platform failure queue records exhausted
worker deliveries back into the tenant journal. Settings → Workflows → Activity links to run details:
ordered steps, loop item, state and reason, with Resume for paused runs and Cancel for unfinished runs
(owner/admin). Empty, unavailable, failed and saving states use words. Triage/outbox bindings are removed; the runner remains reusable infrastructure. [The runbook](runbooks/workflow-runner.md) covers installation,
handler contracts and recovery.

## 5. Data model

Every tenant table has `organisation_id`, forced RLS and tenant-qualified relationships. Use uuidv7
for server-generated records; existing client-generated retry IDs follow their reviewed contracts.
These target semantics do not claim the old schema has already changed.

| Domain | Target authority and shape | Implementation boundary |
|---|---|---|
| Identity/access | Organisations, users, sessions, passkeys and memberships | Existing services; preserve tenant checks and revocation |
| Projects | Named shared outcomes, owner, description and lifecycle; no nesting | Work project pages and revision-aware edits shipped in #138; mail-discovery proposal machinery remains legacy |
| Tasks | Title/body, status, owner, due date, optional project, evidence and one-level checklist | Optional projects (0038, #136) and revisions with copied occurrence evidence requirements (0039, #138) shipped; the authorised legacy reset is complete, not a recurring deployment step |
| Recurring work | Series generate ordinary tasks; no artificial project required; edits affect future occurrences | Standalone materialisation shipped in #136; rule revisions and copied occurrence evidence requirements shipped in #138 |
| Tags | Flat organisation labels; many per task, stable identity on rename, no permissions or inherited duplication | Migration 0035 and API/web controls implemented; [tag contract](plans/workspace-task-tags-2026-09.md) records its original project restrictions, superseded by #136 standalone-task eligibility |
| Saved views | Named, versioned private Work filters in `saved_views`; no stored task results or access grants | [Reviewed contract](plans/saved-work-views-2026-09.md), D26; private API/web delivered in #153/#154; shared views require a separate increment |
| Equipment | Exclusive resources and bookings/maintenance with occupied start/end, setup/cleanup, revision and work/person links | Migration 0036 and web shipped; [contract](plans/equipment-reservations-2026-09.md); standalone task links and revision-aware project movement added by #136 |
| Chat | Conversations, participants, messages, links, pins, stars and read positions with separate stable IDs: `conversations`, `conversation_participants`, `conversation_links`, `messages`, `chat_audit_events`; then `message_pins`, `conversation_stars`, `conversation_reads` | [Adopted contract](plans/linked-chat-2026-09.md), D25; not implemented. Core storage/API, then pins/stars/read state, then web, each in its own PR |
| Evidence | Business source links and deliberately shared correspondence with source-qualified identity and provenance | Existing generic evidence references reusable but need a bounded sharing/access contract; no mailbox archive |
| Files/DAM | Provider originals, version identities, work links, version-scoped review/chat | Planned; no byte store or imported Embrace backend |
| Inventory | Counted ingredients, consumables and finished product, with count time/person and explicit authority | Count services exist. Provider-owned quantities remain provider-owned; finished product does not require Shopify |
| Counterparties | Shared people/companies and business-provider references | Existing services reusable; stop automatic personal mailbox harvesting with legacy sync |
| Accounting | Xero invoice/payment/contact cache with source timestamps and completeness | Existing first-party connector; Xero remains accounting authority |
| Notifications | Captain business notifications on authorised task/resource/chat state | Web Push exists; native delivery is a separate implementation |
| Workflow/inference/audit | Enablements, immutable run snapshots, step journals, usage, budgets and audit events | Existing infrastructure; legacy definitions do not become new product scope. Private chat writes are audited in participant-scoped `chat_audit_events` (D25) |

No separate Notes/comments product is required by the new workspace. Item discussion is D25 chat.
If an actual retained evidence link points to an authored note, resolve that identity deliberately;
do not bulk-convert notes to chat or fabricate authors/messages. Presence of note tables does not
require a Notes view or new note triage.

Correspondence sharing uses normal authenticated APIs, not an inbound forwarding address. Carry
source account/message identifiers, date/participants/subject and a provider link, with only content
a person deliberately shares (selected excerpt or labelled summary). Preview the business audience;
a link never grants access to a private mailbox. Enforce retry-safe identity and permissions.
The data contract must distinguish source text from generated content and specify retention.
Existing `mail_messages` body storage is legacy, not approval for ongoing mailbox mirroring.

Connection tokens use D16 encryption. Personal Google consent does not become a business file grant;
Pip obtains its own consent. Google sign-in is distinct from connected Gmail/Calendar scopes.

Xero monetary reads preserve currencies and source completeness. Shopify is an optional existing
business source; it is neither a mandatory stock authority nor a reason to remove valid counted
stock. Do not silently replace a provider-owned quantity with a person's count.

## 6. Workflows

A workflow is an ordered composition of steps from a typed catalog, defined in TypeScript in
`packages/steps`, versioned with the code, and enabled per organisation with parameters. Definitions
are engine-neutral data structures so the same definition runs on the D19 runner.

### Step kinds

| Kind | Does | Examples |
|---|---|---|
| `read` | reads from a connector or the database | tasks due this week, authorised messages, equipment reservations |
| `infer` | model call: data in, schema-validated object out; no tools | summarise a conversation with validated source IDs |
| `write` | a deterministic write, in the name of the enabling person | suggest task, record summary, update reviewed business state |
| `await` | wait for a time, a record state or an external event, with a timeout | until a task is due; until a count is recorded; until a webhook arrives |
| `notify` | push to a person | task reminder, business update |

Every step declares its input and output types. `read` and `write` steps are plain functions over
the connectors and the database. `infer` steps declare an instruction, an output schema and a model
tier. `await` covers timers: waiting for a time is one of its conditions, not a kind of its own. A
definition that names a capability the enabling person lacks fails at enablement, not at run time.

### Control flow

Control flow is deterministic and bounded, and it is part of the definition rather than a step:

- `when(predicate)` on any step: the step runs only if a pure predicate over earlier outputs holds.
- `each(list, steps)`: run a sub-sequence once per item of a finite list produced by an earlier step,
  journaled per item. Bounded business lists use this control flow.
- `branch(predicate, thenSteps, elseSteps)`: choose a path by a pure predicate.

Predicates are functions over data, never model calls. There is no unbounded loop; anything that
repeats does so over a list that already exists or by being triggered again. The D19 runner interprets these controls and records their steps and loop positions in the journal.

### Workflows and system routines

Workflows are the owner's: enabled per organisation, visible in Settings, journaled, and always
serving a workspace outcome in §2. **System routines** are the product's own housekeeping and are not
workflows: syncing approved business providers, refreshing tokens, creating the next occurrence of a series,
retrying webhooks. They run on a schedule, are logged, and appear in
Settings → Activity only when they fail.

### Definition disposition

The runtime retirement increment removes the assistant catalogue. Its disposition is:

| Existing path | Required disposition |
|---|---|
| `inbox-triage`, `discover-projects`, `calendar-prep` | Removed; no Captain replacement mailbox/discovery/preparation requirement |
| `morning-brief` and Today questions | Removed. Do not transplant their personal mail/calendar/outbox source selectors; business summaries/questions need explicit shared-source contracts |
| `chase-due` v4 | Shared task reminders/escalation only; no email-draft branch or Google/Xero/inference dependency |
| `stocktake` v3 | Counted-stock requests/reorder tasks and optional Shopify quantities; no supplier draft or Google/inference dependency |
| Series materialisation | Keep as system housekeeping; remove Obligations/project requirement |
| Mail/watch/calendar/index routines | Removed from API startup and entry points, together with mail-derived contact harvesting; attachment-text expiry remains housekeeping |

A retirement PR must cover catalogue enablement, scheduled/event/manual triggers, queued retries,
waiting/paused immutable run snapshots and user-facing recovery. Hiding a toggle or removing a handler
alone leaves old executions alive or stranded. Report actual affected run state before operational
changes; choose an audited cancellation/drain policy, with no automatic sending or replay. This is
bounded implementation work, independent of Pip availability or hypothetical stored data.

A new business workflow gets explicit source permissions, typed steps, budgets, idempotency and
failure states. Inference and background jobs are not needed for ordinary task management or chat.

## 7. Inference

- **Bring your own subscription.** Each organisation brings its own Claude (Claude Code) or Codex
  subscription. Captain runs the unmodified CLI on a Captain-owned Fly Sprite, one per organisation
  (D18). Setup completes from a phone. In Settings the owner chooses a provider and presses
  Set up subscription: the API creates the Sprite through the Sprites HTTP API with a platform
  token scoped to a Sprites organisation that holds nothing but Captain runtimes, uploads the
  shim and its bootstrap, generates the per-Sprite secret, starts the service and records the
  Sprite's URL; the shim installs the pinned CLIs on first start and reports readiness on
  `/health`. Sign-in runs on the Sprite but is driven from Settings: the shim runs the
  provider's own login (`claude setup-token` or Codex device login) as a child process and
  exposes the sign-in URL and device code; the owner opens the link on the phone; Codex
  completes on its own, and for Claude the owner pastes the returned one-time code into
  Settings, which the API forwards once, in memory, never stored or logged. The login credential
  stays only on that Sprite; it never enters a prompt, workflow or log. Disconnect destroys the
  Sprite through the same API. No laptop, script or terminal is part of the flow.
  The API calls a bearer-authenticated shim whose URL and per-Sprite secret are encrypted with
  the organisation's data key (D16). Ryan owns the Anthropic hosting-clause consideration and its
  resolution before operating the Claude runtime.
- **Structured output only.** Every infer step supplies a JSON schema; the response is validated
  before any step sees it. A response that fails validation is retried once with the error, then the
  step fails and the run records why.
- **Tiers.** `small` for bounded extraction, `large` for business summaries and answers. The
  tier is declared by the step; the CLI/provider and model behind each tier are configuration.
- **Budgets.** Monthly token allowances and per-step usage records, not dollar reservations.
  Before each call, check used tokens plus estimated input and maximum output against the
  organisation's allowance; settle with actual usage afterwards. When spent, workflows that need
  inference pause with a visible reason; deterministic steps keep running. No rollover process
  is needed: the month's row is created lazily.
- **Provider adapter.** A thin Sprite provider interface supports Claude and Codex without
  changing steps. The shim runs the CLI with every model tool and MCP server disabled, takes
  instruction, labelled input and output schema, and returns structured output and usage only.
- **Privacy and untrusted content.** Infer only over authorised, explicitly selected business
  sources. Label message/file content as untrusted and keep fixed instructions outside it.
  Schema validity does not establish truth or authorisation: validate source IDs, cross-check
  consequential facts and recheck permissions in deterministic code. Usage/diagnostics contain
  no content; durable step output requires its own minimised retention contract.
- **Retrieval.** D21's existing mail/note index is legacy. A future shared-business index needs an
  explicit source/access/retention contract; it must not silently continue personal mailbox
  ingestion. Pip's private iCloud index is separate and receives no copied Captain vectors.
- **Attachments.** D13 forbids retained attachment bytes. Any future extraction requires an
  allow list, size/text limits, transient processing and expiry; provider originals remain the
  authority. Existing legacy extraction/cache behaviour is documented in its runbook, not a
  requirement to recreate mailbox triage.

### Later: API keys and cost budgets

A tenant may in future bring an Anthropic API key instead of a subscription. The
schema and provider interface already leave the seam: provider value `anthropic_api`,
nullable `cost_micros` on `model_usage`, nullable `cost_limit_micros` on `model_budgets`,
and a limits object in the budget check. Enabling it would add an `ApiProvider` in
`packages/model` using the provider SDK, a price table, key storage encrypted with
the organisation's data key, and verification on entry. API-key execution and cost
budgets are not implemented today; the Sprite remains the only inference runtime.

## 8. Connectors

Use first-party SDKs/REST behind our own OAuth, refresh and encryption; no integration platforms
or vendor MCP step sources. Deduplicate webhooks, bound syncs and show source freshness/failure.

| Source | Captain responsibility |
|---|---|
| Xero | Business invoices/payments/contacts and project context; not a new accounting ledger |
| Shopify | Existing optional commerce cache and provider-owned quantities; no obligation for every business to use it |
| Files provider | Deliberately enrolled business originals/versions; provider/scopes/access proved in the files slice |
| Pip or another authorised client | Deliberately shared correspondence and normal work actions through authenticated APIs |
| Google sign-in | Identity; independent of retiring Gmail/Calendar product access |

Existing Gmail/Calendar sync and send adapters are legacy. Do not expand them to keep a “business
inbox” inside Captain. Pip's personal providers need separate consent, never copied credentials.

## 9. Security and tenancy

- Forced RLS on every tenant table; a runtime database role that cannot bypass it; tenant context
  set transactionally. Adversarial cross-tenant tests in CI.
- Roles: owner (billing, keys, members), admin (connections, workflows), member (use). Platform
  operator roles are separate from tenant roles.
- Sign-in with Google for any domain; explicit organisation creation; verified invitations.
  Passkeys (WebAuthn, `@simplewebauthn/server` in the API and `@simplewebauthn/browser` in the web,
  the web app's origin as the relying party) are the second factor: a person who has registered one
  must present it at every sign-in, between Google and the session; owners and admins are asked to
  add one in Settings before invitations open to strangers.
- Secrets: envelope encryption without a cloud key service. A 32-byte master key lives in the API's
  secrets; each organisation has a data key wrapped by it; connection tokens and Sprite connection secrets are
  encrypted with the data key (AES-256-GCM). Rotation re-wraps data keys. No third-party key service
  and no extra cloud account.
- Rate limits per IP, user, organisation and connection. Webhook signature verification.
- Audit log for every write. Data export and organisation deletion as first-class operations: an
  owner or admin downloads every tenant table as newline-delimited JSON without credentials; an owner
  deletes the organisation by typing its name, providers are told to revoke, and the platform keeps a
  one-line record.
- Backups with a rehearsed restore, terms of service and a privacy notice before the second tenant.
  The `backup` workflow dumps the database nightly, restores it into a throwaway Postgres in the same
  job and compares counts, then keeps thirty days of dumps in the Tigris bucket; Neon's own
  point-in-time history is the first resort (`docs/runbooks/backup-and-restore.md`). The workflow
  had been failing since 2026-09-21 on a `pg_dump` version mismatch. #120 repaired the
  tooling and tested a local fixture; the workflow remains disabled. A hosted restore drill is
  not recorded. Staging authorisation does not itself enable backups or production.

## 10. Web and mobile

Phone-first and responsive desktop. The target and web shell have exactly three workspace tabs; legacy destinations still
linked by the current shell are tracked cleanup work:

- **Work** — defaults to My work, filtered to Assigned to you. Projects, tasks, recurring
  work and tag/project/person/status/date views all select the same records. The reviewed
  [By tag navigation](plans/default-business-views-2026-09.md) lists every organisation tag as an
  Everyone · Open Work link by tag ID, with independent bounded paging. It adds no special departments,
  seeded tags or shared saved-view data; delivered in #159 and released to staging
  ([operational record](runbooks/paused.md)).
- **Chat** — participant conversations, unread and personally starred conversations, linked
  bidirectionally to projects/tasks; file-version links follow the Files contract. Participation follows the conversation by
  default; starring is a private bookmark. Important messages use shared pins.
- **Resources** — grouped libraries, planning and business views: files/DAM links, equipment,
  counted stock, people/companies, Xero context and reporting as those slices become available.

Each tab has an untitled grouped view list one page to the left of its selected view. Preserve
per-tab history and native back behaviour; web routes have meaningful URLs and browser history.
Desktop can show the list, work and detail alongside each other. Settings stays reachable from
account/avatar controls; it is not a fourth tab. Task/file/chat detail omits the generic green
plus; creation on other views has a named contextual action and editable defaults.

The [mobile mockups](proposals/assets/captain-mobile-2026-09-22/README.md) specify the compact
rounded tab bar, green selection, continuous multi-day equipment timeline, conversation summaries,
shared pins, latest-six item chats and subtle alternating message rows. Loading, failed, empty,
disabled and permission states remain required. Unknown/unloaded equipment is never shown free.

**Work detail is Work.** Build bounded task/project/series reads and editors under Work; no
“Open in Commitments” escape hatch. Standalone tasks must not display a fabricated project.
The [Work record contract](plans/work-record-pages-2026-09.md) defines bounded reads, revision
preconditions, copied evidence requirements and the replacement web pages, shipped in #138.
Old bookmarks may resolve to the corresponding Work record, or an explicit retired/unavailable
state where no target exists. Redirect compatibility is not a reason to keep old screens/actions.
Task due dates and Work Calendar/Timeline presentations remain in scope; they are not the retired
synced personal Google Calendar product.

**Account settings.** Keep identity, members, approved business connections, notifications,
inference and workflow configuration reachable through account controls. Remove legacy mailbox
onboarding, drafting preferences and mail/discovery workflows with their retirement increments.
The generic runner's activity UI and inference setup can be reused without keeping old duties.

**Design authority (D14).** Reviewed repository-native workspace designs and their documented
behaviour are authoritative for the new workspace. Start with the linked mobile mockups and
preserve user-approved refinements. The Expo architecture harness is technical evidence, not a
replacement visual design. `packages/ui/design/` remains the verbatim legacy Claude Design mirror;
do not hand-edit it. New/adapted components and tokens are authored outside the mirror, with their
source recorded in the implementation PR. Existing screens may continue consuming legacy tokens
while they migrate. Light/dark, accessible focus, contrast and text scaling are acceptance work;
do not invent an unreviewed dark palette or require a Claude Design round-trip for each change.

## 11. Delivery

Follow the [delivery plan](plans/captain-workspace-delivery-2026-09.md) and
[next batch](plans/captain-next-batch-2026-09-25.md). The next work corrects the scope debt before
adding more legacy-backed screens. Assistant navigation/runtime retirement, optional projects and
Work details and private saved views are delivered; remaining retired storage/code cleanup continues
alongside linked chat and the Expo client. Equipment scheduling is
mandatory in the first usable workflow. Web and iOS need two-person acceptance; Android smoke
checks start during mobile development and broader Android release follows.

Implemented: web shell, filtered Work/task creation, tags, counted inventory access, equipment
API/web, session recovery, and the assistant UI/API/runtime retirement with revised task/stock
workflows, optional projects/Obligations removal, and revision-aware Work task/project/series
pages (#138), and private saved Work views (#153/#154). Not complete: remaining retired assistant
storage/connector cleanup, linked chat, files/DAM, native application and device acceptance.
Do not call the remaining screens implemented because mockups or bundle exports exist.

The old phases 0–5 and six jobs are historical. Their completed issues document earlier work;
they are not a second roadmap. Second-customer readiness is separately tracked in
[#27](https://github.com/SomedaySomehowBeer/askthecaptain/issues/27), with verified security,
backup/restore and owner-reviewed legal prerequisites, not mail reconnect prerequisites.

## 12. Non-goals

- Pip's personal inbox, correspondence composer, calendar preparation, Reminders or private search.
- A conversational model with tools or autonomous writes; server inference remains D2 data-only.
- A configurable business domain/process model, inventory movements, conversions, lots or costing.
- A document editor, asset byte store, Embrace/Lore backend, Docs/Sheets sidebar or paper/OCR kit
  inferred from an old proposal. Provider-held DAM and version-scoped chat are in scope; further
  file capabilities need explicit adoption.
- Full offline booking confirmation, automatic rescheduling of other people's work, or copied task
  state across clients. Unknown/pending work never appears confirmed.
- A compatibility product or migration programme for hypothetical customers/data. Preserve security
  and handle affected real records deliberately without keeping obsolete features as a condition.

## 13. Decisions

| # | Decision |
|---|---|
| D1 | Captain is the shared small-business Work/Chat/Resources system (§§1–2); Pip owns personal assistance. The old six assistant jobs are historical identifiers, not scope. Captain is useful without Pip; retirement never waits for it. |
| D2 | Inference is data-only: infer steps take data and return schema-validated data; no tools, no writes, no credentials. |
| D3 | Workflows are compositions of typed steps in five kinds (read, infer, write, await, notify) with deterministic, bounded control flow (`when`, `each`, `branch`). Housekeeping is a system routine, not a workflow. |
| D4 | A workflow acts in the name of the person who enabled it and can do nothing they could not. |
| D5 | No workflow sends external correspondence. The legacy outbox remains person-sent until retirement; no Captain Inbox/Outbox replacement is required. Pip/provider drafts remain person-reviewed. |
| D6 | Tenant isolation is forced RLS with a non-bypassing, non-administrative runtime role. Use SQL-created `captain_runtime` with explicit grants and no role memberships; new policies/grants name it alongside legacy `app`. Verify the actual runtime connection at startup/readiness and release, not only a local test role. |
| D7 | Captain owns shared projects, tasks, recurring series and evidence. Projects do not nest; one-level checklists remain. Tasks/series may have no project. Remove the Obligations system-project requirement through a reviewed schema/service change, not a hidden or renamed default. Flat tags/filters never duplicate work or grant access. |
| D8 | First-party connectors with our OAuth/encryption. Captain connects business sources; Pip holds personal provider access and uses normal Captain APIs. Google sign-in is separate from mail/calendar consent. No copied credentials or inbound forwarding mailbox. |
| D9 | Inference uses each organisation's own Claude or Codex subscription through an unmodified CLI, behind a Sprite provider adapter; monthly token allowances and per-step usage, not dollar reservations. |
| D10 | Historical engine-selection spike: Restate versus pg-boss with a small runner. Completed and settled by D19; not an open phase or current inbox requirement. |
| D11 | Exactly Work, Chat and Resources; Work defaults to Assigned to you, each tab has a grouped view list one page left. Account controls open Settings. Old assistant screens are retirement work; scoped redirects may preserve valid record links without preserving old UI/actions. |
| D12 | Hosting is Fly.io Sydney, Neon Postgres, Cloudflare, GitHub Actions. |
| D13 | Captain retains selected business attachment/file metadata and provider links, never attachment bytes. Any text extraction requires an allow list, size cap, brief cache expiry and labelled untrusted infer input; this does not authorise mailbox-wide ingestion. |
| D14 | Reviewed repository-native workspace designs and behaviour are the new workspace design authority (§10). `packages/ui/design/` remains a verbatim, unedited legacy Claude Design mirror. New components/tokens live outside it; technical proof screens do not supersede the approved visual mockups. |
| D15 | Inventory is a counted list for ingredients, consumables and finished product, not a ledger. Each quantity has one explicit authority: Captain count or a connected provider. Shopify is optional; never hand-overwrite provider-owned quantities. No movements, conversions, lots or costing. |
| D16 | Envelope encryption uses a master key held in the API's secrets wrapping per-tenant data keys; no cloud key-management service and no AWS account. |
| D17 | One environment until the second customer: one Neon branch and compute, one live pair of Fly apps. Current staging releases are manual from reviewed merged code per the operational record; automatic deploy is disabled and production stays dormant. |
| D18 | Inference runs on a Captain-owned Fly Sprite per organisation, with no shared filesystem between organisations. Only the CLI, its login and the minimal runtime/shim needed to invoke it live there; no business-data store or other workloads. Every model tool and MCP server is disabled; credentials stay outside inference data (D2). Provisioning and removal are self-service from Settings (amended 2026-09-19: the API creates and destroys the Sprite through the Sprites HTTP API with a platform token scoped to a dedicated Sprites organisation, and drives the CLI sign-in through the shim; the owner never needs a terminal, and the one-time login code is forwarded once in memory). The Sprite is the only inference runtime today; the API path is a documented seam, not a second runtime. |
| D19 | Durable workflows use pg-boss with a small Captain runner in the existing process and Postgres, following the D10 spike. Tenant-scoped run/step journals and destination idempotency remain ours; neither engine guarantees exactly-once remote writes. Production execution follows the transaction, continuation and recovery contracts in §4; each workflow waits for its complete handler registry. No Restate service or SDK is retained. |
| D20 | Retired product decision: deterministic Gmail triage gates and sender priors belong to the legacy assistant. Their implementation history is not a new Captain requirement. |
| D21 | Legacy mail/note ingestion is retired, its stored index is cleared, and its embedding service is stopped. The unused pgvector/client schema and deployment assets remain cleanup debt. Any new business source needs an explicit access/retention contract; no automatic adoption of old indexes, and no transfer to Pip. |
| D22 | Retired product decision: automatic mail/note project discovery is legacy. Projects are managed in Work; any later suggestion over deliberately shared business evidence needs a separate reviewed contract and does not restore mailbox discovery. |
| D23 | Shared item discussion is D25 chat, not a Notes/comments subsystem. Business evidence retains source identity; handle an actual note reference deliberately when affected, without invented messages or a requirement to retain Notes as a product. Captain is not a document editor. |
| D24 | Equipment scheduling is core. Continuous interval timelines support hours/days/weeks, resource scrolling and focal zoom. The server atomically prevents overlapping confirmed occupancy, including setup/cleanup/maintenance; unconfirmed, unknown and unloaded periods are explicit. Filters cannot hide competing resource occupancy. |
| D25 | Shared chat links bidirectionally to work and file versions (file-version links follow the Files contract). Item chats show the latest six chronological messages plus shared pins referencing original IDs. Stars are personal conversation bookmarks. Membership/access, retry-safe sends, reconnect/read state, pin auditing and source-linked summaries are specified before implementation; summaries remain D2 infer outputs. Chat writes, including personal stars and read positions, are audited in the participant-scoped `chat_audit_events`; the tenant-wide `audit_events` receives no chat identifiers. The [linked-chat contract](plans/linked-chat-2026-09.md) specifies the first increments. |
| D26 | Saved Work views are private, named, versioned filters evaluated for their owner. They never grant record access; filter/name content remains private in audit/export. Writes require revisions, create retry IDs survive content-clearing tombstones, and filter drafts preserve their original revision and explicit clears. Work defaults to My work. Shared views require a separate contract. |


## 14. Open implementation decisions and historical authority

- Saved filters: the [reviewed private-view contract](plans/saved-work-views-2026-09.md) is implemented
  in API/web (#153/#154); organisation-shared views still need their own contract.
- Linked chat: the [adopted contract](plans/linked-chat-2026-09.md) specifies bounded reads,
  revisions, participants/access, retry identity, cursors, read state, pins, participant-scoped
  audit and export/deletion for the first three increments. Implementation has not started. Its
  PR B execution gates (§17) are proven by real-Postgres tests. Summaries, files, notifications and
  native delivery need their own contracts.
- Files: provider/version identity, permissions, preview/extraction retention and explicitly shared
  correspondence contract. Provider originals and version-scoped chat are adopted; the entire
  older files/sidebars/paper-record proposal is not.
- Mobile: secure sessions, links, native notifications, actual iPhone/Android gesture, keyboard,
  accessibility and performance evidence. Next.js remains web; Expo remains mobile direction.
- Server inference tiers and any future API-key/cost-budget alternative (#32) are business-runtime
  decisions, separate from Pip's hard Apple/Siri requirements.
- Pip platform proofs remain in #119. No Captain milestone depends on them. No new claim about
  entitlement eligibility, background execution or device-off personal inference is established here.
- Release operations: current backup/restore evidence, application-role grants, actual deployed
  state, and owner-approved legal documents. Do not assert live data exists, is empty, or has been
  migrated from schema inspection alone.

The [legacy reference index](plans/legacy-assistant-history.md) points to the exact prior plan,
old six jobs and phases, and original migration inventory. Those texts document past implementation
and superseded decisions. Runbooks for those paths are maintenance references while the code still
exists, not instructions to add/enable them for the workspace. Closed issues retain their original
historical scope; the audit lists their disposition. The current plan wins over proposals, old
runbooks, the unedited design mirror and obsolete issue wording.

The [assistant runtime retirement increment](plans/assistant-runtime-retirement-2026-09.md) specifies
the first #133 implementation, revised task/stock workflows and mandatory stopped-worker cutover.
It leaves optional projects and replacement Work detail pages as explicit subsequent work.
