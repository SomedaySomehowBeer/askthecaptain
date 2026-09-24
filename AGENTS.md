# Working on Ask The Captain

This file is for every agent and person who writes code here. Read it, then read
[`docs/plan.md`](docs/plan.md). The plan is the source of truth for what Captain is and how it is
built; its decisions (D1–D25) change only by a reviewed pull request that edits the plan.

## The test for any piece of work

Captain is the shared small-business work system, with six stable job IDs (plan §2): triage shared
business intake, draft and send correspondence, keep the calendar, own commitments, chase, brief
and answer. Pip handles personal assistance; existing Captain features migrate deliberately.
Before starting anything, name the job it moves sooner. If you cannot, do not start it. Put the
job in the pull request body.

## Rules that constrain code

- **Inference is data-only (D2).** A model is called only inside an `infer` step with an
  instruction, input data and an output schema. The output is validated before any code sees it.
  The model gets no tools, makes no writes, and never sees a credential, a token or a key.
- **Writes are plain writes.** A person's write is role-checked inside Row Level Security and
  recorded in `audit_events`. A workflow's write happens in the name of the person who enabled the
  workflow (D4). There is no approval layer, no signed request, no confirmation token. Where a
  person should see something before it happens, the record carries a review state (an outbox
  draft, a suggested task).
- **Outbound waits in the outbox (D5).** Nothing is sent to a third party by a workflow. Mail is
  drafted into `outbox` and a person sends it.
- **RLS on every tenant table (D6).** Every tenant table has `organisation_id`, forced RLS, and a
  policy. The runtime role cannot bypass it. A migration that adds a tenant table adds its policy
  in the same file and a cross-tenant test in the same pull request.
- **Workflows compose typed steps (D3).** Five kinds: `read`, `infer`, `write`, `await`, `notify`,
  with `when`, `each` and `branch` for control flow over data. No unbounded loops. Housekeeping
  (sync, token refresh, series occurrences, budget rollover) is a system routine, not a workflow.
- **Connectors are first-party SDKs (D8).** OAuth, refresh and encryption are ours. No
  integration platforms, no vendor MCP servers as step sources.
- **Attachment bytes are never stored (D13).** Metadata always; text extracted on the allow list
  and size cap, cached briefly, passed to the model as labelled untrusted content.
- **Inventory is a counted list (D15).** No movements, conversions, lots or costing.
- **No configurable domain model.** No entity types, custom fields, units or process definitions.
  The business's vocabulary is the names of its projects, tasks and series.
- **Three workspace tabs (D11).** Work, Chat and Resources; Work defaults to Assigned to you.
  Each has a grouped view list one page left. Settings is reached through account controls. Keep
  legacy routes/actions reachable until their replacement slice is complete.
- **Honest states.** A down connection, a spent budget or an unavailable model is said in words
  with what to do next. Never render a value the data cannot justify; never fabricate a quiet day.

## Layout and conventions

pnpm workspaces with Turborepo, TypeScript strict everywhere, ESM.

| Path | What |
|---|---|
| `apps/api` | Hono API: auth, routes over services, webhooks, health |
| `apps/web` | Next.js app, phone-first, server components read the API |
| `packages/db` | Drizzle schema, hand-written SQL migrations, RLS policies, typed queries |
| `packages/connectors` | Google, Xero, Shopify |
| `packages/steps` | the step catalog and workflow definitions |
| `packages/model` | inference client, structured output, budgets, usage |
| `packages/ui` | tokens/components follow reviewed repository workspace designs (D14); `packages/ui/design/` is an unedited legacy Claude Design mirror, so author new work outside it |
| `infra` | OpenTofu |

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

- Small pull requests, one concern each, with the job named in the body and the decision it
  relies on when there is one. CI must be green. Squash-merge.
- Design of screens and of the step catalog is a plan matter: propose in a plan amendment or a
  reviewed repository-native design before building (D14).
- Do not add a package, a table, a dependency or a background process that the plan does not
  name without amending the plan in the same pull request.
- Do not build for a hypothetical tenant. The first customer is the only one until Phase 4.
- Do not import code or designs from other projects. This repository is self-contained; anything
  worth having is written here against the plan.
- Production deploys, infrastructure applies, DNS, secrets and anything legal are the repository
  owner's to do. Prepare them; do not run them. Preserve the pause in `docs/runbooks/paused.md`;
  development does not authorise resuming machines, deployments, backups or provider schedules.
- On a shared development machine, run one build or test at a time; wrap heavy commands in
  `flock /tmp/atc-build.lock`.

## Definition of done

Typecheck passes. Tests pass against Postgres. Touched pages pass their Playwright checks. The
pull request names the job. Nothing in the diff contradicts a decision in the plan. If a step was
skipped, the pull request says so.
