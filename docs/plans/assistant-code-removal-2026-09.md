# Removing the remaining assistant code

Status: **adopted in #180**, 27 September 2026. This contract guides the implementation sequence for
[#133](https://github.com/SomedaySomehowBeer/askthecaptain/issues/133) under D1, D2, D5, D6, D8,
D13, D19, D21–D23 in the [plan](../plan.md). It follows the
[runtime retirement](assistant-runtime-retirement-2026-09.md) and the
[implementation inventory](captain-workspace-migration-inventory-2026-09.md).

Workspace outcome: **manage shared work** and **manage business context** without carrying the
old personal assistant's modules, storage and deployment assets. Work, Chat and Resources, Xero,
Shopify, People, counted inventory, shared task reminders, stocktake, pg-boss, D2 inference, sessions,
passkeys and Google sign-in keep working unchanged.

## 1. Evidence boundary

- Source facts below were read from the repository working tree at `/home/nanoclaw/atc-next`
  (reported as main `edc81b8`; the commit was not independently verified by this author). No build,
  test, shell, database or provider command was run to produce this plan.
- "No live caller" means no import or SQL reference in `apps/*/src`, `packages/*/src`,
  `apps/api/test`, `apps/e2e`, `packages/*/test`, Dockerfiles or CI workflows, found by repository search. It is a
  code fact, not a claim about stored rows or running machines.
- The [operational record](../runbooks/paused.md) records that the owner-authorised reset
  (25 September) emptied the legacy content tables before 0037/0038 and that staging now runs #176.
  Nothing here asserts that those tables are **still** empty. Every destructive step below has a
  read-only count gate; root owns those counts and the migration gating.
- Historical migrations `0001`–`0043`, the reset script's recorded digest, validation records and
  closed issues are history. They are never edited (AGENTS.md: migrations are never edited after
  merge). Removing live code does not rewrite them.

### Implementation update, 27 September

R1 (#181), R2 (#182), R3 (#184) and R4a (#185) are merged. Fresh read-only staging
counts at 05:22:22.969Z found zero Google connections and zero attachment cache rows;
see [paused.md](../runbooks/paused.md) for the method and scope. R4b is in implementation.
R5a removes the expiry reader after that zero-count gate; its code is reviewed and
207 API tests against disposable Postgres (none skipped) plus API typecheck pass. PR integration
and staging release remain pending. R5b still requires R5a deployed, then fresh counts
of every affected table; neither this audit nor code removal drops storage.

## 2. Source baseline audited for this contract

### Live and retained (do not remove in any slice here)

| Capability | Source |
|---|---|
| Google **sign-in** (identity only) | `apps/api/src/auth/google.ts` (`GoogleIdentityProvider`), `/auth/google/*` in `app.ts`, `GOOGLE_CLIENT_ID/SECRET` in `env.ts` |
| Sessions, passkeys, members, invitations, export/deletion | `auth/*`, `organisations/*`; `lifecycle.ts` discovers tenant tables from the catalogue at request time, so dropped tables need no lifecycle edit |
| Xero / Shopify connectors, connections and caches | `packages/connectors/src/{xero,shopify}.ts`; `apps/api/src/{xero,shopify}/*` read and write their own rows in the shared `connections` and `sync_cursors` tables; the web cards call `/v1/organisations/:id/xero/connection` and `…/shopify/connection`; `workflows/service.ts:125–126` reads `connections` for `connection:xero/shopify` requirements |
| People and companies | `contacts/{service,routes}.ts`; hand-maintained only (`source: 'hand'`) |
| Counted inventory, stocktake v3, task reminders (`chase-due` v4) | `stock/*`, `chase/*`, `commitments/chase.ts`, `packages/steps/src/defs/*`. Registered handlers (`chase/service.ts:12–18`, `stock/workflow.ts:80–85`): `tasks.due`, `time.beforeDue`, `time.afterDue`, `push.taskOwner`, `push.escalate`, `stock.items`, `stock.counted`, `stock.recordCount`, `tasks.createInProject`, `shopify.stockLevels`, `push.counter` |
| pg-boss runner and retirement fences | `packages/engine/*`; `retiredWorkflowVersions` in `packages/steps/src/index.ts` and `apps/web/src/app/settings/workflows/retired.ts` |
| D2 inference | `packages/model`, `apps/api/src/inference/{service,routes,sprites}.ts` (`InferenceService.infer` is the supported, tested interface: `inference/service.test.ts`), `infra/sprites/*`, `model_usage`/`model_budgets`, the definition/validation support for `infer` steps in `packages/steps` |
| Work records and their evidence identities | `commitments/{service,routes}.ts`: new `mail` evidence is refused (`evidence_kind_retired`), new mail/note brief citations are refused (`evidence_retired`), existing identities are kept |
| Honest retirement responses | `retirement/routes.ts` (410 for old API roots and project accept/discard), `/webhooks/gmail` and `/connections/google/{callback,start}` 410s; web `RetiredFeature` pages and `/inbox/contacts/:id` and `/commitments` redirects |

### Legacy code with no live caller

| Code | Only references |
|---|---|
| `packages/retrieval/**` | `apps/api/package.json` dependency line; nothing imports `@captain/retrieval` |
| `packages/connectors/src/gmail.ts`, `calendar.ts` (exports `./gmail`, `./calendar`) | their own tests; `apps/api/src/sync-failure.test.ts` imports `GmailError` |
| `apps/api/src/sync-failure.ts` | its own test |
| `apps/api/src/contacts/addresses.ts` | one parser test in `contacts/contacts.test.ts` (import line 9, test at lines 22–27) |
| `apps/api/src/workflows/bindings.ts` (`notificationStep` only) | no caller. `inferenceStep` is used by `packages/engine/test/fixture.ts`; preserve that D2 adapter and regression (P6) |
| `env.ts` keys `CALENDAR_SYNC_DISABLED`, `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_AUDIENCE`, `MAIL_SYNC_DISABLED`, `EMBED_URL`, `EMBED_TOKEN`, `INDEX_DISABLED` and the Gmail refine | declared and parsed by `readEnv`, never read by any code |
| `GoogleConnector` methods `authorizationUrl`, `exchange`, `refresh`, `profile`, `googleScopes` | `packages/connectors/test/google.test.ts`; only `revoke` is live (`connections/service.ts:37`) |
| Legacy step-catalogue entries: every key in `packages/steps/src/catalog.ts` not in the registered-handler list above and not named by `defs/*`, plus `Requirement` `'connection:google'` | `packages/steps/test/definitions.test.ts` lines 24–32 (negative validation); the API route filters the catalogue to active steps |
| `packages/db/scripts/reset-legacy-staging.ts` | `packages/db/test/legacy-reset.test.ts`; refuses to run after 0036, so it is operationally dead |
| `infra/embed/**` | `.github/workflows/ci.yml:52`, `deploy.yml:11,41–62` (disabled workflow), `.gitignore:19` |

### Google-only code behind generic names

`ConnectionService` (`apps/api/src/connections/service.ts`) and its routes are Google-only in
practice: `disconnect` locks `provider = 'google'` (line 51); the lifecycle revoker at
`index.ts:70` handles Google only; the only product consumer of `GET /v1/organisations/:id/connections`
is the web `GoogleConnection` component (`settings/connections/page.tsx:31–55`); `workspace-fixture.ts:36`
constructs it with no connector. The shared `connections` table itself is **not** Google-only (see
the Xero/Shopify row above).

### Legacy code still running

`apps/api/src/triage/expiry.ts` is started at `index.ts:5,54` and stopped at `:79`. It calls
`attachment_text_organisations()` hourly and deletes expired `attachment_text` rows (D13). It is the
only running reader of legacy storage.

### Legacy storage (schema still present; no application writer found)

Tables: `mail_threads`, `mail_messages`, `mail_attachments`, `mail_triage`, `mail_senders`,
`sent_triage`, `attachment_text`, `outbox`, `calendars`, `calendar_events`, `notes`, `note_triage`,
`content_vectors`, `project_sources`, `project_candidates`, `project_candidate_sources`,
`discovery_seeds`, `briefs`, `answers`, and `webhook_events`/`webhook_attempts` (Gmail push only; no
Xero/Shopify caller). Security-definer functions: `gmail_sync_organisations`,
`calendar_sync_organisations`, `attachment_text_organisations`, `index_organisations`,
`content_vectors_cascade`, `project_sources_cascade`, `clear_changed_event_note`. Retained-table
columns tied to them: `contacts.last_thread_id` (FK to `mail_threads`, 0006),
`workflow_enablements.mail_cursor` (0012) and `sent_cursor` (0034). Apart from the expiry routine,
only tests read these tables (`packages/db/test/{mail,calendar,contacts,connections,schema-policy}.test.ts`,
`apps/api/src/chase/chase.test.ts:36`, `stock/workflow.test.ts:42`, `commitments/tasks.test.ts:52`).

## 3. Removal contract

1. **Code before schema.** No migration drops storage that the deployed image, or any image kept
   as a rollback target, reads or writes. The reader is removed and deployed first; the drop follows
   in a separate PR whose rollback target is that reader-free image. Hourly missing-table errors are
   not an acceptable rollback state.
2. **Repository assets are independent of schema.** Deleting stopped deployment code from the
   repository is reversible repository work within the existing authorisation. It does not wait for,
   or perform, the separate removal of a live stopped resource, which stays an authorised
   infrastructure operation recorded honestly in the operational record.
3. **Every slice is a deletion or narrowing**: no new package, table, dependency, background
   process or product surface. Tests covering retained behaviour stay; tests of deleted code go
   with it.
4. **Inventory text moves with the code.** When a slice removes a package, connector capability or
   deployment asset named in AGENTS.md or plan §4/§8, root updates that text in the same PR.
5. **Deliberate identities.** Keep `evidence.kind/reference`, `tasks.source_kind/source_id`,
   `projects.brief` citations and `contacts.source` values as provenance text. Do not rewrite,
   resolve or fabricate them into chat or mail records (D23). No retained mail/notes subsystem, no
   replacement index, no resolver service.
6. **Shared rows are kept for legitimate providers.** Nothing in `connections`/`sync_cursors` that
   serves Xero or Shopify is removed. A Google mailbox grant is never silently deleted or revoked.
7. **One migration per PR**, next free number at merge time, with forced-RLS/policy parity tests
   still passing for `app` and `captain_runtime` (D6).
8. **Staging only**, one machine per app, per the operational record. Production stays paused;
   no production image may be resumed against a post-R5b schema.

## 4. Ordered slices

R1, R2, R3 and R4a are independent of each other. R4b, R5a and R5b have gates, and R5b follows the
deployment of R5a. File lists are exclusive ownership for the implementing agent; root owns git,
lockfile regeneration, CI, AGENTS/plan inventory text, issues, counts and releases.

### R1 — Unused legacy leaf modules (first code removal; no schema, no gate)

Independent of every other slice. Nothing removed has an importer or runtime reader. The only
behavioural change is that `readEnv` stops declaring seven keys nothing reads (so a malformed stale
value, such as a short `EMBED_TOKEN`, no longer blocks startup). No schema, route, web page,
image layout or release step changes.

Delete:
- `packages/retrieval/`: `package.json`, `tsconfig.json`, `src/{index,client,units,vectors,search}.ts`,
  `test/{client,units}.test.ts`.
- `packages/connectors/src/gmail.ts`, `packages/connectors/src/calendar.ts`,
  `packages/connectors/test/gmail.test.ts`, `packages/connectors/test/calendar.test.ts`,
  `packages/connectors/test/fixtures/{thread,history,calendar-events}.json`.
- `apps/api/src/sync-failure.ts`, `apps/api/src/sync-failure.test.ts`.
- `apps/api/src/contacts/addresses.ts`.

Edit:
- `apps/api/src/workflows/bindings.ts`: remove only unused `notificationStep` and its imports; retain
  `inferenceStep`, which the engine integration fixture imports, and correct its obsolete inbox comment.
- `apps/api/package.json`: remove `"@captain/retrieval": "workspace:*"` (line 22).
- `packages/connectors/package.json`: remove exports `"./gmail"` and `"./calendar"` (lines 7–8).
- `apps/api/src/contacts/contacts.test.ts`: remove the `addresses` import (line 9) and the
  mailbox-parser test (lines 22–27); the member CRUD/isolation test stays.
- `apps/api/src/env.ts`: remove the seven keys listed in §2 and the Gmail `.refine`. Keep Shopify's
  refine and every other key. `z.object` strips unknown keys, so stale Fly secrets still parse; a
  new `apps/api/src/env.test.ts` proves that a source containing the removed keys (including an
  invalid `EMBED_TOKEN`) parses and omits them.
- Root, in the same PR: regenerate `pnpm-lock.yaml` (the `apps/api` importer's `@captain/retrieval`
  entry and the `packages/retrieval` importer); update AGENTS.md's `packages/retrieval` row and
  `packages/connectors` description, and plan §4's `packages/retrieval` and `packages/connectors`
  rows and §8's Gmail/Calendar adapter sentence, so no document still describes removed code.

No-reference gate: after the change, search for `@captain/retrieval`, `packages/retrieval`,
`@captain/connectors/gmail`, `@captain/connectors/calendar`, `GmailClient`, `GmailError`,
`CalendarClient`, `sync-failure`, `addresses.ts`, `from './addresses`, `workflows/bindings`,
`inferenceStep`, `notificationStep`, `MAIL_SYNC_DISABLED`, `CALENDAR_SYNC_DISABLED`, `INDEX_DISABLED`,
`GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_AUDIENCE`, `EMBED_URL` and `EMBED_TOKEN`. Matches are allowed only in
these deliberate exceptions:

| Exception | Why it remains | Removed by |
|---|---|---|
| `apps/api/src/workflows/bindings.ts` and `packages/engine/test/fixture.ts` (`inferenceStep`/binding import only) | retained generic D2 adapter and its integration regression | retained |
| `apps/api/src/env.test.ts` (removed environment-key names only) | regression inputs prove stale settings cannot block startup; no runtime reader | retained test |
| `infra/embed/server.mjs`, `infra/embed/server.test.mjs` (`EMBED_TOKEN`) | the stopped service's own code and test | R2 |
| `.github/workflows/deploy.yml` embed job (disabled workflow) | stopped deployment configuration | R2 |
| `docs/**` other than AGENTS.md/plan text updated above | history, validation records and runbooks | R6 (runbooks); history stays |
| `packages/db/migrations/**` | immutable history | never |

Any other match fails the gate. `pnpm-lock.yaml` must contain no `packages/retrieval` entry.
Other gates: `pnpm install --frozen-lockfile`; workspace typecheck; `pnpm test` against Postgres
(connectors and API suites must actually run); API image build (its `COPY packages` layout is
unaffected). No Playwright check (no web route touched). Release: none required; the change rides
the next reviewed API image. Owner follow-up (outside the PR): unset the seven staging API secrets
when convenient.

### R2 — Embedding-service repository assets (no gate)

Deleting these files is reversible repository work within the existing authorisation, and it does
not depend on removing the live stopped app. Delete `infra/embed/**` and `.gitignore:19`; remove
`infra/embed/*.test.mjs` from `ci.yml:52` (keep `infra/sprites/*.test.mjs`); remove the embed job and
the `infra/embed/**` path filter from `deploy.yml` (lines 11, 41–62). Keep
`docs/runbooks/embedding.md`, marked historical, because the stopped `askthecaptain-embed` app and its
secret still exist and paused.md records them. Root updates AGENTS.md's `infra` row and plan §4's
`infra/embed` row in the same PR, saying the app is stopped and its removal is a separate authorised
infrastructure operation. **Keep** `pgvector/pgvector:pg18` in CI: migration 0030 runs
`create extension vector` on every fresh test database. Update the CI image comment to name that
historical migration rather than a live retrieval index. This slice is unrelated to code-before-schema:
it touches no schema and no running reader.

### R3 — Legacy step-catalogue metadata

Files: `packages/steps/src/{catalog,validate,index}.ts`, `packages/steps/test/definitions.test.ts`.
Keep exactly the keys that `defs/chase-due.ts` or `defs/stocktake.ts` name (the registered-handler
list in §2 is the expected result; the PR proves it by test). Remove the others and `'connection:google'`
from `Requirement`/`requirementWords`. The negative-validation test needs a wrong-kind read and an
infer schema mismatch, but no infer key remains in the product catalogue: `validateDefinition` gains
an optional catalogue argument (default: product catalogue) and the test supplies a synthetic entry,
rather than keeping a legacy key. Web `settings/workflows/steps.test.ts` uses its own fixture data and
may stay. `engine/test/legacy-definition.ts` and the `engine_spike` fixtures are self-contained engine
regression harnesses (own registry and schema) and stay. `retiredWorkflowVersions` stays.
Gates: steps/API/web unit tests; the workflow catalogue API test still offers only chase-due and
stocktake.

### R4a — Narrow the Google connector to revocation

Files: `packages/connectors/src/google.ts`, `packages/connectors/test/google.test.ts`.
Delete `authorizationUrl`, `exchange`, `refresh`, `profile`, `googleScopes` and `GoogleTokens`;
keep the constructor signature and `revoke` so `apps/api/src/index.ts:43–45`,
`connections/service.ts` and `connections/service.test.ts` compile unchanged. The revocation and
no-provider-call assertions in `connections/service.test.ts` stay green. Root updates plan §8's
Gmail/Calendar sentence if R1 has not already.

### R4b — Remove the Google mailbox grant path (gate: count and owner decision)

Callers checked (§2): only Google consumes the generic list/disconnect path; Xero and Shopify have
their own services, routes and web cards, and those, the shared `connections`/`sync_cursors` rows and
the `workflows/service.ts` requirement read all stay.

Gate: a read-only staging count, by root with a recorded method, of `connections where provider = 'google'`
by status, without account emails or tokens. If any grant is not `disconnected`, the owner chooses:
disconnect it through the existing UI first, or keep R4b waiting.

Then remove only the Google-specific path: `GoogleConnector` and `packages/connectors/src/google.ts`
(and the `"."` export), `ConnectionService` and `connections/service.ts`, the list/disconnect routes in
`connections/routes.ts` (keep the file only for the `/connections/google/{callback,start}` 410s, or
move them with equivalent authentication and membership guards), the Google revoker at `index.ts:70` and the
construction at `index.ts:43–45`, the `connections` member of `Deps` in `app.ts`, the constructor
argument in `apps/api/test/workspace-fixture.ts:36`, and the `GoogleConnection` component, its
`Connection` type/scope labels and `ConnectionActions`/`actions.ts` in
`apps/web/src/app/settings/connections/` (the Xero and Shopify cards stay). Adapt
`connections/service.test.ts` to keep asserting the 410s and the unchanged Google identity sign-in.
Keep `/webhooks/gmail` 410 until root records the owner's removal of the Gmail Pub/Sub
subscription/topic. `apps/e2e/scripts/workspace-check.cjs:138` (no Google connect buttons) stays.
The organisation-scoped Google-start retirement route retains its bearer and `roleOf` membership
checks; moving it must not expose a tenant route outside those guards. Tests cover unauthenticated
and foreign-organisation requests as well as authorised 410s. The removal gate requires **zero**
Google rows in any status other than `disconnected` before removing the organisation-deletion
revoker. `organisations/lifecycle.test.ts` keeps its synthetic Google row to test export credential
redaction; that fixture does not indicate a live grant or require a Google product surface.
Playwright: Settings → Connections still shows the Xero and Shopify cards, with no Google section.

### R5a — Remove the attachment-expiry reader and deploy it (gate: cache count)

Gate: a read-only staging count by root of `attachment_text` rows, split by `expires_at <= now()`,
recorded in paused.md without content.
- If the count is zero, remove the routine: delete `apps/api/src/triage/expiry.ts` and its three
  `index.ts` references (lines 5, 54, 79).
- If any row exists, keep the routine (D13 expiry must continue while the cache exists) and wait:
  recount after the latest `expires_at` has passed and the hourly sweep has run. Do not delete rows by
  hand to satisfy the gate.

Release this image to the sole staging API machine and record it. From then on, the rollback target
for R5b is this reader-free image or later; no earlier image is a permitted rollback after R5b.
Gates: typecheck, API tests, `/readyz` after release.

### R5b — Drop legacy storage (gate: R5a deployed, counts; one migration)

Gate: R5a is the deployed staging API; a read-only count of every table in §2's storage list plus
non-null `contacts.last_thread_id` and `workflow_enablements.mail_cursor/sent_cursor`, recorded in
paused.md without content. A non-zero count stops the slice for review (it would mean an unknown
writer). Root owns this gate and the migration's release.

Files: new `packages/db/migrations/00NN_drop_assistant_storage.sql`; delete
`packages/db/src/{mail,triage,calendar,briefs,answers}-schema.ts`; edit
`packages/db/src/contacts-schema.ts` (drop `lastThreadId` and the `mailThreads` import),
`workflows-schema.ts` (`mailCursor`, and `sent_cursor` if described), `connections-schema.ts`
(webhook tables, under P3); delete `packages/db/test/{mail,calendar}.test.ts`; edit
`packages/db/test/{contacts,connections,schema-policy}.test.ts` (schema-policy line 112 drops
`gmail_sync_organisations()`), `apps/api/src/chase/chase.test.ts:36`,
`apps/api/src/stock/workflow.test.ts:42`, `apps/api/src/commitments/tasks.test.ts:52–58` (use a
fabricated citation UUID instead of inserting a note; the `evidence_retired` assertions stay).

Migration order, no `cascade` so any unknown dependency fails loudly:
1. Guard: raise if any listed table has a row or any listed retained column is non-null.
2. `alter table contacts drop column last_thread_id` (removes the 0006 FK);
   `alter table workflow_enablements drop column mail_cursor, drop column sent_cursor`.
3. Drop tables children first: `note_triage`, `notes`, `content_vectors`, `project_candidate_sources`,
   `project_candidates`, `project_sources`, `discovery_seeds`, `mail_triage`, `sent_triage`,
   `attachment_text`, `mail_attachments`, `outbox`, `mail_messages`, `mail_senders`, `mail_threads`,
   `calendar_events`, `calendars`, `briefs`, `answers`, then `webhook_attempts`, `webhook_events`
   (P3). Their triggers go with them.
4. Drop the seven functions in §2.
5. Leave the `vector` extension, `projects` proposal/brief columns and generated `state`,
   `evidence`/`tasks`/`contacts` check values, `auth_requests` kind values and `connections`.

Gates: typecheck; full Postgres suite including schema-policy parity (its `> 40` grants and `> 20`
policies floors must still hold; recount); `legacy-reset.test.ts` still passes (it migrates only
through 0036) or is removed under P5; export/deletion tests; fresh-database migration twice
(idempotent). Release: sole staging API machine, HTTP stopped, one-shot migration and queue install,
then the new image; post-release `/readyz`, the runtime-role probe, and absence of the dropped tables.
Rollback: forward fix, or an image at or after R5a. Never recreate the tables.

### R6 — Runbooks and retired-surface tidy (after R1–R5b)

Move runbooks for removed code to the legacy history index: `mail-sync.md`, `calendar-sync.md`,
`inbox-triage.md`, `discovery.md`, `question-box.md`; `embedding.md` once the stopped app is removed;
`gmail-push.md` once the owner removes Pub/Sub. Web retired pages (`/today`, `/inbox/**`,
`/calendar`, `/notes/**`) and API 410s comply with D11 and stay unless a later reviewed change
replaces them with redirects; that is not required to complete #133.

## 5. Data safety

- R1–R4a delete no rows. R4b removes code for rows it first counts. R5a removes a reader only when
  its cache is empty. R5b is the only destructive step: owner authorisation for old-version data
  exists (paused.md, 25 September), but the in-migration guard makes an unexpected row stop the
  release instead of being deleted silently.
- Rows kept on purpose: workflow runs/steps and their snapshots (retirement fences still apply),
  audit events, model usage and budgets, evidence and brief citations, contacts/companies,
  `connections` and `sync_cursors` (Xero, Shopify, and any Google row until R4b).
- Provider originals, backups/PITR, logs, the stopped embedding app and the inference Sprite are
  outside this plan.

## 6. Risks and decisions

| # | Source-backed risk | Decision |
|---|---|---|
| P1 | Removing env keys could reject a configured secret at startup | `z.object` strips unknown keys; R1 adds `env.test.ts` proving it |
| P2 | `validateDefinition` loses infer-schema coverage when legacy infer keys go | Optional catalogue argument for tests (R3); no retained legacy key |
| P3 | `webhook_events`/`webhook_attempts` look generic but only Gmail push used them | Drop in R5b; a future Xero/Shopify webhook contract re-adds what it needs |
| P4 | `projects.state` is generated from `proposed_at`/`accepted_at`, and Work/tag tests set them | Keep discovery-proposal columns; a separate reviewed change can simplify them |
| P5 | `reset-legacy-staging.ts` and its test are dead but document the destructive reset | Delete both in R5b; paused.md and the validation record keep the digest and counts |
| P6 | Initial source-only audit missed `packages/engine/test/fixture.ts` importing `inferenceStep` | Preserve that generic D2 adapter and integration coverage. R1 removes only unused `notificationStep`; include package test trees in caller searches |
| P7 | `pgvector` looks removable after R5b | Keep the CI image and extension: historical 0030 needs it |
| P8 | `env.ts`, `index.ts`, `app.ts` and `auth/*` are also touched by native-foundation work | Root sequences R1/R4b/R5a against the mobile A1/A2 PRs; no parallel edits of those files |
| P9 | The Google OAuth client still lists Gmail/Calendar scopes at the provider | Owner operation: reduce consent-screen scopes to sign-in; not a code slice |
| P10 | A paused production image predates 0037/0038 | Already unsafe to resume; after R5b it also lacks tables. Production resume needs a current image (paused.md) |
| P11 | Mobile A1 rebuilds the `auth_requests` kind check | It must keep every existing kind, including `google_connection`; narrowing that list is not part of this plan |

## 7. Not in scope

Pip, any replacement inbox/notes/index, native client work, renaming `apps/api/src/commitments`
(it is the live Work service), changing retired-route semantics, removing the stopped embedding app
or Pub/Sub resources, production operations, credential or DNS changes, and any live count asserted
here.
