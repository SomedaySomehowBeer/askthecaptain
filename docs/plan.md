# Ask The Captain — product and engineering plan

**Status:** adopted. The workspace amendment merged as #116 on 2026-09-24, following the
merged product proposal #114. This document is the source of truth for what Captain is and how it is built. Decisions are
recorded in §13 and changed only by a reviewed pull request. Target behaviour below is delivered
in the [workspace sequence](plans/captain-workspace-delivery-2026-09.md); naming a capability here
does not claim it is implemented. Existing personal-assistant behaviour remains a compatibility
surface until its data and workflows are deliberately migrated. The operational pause in
[paused.md](runbooks/paused.md) remains in force; development does not authorise a resume.

## 1. What Captain is

Captain is the shared project and work system for a small business. It owns projects, tasks,
recurring duties, accountable owners, equipment reservations and the conversations and evidence
around that work. Work, Chat and Resources are views of the same records. Production, Marketing,
Sales and Admin/reporting are tags; people and projects can span them.

Pip is a separate personal assistant on Apple devices. Personal mail, calendar assistance,
Reminders and private attachment search belong to that product and its providers. Captain is
useful without Pip. Pip reads or changes shared business work through Captain's authenticated,
role-checked API; it does not keep a second business task or project state. Xero remains the
accounting authority, file/email providers retain originals, and Captain holds their links.
Captain's shared business schedules and inference run on the server, even when devices are off.
Pip's Apple model/system capabilities require their own device proofs.

The six job numbers below stay stable for existing workflow definitions. Their target scope is
shared business work. The existing mail/outbox/calendar implementation is retained during the
transition, not silently deleted, duplicated into Pip or restarted by this amendment.

People manage shared records through ordinary role-checked writes. Automation uses **workflows
of deterministic steps**. Where judgement is needed, a step asks a
language model a narrow question and takes back structured data, which the next step acts on. The
model never holds a tool, never writes to anything, and never sees a credential. The owner decides
which workflows run and how; the machine does exactly what those workflows say.

The first customer is a small brewery. The product is generic to small producers, trades and
service businesses; the brewery's specifics are configuration, not code.

## 2. The six jobs

Every piece of work on Captain must move one of these sooner.

1. **Triage the inbox.** Turn incoming shared business evidence into reviewable work and updates.
   Pip handles personal mailbox assistance; Captain receives business correspondence links through
   its API. Existing connected-mail triage remains until its replacement and retention are settled.
2. **Draft and send correspondence.** Prepare business correspondence with linked project context;
   a person sends it (D5). Keep current outbox drafts and their provenance during the transition.
3. **Keep the calendar.** Plan shared work and equipment reservations, show conflicts and preparation,
   and retain provider event links. Pip handles personal calendar assistance.
4. **Own commitments.** Projects, tasks and recurring duties with owners, dates, tags, equipment and
   evidence; one shared state across clients and linked conversations.
5. **Chase.** Remind owners before something is due and escalate after; nudge counterparties about
   overdue invoices and unanswered business correspondence, as drafts a person sends.
6. **Brief and answer.** Explain shared work, conversation decisions, commitments, customers and money
   from authorised business data, with source links and freshness. Pip handles private catch-ups.

### Existing assistant walkthrough (compatibility during migration)

06:30 the owner's phone shows the brief: two invoices overdue, the excise return due Friday, three
mails need an answer and the drafts are ready, a supplier meeting at 11 with the last three
conversations attached. The owner reads the drafts on the train, edits one, sends all three. At 09:00
a customer emails asking for a price list; by the time the owner looks, the reply is drafted and a
task "send updated price list" sits in the Wholesale project. At 14:00 the tax office's confirmation
arrives; the excise duty for the period is marked done with the mail attached, and nobody touched
it. On Thursday the chaser workflow drafts a polite note to the customer whose invoice is now three
weeks overdue. The owner sends it.

## 3. Principles

- **Data-only inference.** A model is called only by an *infer* step: input data, an instruction,
  an output schema. The output is validated and handed to deterministic code, which decides what it
  means. No tools, no free prose that a person acts on directly.
- **People configure, machines execute.** A workflow runs in the name of the person who enabled it
  and can do nothing that person could not do. Enabling a workflow is the authorisation.
- **See it before it leaves.** Anything that goes to a third party, mail above all, waits in the
  outbox until a person sends it. Anything else the workflows do is visible in the journal.
- **Tenant isolation is enforced by the database.** Row Level Security on every tenant table,
  forced, with a runtime role that cannot bypass it. Application code cannot forget it.
- **Everything is journaled.** Every workflow run records each step's input digest and output;
  every write records who or what made it. Provenance is a property of the record, not a feature.
- **Small surface.** Three workspace tabs: Work, Chat and Resources. Features earn their place by a job in §2.
- **Honest states.** When a connection is down, a budget is spent or a model is unavailable, the
  product says so and what to do. It never fabricates a quiet day.

## 4. Architecture

A pnpm/Turborepo monorepo, TypeScript throughout.

| Path | What |
|---|---|
| `apps/api` | Hono HTTP API: auth, routes over services, webhooks, health |
| `apps/web` | Next.js; server components read the API. Today it is the legacy five-tab app (Today, Inbox, Commitments, Calendar, Settings); the responsive Work/Chat/Resources shell is a later slice |
| `apps/e2e` | Playwright deployment smoke suite (deploy workflow, currently paused) and isolated browser regression in CI |
| `apps/mobile` | Planned React Native/Expo development-build client for iOS and Android; not in the repository yet; native-device acceptance precedes release |
| `packages/db` | Drizzle schema, hand-written SQL migrations, RLS policies, typed queries |
| `packages/connectors` | Google (Gmail, Calendar), Xero, Shopify: OAuth, refresh, typed clients, webhooks |
| `packages/steps` | the step catalog (§6) and the workflow definitions that compose it |
| `packages/engine` | durable workflow execution: pg-boss and a small typed runner in the API process |
| `packages/model` | the inference client: provider adapter, structured output, budgets, usage |
| `packages/retrieval` | embedding units, the client for the embedding service, thread vectors and hybrid search over the mail index (§5, §7) |
| `infra/embed` | the stateless embedding service: one small sentence encoder behind a bearer secret, shared by all organisations, holding no data (D21) |
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
Fly apps that serve app.askthecaptain.app, deployed from `main` behind the smoke gate. A second
database waits for a second customer (D17).

The checked-in configuration and 23 September pause record identify the serving pair under D17 as
`askthecaptain-api-staging` and `askthecaptain-web-staging`; `app.askthecaptain.app`, the apex and
`www` are configured to point at the web app and `api-staging.askthecaptain.app` at the API.
A dormant pair, `askthecaptain-api` and `askthecaptain-web`, is retained; `api.askthecaptain.app`
points at the production API. The pause record dates its last promotion to 2026-09-05.
`askthecaptain-embed` is the D21 embedding service. All apps are recorded stopped under the
operational pause ([paused.md](runbooks/paused.md)); the `deploy` and `backup` workflows were
verified disabled on 24 September. Configuration is not a live availability check.

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
external-write guarantee. D5 still requires a person to send outbound mail.

`packages/engine` is the production runner in the API process (`WORKFLOWS_DISABLED=1` stops it).
A catalogue registry binds service/connector handlers; uninstalled handlers keep the corresponding
workflow unavailable. Run snapshots pin definitions, parameters and enabling people. Local writes
and journal completion share a transaction; provider intent precedes I/O, with idempotency or
reconciliation in the adapter. Successful mail-sync cursor commits enqueue `mail.synced` runs in
the same transaction. Await deadlines and event wake-ups are also atomic with journal/destination
state. Membership checks, actionable inference pauses, Resume, cancellation and named retry
exhaustion are part of the runner. No separate engine service is provisioned.

Daily/weekly schedules use the organisation's timezone and a persisted next run, replacing it on
first delivery; each queue payload contains only a run id. A platform failure queue records exhausted
worker deliveries back into the tenant journal. Settings → Workflows → Activity links to run details:
ordered steps, loop item, state and reason, with Resume for paused runs and Cancel for unfinished runs
(owner/admin). Empty, unavailable, failed and saving states use words. The triage/outbox handlers bind this runner to mail, inference, commitments and person-sent drafts. [The runbook](runbooks/workflow-runner.md) covers installation,
handler contracts and recovery.

## 5. Data model

Every tenant table carries `organisation_id`, has forced RLS, and uses uuidv7 keys.

**Identity and access**
- `organisations` — name, timezone, locale, settings.
- `users`, `identities` (Google OIDC subject, email), `sessions` (with whether a passkey was presented),
  `passkeys` — a person's WebAuthn credentials: id, public key, counter, transports, a name.
- `memberships` — user, organisation, role ∈ owner · admin · member.
- `audit_events` — actor (person, workflow run or system), action, subject, before/after digest,
  at. Append-only.
- `organisation_deletions` — platform record of a deleted organisation: name, who deleted it, row
  counts; everything else cascades away with the organisation (§9 deletion as a first-class operation).

**Workspace additions (target; implemented in subsequent migrations)** None of these tables exists
on `main` yet. Tags and task tags are proposed in migration 0035 in PR #117, open at the time of
writing.
- `tags` — organisation-owned flat labels with a stable ID and a nonblank name, unique without
  case distinctions inside the organisation. Tags carry no custom fields or permissions.
- `task_tags` — tenant-qualified links between tasks and tags. A task can have zero or more;
  assignment/removal never copies the task or moves its project. Start with explicit task tags,
  without automatic project/series inheritance. Renaming a label keeps all links. Production,
  Marketing, Sales and Admin/reporting are suggested names, not hard-coded workspaces.
- Saved views are versioned filters over existing records, scoped to their owner or explicit
  sharing rules; their persistence schema is a later slice. A filter never grants access.
- Equipment and reservation records hold named resources, actual start/end instants, unavailability,
  occupied setup/cleanup intervals, status and task/project/person links (D24). Concrete tables and
  transaction constraints are reviewed together in the equipment slice.
- Conversations, membership, messages, record links, shared pins, personal stars and read position
  are distinct identities (D25). Their schema and access model are reviewed in the chat slice.
  These target descriptions are not an authorisation for an unaudited generic record store.

**Connections**
- `connections` — provider, organisation, connected by, scopes, status, error; access and refresh
  tokens envelope-encrypted with a per-tenant data key wrapped by the master key (D16).
- `sync_cursors`, `webhook_events` (deduplicated by provider id), `webhook_attempts`.

**Mail**
- `mail_threads`, `mail_messages` — synced from Gmail; bodies stored, provider ids kept.
- `mail_triage` — one row per thread: category, needs-owner flag, summary, extracted facts,
  produced by the triage workflow with the run id that produced it.
- `mail_attachments` — metadata only: message, filename, media type, size, provider attachment
  id. Attachment bytes are **not stored**; the provider keeps them and they are fetched on demand.
- `attachment_text` — extracted text for attachments that triage was allowed to read (§7),
  capped in length, kept for a bounded period, then dropped.
- `outbox` — drafts awaiting a person: thread (or none), to, subject, body, created by run,
  state ∈ drafted · sent · discarded, sent by, sent at, provider message id; outcome ∈ sent ·
  edited · discarded · not_needed · expired, and remind-at for a draft a person deferred.
- `mail_senders` — per sender address: threads seen, verdicts by category, needs-owner count,
  replies and stars by a person, draft outcomes (sent, edited then sent, discarded, not needed,
  requested), last seen. The learned priors the triage gate and the draft score read (§6); any
  reply or star from a person resets the sender to "always classify".
- `content_vectors` — the retrieval index: source ∈ mail_message · note (a later source, such as
  the extracted text of an enrolled file version, adds a value, not a table), source id, chunk index,
  encoder name and version, vector (pgvector). Derived from content and treated as that content:
  same policy, cascades with its source, never logged or exported on its own. The thread vector is
  recomputed from these rows and kept on `mail_threads` with its encoder version; a note's vector
  is kept on the note.

**Notes**
- `notes` — plain text a person writes in Captain: a quick note, meeting notes, anything between.
  Author, title (optional), body capped at 20,000 characters, and at most one link each to a
  calendar event, a contact, a company, a project and a task; archived at. Not a document store
  (§12): no formatting, files or comments. A note is content like a mail thread: triaged, indexed
  and citable as evidence, and its author is the person, so it never needs the owner and is
  never drafted a reply. Existing notes remain notes. New task/project/file discussions use the
  shared chat model (D25), including a file-version anchor where relevant; they are not copied
  into notes or a second comments table. A later migration decides how any existing file notes
  are linked without losing their original author, evidence identity or audit history.
- `note_triage` — one row per note, the same shape as `mail_triage` less the needs-owner flag:
  summary, facts, produced by run, model.

**Calendar**
- `calendars`, `calendar_events` — synced cache; event writes go to the provider and are re-read.
  Preparation is local: `preparation_note`, `prepared_by_run` (tenant-scoped run reference) and
  `prepared_at` on `calendar_events` (migration 0020); provider revisions clear the note.

**People and companies**
- `contacts`, `companies` — the business's counterparties, kept current by triage and by hand.

**Commitments**
- `projects` — name, description, stages, owner, state ∈ proposed · active · archived, proposed
  by run, and a brief: what this is, where it stands, who is involved, open questions, each line
  citing an evidence thread; written by discovery, editable by a person, and the whole of an
  idea-stage project that has no tasks yet. One system project per organisation, **Obligations**,
  flagged so the UI shows it as a deadline book. A proposed project is visible on Commitments and
  becomes active only when a person accepts it.
- `project_sources` — project, source ∈ mail_thread · note, source id, linked by ∈ rule · model ·
  person with the run or person that made the link. A source may belong to more than one project.
- `project_candidates` — a proposed project name the triage model returned for a thread or note
  that fits no existing project: normalised name, the sources that proposed it and whether each is
  the person's own writing, first and last seen. Promoted
  to a discovery seed by the threshold rule in §6, never directly to a project.
- `tasks` — project, title, body, status ∈ suggested · open · in_progress · done · cancelled,
  owner, due, source (mail thread, series, person, run), completed by, completed at, and parent:
  a sub-task is a task whose parent is another task in the same project, one level deep, with no
  series and no sub-tasks of its own. A parent is completed by a person; completing its last
  sub-task suggests that, never does it.
- `task_series` — the rule that generates recurring tasks. A series belongs to a project (by
  default Obligations), carries a template (title pattern, body, owner, evidence required), a
  recurrence (monthly, quarterly, yearly, weekdays, custom) and a due rule (for example "due 21 days
  after the period ends"). Each occurrence is an ordinary task with `series_id`, `period_start` and
  `period_end`; the system creates the next occurrence at the start of its period. Editing a series
  changes future occurrences only; completing a task never touches its series. "Excise return" is a
  monthly series in Obligations whose September task is due on 21 October. "Order cans" is a monthly
  series in the Production project. A one-off task simply has no series.
- `evidence` — a link from a task to a mail message, a note, a file or a URL, with who attached it.

**Stock** (what nothing else counts)
- `stock_items` — name, location, unit label (text), current count, counted at, counted by,
  reorder point, preferred supplier (a company), notes. The count is the truth and a person
  enters it; Captain never computes stock from movements. Sellable products live in the connected
  commerce system and are read from there, not duplicated here.
- `stock_counts` — the history of counts per item: when, by whom, the number.

**Shopify commerce cache**
- `shopify_products` — provider product and variant ids, names, SKU, price, inventory item and
  tracking status. Shopify owns these records; they are never hand-counted or copied to `stock_items`.
- `shopify_inventory_levels` — available quantity per inventory item and Shopify location, with
  provider update time. A complete paged snapshot removes variants and locations no longer present.
- `shopify_orders` — accessible orders with customer name/email when granted, status, total,
  currency and provider timestamps. Details sync incrementally by `updated_at`; an id-only sweep
  removes deleted orders. The standard `read_orders` scope covers 60 days, and summaries say so.
- `shopify_reorder_points` — the person's threshold per variant, applied separately at each location.
  It stays separate from provider-owned quantities and survives a same-shop reconnect and sync.
  Members can change it; edits are audited. A different shop clears the previous shop's cache and thresholds.

**Workflows**
- `workflow_definitions` — code-defined and versioned; the table holds the catalogue the API exposes.
- `workflow_enablements` — organisation, definition, enabled by, parameters, schedule overrides.
- `workflow_runs`, `workflow_run_steps` — the journal: trigger, started, finished, state, and per
  step the kind, input digest, output, error.

**Inference**
- `inference_runtimes` — one per organisation: Claude or Codex, Sprite id/name and region,
  provisioning/login/readiness status, non-secret login hint, added by, last verified at and error;
  Sprite URL and bearer secret envelope-encrypted with the organisation's data key (D16).
- `model_budgets` — organisation, first-of-month date, token limit and used tokens; a missing month
  is created lazily from the organisation's configured monthly allowance.
- `model_usage` — per infer step: optional run, step, tier, provider, model, input and output tokens,
  latency and timestamp; no content.

**Briefs**
- `briefs` — one saved brief per tenant/run, with the organisation's date, title, short lines,
  validated source item references and produced-at time. The `briefs.record` write step saves it
  after inference and before push, atomically with the step journal and an audit event.

**Answers**
- `answers` (migration 0025) — independent saved exchanges: organisation, asking member, question,
  validated answer, source references, confidence in words, actual provider-reported model and time.
  Tenant-qualified membership keys and forced RLS protect append-only writes in the asking person's
  name. History reads show that person's questions; organisation exports include every exchange.
  Stored exchanges never become model conversation context.

**Notifications**
- `push_subscriptions` — a member's device: endpoint and keys, disabled when the push service says it is gone.
- `push_deliveries` — every push sent, whether it arrived; journaled like any other write.
  Web Push encryption and VAPID signing use the `web-push` library; the private key lives only in the API.

### Xero accounting cache (D6, D8)

`xero_contacts`, `xero_invoices` and `xero_payments` cache the selected Xero organisation's
contacts, sales invoices / purchase bills, and invoice payments. All carry tenant-qualified
connection and provider keys; contacts may link to Captain companies / contacts on an unambiguous
exact name / email match without changing a person's fields. Company external references record
that match. Money reads preserve currencies and report incomplete syncs. These are system sync
records, not a configurable financial model. Products and stock remain Shopify's responsibility.

## 6. Workflows

A workflow is an ordered composition of steps from a typed catalog, defined in TypeScript in
`packages/steps`, versioned with the code, and enabled per organisation with parameters. Definitions
are engine-neutral data structures so the same definition runs on whichever execution engine §4
settles on.

### Step kinds

| Kind | Does | Examples |
|---|---|---|
| `read` | reads from a connector or the database | new threads since cursor, overdue invoices, tasks due this week |
| `infer` | model call: data in, schema-validated object out; no tools | classify a thread, extract a due date and counterparty, draft a reply body |
| `write` | a deterministic write, in the name of the enabling person | create task, complete task, create outbox draft, label thread |
| `await` | wait for a time, a record state or an external event, with a timeout | until three days before due; until the outbox draft is sent; until a webhook arrives |
| `notify` | push to a person | morning brief, escalation |

Every step declares its input and output types. `read` and `write` steps are plain functions over
the connectors and the database. `infer` steps declare an instruction, an output schema and a model
tier. `await` covers timers: waiting for a time is one of its conditions, not a kind of its own. A
definition that names a capability the enabling person lacks fails at enablement, not at run time.

### Control flow

Control flow is deterministic and bounded, and it is part of the definition rather than a step:

- `when(predicate)` on any step: the step runs only if a pure predicate over earlier outputs holds.
- `each(list, steps)`: run a sub-sequence once per item of a finite list produced by an earlier step,
  journaled per item. Triage classifies threads this way.
- `branch(predicate, thenSteps, elseSteps)`: choose a path by a pure predicate.

Predicates are functions over data, never model calls. There is no unbounded loop; anything that
repeats does so over a list that already exists or by being triggered again. If the execution engine
chosen in §4 runs workflows as ordinary code, these are simply the language's `if`, `for` and the
engine's durable `await`, and the journal records the steps within them.

### Workflows and system routines

Workflows are the owner's: enabled per organisation, visible in Settings, journaled, and always
doing one of the six jobs. **System routines** are the product's own housekeeping and are not
workflows: syncing mail and calendars, refreshing tokens, creating the next occurrence of a series,
retrying webhooks. They run on a schedule, are logged, and appear in
Settings → Activity only when they fail.

### The first workflows

- **inbox-triage** (on mail arrival, on a saved note, and 06:00): read new threads and notes → gate
  each thread with
  deterministic rules and sender priors, no model (bulk and automated mail is filed as information
  with the rule named in the journal) → infer classification per thread that passes the gate, and per note and per sent message with
  enough own text (§14 own writing)
  (category, needs owner, summary, facts: counterparty, amounts, dates, references, suggested tasks
  each with optional steps that become sub-tasks, and a project: an existing one, none, or a
  proposed name with its stage, idea or underway) → write triage rows, the project link, the sender
  verdict, suggested tasks in the linked project or Obligations, complete duties whose
  confirmation arrived, update contacts → infer reply drafts for threads whose draft score crosses the
  organisation's threshold (§14), at most twenty per run → write outbox drafts → await send →
  write labels.
- **discover-projects** (on demand from Commitments by an owner or admin, and at 06:00 when a
  candidate has crossed its threshold; rerunnable): read the seeds (a thread a person chose, a
  candidate name, or on the first run the clusters of the synced backlog) → read the retrieval
  index for each seed's neighbours and widen deterministically → infer, once per seed, which
  candidates belong and what they amount to: a project (with a brief, a stage and any tasks, each
  with steps and its evidence thread), a single task with or without steps, a relationship, or
  nothing → write a proposed project with its brief, thread links, suggested tasks and evidence;
  or one suggested task in the linked project or Obligations; or a company link → notify the
  enabling person. Nothing
  is active until a person accepts it. Delivery detail in §14.
- **morning-brief** (06:30): read overdue and due-this-week tasks, outbox, today's events, overdue
  receivables → infer a brief from that data → write `briefs.record` → notify the enabling person.
  Requires ready inference and that person's subscribed push device. Google calendar and Xero are
  optional cache reads with explicit connection/completeness state. Bounded snapshots (100 items per
  source, with a truncation notice) contain no mail bodies or credentials. The output's kind/id pairs
  must belong to the snapshot; code supplies link labels and destinations. Missing/incomplete-source
  notices are saved even if the model omits them. Today places this brief first, with title, lines,
  source links and produced-at time; older dates, workflow-off, loading, unavailable and failed runs
  are explicit. Push failure leaves the saved brief readable and the run retryable.
- **chase-due** (07:00, version 3): read up to 100 open/in-progress tasks due within the configured
  window, including overdue tasks → each task independently: await the reminder date, notify its
  owner (or enabling person if unowned), await the day after due, escalate to the enabling person.
  Await steps re-read the task and save it as the loop item, so completion/cancellation/deletion or
  date changes govern later predicates. Notify checks current state again. Replacement push tags
  are stable per tenant/task. Independent `each` iterations park separately: another task's wait
  does not delay invoice drafting. Other workflows retain sequential loops unless opted in.
  Await handlers may return a wake time separate from their bounded timeout; journalled timers
  wake at 07:00 in the organisation's timezone and survive restarts, with a 90-day maximum wait.
  Read cached overdue receivables (configured overdue-days threshold) → infer a courteous chaser →
  write a standalone outbox draft, never send. Requires Google, Xero, ready inference and push.
  Missing/incomplete Xero cache or more than 100 candidates pauses with instructions; it does not
  silently claim success. Before writing, recheck the invoice's amount, currency, due date, number
  and recipient; paid/changed records are skipped for the next daily run. Drafts are idempotent per
  run/step/item. The outbox stores the invoice provider id: a pending chaser (including an
  unconfirmed send) blocks another draft across runs. Sent chasers enforce `chaseAgainAfterDays`
  (default seven elapsed days); discarding an unsent draft permits a replacement, while any recent
  sent chaser still enforces that interval. Concurrent runs serialize the history check and write. Activity shows each waiting step’s next check time and why an action
  was skipped. No new tenant table or background process is required.

- **stocktake** (weekly, or on demand): each stock item at the configured location: notify the
  counter and await the count → write the count → branch on count below reorder point: write a
  task in Purchasing, infer a short order email to the preferred supplier, write an outbox draft.
  For connected commerce stock: read levels → the same branch, without asking anyone to count.
- **calendar-prep** (evening): read tomorrow's events → read related threads and contacts → infer a
  one-paragraph preparation note per event → write notes locally, never to Google. At 18:00 in the
  organisation’s timezone, it reads events overlapping tomorrow from primary/selected synced calendars,
  matches attendee email addresses to contacts and companies, and reads at most 10 matching threads
  from the last 30 days (subjects and snippets only). The large-tier infer receives labelled untrusted
  data and returns a validated single paragraph: who they are, what was discussed and anything
  explicitly owed either way. Unmatched contacts and limited correspondence remain explicit.
  Incomplete calendar/mail sync pauses with instructions to sync and Resume. Candidate mail reads
  are bounded to 1000 messages with an explicit truncation warning; events/attendees are bounded to
  100, with an actionable pause if exceeded. The audited write checks the event revision and newer
  preparation before saving; replay cannot duplicate it. Calendar and Today display the paragraph
  under its event with “Prepared at” in the organisation’s timezone, a missing-note message, and
  a linked notice when preparation is off, inference unavailable or the latest run paused/failed.
  The existing page loading/error states remain. No Google writes or additional background process.

### Stocktake delivery detail (D2, D4, D5, D15)

The enabling person is the stock counter: notify their subscribed devices, then await a count newer
than the run's start, with a three-day deadline per item. The person's count transaction emits its
wake-up; the workflow journals that observation without inserting another count. Local step writes
and journal completion commit together, with run/step/item receipts for observations and reorder tasks.
A named Purchasing project is created once if absent; duplicate active names require correction.
Reorder tasks are due seven days later in the organisation's timezone. Supplier drafts use the one
active contact of the preferred company, when unambiguous; missing email skips inference/outbox with
a journal note. Usual order quantity is unknown until a later data-model decision, never inferred.
Google and inference are prerequisites for drafting. Shopify is optional: disconnected or incomplete
cache data is journaled and skipped; tracked variants with thresholds create tasks without a count.
Both counted-item and shop-stock loops are capped at 100, with an explicit pause above the bound.

Commitments → Stock has an owner/admin **Start a stocktake** form with the location. It starts the
existing enabled workflow and opens Activity, with pending, failed and disabled states. The selected
location is pinned only to this run; its weekly settings and enabling person stay fixed. Activity
shows step notes for missing supplier addresses, unavailable Shopify data and count notifications.

### Example: inbox-triage

An illustration of the definition's first shape. The live definition, now version 7 with the gate,
drafting rules, notes, association and sent mail, is `packages/steps/src/defs/inbox-triage.ts`.

```ts
export const inboxTriage = defineWorkflow({
  key: 'inbox-triage',
  triggers: [onEvent('mail.synced'), daily('06:00')],
  parameters: { replyStyle: text(), draftReplies: boolean(true) },
  steps: [
    read('gmail.newThreads', { since: cursor('mail') }),
    each('threads', [
      read('attachments.extractText', { allow: ['application/pdf', 'text/csv'], maxBytes: mb(5) }),
      infer('classifyThread', { schema: TriageSchema, tier: 'small' }),
      write('triage.record'),
      write('tasks.suggestFromTriage'),
      write('tasks.completeFromConfirmations'),
      write('contacts.upsertFromTriage'),
      branch((t) => t.needsOwner && params.draftReplies, [
        infer('draftReply', { schema: DraftSchema, tier: 'large' }),
        write('outbox.create'),
        await('outbox.sent', { timeout: days(7) }),
      ]),
      write('gmail.label', { label: 'Captain/Handled' }),
    ]),
  ],
});
```

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
- **Tiers.** `small` for classification and extraction, `large` for drafting and the brief. The
  tier is declared by the step; the CLI/provider and model behind each tier are configuration.
- **Budgets.** Monthly token allowances and per-step usage records, not dollar reservations.
  Before each call, check used tokens plus estimated input and maximum output against the
  organisation's allowance; settle with actual usage afterwards. When spent, workflows that need
  inference pause with a visible reason; deterministic steps keep running. No rollover process
  is needed: the month's row is created lazily.
- **Voice.** Drafting steps carry a short style note and up to three example replies from the
  organisation's settings. That is the whole "personality" system.
- **Provider adapter.** A thin Sprite provider interface supports Claude and Codex without
  changing steps. The shim runs the CLI with every model tool and MCP server disabled, takes
  instruction, labelled input and output schema, and returns structured output and usage only.
- **Privacy.** Mail bodies and notes go to the model only inside triage and drafting steps of
  workflows the owner enabled. Usage is recorded per step; content is not logged.
- **Untrusted content.** Everything a model reads from mail is untrusted: bodies, subjects, sender
  names, attachment text. The prompt labels it as such and the instruction lives outside it. The
  structural defence is D2: the only thing an injected instruction can influence is the data the
  step returns, which a schema validates and deterministic code interprets. Wrong data is possible;
  an action is not. Facts that matter (amounts, bank details, due dates) are cross-checked against
  the ledger and known counterparties where a source exists, and anything from an unknown sender
  is marked needs-owner regardless of what the model said.
- **Retrieval is not inference.** A small sentence encoder (ONNX, CPU) runs in one Captain-run
  embedding service (`infra/embed`, D21) to embed mail into the retrieval index (§5
  `content_vectors`). It takes no instruction and returns numbers, not text, so it is a `read` step
  and D2 does not apply to it; it is not a model tier and never sees a schema. The service is
  stateless and shared by all organisations: mail text reaches it over TLS with a bearer secret,
  is embedded in memory and never written to disk. It is not the inference Sprite (D18), which
  keeps hosting nothing but the CLI. There is no third-party embeddings service.
- **Attachments.** Triage may read an attachment only if its media type is on the allow list
  (PDF, CSV, plain text; images later, with OCR) and it is under the size cap. Text is extracted
  server-side, truncated, cached briefly (§5) and passed as labelled untrusted content. Files are
  never sent to the model as files and never stored by Captain; the mail provider remains the
  system of record for the bytes, and evidence links point at the message and attachment id.

### Later: API keys and cost budgets

A tenant may in future bring an Anthropic API key instead of a subscription. The
schema and provider interface already leave the seam: provider value `anthropic_api`,
nullable `cost_micros` on `model_usage`, nullable `cost_limit_micros` on `model_budgets`,
and a limits object in the budget check. Enabling it would add an `ApiProvider` in
`packages/model` using the provider SDK, a price table, key storage encrypted with
the organisation's data key, and verification on entry. API-key execution and cost
budgets are not implemented today; the Sprite remains the only inference runtime.

## 8. Connectors

First-party SDKs and REST behind `packages/connectors`, each with OAuth, token refresh under a row
lock, a typed client, webhook verification and a sync cursor.

| Provider | For | Order |
|---|---|---|
| Google | Gmail (read, label, drafts, send), Calendar (read, create, update), sign-in | 1 |
| Xero | invoices, payments, contacts, aged receivables and payables | 2 |
| Shopify | orders, customers, inventory | 3 |

Webhooks land on the API directly, are deduplicated by provider id, and enqueue work. Polling is the
fallback for providers without webhooks. Shopify initially polls products, inventory levels and
accessible orders every 15 minutes in the existing API process (`SHOPIFY_SYNC_DISABLED=1` pauses it),
with a manual sync control. Its standalone custom-distribution app uses a non-expiring offline
token, callback HMAC and browser nonce verification; provider-requested GraphQL cost delays are
respected and persisted. Public-app expiring tokens and Shopify webhooks are later slices.

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
  had been failing since 2026-09-21 on a `pg_dump` version mismatch and is disabled under the pause;
  no restore drill has been recorded yet.

## 10. Web and mobile

Phone-first and responsive desktop. The target is exactly three workspace tabs; the running app
still has the five legacy tabs described under Compatibility below:

- **Work** — defaults to My work, filtered to Assigned to you. Projects, tasks, recurring
  obligations and tag/project/person/status/date views all select the same records.
- **Chat** — participant conversations, unread and personally starred conversations, linked
  bidirectionally to projects/tasks/file versions. Participation follows the conversation by
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

**Compatibility.** Existing Today, Inbox, Commitments, Calendar and Settings URLs/data remain
reachable until their replacements preserve the relevant actions and source links. The new shell
is a later implementation PR, not part of this plan amendment. Briefs/questions and recurring work
move under Work; retained mail/calendar views can be reached from grouped lists during migration.
Do not break old evidence URLs or silently stop an enabled workflow to make the navigation fit.
The paragraphs below describe retained features until their workspace slices relocate them.

**Settings → Workflows.** Each workflow is drawn as its steps, in the manner of Apple Shortcuts:
what starts it, then one card per step in the catalogue's words (Read, Ask the model, Write, Wait,
Notify) with the values it uses and saves as named chips and its settings as chips, and `each` and
`branch` as indented Repeat and If blocks. A person can see exactly what turning a workflow on
authorises before they do. A run's detail lays the journal over the same steps, saying how far each
got and for how many items, with the flat journal beneath it.

**Settings → Inference.** A provider selector (Claude or Codex) and one Set up subscription
button that creates the runtime; a status line that moves through Setting up → Needs sign-in →
Ready, with the next action beside it; a Sign in button that opens the provider's link, a device
code shown in large type for Codex, and a code field for Claude's returned code; Verify and
Disconnect; a monthly token allowance form and usage by tier. Empty, loading, failed and disabled
states say what is known and what to do next, including when the platform has no Sprites token
configured. Every step works on a phone; nothing requires a terminal.

**Design authority (D14).** Reviewed repository-native workspace designs and their documented
behaviour are authoritative for the new workspace. Start with the linked mobile mockups and
preserve user-approved refinements. The Expo architecture harness is technical evidence, not a
replacement visual design. `packages/ui/design/` remains the verbatim legacy Claude Design mirror;
do not hand-edit it. New/adapted components and tokens are authored outside the mirror, with their
source recorded in the implementation PR. Existing screens may continue consuming legacy tokens
while they migrate. Light/dark, accessible focus, contrast and text scaling are acceptance work;
do not invent an unreviewed dark palette or require a Claude Design round-trip for each change.

### The Today question box (job 6)

The bottom card accepts one question, displays its answer, evidence confidence in words, source links
and time, and folds the previous three questions under a disclosure. Empty, reading, failed,
unavailable and spent-budget states say what to do, linking Settings → Inference when appropriate.
Each submission is independent; no action or conversation is inferred from a question.

### Notes (jobs 4 and 6)

A note is written in one motion: a note control sits with the question box on Today and on every
event, contact, company, project and task, pre-linked to the thing it was opened from. Today lists
the last few notes; each linked thing lists its own. A note is plain text with an optional title
and can be edited or archived by its author or an owner. It is not a sixth tab (D11) and not a
document editor (§12). Workspace replacements follow the reviewed repository designs (D14).

`POST /v1/organisations/:id/answers` accepts an active member's question (up to 1000 characters),
limited to 30 attempts/hour per organisation using the existing process rate limiter. `GET` reads
that person's last few exchanges, with inference availability. Deterministic code selects sources:
whole name words/exact emails match contacts and companies; task, mail, calendar, money and stock
words select the corresponding saved records. Today/tomorrow/yesterday, this/last/next week or month,
and month names (optionally with a year) set civil date ranges in the organisation's timezone.
Unspecified calendar dates use the next seven days. Task dates are due dates; paid invoices use
fully-paid dates, overdue invoices due dates, other invoices issue dates unless due dates are asked
for; “owe today” uses current unpaid balances, not issue dates. Invoices retain currency and are not a cash-flow report. Mail is limited to subjects/snippets
from the last 60 days. Stock is the current saved observation, never reconstructed historical stock.

Each source is capped at 20 rows; mail candidate matching at 1000 messages. Caps, date scope,
ambiguous names, missing connections and incomplete syncs are explicit. Each row has a code-owned
`{ kind, id, label, url }` reference to its existing tab or detail page. One interactive catalogue
`answer` infer step (large tier) receives the question and labelled untrusted retrieved data, with no
previous exchanges, tools or credentials. The schema is `{ answer, sources, confidence }`; code drops
unknown source ids, downgrades unsupported confidence and keeps source gaps in the displayed answer.
The inference service records normal usage and returns the actual model name; a separate plain,
audited insert stores the exchange. No workflow enablement or queue is needed for this synchronous
one-question step. Unavailable inference and spent budgets refuse before any model call. This adds
no dependency, provider operation, background process or tab (D2, D6, D11).

## 11. Phases

The [workspace delivery plan](plans/captain-workspace-delivery-2026-09.md) now sequences new work:
reviewed scope/migration amendments → client/work foundation → equipment → linked chat → first
usable web/iOS release → files/business context → assistance → broader Android release. Equipment
is mandatory in the first usable release; Android smoke checks begin early. Device acceptance and
transactional booking tests remain gates. The table below records the earlier assistant delivery
history and is not a new schedule or authority to resume the paused deployment. Phase numbers
(0–5) and slice numbers (0–7) are separate sequences: "Phase 4" is not "slice 4", and the delivery
plan's first-customer release is not the historical phase that prepared for a second customer.

| Phase | Weeks | Delivers |
|---|---|---|
| 0 Foundation | 1 | Monorepo, infra, CI and deploy, auth, organisations and memberships, RLS with tests, design tokens and shell |
| 1 Connect and collect | 1–2 | Google connection, Gmail sync and webhooks, calendar sync, contacts; projects, tasks, series, Obligations project; Commitments and Inbox tabs reading synced data |
| 2 Think | 2 | Inference client with budgets; engine decision recorded by the inbox-triage spike (D19: pg-boss); harden the runner and ship inbox-triage and the outbox for the first customer |
| 3 Assist | 2 | morning-brief, chase-due, materialise-series, calendar-prep; push; Today tab; Xero connection |
| 4 Ready for a second customer | 2 | MFA, backups and restore drill, export and deletion, terms and privacy, support runbook; a second business onboarded by hand |
| 5 Projects from mail and notes | 2 | In order: the triage gate, sender priors, weighted drafting and trimmed model input; notes; sub-tasks and the project brief; the retrieval index filled by mail sync; project association in triage; discover-projects and proposed projects on Commitments |

The existing assistant code covers work from these phases; the table is not evidence that every
feature was configured or verified live. Phase 4 is incomplete: a second business is not recorded
as onboarded, the terms and privacy notice are unpublished drafts (`docs/legal/`), and the manual
restore-drill ledger is empty. Use the workspace delivery gates for new work.

## 12. Non-goals for version 1

- A conversational assistant with tools; the question box answers from data, not by acting.
- General-purpose hosted workspaces or interactive agents: the inference Sprite runs only the
  subscription CLI with tools disabled; it is not a conversational assistant with tools.
- Inventory as a ledger: movements, unit conversions, lots and expiry, costing, bills of materials.
  Captain keeps a counted stock list (§5) and reads sellable stock from the connected commerce
  system; a business that needs a ledger connects a system that has one.
- A configurable domain model: custom entity types (a brewery's "Batch" with gyle number, recipe
  and volume; a pottery's "Firing"), units with conversions (hectolitres, kegs of 50 litres, cases
  of 24), and process definitions (planned → brewing → fermenting → conditioning → packaged, with
  allowed transitions and measurements at each step). That is a production system, and the
  assistant does not need it: "Package batch 42" is a task. The business's vocabulary is the names
  of its projects, tasks and series.
- Marketplace integrations beyond Google, Xero and Shopify.
- A document editor or file-byte store. Captain links provider-held originals and versions;
  business file/DAM review is in scope after its schema/access slice. Linked team chat is in scope
  (D25). Notes (§5) remain plain authored records, distinct from conversations and file originals.
- A personal mailbox, personal task authority or private cross-device search service inside Captain.
  Those are Pip/provider responsibilities; existing Captain data is retained under the migration plan.
- Full offline booking confirmation or automatic rescheduling of other people's work. Cached reads
  and unsent drafts can be offline; booking confirmation requires the server.

## 13. Decisions

| # | Decision |
|---|---|
| D1 | Captain is the shared small-business work/project system; Pip is the separate personal assistant. The six stable job IDs in §2 apply to shared business work. Existing assistant features remain through an explicit migration; Captain is useful without Pip. |
| D2 | Inference is data-only: infer steps take data and return schema-validated data; no tools, no writes, no credentials. |
| D3 | Workflows are compositions of typed steps in five kinds (read, infer, write, await, notify) with deterministic, bounded control flow (`when`, `each`, `branch`). Housekeeping is a system routine, not a workflow. |
| D4 | A workflow acts in the name of the person who enabled it and can do nothing they could not. |
| D5 | Anything sent to a third party waits in the outbox for a person. |
| D6 | Tenant isolation is forced RLS with a non-bypassing runtime role. |
| D7 | Captain owns projects/tasks/series and their stable evidence identities. Projects do not nest; one-level task checklists and series remain. Tasks have an accountable owner and zero or more flat tags, not separate business areas. Standalone work needs no user-created project; the existing Obligations system project remains its compatible storage default. Tags/filters never duplicate work or grant access. |
| D8 | Connectors are first-party SDKs behind our own OAuth and encryption; no third-party integration platforms. Captain owns shared business connections; Pip owns personal provider access and calls Captain through its ordinary authenticated API. Existing credentials are preserved in place during migration, never copied into Pip. No inbound forwarding mailbox is added. |
| D9 | Inference uses each organisation's own Claude or Codex subscription through an unmodified CLI, behind a Sprite provider adapter; monthly token allowances and per-step usage, not dollar reservations. |
| D10 | The durable execution engine is chosen by a bounded spike in Phase 2 between Restate and pg-boss with a small runner. (Settled by D19.) |
| D11 | Work, Chat and Resources are the three workspace tabs. Work defaults to Assigned to you; each tab has a grouped view list one page left. Settings is reached through account controls. Preserve existing URLs/actions until their replacement slice is ready. |
| D12 | Hosting is Fly.io Sydney, Neon Postgres, Cloudflare, GitHub Actions. |
| D13 | Attachment bytes are never stored. Metadata always; text extracted on an allow list and size cap, cached briefly, passed to the model as labelled untrusted content. |
| D14 | Reviewed repository-native workspace designs and behaviour are the new workspace design authority (§10). `packages/ui/design/` remains a verbatim, unedited legacy Claude Design mirror. New components/tokens live outside it; technical proof screens do not supersede the approved visual mockups. |
| D15 | Inventory is a counted list, not a ledger: sellable stock is read from the connected commerce system; everything else is a stock item whose count a person enters, with a stocktake workflow and reorder tasks. |
| D16 | Envelope encryption uses a master key held in the API's secrets wrapping per-tenant data keys; no cloud key-management service and no AWS account. |
| D17 | One environment until the second customer: one Neon branch and compute, one live pair of Fly apps deployed from `main`; production promotion exists but stays dormant. |
| D18 | Inference runs on a Captain-owned Fly Sprite per organisation, with no shared filesystem between organisations. Only the CLI, its login and the minimal runtime/shim needed to invoke it live there; no business-data store or other workloads. Every model tool and MCP server is disabled; credentials stay outside inference data (D2). Provisioning and removal are self-service from Settings (amended 2026-09-19: the API creates and destroys the Sprite through the Sprites HTTP API with a platform token scoped to a dedicated Sprites organisation, and drives the CLI sign-in through the shim; the owner never needs a terminal, and the one-time login code is forwarded once in memory). The Sprite is the only inference runtime today; the API path is a documented seam, not a second runtime. |
| D19 | Durable workflows use pg-boss with a small Captain runner in the existing process and Postgres, following the D10 spike. Tenant-scoped run/step journals and destination idempotency remain ours; neither engine guarantees exactly-once remote writes. Production execution follows the transaction, continuation and recovery contracts in §4; each workflow waits for its complete handler registry. No Restate service or SDK is retained. |
| D20 | Deterministic code decides before any model call: a rules gate on Gmail categories, list headers, sender shape and reply state, plus per-sender priors learned from earlier verdicts and a person's replies, files bulk and automated mail without inference. The model classifies only what passes. |
| D21 | The retrieval index is a pgvector column in the tenant's own Postgres rows, filled by a small sentence encoder (bge-small-en-v1.5, 384 dimensions) in one Captain-run, stateless embedding service shared by all organisations: a plain Fly machine in Sydney that scales to zero and holds no data (`infra/embed`, decided 2026-09-20 over Workers AI, which would add a processor of mail text to audit). No separate vector store and no third-party embeddings service; vectors are mail-derived data under the same policy as mail. |
| D22 | Captain proposes projects from evidence and a person makes them real. The triage model may name a project per thread; deterministic thresholds decide when that evidence is worth a discovery call; the discovery call judges the assembled evidence against the criteria in §14 and answers project, task, relationship or nothing; a person accepts. A project is never created from a single mail, and a proposed project is inert until accepted. |
| D23 | Existing notes remain first-class authored plain text, citable by stable ID and retained during migration. Shared discussions use D25 conversations, not duplicate notes/comments; file review may anchor a chat to a version. Captain retains metadata/links rather than file bytes and is not a document editor. |
| D24 | Equipment scheduling is core. Continuous interval timelines support hours/days/weeks, resource scrolling and focal zoom. The server atomically prevents overlapping confirmed occupancy, including setup/cleanup/maintenance; unconfirmed, unknown and unloaded periods are explicit. Filters cannot hide competing resource occupancy. |
| D25 | Shared chat links bidirectionally to work and file versions. Item chats show the latest six chronological messages plus shared pins referencing original IDs. Stars are personal conversation bookmarks. Membership/access, retry-safe sends, reconnect/read state, pin auditing and source-linked summaries are specified before implementation; summaries remain D2 infer outputs. |

## 14. Open questions

- The merged [Captain/Pip proposal](proposals/2026-09-22-captain-and-pip.md) supplies the product
  direction adopted by this workspace amendment. The [delivery plan](plans/captain-workspace-delivery-2026-09.md)
  sequences implementation and the [migration inventory](plans/captain-workspace-migration-inventory-2026-09.md)
  records retained data and unresolved disposition decisions. Do not treat the historical proposal's
  “not adopted” status as an override of the reviewed decisions here.
- Client proof: the isolated Expo experiment under `docs/proposals/assets/captain-client-proof-2026-09-23`
  has its own locked Expo, React/React Native, React Native Web, development-client, safe-area and
  TypeScript/tsx dependencies outside the production workspace. Web checks and bundle exports pass;
  real-device gestures/keyboards/performance remain open. Retain Next.js web while building Expo
  mobile; a web replacement requires a representative comparison and another decision.
- Pip: device model availability, Siri natural-language action routing, Reminders/iCloud identity,
  phone/voicemail inputs and Focus control remain separate proofs. No unsupported Apple API or
  device-off personal inference capability is assumed by Captain.
- Model tiers: which models sit behind `small` and `large` at launch, and whether drafting starts
  on the large tier or is measured first.
- Whether the first customer's printable production records belong in Captain or in its asset
  management system; out of scope until asked.
- Pricing and the operator's own costs per tenant.
- When to enable the API-key path and cost-based budgets; pricing for it.
- Whether Gmail's Updates category is gated by sender knowledge, as §14 says, or always classified.
- Files in place: `docs/proposals/2026-09-16-files-in-place-and-workspace.md` is merged for
  discussion, not adopted in full. Provider-backed originals/version links fit the workspace;
  shared file discussions now follow D25 rather than a separate annotations-as-notes system.
  Its editor sidebars, record kits and paper-to-record pipeline are not included by this amendment.
  The file slice must settle provider/version access, evidence identity and any extracted-text
  retention before adding schema or a retrieval source.
- Proposing first steps for an idea-stage project: an infer step over the brief that suggests tasks
  for a person to accept. A later phase, after proposals have been accepted and discarded for a
  while and the brief format has settled.

### Inbox triage delivery detail (D2, D4, D5, D13)

The first triage handlers read at most 100 newly cached messages per run, using a UUIDv7 insertion
cursor on the enablement; label-only changes do not reclassify mail. The first run includes cached
mail. A cancelled run retains its input in Activity but skips its remaining work; run cancellation
is deliberate, and does not silently replay the cancelled batch. Unknown means no person-maintained
contact and no prior sent correspondence to the sender. Mail sync's automatic contact creation does
not establish trust. Unknown senders always need the owner. Confirmation completion requires one
open task with an exact title and reference (stored in the task body), both quoted in the mail;
ambiguous matches become suggestions. Confirming mail is attached as evidence before completion.

Extracted plain text and CSV are capped at 5 MB and 20,000 characters each, cached for at most 24
hours, and deleted by hourly housekeeping. PDFs remain in Gmail with an explicit extraction skip
in the journal. The journal carries cache references and notes, never extracted attachment text.
The model sees labelled untrusted mail and attachment data, with fixed instructions in `packages/steps`.

Inbox groups are **Needs you**, **Waiting for a reply you drafted**, **Awaiting triage**, and **Handled**,
with category, summary and extracted facts. Its Outbox section links to each thread's editable draft;
standalone drafts have the same controls there. A person saves edits before Send or Discard. Sending
records an intent and a stable RFC Message-ID before Gmail is called. If the response is lost, **Check
send** reconciles against Gmail Sent and never sends another copy. An unconfirmed send stays frozen
with instructions to check Gmail. The outbox pins the Google account, connection and reply header;
reconnecting a different account cannot send an old account's draft. Sent and discarded states wake
the workflow; no workflow handler sends mail.

### Project discovery delivery detail (D2, D7, D20, D21, D22)

Today every task the triage suggests lands in Obligations and no mail is linked to a project. Phase 5
delivers the four pieces below in order; each is its own pull request set and each is useful alone.

**The gate (D20).** Before any model call, deterministic code decides whether a thread needs one.
A thread is filed as information with needs-owner off, a `mail_triage` row whose model column names
the rule, and no facts, when any of these hold: Gmail's promotions, social or forums category label;
a List-Unsubscribe or List-Id header, Precedence bulk or Auto-Submitted (the sync keeps these three
headers; nothing else new is stored); a sender local part of noreply, no-reply, notifications or
mailer-daemon; a reply from a person later than the latest incoming message; or a sender prior of at
least three information verdicts with needs-owner off and no reply or star from a person. Gmail's
Updates category goes to the model only when the sender is known (a person-maintained contact, a
Xero contact or a Shopify customer, or prior sent mail). Every gate decision is journaled with the
rule that fired. Sender priors live in `mail_senders`, updated by each verdict and each send from the
outbox; a reply or star resets the sender. The small tier runs on the cheapest model that returns the
schema reliably (§14 open question on tiers), configured per provider as today.

**Trimmed input.** A classified thread sends the latest message in full (the existing 20,000
character cap), each earlier message's own text to 500 characters, and no quoted reply blocks or
signatures. Attachments are unchanged (D13). Drafting sends the same trimmed thread.

**Own writing.** Notes and sent mail are the person's own words, and they are where intentions
show up first. Both are classified for tasks with steps, facts and a project name with its stage,
never for needs-owner and never drafted. A sent message is classified only when it carries at
least about 40 tokens of its own text, the same floor as the index, so acknowledgements cost
nothing; a note is always classified when saved, and again when edited beyond a trivial change.
A single note that names one concrete action becomes a suggested task directly, as mail does. Own
writing also seeds discovery on its own rule: a candidate name proposed by two or more own items,
a note or a sent message, in any period and at any stage, qualifies, because a person writing
about the same outcome twice is the strongest evidence there is that it is theirs to own. The
discovery call then decides, as for everything else, whether that is a project, a task with steps,
or nothing.

**The index (D21).** Mail sync embeds each new message after it is saved, in the same bounded batch
and outside the transaction, as a `read`. The embedding unit is: subject, then the parent message's
own text to about 200 tokens (found by In-Reply-To in the store; when the parent is not stored the
message's quoted block is kept as the context instead), then this message's own text. A message with
fewer than about 40 tokens of own text gets no vector and inherits its parent's, since its meaning is
the parent plus a yes or a no, which the model reads at discovery time, not the encoder. A note's unit is its title
or first line, then the title of the linked event or the name of the linked contact, company,
project or task when there is one, then its body; a note has no parent and is embedded when saved
and re-embedded when edited. Longer units
are chunked at about 256 tokens; the message vector is the mean of its chunks. The thread vector is
the mean of its message vectors weighted by min(1, tokens ÷ 300), recomputed when a message arrives,
so an acknowledgement barely moves it. Each row stores the encoder name and version; a changed
encoder re-embeds by housekeeping (a system routine, D3), never inline. Embedding happens in the
embedding service (§7), one shared stateless machine that scales to zero; the sync batches units
per request and tolerates a cold start, and a service that is down leaves rows unembedded for
housekeeping to fill later, never a failed sync.

**Weighted drafting.** A draft is prepared when a thread's draft score crosses the organisation's
threshold, not for every thread that needs the owner. The score is deterministic and explainable:
the model's needs-owner verdict and a request category count for it; a known sender, a sender the
person has replied to before, and a linked project or open task count for it; the sender's draft
outcomes weigh most, sent or edited-then-sent up, discarded or not-needed down, and a draft the
person asked for on a thread we did not draft is the strongest up signal. The initial rule before
any outcomes exist is: needs owner and (known sender or request). At most twenty drafts per run
on the large tier, so a burst cannot spend the allowance. Every draft records its outcome in
`outbox` and the counts roll into `mail_senders`. On a thread with a draft the control is a split
button: **Send** as the action, and in its menu Edit, Remind me later (tomorrow morning or next
week, which sets remind-at and keeps the draft), Not needed (no reply wanted; a down signal for the
sender on both drafting and needs-owner) and Discard (wrong draft; a down signal on drafting only).
On a needs-you thread without a draft the split button is **Draft a reply** with Not needed and
Remind me later in its menu. A draft untouched for seven days expires with a neutral outcome. D5
is unchanged: only Send sends, and only a person presses it.

**What it becomes.** The determination is four-way, and it is made twice: cheaply per thread inside
the classify call, and properly over assembled evidence inside the discovery call. The definitions
are the same in both instructions:

- **A project** is work with an outcome that takes more than one exchange or more than one action,
  or an intention still being discussed. It need not have tasks yet. Onboarding a can supplier,
  this year's wholesale price list, or two mails weighing whether to open a taproom are projects;
  the last is an idea-stage project whose whole substance is its brief.
- **A task** is one concrete action with an owner. When it has a checklist of steps that are all
  ours to do and finish together, such as update the prices, export the sheet and send it, the
  steps are sub-tasks and the task is still one task. Sub-tasks never make a project.
- **A relationship** is ongoing correspondence with a counterparty and no shared outcome. It links
  the company and creates nothing.
- **Nothing** is everything else.

The classify step names a project per thread, with a stage of idea or underway, and returns tasks
each with optional steps. Deterministic thresholds decide when a candidate is worth a discovery
call: for a candidate marked underway, at least three threads across at least fourteen days; for a
candidate marked idea, two threads, or one thread in which both parties wrote, because ideation is
the moment a person most wants the project written down; or two or more suggested tasks in
Obligations that share a counterparty and a reference, the concrete symptom of a missing project; or
two or more own items, a note or a sent message, proposing the same name in any period; or a person
choosing a thread or note and pressing Make this a project; or, on the first run, a cluster of the
backlog. The discovery call then judges the assembled evidence and answers project, task,
relationship or nothing. A project proposal carries its brief and any tasks, an idea-stage one
carries the brief alone, and a task answer becomes one suggested task with its steps in the linked
project or Obligations. Last, a person accepts. Proposing first steps for an idea-stage project is a
later phase (§14 open questions); Phase 5 writes the project down and stops. The thresholds are
constants until a second tenant shows they should be settings.

**Retrieval.** A seed is embedded with the same unit rules. Candidates are threads and notes in
the organisation scored by thread or note similarity plus the best single message similarity,
then widened deterministically: the same counterparty company, shared references such as invoice
or order numbers, the reply chain, the normalised subject, notes linked to the same event, company,
project or task, and a window of sixty days either side of the seed.
At most fifty candidates per seed. Every query runs under the tenant's RLS like any other read.

**Association in triage.** For a thread that passes the gate, rules first: an existing link, a
counterparty company linked to exactly one active project, or a reference that matches a task links
the thread without the model. Otherwise the classify input carries the active projects' names and
one-line descriptions (at most fifty, most recently active first) and the schema gains a project
field: an existing project's name, none, or a proposed name. Code links only to a name that exists;
a proposed name goes to `project_candidates`. Suggested tasks from a linked thread go to that project,
otherwise to Obligations as today.

**Discovery (D22).** One large-tier call per seed receives the seed and its candidates, trimmed and
each carrying an opaque id, and returns: the ids that belong, kind ∈ project · relationship · noise,
name, description, stage, tasks each with a title, reference, due date and evidence id, and open
questions. Code discards any id outside the candidate set, writes a proposed project only for kind
project, links the company for relationship and journals noise. Contacts, calendar events, Xero
documents and existing tasks are attached by walking from the chosen threads with the existing
links, never by the model. A candidate name becomes a seed when at least three threads across at
least fourteen days proposed it; at most ten seeds run per invocation. On Commitments a proposed
project shows its threads, tasks and evidence with Accept and Discard; accepting sets it active and
its tasks open, discarding archives it and marks its candidate closed so it is not proposed again.
Clusters tend to follow counterparties and topics, and some are relationships rather than work; the
failure mode is a discarded proposal, never a wrong active project.
