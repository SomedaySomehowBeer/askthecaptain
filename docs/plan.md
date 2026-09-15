# Ask The Captain — product and engineering plan

**Status:** draft for approval, 2026-09-14. This document is the source of truth for what Captain
is and how it is built. Decisions are recorded in §13 and changed only by a reviewed pull request.

## 1. What Captain is

Captain is an administrative assistant for a small business, the person a ten-person company would
hire first if it could afford to. It reads the inbox and says what needs the owner, drafts the
replies the owner would send, keeps the calendar, owns the list of projects, tasks and recurring
duties, chases what is due, and gives the owner a short brief every morning. It answers questions
about the business from the business's own data and shows where the answer came from.

It is built as **workflows of deterministic steps**. Where judgement is needed, a step asks a
language model a narrow question and takes back structured data, which the next step acts on. The
model never holds a tool, never writes to anything, and never sees a credential. The owner decides
which workflows run and how; the machine does exactly what those workflows say.

The first customer is a small brewery. The product is generic to small producers, trades and
service businesses; the brewery's specifics are configuration, not code.

## 2. The six jobs

Every piece of work on Captain must move one of these sooner.

1. **Triage the inbox.** As mail arrives and each morning: what came in, what needs the owner,
   drafts for the replies the owner would send, everything else filed. Triage raises tasks, closes
   duties when confirmations arrive, and keeps contacts current.
2. **Draft and send correspondence.** Replies and new mail written in the owner's voice, waiting in
   the outbox until the owner sends them.
3. **Keep the calendar.** Find time, create and move events, attach preparation notes, remind.
4. **Own commitments.** Projects, tasks and recurring duties with owners, due dates and evidence.
   One list that the rest of the product reads.
5. **Chase.** Remind owners before something is due and escalate after; nudge counterparties about
   overdue invoices and unanswered mail, as drafts the owner sends.
6. **Brief and answer.** A morning brief delivered by push. Questions about mail, calendar,
   commitments, customers and money answered from data, with sources shown.

### A day with Captain

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
- **Small surface.** Five tabs on a phone. Features earn their place by a job in §2.
- **Honest states.** When a connection is down, a budget is spent or a model is unavailable, the
  product says so and what to do. It never fabricates a quiet day.

## 4. Architecture

A pnpm/Turborepo monorepo, TypeScript throughout.

| Path | What |
|---|---|
| `apps/api` | Hono HTTP API: auth, routes over services, webhooks, health |
| `apps/web` | Next.js, phone-first, five tabs; server components read the API |
| `apps/mobile` | Expo, later; the web is installable in the meantime |
| `packages/db` | Drizzle schema, hand-written SQL migrations, RLS policies, typed queries |
| `packages/connectors` | Google (Gmail, Calendar), Xero, Shopify: OAuth, refresh, typed clients, webhooks |
| `packages/steps` | the step catalog (§6) and the workflow definitions that compose it |
| `packages/engine` | durable workflow execution: pg-boss and a small typed runner; the Phase 2 spike stays unmounted until production hardening |
| `packages/model` | the inference client: provider adapter, structured output, budgets, usage |
| `packages/ui` | design tokens and shared components |
| `infra` | OpenTofu for Neon, Cloudflare and monitoring; owner-run inference Sprite provisioning |

**Hosting.** Fly.io in Sydney for the API and web; Neon Postgres; Cloudflare for DNS and TLS at the
edge; GitHub Actions for CI and deploy. One environment: a single Neon branch and compute, and the
Fly apps that serve app.askthecaptain.app, deployed from `main` behind the smoke gate. The second
pair of Fly apps and a second database wait for a second customer (D17).

**Durable execution (D19).** Use **pg-boss with a small Captain runner** in the existing
application process and Postgres. The bounded D10 inbox-triage spike ran both pg-boss and
self-hosted Restate through retries, delayed events, timeouts and incident journals. Both
needed destination idempotency at the boundary where a write committed before its completion
was recorded; Restate's simpler waits did not justify another service for the first customer.
[The decision and evidence](plans/engine-decision-2026-09.md) record the comparison and its limits.

Definitions remain engine-neutral (§6). Runs and steps use Captain's tenant-scoped journal;
queue jobs carry opaque run identifiers, with no mail, prompts or credentials. Worker business
access uses the enabling person's tenant context and the non-bypassing runtime role (D4, D6).
pg-boss owns platform queue metadata; its schema installation/upgrades remain operator-run.
Local effects and completion records must be atomic where possible, otherwise destination
idempotency or reconciliation is required. Queue delivery is not a generic exactly-once
external-write guarantee. D5 still requires a person to send outbound mail.

`packages/engine` currently contains the unmounted spike and fixture catalogue tests. Production
inbox triage must close enqueue/event handoff gaps, enforce continuation permissions and pinned
definition snapshots, and implement budget pauses, cancellation and retry-exhaustion journaling
before the worker is enabled. No separate engine service is provisioned.

## 5. Data model

Every tenant table carries `organisation_id`, has forced RLS, and uses uuidv7 keys.

**Identity and access**
- `organisations` — name, timezone, locale, settings.
- `users`, `identities` (Google OIDC subject, email), `sessions`.
- `memberships` — user, organisation, role ∈ owner · admin · member.
- `audit_events` — actor (person, workflow run or system), action, subject, before/after digest,
  at. Append-only.

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
  state ∈ drafted · sent · discarded, sent by, sent at, provider message id.

**Calendar**
- `calendars`, `calendar_events` — synced cache; writes go to the provider and are re-read.

**People and companies**
- `contacts`, `companies` — the business's counterparties, kept current by triage and by hand.

**Commitments**
- `projects` — name, description, stages, owner, archived. One system project per organisation,
  **Obligations**, flagged so the UI shows it as a deadline book.
- `tasks` — project, title, body, status ∈ suggested · open · in_progress · done · cancelled,
  owner, due, source (mail thread, series, person, run), completed by, completed at.
- `task_series` — the rule that generates recurring tasks. A series belongs to a project (by
  default Obligations), carries a template (title pattern, body, owner, evidence required), a
  recurrence (monthly, quarterly, yearly, weekdays, custom) and a due rule (for example "due 21 days
  after the period ends"). Each occurrence is an ordinary task with `series_id`, `period_start` and
  `period_end`; the system creates the next occurrence at the start of its period. Editing a series
  changes future occurrences only; completing a task never touches its series. "Excise return" is a
  monthly series in Obligations whose September task is due on 21 October. "Order cans" is a monthly
  series in the Production project. A one-off task simply has no series.
- `evidence` — a link from a task to a mail message, a file or a URL, with who attached it.

**Stock** (what nothing else counts)
- `stock_items` — name, location, unit label (text), current count, counted at, counted by,
  reorder point, preferred supplier (a company), notes. The count is the truth and a person
  enters it; Captain never computes stock from movements. Sellable products live in the connected
  commerce system and are read from there, not duplicated here.
- `stock_counts` — the history of counts per item: when, by whom, the number.

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

**Notifications**
- `push_subscriptions` — a member's device: endpoint and keys, disabled when the push service says it is gone.
- `push_deliveries` — every push sent, whether it arrived; journaled like any other write.
  Web Push encryption and VAPID signing use the `web-push` library; the private key lives only in the API.

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

- **inbox-triage** (on mail arrival, and 06:00): read new threads → infer classification per thread
  (category, needs owner, summary, facts: counterparty, amounts, dates, references) → write triage
  rows, create suggested tasks, complete duties whose confirmation arrived, update contacts → infer
  reply drafts for threads that need one → write outbox drafts → await send → write labels.
- **morning-brief** (06:30): read overdue and due-this-week tasks, outbox, today's events, overdue
  receivables → infer a brief from that data → notify.
- **chase-due** (daily): read tasks due within the configured window → each task: await until the
  reminder time → notify owner; after due, escalate; for receivables, infer a courteous chaser →
  write outbox draft.
- **stocktake** (weekly, or on demand): each stock item at the configured location: notify the
  counter and await the count → write the count → branch on count below reorder point: write a
  task in Purchasing, infer a short order email to the preferred supplier, write an outbox draft.
  For connected commerce stock: read levels → the same branch, without asking anyone to count.
- **calendar-prep** (evening): read tomorrow's events → read related threads and contacts → infer a
  one-paragraph preparation note per event → write notes.

### Example: inbox-triage

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
  (D18). In Settings the owner chooses a provider, follows the owner-run provisioning instructions,
  and opens the Sprite's sign-in URL: Claude uses `claude setup-token`, Codex uses device login.
  The login credential stays only on that Sprite; it never enters a prompt, workflow or log.
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
- **Privacy.** Mail bodies go to the model only inside triage and drafting steps of workflows the
  owner enabled. Usage is recorded per step; content is not logged.
- **Untrusted content.** Everything a model reads from mail is untrusted: bodies, subjects, sender
  names, attachment text. The prompt labels it as such and the instruction lives outside it. The
  structural defence is D2: the only thing an injected instruction can influence is the data the
  step returns, which a schema validates and deterministic code interprets. Wrong data is possible;
  an action is not. Facts that matter (amounts, bank details, due dates) are cross-checked against
  the ledger and known counterparties where a source exists, and anything from an unknown sender
  is marked needs-owner regardless of what the model said.
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
fallback for providers without webhooks.

## 9. Security and tenancy

- Forced RLS on every tenant table; a runtime database role that cannot bypass it; tenant context
  set transactionally. Adversarial cross-tenant tests in CI.
- Roles: owner (billing, keys, members), admin (connections, workflows), member (use). Platform
  operator roles are separate from tenant roles.
- Sign-in with Google for any domain; explicit organisation creation; verified invitations.
  MFA or passkeys for owners and admins before invitations open to strangers.
- Secrets: envelope encryption without a cloud key service. A 32-byte master key lives in the API's
  secrets; each organisation has a data key wrapped by it; connection tokens and Sprite connection secrets are
  encrypted with the data key (AES-256-GCM). Rotation re-wraps data keys. No third-party key service
  and no extra cloud account.
- Rate limits per IP, user, organisation and connection. Webhook signature verification.
- Audit log for every write. Data export and organisation deletion as first-class operations.
- Backups with a rehearsed restore, terms of service and a privacy notice before the second tenant.

## 10. Web and mobile

Phone-first. Five tabs:

- **Today** — the brief, what needs you, a question box.
- **Inbox** — triaged threads grouped by what they need, and the outbox.
- **Commitments** — projects with their tasks, the Obligations deadline book, and Stock: the
  counted list with each item's last count and what is below its reorder point.
- **Calendar** — the week, with preparation notes.
- **Settings** — organisation, members, connections, workflows, inference subscription and budget, activity
  (the workflow journal), notifications.

**Settings → Inference.** A provider selector (Claude or Codex), owner-run provisioning and sign-in
steps with a login link, runtime status with the next action, a monthly token allowance form and
usage by tier. Empty, loading, failed and disabled states say what is known and what to do next;
provisioning and removal of Fly resources remain owner operations.

**Design system.** The visual language is the **Ask The Captain Design System** maintained in
Claude Design; that project is the design authority. Its tokens (colour, type, spacing, radii,
motion), brand assets (the octopus mark, lockups, app icons) and core components are mirrored
verbatim into `packages/ui/design/` and re-imported when the project changes; `apps/web` consumes the
tokens directly and adapts the reference components; `packages/ui` carries the same values for the
native app. Screens for the five tabs are designed in that project first, then built. Paper ground
in light, forest in dark, mint for the Captain's own actions and focus, semantic colour reserved
for state; system fonts; states described in words, counts shown only when they change what the
person does next. Dark and light themes and an installable web app until the Expo app exists.

## 11. Phases

| Phase | Weeks | Delivers |
|---|---|---|
| 0 Foundation | 1 | Monorepo, infra, CI and deploy, auth, organisations and memberships, RLS with tests, design tokens and shell |
| 1 Connect and collect | 1–2 | Google connection, Gmail sync and webhooks, calendar sync, contacts; projects, tasks, series, Obligations project; Commitments and Inbox tabs reading synced data |
| 2 Think | 2 | Inference client with budgets; engine decision recorded by the inbox-triage spike (D19: pg-boss); harden the runner and ship inbox-triage and the outbox for the first customer |
| 3 Assist | 2 | morning-brief, chase-due, materialise-series, calendar-prep; push; Today tab; Xero connection |
| 4 Ready for a second customer | 2 | MFA, backups and restore drill, export and deletion, terms and privacy, support runbook; a second business onboarded by hand |

Each phase ships to production behind feature flags to the first customer. Phase 1 and the inference
client in Phase 2 can proceed in parallel.

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
- Team chat, documents, or a file store; link to where those already live.

## 13. Decisions

| # | Decision |
|---|---|
| D1 | Captain is an administrative assistant for small businesses, defined by the six jobs in §2. |
| D2 | Inference is data-only: infer steps take data and return schema-validated data; no tools, no writes, no credentials. |
| D3 | Workflows are compositions of typed steps in five kinds (read, infer, write, await, notify) with deterministic, bounded control flow (`when`, `each`, `branch`). Housekeeping is a system routine, not a workflow. |
| D4 | A workflow acts in the name of the person who enabled it and can do nothing they could not. |
| D5 | Anything sent to a third party waits in the outbox for a person. |
| D6 | Tenant isolation is forced RLS with a non-bypassing runtime role. |
| D7 | Captain owns projects and tasks. Recurrence is a series on a task. Obligations are tasks in a flagged system project. |
| D8 | Connectors are first-party SDKs behind our own OAuth and encryption; no third-party integration platforms. |
| D9 | Inference uses each organisation's own Claude or Codex subscription through an unmodified CLI, behind a Sprite provider adapter; monthly token allowances and per-step usage, not dollar reservations. |
| D10 | The durable execution engine is chosen by a bounded spike in Phase 2 between Restate and pg-boss with a small runner. |
| D11 | Five tabs: Today, Inbox, Commitments, Calendar, Settings. |
| D12 | Hosting is Fly.io Sydney, Neon Postgres, Cloudflare, GitHub Actions. |
| D13 | Attachment bytes are never stored. Metadata always; text extracted on an allow list and size cap, cached briefly, passed to the model as labelled untrusted content. |
| D14 | The Ask The Captain Design System in Claude Design is the design authority, mirrored into `packages/ui/design/`. |
| D15 | Inventory is a counted list, not a ledger: sellable stock is read from the connected commerce system; everything else is a stock item whose count a person enters, with a stocktake workflow and reorder tasks. |
| D16 | Envelope encryption uses a master key held in the API's secrets wrapping per-tenant data keys; no cloud key-management service and no AWS account. |
| D17 | One environment until the second customer: one Neon branch and compute, one live pair of Fly apps deployed from `main`; production promotion exists but stays dormant. |
| D18 | Inference runs on a Captain-owned Fly Sprite per organisation, with no shared filesystem between organisations. Only the CLI, its login and the minimal runtime/shim needed to invoke it live there; no business-data store or other workloads. Every model tool and MCP server is disabled; credentials stay outside inference data (D2). Provisioning and resource removal are owner-run. The Sprite is the only inference runtime today; the API path is a documented seam, not a second runtime. |
| D19 | Durable workflows use pg-boss with a small Captain runner in the existing process and Postgres, following the D10 spike. Tenant-scoped run/step journals and destination idempotency remain ours; neither engine guarantees exactly-once remote writes. Production enablement waits for the hardening in §4 and the decision document. No Restate service or SDK is retained. |

## 14. Open questions

- Model tiers: which models sit behind `small` and `large` at launch, and whether drafting starts
  on the large tier or is measured first.
- Whether the first customer's printable production records belong in Captain or in its asset
  management system; out of scope until asked.
- Pricing and the operator's own costs per tenant.
- When to enable the API-key path and cost-based budgets; pricing for it.
