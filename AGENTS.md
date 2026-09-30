# Working on Ask The Captain

This file is for every agent and person who writes code here. Read it, then read
[`docs/plan.md`](docs/plan.md). The plan is the source of truth for what Captain is and how it is
built; its decisions (D1–D38) change only by a reviewed pull request that edits the plan. The
[chat-first proposal](docs/proposals/2026-09-29-chat-first-captain.md) and the
[rebuild plan](docs/plans/chat-first-rebuild-2026-09.md) are the rules and the increments behind D27–D38.

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
- **Business changes are versioned (D29).** A business write is role-checked inside Row Level
  Security, stores a full snapshot with who (person, agent or system), what caused it and when, and is recorded in
  `audit_events`, except private thread records (D25), which are recorded in the
  participant-scoped, append-only `chat_audit_events` so audit never reveals a private conversation
  to nonparticipants. Store typed before/after changes as well as snapshots. A person can select
  independent changes to reverse; undo applies checked inverse operations, preserves unrelated
  later edits, and appends a new change set. Conflicts and dependencies are explicit; never restore
  an entire old snapshot over newer work. See the
  [privacy and selective-undo contract](docs/plans/private-threads-and-selective-undo-2026-09.md).
  A person-enabled workflow writes as that person (D4); an agent writes under its own key with member limits (D30). There is no signed request or confirmation token.
  Code, never the model, decides when an action needs approval: an external action, or a write to
  a record linked to an outside company or person, waits as `pending` with an approval card
  showing the exact editable content (D31).
- **Private threads stay outside inference (D25/D33).** Only an explicit participant `@` mention
  permits a call. The classifier and any needed agent receive only the calling message, never
  thread history, summaries or cached context. A call grants no thread membership; replies,
  private causes and call records remain participant-scoped.
- **Nothing leaves unapproved (D5).** An outside message is sent only after its owner, or an agent
  within admin-set limits, approves the exact content. No inbox; the retired outbox is not a
  requirement for a Captain mail product.
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
- **Attachment bytes are never stored (D13)**, except photos of Captain's own worksheets, kept in
  object storage and linked from the versions they produced (D35). Keep selected business
  metadata/provider links. Extraction needs an allow list, size cap, brief expiry and labelled
  untrusted input; no mailbox ingestion.
- **Inventory is a counted list (D15).** Ingredients, consumables and finished product. Each stock
  item is a record with a thread; counts are versioned writes. One explicit quantity authority;
  Shopify is optional. No movements, conversions, lots or costing.
- **No configurable domain model.** No entity types, custom fields, units or process definitions.
  The business's vocabulary is the names of its projects, tasks and series.
- **One list of threads (D28).** Every record has a thread with a small card on top (D27). The app
  is one list of threads grouped by tag with fixed filters; no tabs and no saved views (D26).
  Views that are not lists of threads open from pinned rows. Settings is reached through account
  controls. Retire old screens; a scoped redirect may preserve a valid record link without keeping old UI.
- **Honest states.** A down connection, a spent budget or an unavailable model is said in words
  with what to do next. Never render a value the data cannot justify; never fabricate a quiet day.
  A change Captain makes is worded as a person's ("Captain added the tag …"); never "Captain
  thinks" (D33). Pending is never shown as free (D32).

## Layout and conventions

pnpm workspaces with Turborepo, TypeScript strict everywhere, ESM.

| Path | What |
|---|---|
| `apps/api` | Hono API: auth, routes over services, webhooks, health |
| `apps/mobile` | The one Expo/React Native client with Expo Router for web, iOS and Android (D37); auth/account composition (#197), My work (#199), All tasks (#201), native navigation (#205), session controls (#207), Inventory (#210) and the equipment timeline (#212/#213) merged; the three-tab navigation is replaced by the thread list (R2); business writes remain; native sign-in off, no installed-app or device evidence |
| `apps/e2e` | Playwright deployment smoke suite and browser regression checks against the Expo web export |
| `packages/db` | Drizzle schema, hand-written SQL migrations, RLS policies, typed queries |
| `packages/connectors` | Xero and Shopify business adapters; Google identity is separate in `apps/api` |
| `packages/steps` | the step catalog and workflow definitions |
| `packages/engine` | pg-boss workflow runner in the API process (D19) |
| `packages/model` | inference client, structured output, budgets, usage |
| `infra` | OpenTofu (`infra/tofu`) and the inference Sprite's bootstrap files (`infra/sprites`, D18); the retired embedding app remains stopped with repository assets removed (D21) |

The Expo shell is application code in `apps/mobile` (merged #188). The Next.js app (`apps/web`) and
`packages/ui` are retired in R1; logo, icon and splash assets move to `apps/mobile`. The earlier
client proof under `docs/proposals/assets/captain-client-proof-2026-09-23` was a standalone,
fictional harness outside the pnpm workspace, not application code. It and its `client-proof`
workflow were retired in R0 (#215) and live only in git history.

- Migrations are hand-written SQL, numbered, never edited after merge. One migration per pull
  request. Drizzle describes the schema; SQL is what runs.
- Services are plain functions over a transaction with tenant context set. Routes call services.
  Steps call services and connectors. Nothing reaches into another package's tables.
- API and database integration tests run against real Postgres. Set `DATABASE_URL` to a throwaway
  database; skipped database tests do not count as passing. Database-store, RLS and workflow tests
  are integration tests. Pure mobile protocol and device-storage queue tests use injected adapters
  under Node; they do not prove SecureStore or native device behaviour.
- Screens touched by a change get a Playwright check on the Expo web export. Every screen has
  designed empty, loading, failed, disabled and pending states.
- Conventional commits: `feat(api): …`, `fix(client): …`, `docs(plan): …`.

## How work moves

- Small pull requests, one concern each, with the workspace outcome named in the body and the decision it
  relies on when there is one. CI must be green. Squash-merge.
- Design of screens and of the step catalog is a plan matter: the
  [checked-in chat-first prototype](docs/proposals/assets/captain-chat-first-2026-09-30/README.md)
  and its documented behaviour are the design authority; propose changes in a plan amendment
  before building (D14). The 2026-09-22 mockups are historical.
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

Typecheck passes. Tests pass against Postgres. Touched screens pass their Playwright checks on the
Expo web export. Business changes are versioned with selective reversal or an explicit reason
why reversal is unavailable; private agent calls expose only the invoking message, and no external
action bypasses approval. The pull request names the workspace outcome. Nothing in the diff
contradicts a decision in the plan. If a step was skipped, the pull request says so.
