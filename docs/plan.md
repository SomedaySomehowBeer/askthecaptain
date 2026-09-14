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
| `packages/model` | the inference client: provider adapter, structured output, budgets, usage |
| `packages/ui` | design tokens and shared components |
| `infra` | OpenTofu for Neon, Fly, Cloudflare and GitHub |

**Hosting.** Fly.io in Sydney for the API and web; Neon Postgres; Cloudflare for DNS and TLS at the
edge; GitHub Actions for CI and deploy. One production environment and one staging environment.

**Durable execution.** Workflows need exactly-once side effects, retries, timers ("in three days")
and waits ("until the owner sends it"). Two candidates: **Restate** (a durable execution engine with
journaled handlers, timers and awakeables; hosted or self-run) and **pg-boss with a small runner of
our own** in Postgres. The decision is made by a three-day spike in Phase 2 that builds inbox triage
on Restate and judges it on: exactly-once sends without hand-written fences, timer and await
ergonomics, how the journal reads during an incident, operational weight, and whether the
determinism rules are livable. Until then the workflow definition format is engine-neutral (§6).

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
  tokens envelope-encrypted with a per-tenant data key under a KMS master key.
- `sync_cursors`, `webhook_events` (deduplicated by provider id), `webhook_attempts`.

**Mail**
- `mail_threads`, `mail_messages` — synced from Gmail; bodies stored, provider ids kept.
- `mail_triage` — one row per thread: category, needs-owner flag, summary, extracted facts,
  produced by the triage workflow with the run id that produced it.
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
- `task_series` — recurrence rule, due rule, template; the workflow that materialises the next
  occurrence writes a task pointing back at the series.
- `evidence` — a link from a task to a mail message, a file or a URL, with who attached it.

**Workflows**
- `workflow_definitions` — code-defined and versioned; the table holds the catalogue the API exposes.
- `workflow_enablements` — organisation, definition, enabled by, parameters, schedule overrides.
- `workflow_runs`, `workflow_run_steps` — the journal: trigger, started, finished, state, and per
  step the kind, input digest, output, error.

**Inference**
- `tenant_keys` — provider, envelope-encrypted API key, added by, status.
- `model_budgets` — organisation, month, limit, reserved, used.
- `model_usage` — per infer step: run, step, model, input and output tokens, latency, cost.

**Notifications**
- `push_subscriptions`, `push_deliveries`.

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
| `timer` | sleep until a time or for a duration | wake three days before due |
| `await` | wait for a record to reach a state | outbox draft sent, suggested task accepted |
| `notify` | push to a person | morning brief, escalation |

Every step declares its input and output types. `read` and `write` steps are plain functions over
the connectors and the database. `infer` steps declare an instruction, an output schema and a model
tier. A definition that names a capability the enabling person lacks fails at enablement, not at
run time.

### The first workflows

- **inbox-triage** (on mail arrival, and 06:00): read new threads → infer classification per thread
  (category, needs owner, summary, facts: counterparty, amounts, dates, references) → write triage
  rows, create suggested tasks, complete duties whose confirmation arrived, update contacts → infer
  reply drafts for threads that need one → write outbox drafts → await send → write labels.
- **morning-brief** (06:30): read overdue and due-this-week tasks, outbox, today's events, overdue
  receivables → infer a brief from that data → notify.
- **chase-due** (daily): read tasks due within the configured window → timer per task → notify
  owner; after due, escalate; for receivables, infer a courteous chaser → write outbox draft.
- **materialise-series** (daily): read series whose next occurrence is not yet a task → write tasks.
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
    infer('classifyThread', { perItem: true, schema: TriageSchema, tier: 'small' }),
    write('triage.record'),
    write('tasks.suggestFromTriage'),
    write('tasks.completeFromConfirmations'),
    write('contacts.upsertFromTriage'),
    infer('draftReply', { when: (t) => t.needsOwner && params.draftReplies, schema: DraftSchema, tier: 'large' }),
    write('outbox.create'),
    await('outbox.sent', { timeout: days(7) }),
    write('gmail.label', { label: 'Captain/Handled' }),
  ],
});
```

## 7. Inference

- **Bring your own key.** Each organisation adds its own Anthropic API key in Settings. The key is
  envelope-encrypted per tenant and used only by the API process; it never reaches the web, a
  workflow definition or a log.
- **Structured output only.** Every infer step supplies a JSON schema; the response is validated
  before any step sees it. A response that fails validation is retried once with the error, then the
  step fails and the run records why.
- **Tiers.** `small` for classification and extraction, `large` for drafting and the brief. The
  tier is declared by the step, and the models behind the tiers are configuration.
- **Budgets.** A monthly token budget per organisation, reserved before each infer step and settled
  after with actual usage. When spent, workflows that need inference pause with a visible reason;
  deterministic steps keep running.
- **Voice.** Drafting steps carry a short style note and up to three example replies from the
  organisation's settings. That is the whole "personality" system.
- **Provider adapter.** Anthropic first, behind a thin interface so a second provider can be added
  without touching steps.
- **Privacy.** Mail bodies go to the model only inside triage and drafting steps of workflows the
  owner enabled. Usage is recorded per step; content is not logged.

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
- Secrets: KMS master key, per-tenant data keys, envelope encryption for tokens and API keys.
- Rate limits per IP, user, organisation and connection. Webhook signature verification.
- Audit log for every write. Data export and organisation deletion as first-class operations.
- Backups with a rehearsed restore, terms of service and a privacy notice before the second tenant.

## 10. Web and mobile

Phone-first. Five tabs:

- **Today** — the brief, what needs you, a question box.
- **Inbox** — triaged threads grouped by what they need, and the outbox.
- **Commitments** — projects with their tasks, and the Obligations deadline book.
- **Calendar** — the week, with preparation notes.
- **Settings** — organisation, members, connections, workflows, inference key and budget, activity
  (the workflow journal), notifications.

Dark and light themes, system fonts, an installable web app until the Expo app exists. The design
language is warm, plain and confident; states are described in words, counts appear only when they
change what the person does next.

## 11. Phases

| Phase | Weeks | Delivers |
|---|---|---|
| 0 Foundation | 1 | Monorepo, infra, CI and deploy, auth, organisations and memberships, RLS with tests, design tokens and shell |
| 1 Connect and collect | 1–2 | Google connection, Gmail sync and webhooks, calendar sync, contacts; projects, tasks, series, Obligations project; Commitments and Inbox tabs reading synced data |
| 2 Think | 2 | Inference client with budgets; the execution-engine spike on inbox triage and the decision; inbox-triage in production for the first customer; outbox |
| 3 Assist | 2 | morning-brief, chase-due, materialise-series, calendar-prep; push; Today tab; Xero connection |
| 4 Ready for a second customer | 2 | MFA, backups and restore drill, export and deletion, terms and privacy, support runbook; a second business onboarded by hand |

Each phase ships to production behind feature flags to the first customer. Phase 1 and the inference
client in Phase 2 can proceed in parallel.

## 12. Non-goals for version 1

- A conversational assistant with tools; the question box answers from data, not by acting.
- Hosted per-user sandboxes or bring-your-own-subscription runtimes.
- A configurable domain model (custom entity types, units, process definitions); the business's
  vocabulary is the names of its projects, tasks and series.
- Marketplace integrations beyond Google, Xero and Shopify.
- Team chat, documents, or a file store; link to where those already live.

## 13. Decisions

| # | Decision |
|---|---|
| D1 | Captain is an administrative assistant for small businesses, defined by the six jobs in §2. |
| D2 | Inference is data-only: infer steps take data and return schema-validated data; no tools, no writes, no credentials. |
| D3 | Workflows are compositions of typed steps in six kinds: read, infer, write, timer, await, notify. |
| D4 | A workflow acts in the name of the person who enabled it and can do nothing they could not. |
| D5 | Anything sent to a third party waits in the outbox for a person. |
| D6 | Tenant isolation is forced RLS with a non-bypassing runtime role. |
| D7 | Captain owns projects and tasks. Recurrence is a series on a task. Obligations are tasks in a flagged system project. |
| D8 | Connectors are first-party SDKs behind our own OAuth and encryption; no third-party integration platforms. |
| D9 | Inference uses the tenant's own Anthropic key with a monthly budget; provider behind an adapter. |
| D10 | The durable execution engine is chosen by a bounded spike in Phase 2 between Restate and pg-boss with a small runner. |
| D11 | Five tabs: Today, Inbox, Commitments, Calendar, Settings. |
| D12 | Hosting is Fly.io Sydney, Neon Postgres, Cloudflare, GitHub Actions. |

## 14. Open questions

- Model tiers: which models sit behind `small` and `large` at launch, and whether drafting starts
  on the large tier or is measured first.
- Restate Cloud or self-hosted for the spike.
- Whether the first customer's printable production records belong in Captain or in its asset
  management system; out of scope until asked.
- Pricing and the operator's own costs per tenant.
