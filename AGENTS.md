# Working on Ask The Captain

This file is for every agent and person who writes code here. Read it, then read
[`docs/plan.md`](docs/plan.md). The plan is the source of truth for what Captain is and how it is
built; its decisions (D1–D26) change only by a reviewed pull request that edits the plan.

## The test for any piece of work

Captain is the shared small-business work system: manage shared work, allocate resources,
discuss work, manage business context, and understand/follow up (plan §2). Pip owns personal
assistance. Name the concrete workspace outcome in each PR; the old six assistant job IDs are
historical, not an eligibility test or permission to retain old features. Commitments, Obligations,
Inbox/Outbox and personal calendar assistance are legacy scope to retire. Do not retain them for
hypothetical data or make retirement wait for Pip. Reuse valid services and handle actual affected
records deliberately; never claim a live data audit from a code inventory.

## Rules that constrain code

- **Inference is data-only (D2).** A model is called only inside an `infer` step with an
  instruction, input data and an output schema. The output is validated before any code sees it.
  The model gets no tools, makes no writes, and never sees a credential, a token or a key.
- **Writes are plain writes.** A person's write is role-checked inside Row Level Security and
  recorded in `audit_events`, except private chat records (D25), which are recorded in the
  participant-scoped, append-only `chat_audit_events` so audit never reveals a private conversation
  to nonparticipants. A workflow's write happens in the name of the person who enabled the
  workflow (D4). There is no approval layer, no signed request, no confirmation token. Where a
  person should see something before it happens, the record carries a review state (for example, a suggested task).
- **No autonomous correspondence (D5).** Workflows never send external mail. The legacy outbox
  remains person-sent until retirement; it is not a requirement for a Captain mail product.
- **RLS on every tenant table (D6).** Every tenant table has `organisation_id`, forced RLS, and a
  policy. The SQL-created runtime role `captain_runtime` cannot bypass it or hold administrative
  memberships; policies and direct grants include it alongside legacy `app`. Verify live connection
  privileges at startup/readiness and release. A migration that adds a tenant table adds its policy
  in the same file and a cross-tenant test in the same pull request.
- **Workflows compose typed steps (D3).** Five kinds: `read`, `infer`, `write`, `await`, `notify`,
  with `when`, `each` and `branch` for control flow over data. No unbounded loops. Housekeeping
  (sync, token refresh, series occurrences, budget rollover) is a system routine, not a workflow.
- **Connectors are first-party SDKs (D8).** OAuth, refresh and encryption are ours. No
  integration platforms, no vendor MCP servers as step sources.
- **Attachment bytes are never stored (D13).** Keep selected business metadata/provider links.
  Extraction needs an allow list, size cap, brief expiry and labelled untrusted input; no mailbox ingestion.
- **Inventory is a counted list (D15).** Ingredients, consumables and finished product. One
  explicit quantity authority; Shopify is optional. No movements, conversions, lots or costing.
- **No configurable domain model.** No entity types, custom fields, units or process definitions.
  The business's vocabulary is the names of its projects, tasks and series.
- **Three workspace tabs (D11).** Work, Chat and Resources; Work defaults to Assigned to you.
  Each has a grouped view list one page left. Settings is reached through account controls. Retire
  old assistant screens; a scoped redirect may preserve a valid record link without keeping old UI.
- **Honest states.** A down connection, a spent budget or an unavailable model is said in words
  with what to do next. Never render a value the data cannot justify; never fabricate a quiet day.

## Layout and conventions

pnpm workspaces with Turborepo, TypeScript strict everywhere, ESM.

| Path | What |
|---|---|
| `apps/api` | Hono API: auth, routes over services, webhooks, health |
| `apps/web` | Next.js app, phone-first, server components read the API; Work/Chat/Resources client; remaining legacy routes are cleanup debt |
| `apps/e2e` | Playwright deployment smoke suite and isolated browser regression checks |
| `packages/db` | Drizzle schema, hand-written SQL migrations, RLS policies, typed queries |
| `packages/connectors` | Google, Xero, Shopify |
| `packages/steps` | the step catalog and workflow definitions |
| `packages/engine` | pg-boss workflow runner in the API process (D19) |
| `packages/model` | inference client, structured output, budgets, usage |
| `packages/retrieval` | embedding units, the embedding-service client, similarity search (D21) |
| `packages/ui` | tokens/components follow reviewed repository workspace designs (D14); `packages/ui/design/` is an unedited legacy Claude Design mirror, so author new work outside it |
| `infra` | OpenTofu (`infra/tofu`), the embedding service (`infra/embed`, D21) and the inference Sprite's bootstrap files (`infra/sprites`, D18) |

There is no `apps/mobile` yet; the plan names it for a later slice. The Expo client proof under
`docs/proposals/assets/captain-client-proof-2026-09-23` is a standalone, fictional harness outside the
pnpm workspace, not application code.

- Migrations are hand-written SQL, numbered, never edited after merge. One migration per pull
  request. Drizzle describes the schema; SQL is what runs.
- Services are plain functions over a transaction with tenant context set. Routes call services.
  Steps call services and connectors. Nothing reaches into another package's tables.
- Tests run against a real Postgres. Set `DATABASE_URL` to a throwaway database; a test suite that
  was not run against a database was not run. Store tests, RLS tests and workflow tests are
  integration tests by nature.
- Web routes touched by a change get a Playwright check. Every page has designed empty, loading,
  failed and disabled states.
- Conventional commits: `feat(api): …`, `fix(web): …`, `docs(plan): …`.

## How work moves

- Small pull requests, one concern each, with the workspace outcome named in the body and the decision it
  relies on when there is one. CI must be green. Squash-merge.
- Design of screens and of the step catalog is a plan matter: propose in a plan amendment or a
  reviewed repository-native design before building (D14).
- Do not add a package, a table, a dependency or a background process that the plan does not
  name without amending the plan in the same pull request.
- Do not build for a hypothetical tenant. The first customer is the only one until a second business
  is onboarded (D17). The historical Phase 4 prepared for that and did not complete it.
- Do not import code or designs from other projects. This repository is self-contained; anything
  worth having is written here against the plan.
- Production deploys, infrastructure applies, DNS, secrets and anything legal are the repository
  owner's to do. Prepare them; do not run them. The owner authorised reviewed PR merges and staging-only resumption on 24 September 2026,
  with at most one machine per app. Production remains paused; backups are a separate operation.
  Follow `docs/runbooks/paused.md` and record any actual operational changes there.
- On a shared development machine, run one build or test at a time; wrap heavy commands in
  `flock /tmp/atc-build.lock`.

## Definition of done

Typecheck passes. Tests pass against Postgres. Touched pages pass their Playwright checks. The
pull request names the workspace outcome. Nothing in the diff contradicts a decision in the plan. If a step was
skipped, the pull request says so.
