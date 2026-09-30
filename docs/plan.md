# Ask The Captain — product and engineering plan

**Status:** adopted workspace direction (#114/#116), corrected by the 25 September scope audit and
amended on 30 September 2026 for the chat-first rebuild (D27–D38). This is the source of truth for
Captain. Decisions in §13 change through reviewed pull requests. The
[chat-first proposal](proposals/2026-09-29-chat-first-captain.md) states the rules; the
[rebuild plan](plans/chat-first-rebuild-2026-09.md) records the audit, the owner's decisions and
increments R0–R9. The owner's 30 September
[private-call and selective-undo amendment](plans/private-threads-and-selective-undo-2026-09.md)
refines D25, D29 and D33; the [prototype export](proposals/assets/captain-chat-first-2026-09-30/README.md)
is the repository design reference.
The [delivery plan](plans/captain-workspace-delivery-2026-09.md) separates implemented capabilities
from targets. The [audit](plans/captain-scope-audit-2026-09-25.md) records the correction and issue
coverage; the [implementation inventory](plans/captain-workspace-migration-inventory-2026-09.md)
records legacy dependencies still to remove. The [code-removal contract](plans/assistant-code-removal-2026-09.md)
orders the remaining deletions and schema gates. None of these is evidence of useful live customer data.
Staging is authorised with at most one machine per app; production remains paused. Actual releases
are recorded in [paused.md](runbooks/paused.md).

## 1. What Captain is

Captain is the shared project and work system for a small business. It owns projects, tasks,
recurring work, accountable owners, equipment reservations, simple inventory, files and the
conversations around that work. **Every record is a conversation** (D27): its thread holds what
happened to it, and the app is one list of threads (D28). Production, Marketing, Sales and
Admin/reporting are flat tags; a project is a tag with an owner, dates and a thread (D7), and a
thread can carry several. The first customer is a small brewery; its vocabulary is record names,
not a custom domain model.

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
- **Discuss work:** every record's thread, topics without a record, and private conversations
  between people (D27); agents take part as members (D30).
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
  The model has four jobs (D36); every decision and write is code.
- **Versioned writes:** business-record writes are role-checked in RLS and store a full snapshot with who,
  what caused it and when, plus typed before/after changes (D29). Undo reverses selected changes
  against current state, preserving unrelated later edits, and appends new versions.
  A person-enabled workflow acts as that person; an agent writes under its own key within member limits (D4, D30). No signed request or
  confirmation token; code decides when an external action or an outside-linked record waits as
  pending for approval of its exact content (D31).
- **Nothing leaves unapproved:** an outside message is sent only after its owner, or an agent
  within admin-set limits, approves the exact content (D5, D31). The retired outbox is not a
  requirement for a Captain mail product; there is no inbox.
- **Tenant isolation:** forced RLS on every tenant table; the runtime role cannot bypass it.
  The [runtime-role repair](plans/runtime-database-role-2026-09.md) introduces SQL-created
  `captain_runtime`, explicit grants and live startup/readiness checks; hosted activation is a
  separately recorded credential operation.
- **Traceable effects:** version and audit writes and journal workflow steps, with explicit retry/idempotency
  boundaries. No credentials in model input, diagnostics or queue payloads.
- **Honest states:** distinguish empty, loading, failed, unavailable, stale and unconfirmed data.
  A failed read is not an empty day; an incomplete equipment read never establishes free time.
- **Small surface:** one list of threads with fixed filters and pinned views (D28), one
  authoritative record per thread, no configurable entity types, custom fields, units/conversions
  or process definitions.

## 4. Architecture

A pnpm/Turborepo monorepo, TypeScript throughout.

| Path | What |
|---|---|
| `apps/api` | Hono HTTP API: auth, routes over services, webhooks, health |
| `apps/web` | Retired Next.js web client; source and build configuration removed in R1c (D37) |
| `apps/e2e` | Playwright deployment smoke suite (deploy workflow, currently paused) and browser regression checks against the Expo web export |
| `apps/mobile` | The one Expo/React Native client with Expo Router for web, iOS and Android (D37). Shell/auth/platform/account composition (#188/#189/#193/#197), My work (#199), All tasks (#201), native navigation (#205), person-scoped session controls (#207), read-only [Inventory](plans/expo-mobile-inventory-read-2026-09.md) (#210) and the [equipment timeline](plans/expo-mobile-equipment-read-2026-09.md) (E-1 #212, E-2 #213) merged after review and CI; the three-tab navigation is replaced by the thread list (D28, R2). Business writes remain; native sign-in stays off, with no installed-app, simulator or device evidence. Native acceptance precedes device release. |
| `packages/db` | Drizzle schema, hand-written SQL migrations, RLS policies, typed queries |
| `packages/connectors` | Xero and Shopify business adapters; Google sign-in remains separate |
| `packages/steps` | the step catalog (§6) and the workflow definitions that compose it |
| `packages/engine` | durable workflow execution: pg-boss and a small typed runner in the API process |
| `packages/model` | the inference client: provider adapter, structured output, budgets, usage |
| Retired embedding app | `askthecaptain-embed` remains stopped with autostart off; repository assets removed, live resource removal is a separate operation (D21) |
| `packages/ui` | Removed in R1c: only Next.js imported it; owned brand assets live in `apps/mobile/assets/brand` |
| `infra` | OpenTofu for Neon, Cloudflare and monitoring; the inference Sprite's bootstrap files, which the API uploads when an owner sets up a subscription |

**Clients.** One Expo/React Native application with Expo Router serves web, iOS and Android
(D37); the Next.js app is retired in R1. The API serves the Expo web export from its own origin
and issues an HttpOnly cookie session with a CSRF check; native clients keep the bearer session.
Share client-safe contracts and deterministic date/filter/interval logic. Keep native
navigation/gesture/keyboard code platform-appropriate. The Expo web export is browser evidence;
iOS and Android remain bundle evidence until there is a device. Do not claim a signed native
build from that evidence. Browser and device access use the same API;
never bundle server credentials, database access or model secrets into a client. New shared
packages/dependencies are named in the slice that introduces them, not added speculatively. The
[mobile foundation contract](plans/expo-mobile-foundation-2026-09.md) names `apps/mobile` and its
proposed Expo/React Native dependencies (§8). Native sign-in stays off on shared staging and for
real accounts until verified claimed HTTPS links (or a reviewed equivalent) pass the app-identity
gate. Isolated synthetic-account proofs may precede that gate; real-device evidence is required
before mobile authentication is complete.

**Hosting.** Fly.io in Sydney for the API, which also serves the Expo web export (D37); Neon
Postgres; Cloudflare DNS; GitHub Actions
for CI and deploy. The checked-in DNS records are not proxied through Cloudflare; they do not
establish Cloudflare edge TLS processing. One data environment: a single Neon branch and compute, and the
Fly apps that serve app.askthecaptain.app. The automatic deploy/smoke workflow is disabled;
current staging releases are manual from reviewed, merged code under the operational record. A second
database waits for a second customer (D17).

The checked-in configuration and 23 September pause record identify the serving pair under D17 as
`askthecaptain-api-staging` and `askthecaptain-web-staging`; `app.askthecaptain.app`, the apex and
`www` are configured to point at the web app and `api-staging.askthecaptain.app` at the API.
A dormant pair, `askthecaptain-api` and `askthecaptain-web`, is retained; `api.askthecaptain.app`
points at the production API. The pause record dates its last promotion to 2026-09-05. Under D37
the `app` CNAME moves to the API app and the web apps are retired with the Next.js client (R1).
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
access uses the enabling person's tenant context, or the agent's key (D30), and the non-bypassing runtime role (D4, D6).
pg-boss owns platform queue metadata; its idempotent installer runs after database migrations in
the API release step, using the migration-owner connection. The runbook retains an operator
fallback; the running API never installs or upgrades the schema.
Local effects and completion records must be atomic where possible, otherwise destination
idempotency or reconciliation is required. Queue delivery is not a generic exactly-once
external-write guarantee. D5 allows an outside message only as an approved external action (D31); Captain retains no inbox.

`packages/engine` is the production runner in the API process (`WORKFLOWS_DISABLED=1` stops it).
A catalogue registry binds service/connector handlers; uninstalled handlers keep the corresponding
workflow unavailable. Run snapshots pin definitions, parameters and the enabling person or agent. Local writes
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
| Projects | A tag with an owner, dates, a thread and a planning task (D7); no nesting; a thread can carry several | Work project pages and revision-aware edits shipped in #138; projects become tags in the rebuild (plan §1); mail-discovery machinery is retired with the legacy work fields (R4) |
| Tasks | Title/body, status, owner, due date, tags (including projects), evidence, one-level checklist and a thread | Optional projects (0038, #136) and revisions with copied occurrence evidence requirements (0039, #138) shipped; the authorised legacy reset is complete, not a recurring deployment step; `suggested` and the other legacy fields are removed in R4 |
| Recurring work | Series generate ordinary tasks; no artificial project required; edits affect future occurrences | Standalone materialisation shipped in #136; rule revisions and copied occurrence evidence requirements shipped in #138 |
| Tags | Flat organisation labels on every record; many per record, stable identity on rename, no permissions or inherited duplication; a project is a tag with more on it (D7) | Migration 0035 and API/web controls implemented; [tag contract](plans/workspace-task-tags-2026-09.md) records its original project restrictions, superseded by #136 standalone-task eligibility |
| Saved views | Retired (D26): the thread list has fixed filters (D28) | [Contract](plans/saved-work-views-2026-09.md) delivered in #153/#154 and since retired; `saved_views` is removed in R5 after a live count |
| Equipment | Exclusive resources and bookings/maintenance with occupied start/end, setup/cleanup, revision and work/person links; a booking is pending, confirmed or cancelled (D32) | Migration 0036 and web shipped; [contract](plans/equipment-reservations-2026-09.md); standalone task links and revision-aware project movement added by #136; `pending` joins the status check and the no-overlap predicate in R5 |
| Threads | One thread per record, topics without a record, and private threads between people: `threads` (kind record, topic or private) and `thread_messages`; private threads keep participant-only rules and `chat_audit_events` (D27, D25) | R2 replaces the 0042/0043 tables (`conversations`, `conversation_participants`, `conversation_links`, `messages`, pins, stars, reads) after migrating staging data; the [linked-chat contract](plans/linked-chat-2026-09.md) was delivered in #169/#171/#173/#174 and is since retired |
| Versions | Business-record snapshots plus typed before/after changes with stable identities, actor, cause and time; selectable change sets and revision-checked inverse operations (D29) | `record_versions` in R3; the audit log stops being a state store (stocktake idempotency and Xero sync state move to their own tables) |
| Agents | Users of kind `agent` with a membership, a long-lived revocable key and a fixed capability list in code (D30) | R4; audit actor kind `agent`; chain origin, loop stop and budget in the run model |
| Approvals | Pending records with an approval card holding the exact editable content; take-ownership privilege; agent approval limits (D31) | R5 (pending, owner approval), R9 (outside messages, agent limits) |
| Evidence | Business source links and deliberately shared correspondence with source-qualified identity and provenance | Existing generic evidence references reusable but need a bounded sharing/access contract; no mailbox archive |
| Files/DAM | Provider originals, version identities, work links, a thread per file, "working on" markers and change notices through a Drive write grant (D34) | Planned (R7); no byte store or imported Embrace backend |
| Inventory | Each stock item is a record with a thread; counts are versioned writes with count time/person and explicit authority (D15) | Count services exist; versioned counts land with R3. Provider-owned quantities remain provider-owned; finished product does not require Shopify |
| Counterparties | Shared people/companies and business-provider references | Existing services reusable; stop automatic personal mailbox harvesting with legacy sync |
| Accounting | Xero invoice/payment/contact cache with source timestamps and completeness | Existing first-party connector; Xero remains accounting authority |
| Notifications | Captain business notifications on authorised task/resource/chat state | Web Push exists; native delivery is a separate implementation |
| Workflow/inference/audit | Enablements, immutable run snapshots, step journals, usage, budgets and audit events | Existing infrastructure; legacy definitions do not become new product scope. Private thread writes are audited in participant-scoped `chat_audit_events` (D25) |

No separate Notes/comments product is required by the new workspace. Item discussion is the record's thread (D23, D27).
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
| `write` | a deterministic, versioned write in the name of the enabling person or under the agent's key (D29, D30) | create task, record summary, apply a classifier's tags (D33), update business state |
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

The rebuild plan retires `chase-due` and `stocktake` with R6, once the Scheduler and Stock keeper
agents do that work.

A new business workflow gets explicit source permissions, typed steps, budgets, idempotency and
failure states. Captain's reading of shared messages and explicit private message-only calls
(D33, D25) and an agent's work (D30) run on the same
runner, with the chain's origin, loop stop and budget in the run model. Inference and background
jobs are not needed for ordinary task management or chat.

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
- **Four jobs (D36).** A message to a structured request, a handwritten box to a typed value
  with a confidence, drafting an outside message, and summarising a thread. Each has a schema;
  every decision and write is code.
- **Tiers.** The cheapest tier that does the job for the message classifier (D33), `small` for
  bounded extraction, `large` for business summaries and the conflict read (D33). Worksheet
  boxes need image input (D35). The tier is declared by the step; the CLI/provider and model
  behind each tier are configuration.
- **Budgets.** Monthly token allowances and per-step usage records, not dollar reservations.
  Before each call, check used tokens plus estimated input and maximum output against the
  organisation's allowance; settle with actual usage afterwards. When spent, workflows that need
  inference pause with a visible reason; deterministic steps keep running. No rollover process
  is needed: the month's row is created lazily.
- **Provider adapter.** A thin Sprite provider interface supports Claude and Codex without
  changing steps. The shim runs the CLI with every model tool and MCP server disabled, takes
  instruction, labelled input (text, or an image of a worksheet box), and output schema, and
  returns structured output and usage only.
- **Privacy and untrusted content.** Infer only over authorised, explicitly selected business
  sources. Label message/file content as untrusted and keep fixed instructions outside it.
  Schema validity does not establish truth or authorisation: validate source IDs, cross-check
  consequential facts and recheck permissions in deterministic code. Usage/diagnostics contain
  no content; durable step output requires its own minimised retention contract.
- **Retrieval.** D21's existing mail/note index is legacy. A future shared-business index needs an
  explicit source/access/retention contract; it must not silently continue personal mailbox
  ingestion. Pip's private iCloud index is separate and receives no copied Captain vectors.
- **Attachments.** D13 forbids retained attachment bytes, with one exception: photos of
  Captain's own worksheets are kept in object storage and linked from the versions they
  produced (D35). Any future extraction requires an
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
| Google Drive | Deliberately enrolled business originals/versions; a write grant limited to marker files and change notifications (D34); scopes/access proved in the files slice (R7) |
| Mail, send-only | Approved outside messages sent as the record's owner, and a shared sending address for agents within limits (D5, D31, R9); no inbox |
| Pip or another authorised client | Deliberately shared correspondence and normal work actions through authenticated APIs |
| Google sign-in | Identity; independent of retiring Gmail/Calendar product access |

The unused Gmail/Calendar read/send adapters and retrieval package are removed by the first
[code-removal increment](plans/assistant-code-removal-2026-09.md#r1--unused-legacy-leaf-modules-first-code-removal-no-schema-no-gate).
The Google mailbox grant/revocation path is removed after the R4b live-count gate confirmed
zero Google connections on staging (27 September, 05:22:22.969Z). Google identity sign-in remains.
No business inbox replaces the removed code; mail returns only as a send-only grant for approved
outside messages (D5). Pip's personal providers need separate consent,
never copied credentials. The shared connection schema remains for Xero and Shopify.

## 9. Security and tenancy

- Forced RLS on every tenant table; a runtime database role that cannot bypass it; tenant context
  set transactionally. Adversarial cross-tenant tests in CI.
- Roles: owner (billing, keys, members), admin (connections, workflows), member (use). Platform
  operator roles are separate from tenant roles. Agents are users of kind `agent` with a
  membership and a long-lived revocable key instead of a session; they can do what a member can
  and never what only an admin can (D30).
- Privileges: approval of an outside action belongs to the record's owner. Taking ownership is a
  privilege of admins and the organisation owner, grantable to others, and is a visible versioned
  change; an agent may approve within admin-set limits, never its own draft (D31).
- Sign-in with Google for any domain; explicit organisation creation; verified invitations.
  The web client's session is an HttpOnly cookie issued by the API with a CSRF check; native clients
  hold a bearer session (D37).
  Passkeys (WebAuthn, `@simplewebauthn/server` in the API and `@simplewebauthn/browser` in the Expo
  web export, the served app origin as the relying party) are the second factor: a person who has registered one
  must present it at every sign-in, between Google and the session; owners and admins are asked to
  add one in Settings before invitations open to strangers.
- Secrets: envelope encryption without a cloud key service. A 32-byte master key lives in the API's
  secrets; each organisation has a data key wrapped by it; connection tokens and Sprite connection secrets are
  encrypted with the data key (AES-256-GCM). Rotation re-wraps data keys. No third-party key service
  and no extra cloud account.
- Rate limits per IP, user, organisation and connection. Webhook signature verification.
- Business-record writes store versions and typed changes (D29); writes remain audited under
  their domain rules. An agent's write is recorded against its
  key with actor kind `agent` (D30). Data export and organisation deletion as first-class operations: an
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

Phone-first and responsive desktop, one Expo application for web, iOS and Android (D37). The
three-tab shell (Work, Chat and Resources, delivered in #159/#188/#205 and since retired) is
replaced by the thread list (D28):

- **The thread list** — one list of threads, newest activity first, with what needs the person
  marked. A row is dense: title, time, the record's key facts, the latest message on one line and a
  count of what needs you. The list is grouped by tag with foldable headings (a project's heading
  shows its owner and date); a thread with several tags appears under each. Fixed filters: All,
  Needs you, Tasks, Bookings, Stock, Records, Files, People. No tabs and no saved views (D26).
- **The record thread** — a small card on top (title, status and two facts; the rest in a
  fold-out) that stays in view while the thread scrolls. Below it, messages, change lines written
  by code from versions, and approval cards, oldest to newest; the thread opens at the first
  unread, with earlier messages folded behind one row. A new thread is an empty composer; Captain
  reads shared messages; a private thread invokes an agent only through an explicit mention,
  exposing just the calling message (D33). A pending record shows its approval card with the exact
  editable content (D31).
- **Pinned views** — views that are not lists of threads open from pinned rows: the equipment
  schedule (confirmed, pending and cleaning; scale buttons and native scrolling only, gestures
  deferred by D38) and the team.

Web routes have meaningful URLs and browser history; native back behaviour is preserved. Desktop
can show the list and the thread alongside each other. Settings stays reachable from
account/avatar controls. Loading, failed, empty, disabled, pending and permission states remain
required. Unknown/unloaded equipment is never shown free, and pending is never shown as free.

**A record's detail is its thread (D27).** Standalone tasks must not display a fabricated project.
The [Work record contract](plans/work-record-pages-2026-09.md) defined bounded reads, revision
preconditions and copied evidence requirements, shipped as web pages in #138 and since retired
with the Next.js client; the reads and preconditions carry over to the record card. Old bookmarks
may resolve to the corresponding record thread, or an explicit retired/unavailable state where no
target exists. Redirect compatibility is not a reason to keep old screens/actions. Task due dates
and the equipment schedule remain in scope; they are not the retired synced personal Google
Calendar product.

**Account settings.** Keep identity, members, approved business connections, notifications,
inference and workflow configuration reachable through account controls. Remove legacy mailbox
onboarding, drafting preferences and mail/discovery workflows with their retirement increments.
The generic runner's activity UI and inference setup can be reused without keeping old duties.

**Design authority (D14).** The owner-supplied
[chat-first HTML prototype](proposals/assets/captain-chat-first-2026-09-30/README.md), checked in
unchanged with its checksum, and the reviewed behaviour contracts are the design authority.
The privacy and selective-undo amendment takes precedence over older prototype interactions;
new selection/conflict screens require reviewed designs before implementation. The
[2026-09-22 mobile mockups](proposals/assets/captain-mobile-2026-09-22/README.md) are historical.
The Expo architecture harness is technical evidence, not a replacement visual design.
`packages/ui/design/`, the verbatim legacy Claude Design mirror, is retired with `packages/ui`
in R1 and is never hand-edited; components and tokens live in `apps/mobile`, with their source
recorded in the implementation PR. Existing screens may continue consuming legacy tokens
while they migrate. Light/dark, accessible focus, contrast and text scaling are acceptance work;
do not invent an unreviewed dark palette or require a Claude Design round-trip for each change.

## 11. Delivery

Follow the [rebuild plan](plans/chat-first-rebuild-2026-09.md) increments R0–R9: adopt; web
session and shell; threads; versions and undo; Captain reads; pending and approval; first agents;
files; worksheets; outside messages. Each is small pull requests with the workspace outcome named;
the first three retire the old surface while the new one becomes usable, and nothing deploys to
production. The [delivery plan](plans/captain-workspace-delivery-2026-09.md) and
[assignments](plans/captain-next-batch-2026-09-27.md) record work up to `2d3f1ef`. Assistant code
and storage retirement is complete (#194/#196). Equipment scheduling is mandatory in the first
usable workflow. Web and iOS need two-person acceptance; Android smoke checks start during mobile
development and broader Android release follows.

Implemented: web shell, filtered Work/task creation, tags, counted inventory access, equipment
API/web, session recovery, and the assistant UI/API/runtime retirement with revised task/stock
workflows, optional projects/Obligations removal, and revision-aware Work task/project/series
pages (#138), private saved Work views (#153/#154), default business views (#159), and linked-chat
API/web (#169/#171/#173/#174). The Next.js deliveries among these are retired by R1; their services
and contracts carry over where the rebuild plan says so. Not complete: the thread list and record
threads, versions, agents, pending, files/DAM, worksheets, native application and device acceptance.
Do not call the remaining screens implemented because a prototype or bundle exports exist.

The old phases 0–5 and six jobs are historical. Their completed issues document earlier work;
they are not a second roadmap. Second-customer readiness is separately tracked in
[#27](https://github.com/SomedaySomehowBeer/askthecaptain/issues/27), with verified security,
backup/restore and owner-reviewed legal prerequisites, not mail reconnect prerequisites.

## 12. Non-goals

- Pip's personal inbox, correspondence composer, calendar preparation, Reminders or private search.
- A model with tools or the authority to write: the model has four schema-checked jobs (D36) and
  code makes every decision and write (D2).
- A configurable business domain/process model, inventory movements, conversions, lots or costing.
- A document editor, a Captain file client or an asset byte store: files stay in Drive (D34) and
  worksheet photos are the only stored bytes (D35). No Embrace/Lore backend or Docs/Sheets
  sidebar. Provider-held DAM and version-scoped chat are in scope; further file capabilities need
  explicit adoption.
- Full offline booking confirmation, automatic rescheduling of other people's work, or copied task
  state across clients. Unknown work never appears confirmed, and a pending booking is never shown
  as free (D32).
- A compatibility product or migration programme for hypothetical customers/data. Preserve security
  and handle affected real records deliberately without keeping obsolete features as a condition.

## 13. Decisions

| # | Decision |
|---|---|
| D1 | Captain is the shared small-business work system (§§1–2): every record is a conversation and the app is one list of threads (D27, D28). Pip owns personal assistance. The old six assistant jobs are historical identifiers, not scope. Captain is useful without Pip; retirement never waits for it. |
| D2 | Inference is data-only: infer steps take data and return schema-validated data; no tools, no writes, no credentials. |
| D3 | Workflows are compositions of typed steps in five kinds (read, infer, write, await, notify) with deterministic, bounded control flow (`when`, `each`, `branch`). Housekeeping is a system routine, not a workflow. |
| D4 | A person-enabled workflow acts as that person and can do nothing they could not; an agent acts under its own key with member limits (D30). |
| D5 | Nothing leaves the organisation unapproved. Approved exact content may be sent by the record's owner or by an agent within admin-set limits (D31). No Captain inbox; Pip/provider drafts remain person-reviewed. |
| D6 | Tenant isolation is forced RLS with a non-bypassing, non-administrative runtime role. Use SQL-created `captain_runtime` with explicit grants and no role memberships; new policies/grants name it alongside legacy `app`. Verify the actual runtime connection at startup/readiness and release, not only a local test role. |
| D7 | Captain owns shared projects, tasks, recurring series and evidence. A project is a tag with an owner, dates, a thread and a planning task; a task or booking may carry several. Projects do not nest; one-level checklists remain. Tasks/series may have no project. Remove the Obligations system-project requirement through a reviewed schema/service change, not a hidden or renamed default. Flat tags/filters never duplicate work or grant access. |
| D8 | First-party connectors with our OAuth/encryption. Captain connects business sources; Pip holds personal provider access and uses normal Captain APIs. Google sign-in is separate from mail/calendar consent. No copied credentials or inbound forwarding mailbox. A Drive write grant for marker files and change notifications (D34) and a send-only mail grant (D5) are allowed; still no inbox. |
| D9 | Inference uses each organisation's own Claude or Codex subscription through an unmodified CLI, behind a Sprite provider adapter; monthly token allowances and per-step usage, not dollar reservations. |
| D10 | Historical engine-selection spike: Restate versus pg-boss with a small runner. Completed and settled by D19; not an open phase or current inbox requirement. |
| D11 | Replaced by D28 (2026-09-30). Was: exactly Work, Chat and Resources, each with a grouped view list one page left, delivered in #159/#188/#205 and since retired. Account controls still open Settings; scoped redirects may preserve valid record links without preserving old UI/actions. |
| D12 | Hosting is Fly.io Sydney, Neon Postgres, Cloudflare, GitHub Actions. The web client is the Expo web export served by the API (D37). |
| D13 | Captain retains selected business attachment/file metadata and provider links, never attachment bytes, with one exception: photos of Captain's own worksheets (D35). Any text extraction requires an allow list, size cap, brief cache expiry and labelled untrusted infer input; this does not authorise mailbox-wide ingestion. |
| D14 | The checked-in owner-supplied chat-first prototype and reviewed behaviour contracts are the design authority (§10); the 2026-09-22 mockups are historical. `packages/ui/design/` is retired with `packages/ui` and is never hand-edited; components and tokens live in `apps/mobile`. Technical proof screens do not supersede the reviewed prototype. |
| D15 | Inventory is a counted list for ingredients, consumables and finished product, not a ledger. Each stock item is a record with a thread (D27) and counts are versioned writes (D29). Each quantity has one explicit authority: Captain count or a connected provider. Shopify is optional; never hand-overwrite provider-owned quantities. No movements, conversions, lots or costing. |
| D16 | Envelope encryption uses a master key held in the API's secrets wrapping per-tenant data keys; no cloud key-management service and no AWS account. |
| D17 | One environment until the second customer: one Neon branch and compute, one live pair of Fly apps. Current staging releases are manual from reviewed merged code per the operational record; automatic deploy is disabled and production stays dormant. |
| D18 | Inference runs on a Captain-owned Fly Sprite per organisation, with no shared filesystem between organisations. Only the CLI, its login and the minimal runtime/shim needed to invoke it live there; no business-data store or other workloads. Every model tool and MCP server is disabled; credentials stay outside inference data (D2). Provisioning and removal are self-service from Settings (amended 2026-09-19: the API creates and destroys the Sprite through the Sprites HTTP API with a platform token scoped to a dedicated Sprites organisation, and drives the CLI sign-in through the shim; the owner never needs a terminal, and the one-time login code is forwarded once in memory). The Sprite is the only inference runtime today; the API path is a documented seam, not a second runtime. |
| D19 | Durable workflows use pg-boss with a small Captain runner in the existing process and Postgres, following the D10 spike. Tenant-scoped run/step journals and destination idempotency remain ours; neither engine guarantees exactly-once remote writes. Production execution follows the transaction, continuation and recovery contracts in §4; each workflow waits for its complete handler registry. No Restate service or SDK is retained. |
| D20 | Retired product decision: deterministic Gmail triage gates and sender priors belong to the legacy assistant. Their implementation history is not a new Captain requirement. |
| D21 | Legacy mail/note ingestion is retired, its stored index is cleared, and its embedding service is stopped. Legacy index schema, unused client code and deployment assets are removed (#181/#182/#194). The stopped embedding app is retained until a separately authorised infrastructure operation. Any new business source needs an explicit access/retention contract; no automatic adoption of old indexes, and no transfer to Pip. |
| D22 | Retired product decision: automatic mail/note project discovery is legacy. Projects are managed in Work; any later suggestion over deliberately shared business evidence needs a separate reviewed contract and does not restore mailbox discovery. |
| D23 | Discussion of a record is its thread (D27), not a Notes/comments subsystem. Business evidence retains source identity; handle an actual note reference deliberately when affected, without invented messages or a requirement to retain Notes as a product. Captain is not a document editor. |
| D24 | Equipment scheduling is core. Continuous interval timelines support hours/days/weeks by scale buttons and resource scrolling; focal zoom and other touch gestures are deferred (D38). Bookings are pending, confirmed or cancelled (D32); the server atomically prevents overlapping pending and confirmed occupancy, including setup/cleanup/maintenance; unknown and unloaded periods are explicit. Filters cannot hide competing resource occupancy. |
| D25 | Record threads follow the record's audience (D27); private threads remain participant-only with retry-safe sends and reconnect/read state. They are excluded from classification and inference unless a participant explicitly mentions an agent; only the calling message may be processed, never prior history, summaries or cached context. A call grants no thread membership. Private source links, call records and replies remain participant-scoped; existing linked chats retain their private audience during migration. The latest-six item panel is superseded by the record thread. Shared pins and personal stars carry into the thread model: pins reference original messages and are audited; stars are personal thread bookmarks. Private thread writes, including personal stars and read positions, are audited in the participant-scoped `chat_audit_events`; the tenant-wide `audit_events` receives no chat identifiers. The [linked-chat contract](plans/linked-chat-2026-09.md) specified the first increments, delivered in #169/#171/#173/#174 and replaced by the thread model in R2. |
| D26 | Retired (2026-09-30): saved views are removed and the thread list has fixed filters (D28). Delivered as private, versioned filters in #153/#154; `saved_views` is dropped in R5 after a live count. |
| D27 | Every record — task, project, booking, stock item, production record, company or file — has one thread: a small card with its current state on top and, below it, every message, change line written by code from versions, and approval card. A conversation with no record is a topic. A record thread is visible to whoever can see the record; private threads between people stay participant-only. |
| D28 | The app is one list of threads, newest activity first, grouped by tag with foldable headings and filtered by All, Needs you, Tasks, Bookings, Stock, Records, Files and People. No tabs; views that are not lists of threads (the equipment schedule, the team) open from pinned rows. Messages read oldest to newest and a thread opens at the first unread. Replaces D11. |
| D29 | Business writes retain full snapshots and immutable typed before/after changes with actor, cause, revisions and stable identities. A person can select whole change sets or independent changes within them to reverse. Preview and atomically apply inverse operations against current state, preserving unrelated later edits; conflicting or dependent changes are explicit, never silently overwritten. Reversal appends a retry-safe change set and new versions, never restores a whole snapshot over later work. Current permissions, domain rules and external-effect limits still apply; see the private-call and selective-undo contract. |
| D30 | Agents are users of kind `agent`: a plain name, a long-lived revocable key instead of a session, a membership, and a fixed list in code of what they can do — what a member can, never what only an admin can. Every agent write is recorded against its key (audit actor kind `agent`). Agents ask each other by mention in shared record threads, with no hidden inter-agent conversation. A participant's explicit private call may be routed only within its calling-message scope (D25/D33); a chain carries its origin, never asks the same agent the same thing about the same record version twice, and stops on a shared admin-set time and inference budget. |
| D31 | Code, never the model, decides whether approval is needed: any external action type, or any record linked to an outside company or person, waits as pending with an approval card showing the exact editable content. Acting under a person's name always needs that person. Taking ownership is a grantable privilege and a visible versioned change. An agent may approve within admin-set limits (kind, counterparties, amount per action and per week), under its own name from a shared address, never its own draft. |
| D32 | Bookings are pending, confirmed or cancelled. Pending holds the slot with no expiry, and the no-overlap rule covers pending and confirmed; the booking's owner, an admin or the organisation owner can cancel it. An agent's internal booking is confirmed at once. Pending is never shown as free. |
| D33 | Captain reads messages in shared record/topic threads through a cheap schema-checked classifier. Private threads bypass it unless a participant explicitly `@` mentions an agent; classification and every needed agent receive only that calling message, with no thread history or persistent context (D25). Captain applies what is new as a plain change worded as a person's ("Captain added the tag …"), never "Captain thinks"; it asks another agent by mention. On a conflict with the card it changes nothing, and a second, slightly larger read decides whether to stay quiet or offer the change as one tap. A new thread is an empty composer. |
| D34 | Files stay in Google Drive; Captain has no file client. "Working on" adds an advisory marker file beside the original and removes it when done; Captain watches Drive and posts in the thread when someone else saves; what is in Drive when the person finishes becomes the next version. |
| D35 | Worksheets are printed by Captain from versioned code templates carrying a code. Code locates the code and crops the boxes; the model reads each box to a typed value with a confidence; code checks units, ranges and totals and saves one change set, leaving unreadable boxes blank. Internal scans need no human approval; third-party effects follow D31. A scan is one change set, reversible as a whole or as selected independent changes under D29. The photo is kept in object storage and linked from the versions it produced. |
| D36 | The model has four jobs, each schema-checked: a message to a structured request, a handwritten box to a value, drafting an outside message, summarising a thread. Everything else, including every decision and write, is code. |
| D37 | The client is one Expo/React Native application with Expo Router for web, iOS and Android; the Next.js app is retired. The API serves the Expo web export from its own origin with an HttpOnly cookie session and a CSRF check; Playwright checks run against that export. |
| D38 | Equipment timeline touch gestures are deferred: scale buttons and native scrolling only, with no gesture or animation dependency, until a reviewed increment names the dependency and its device gate. |


## 14. Open implementation decisions and historical authority

- Saved views: the [private-view contract](plans/saved-work-views-2026-09.md) was implemented in
  API/web (#153/#154) and is retired by D26; `saved_views` is dropped in R5 after a live count.
- Linked chat: the [adopted contract](plans/linked-chat-2026-09.md) specifies bounded reads,
  revisions, participants/access, retry identity, cursors, read state, pins, participant-scoped
  audit and export/deletion for the first three increments. Core storage/API shipped in #169 on
  the restricted staging runtime. PR C (#171) shipped pins/stars/read positions/edits to staging; the
  [web delivery amendment](plans/linked-chat-web-2026-09.md) defines PR D. Its bounded read API prerequisite shipped in #173; web #174 is released to staging, with local and CI two-person browser acceptance. Hosted checks cover anonymous protection and sign-in, not an authenticated two-person session.
  PR B execution gates (§17) passed real-Postgres and hosted rollback-only checks. R2 replaces the
  0042/0043 tables with the thread model (D27) after migrating staging data; summaries,
  notifications and native delivery need their own contracts.
- Versions: the [selective-undo contract](plans/private-threads-and-selective-undo-2026-09.md)
  defines selection, inverse operations, concurrency and privacy. The R3 schema/migration contract
  must name the typed change journal alongside `record_versions`, including moving stocktake
  idempotency and Xero sync state out of the audit log into their own tables.
- Agents: where agent keys are stored, how they are rotated and withdrawn, and the shared admin-set
  chain budget (D30).
- Inference: the cheapest tier for the message classifier and image inference for worksheet boxes
  on the Sprite (D33, D35).
- Files: the Drive connector and write grant, the marker file's appearance in Finder and open
  dialogs, and how quickly Drive reports a save and whether it names who saved — to test before
  relying on it (D34, R7). Provider/version identity, permissions and preview/extraction retention
  still need their contract; the older files/sidebars/paper-record proposal is not adopted.
- Worksheets: the object storage provider for photos (D35); provisioning is the owner's.
- Outside messages: the send-only mail grant and the shared sending address for agents (D5, D31,
  R9) are new grants for the owner to review.
- Mobile: the [foundation contract](plans/expo-mobile-foundation-2026-09.md), tracked in #178,
  specifies secure sessions, app-bound handoff, the three-tab shell (since replaced by the thread
  list, D28) and authenticated reads. Native
  sign-in stays off on shared staging and for real accounts until verified claimed HTTPS links
  (or a reviewed equivalent) pass the app-identity gate. Remote session revocation is required for
  first-customer native readiness. Native notifications, actual iPhone/Android gesture, keyboard,
  accessibility and performance evidence remain separate. Next.js is retired; the Expo app is the one client for web, iOS and Android (D37).
  Sign-in composition and the account screens ([composition plan](plans/expo-mobile-auth-composition-2026-09.md))
  merged in #197. The read-only [My work read](plans/expo-mobile-my-work-read-2026-09.md) (M-read slice 1)
  merged in #199 after independent review and green CI. Other business reads and writes, native
  sign-in and device evidence remain. The response byte budget merged in #202 after review and green CI.
  [All tasks](plans/expo-mobile-all-tasks-read-2026-09.md) merged in #201.
  [Native navigation](plans/expo-mobile-native-navigation-2026-09.md) merged in #205 after review and green CI;
  native device evidence remains open. The [remote session revocation](plans/mobile-session-revocation-2026-09.md)
  API merged in #204, its web control in #206, and its mobile control in #207 after review and green CI.
  The [Inventory read](plans/expo-mobile-inventory-read-2026-09.md) merged in #210 after review and green CI.
  The [equipment timeline contract](plans/expo-mobile-equipment-read-2026-09.md) follows: multi-day, cross-equipment
  reads with Hours/Days/Weeks buttons, delivered in #212/#213; touch gestures are deferred (D38) and native device acceptance remains a separate gate.
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
