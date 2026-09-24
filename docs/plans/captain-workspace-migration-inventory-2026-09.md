# Captain workspace migration inventory

Status: reviewed and merged with the plan amendment in #116, 24 September 2026; slice 1 of the
[delivery plan](captain-workspace-delivery-2026-09.md). The plan adopted the conservative
first-slice answers below (D7: Obligations remains the default home; D23: existing notes stay notes).
Jobs advanced: **own commitments** and **brief and answer**.

This is an inventory of the **code**: schema, services, schedulers and workflow definitions on
`main` at `ac54ee0`. It is **not** a live data audit. It records what each store is, where it
is written and read, and a proposed disposition after the Captain/Pip split in the
[product proposal](../proposals/2026-09-22-captain-and-pip.md). No row count, enablement,
connection status or configured secret was read from production to write it. Every "unknown"
below is something the owner must establish from a read-only look at a restored copy, not from
the paused production database.

The amended plan (D1–D25) is authoritative; where this inventory says "proposed", the plan's
text decides. Nothing here authorises a migration, a deletion or a change to a running system.

## Ground rules while the migration is developed

These hold from now until the owner explicitly lifts them.

1. **The production pause stands.** [`docs/runbooks/paused.md`](../runbooks/paused.md) records
   what was stopped on 2026-09-23: all Fly machines stopped with autostart off, and the `deploy`
   and `backup` workflows disabled. Development does not resume, redeploy or re-enable any of it.
   Resuming is the owner's decision and the owner's action.
2. **No data is deleted.** No `drop`, `truncate` or `delete` of existing tenant data in a
   migration, script or service during this work. Retiring a capability means disabling it and
   keeping its data until a disposition is agreed and a verified backup exists (rule 5).
3. **No schedule is re-enabled.** Workflow enablements, pg-boss schedules and system routines stay
   as they are. See "Things that run by themselves" below: starting the API against any copy of
   production data is enough to start them, so such a process must have every switch off.
4. **No production queries.** Development uses local, seeded or fictional data. A read-only look at
   the real data, needed to replace the "unknown" cells, is the owner's action against a restored
   copy, not against the paused Neon branch.
5. **No successful scheduled dump since 21 September.** The pause runbook reports that the
   `backup` workflow had been failing since 2026-09-21 on a `pg_dump` server version mismatch
   before it was disabled, so the newest good scheduled dump predates that. Whether any other
   copy exists, and whether Neon's point-in-time history covers the period, is unknown: neither
   was checked for this document. Before any production migration the owner fixes the dump
   client, takes a dump and rehearses its restore.
6. **No credential or mail history moves to Pip.** People reconnect personal providers in Pip
   themselves (delivery plan, "Migration and simplification").

## How to read the tables

- **Code fact**: taken from a migration, service or definition; the file is named.
- **Unknown (live)**: depends on production state not read for this document.
- **Proposed**: this document's suggestion, reviewed with the slice 1 amendment (#116); the plan decides where they differ.
- **Decision**: an open product question for the owner; listed together at the end.

Dispositions are one of **keep** (Captain stays the authority, schema kept), **migrate** (kept, but
the shape changes through additive migrations), **freeze** (read-only, no new writes, kept
until a retention decision), **retire** (writer disabled; data kept until an agreed deletion that
follows a verified dump and rehearsed restore) or **decide**.

## Things that run by themselves

Code fact: `apps/api/src/index.ts` starts all of these on process start. Workflow schedules live in
the database (pg-boss `schedule`, `missed: 'once'` in `packages/engine/src/pg-boss.ts`), so an API
started against a copy of production data would fire each missed daily run once.

| Runner | Interval | Off switch | Reaches out to |
|---|---|---|---|
| Workflow engine (pg-boss) | enablement schedules, events | `WORKFLOWS_DISABLED=1` | Sprite inference, Gmail labels, push |
| Mail sync | 5 min | `MAIL_SYNC_DISABLED=1` | Gmail |
| Gmail watch renewal and push queue | 1 min | none; runs only if `GMAIL_PUBSUB_TOPIC` and `GMAIL_PUSH_AUDIENCE` are set | Gmail `watch` |
| Calendar sync | 5 min | `CALENDAR_SYNC_DISABLED=1` | Google Calendar |
| Xero sync | 15 min | `XERO_SYNC_DISABLED=1` | Xero |
| Shopify sync | 15 min | `SHOPIFY_SYNC_DISABLED=1` | Shopify |
| Series occurrences | 1 h | `SERIES_DISABLED=1` | database only (creates tasks) |
| Retrieval index fill | 1 h and after sync | `INDEX_DISABLED=1` | embedding service |
| Attachment text expiry (D13) | 1 h | none | database only (deletes expired `attachment_text`, a D13 requirement) |

Outside the API, configured callers include a Better Stack monitor for
`api-staging.askthecaptain.app/readyz` every 30 minutes (`infra/tofu/uptime.tf`) and Gmail's
Pub/Sub push subscription to `/webhooks/gmail`, if configured. Their live state was not audited.
Neither can start a stopped machine while autostart is off.

**Proposed:** any process pointed at a copy of real data sets all seven `*_DISABLED` flags to `1` and leaves the
Gmail push variables unset. Add a disable flag for the Gmail watch in the first migration PR that
touches mail, so "all off" is one checklist. There should be no second scheduler for a commitment:
series occurrences and `chase-due` must never run in both an old and a new path.

## Inventory

### 1. Projects, tasks, sub-tasks and series

| | |
|---|---|
| Stores (code fact) | `projects` (0002; stages, `system_kind = 'obligations'`, brief 0032, proposal/accept columns and generated `state` 0033), `tasks` (0002; `project_id` **not null**, status incl. `suggested`, `source_kind` person/mail/series/run/note, `parent_id` one level deep 0032), `task_series` (0002; `project_id` not null), `project_sources`, `project_candidates`, `project_candidate_sources` (0031), `discovery_seeds` (0033) |
| Code paths | `apps/api/src/commitments/{service,series,routine,triage}.ts`, `apps/api/src/discovery`, web `commitments/`; writers in workflows: `tasks.suggestFromTriage`, `tasks.suggestFromNote`, `tasks.suggestFromSent`, `tasks.completeFromConfirmations`, `tasks.createInProject` (stocktake), `discovery.record` |
| Authority now | Captain (D7, D22) |
| Authority after split | Captain: shared projects, tasks, owners, recurring obligations. Personal tasks: Apple Reminders via Pip, never copied from Captain |
| Proposed disposition | **Keep and migrate.** Keep every id (uuidv7) so evidence, notes, chat links and exports keep resolving. Additive migrations for tags (a tag table plus a task↔tag link, tenant-scoped with RLS), saved views and equipment reservations linked to task/project. The proposal's "work needs no artificial project" conflicts with `project_id not null` on tasks and series; **first-slice decision (conservative):** standalone and recurring work keeps its home in the Obligations system project as the compatibility default; no nullable-project migration now. The new views can hide or relabel it. Revisiting this later is D-3, which does not block tags or views |
| Mail-derived parts | `suggested` tasks, `project_sources` with `linked_by in ('rule','model')`, `project_candidates*`, `discovery_seeds`, proposed (unaccepted) projects and the project brief were produced from mail/notes triage. **Proposed:** freeze the writers with triage (§3); keep accepted projects and their briefs; keep pending suggestions and proposed projects visible for a person to accept or discard, then freeze. Unknown (live): how many suggested tasks and proposed projects exist |
| Compatibility / rollback | All changes additive; old five-tab routes keep reading the same rows until the new views work. No existing column changes meaning, so the old code keeps working if new tables are ignored; each new migration still ships a locally tested inverse migration |
| First dependencies | Slice 1 amendment of D7 (tags, Obligations as default home, sub-tasks retained or not), D11 (views). Then the first migration after 0034: tags + task tags, with RLS policy and cross-tenant test in the same PR |

### 2. Notes and evidence

| | |
|---|---|
| Stores (code fact) | `notes` (0029; author, body ≤ 20 000 chars, optional links to event/contact/company/project/task, own vector 0030), `note_triage` (0029), `evidence` (0002; kind mail/note/file/url 0033, `reference` is **text with no foreign key**) |
| Code paths | `apps/api/src/notes/service.ts`, `apps/api/src/commitments/service.ts` (`addEvidence`), `apps/api/src/commitments/triage.ts` (`suggestFrom` writes evidence with `kind 'mail'` and `reference` = `mail_threads.id`) |
| Authority now | Captain (D23 notes; D7 evidence) |
| Authority after split | Captain for project/task evidence. Chat replaces item discussion (proposal §2); notes are not mentioned in the new navigation |
| Proposed disposition | **Evidence: keep.** It is the shared record's link to its proof. **Notes: keep (first-slice decision, conservative).** Existing notes stay notes with stable ids and their links; they are not converted into chat. Whether new item discussion should ever absorb notes is D-6, which does not block additive work. **`note_triage`: freeze** with the triage workflow |
| Risk | `evidence.reference` for `kind = 'mail'` points at `mail_threads.id` without a constraint. Deleting or pruning mail rows would silently break these links. Any mail retention decision must first resolve each mail evidence reference to a durable description (subject, participants, date, provider message id) or keep the thread rows. Unknown (live): count of mail-kind evidence |
| Compatibility / rollback | Additive: a later "shared correspondence" record (proposal §3) can be added and referenced by new evidence rows; old rows keep pointing at mail threads |
| First dependencies | Decision D-1 (mail history) before any mail pruning; proposal §3 correspondence API design |

### 3. Mail, triage, outbox, attachment text and vectors

| | |
|---|---|
| Stores (code fact) | `mail_threads`, `mail_messages` (bodies stored, 0004), `mail_attachments` (metadata only), `attachment_text` (≤ 20 000 chars, expires ≤ 24 h, 0012), `mail_triage` (0012, `remind_at` 0028), `sent_triage` (0034), `mail_senders` (learned priors, 0026), `outbox` (0012; outcomes 0027; `invoice_provider_id` 0024), `content_vectors` (0030) plus `vector` columns on `mail_threads` and `notes`, `sync_cursors`, `webhook_events`, `webhook_attempts` (0003), `workflow_enablements.mail_cursor`/`sent_cursor` |
| Code paths | `apps/api/src/mail/{sync,push,watch,service,store}.ts`, `apps/api/src/triage/*`, `apps/api/src/retrieval/service.ts`, `infra/embed`; workflow `inbox-triage` v7 |
| Authority now | Captain holds a synced copy of **one Google mailbox per organisation**: `connections` is `unique (organisation_id, provider)`, so the mailbox is whichever member connected Google |
| Authority after split | Email provider for original mail, sent mail and accepted drafts. Pip for personal interpretation, transient processing and its own iCloud index. Captain holds only correspondence deliberately shared into a project (proposal §3) |
| Proposed disposition | **Retire the sync, triage and drafting path; freeze its data.** Stop writers in this order once replacements exist: inbox-triage enablement, mail sync, Gmail watch, index fill. Keep `mail_*`, `mail_triage`, `sent_triage`, `outbox` read-only until Decision D-1. `attachment_text` keeps expiring as D13 requires (it holds nothing older than a day). `content_vectors` and the thread/note vectors are derived data: **freeze**, then delete with their sources once D-1 is agreed; never migrate them to Pip (D21 vectors are mail-derived data) |
| Outbox specifically | Pending drafts (`state = 'drafted'`) are unsent correspondence someone may still want. **Proposed:** before retiring, surface them once for a person to send, discard or copy to the provider as a draft; do not auto-send and do not auto-discard. `chase-due` also writes invoice chasers into `outbox`; see §5 and Decision D-2. Unknown (live): number of pending drafts |
| Compatibility / rollback | Retirement is disabling enablements and schedulers, not dropping tables, so rollback is re-enabling them (owner only, after the pause lifts). Old Inbox routes can stay read-only while the new shell ships |
| First dependencies | Decision D-1; the §3 correspondence attach API (slice 5/6 in the delivery plan); a disable flag for Gmail watch; a verified dump and rehearsed restore (plus an organisation export for the record) before any deletion |

### 4. Contacts, companies and calendar

| | |
|---|---|
| Stores (code fact) | `companies`, `contacts` (0006; `source` mail/hand/import, `last_thread_id` → mail thread, `external_refs` for Xero matches), `calendars`, `calendar_events` (0005; synced cache; `preparation_note`, `prepared_by_run` 0020) |
| Code paths | `apps/api/src/contacts/{service,upkeep}.ts` (`contacts.upsertFromTriage` in inbox-triage), `apps/api/src/calendar/*`, workflow `calendar-prep` (18:00) |
| Authority now | Contacts/companies: Captain, kept current by triage and by hand. Calendar: Google, cached in Captain from the connecting member's calendars |
| Authority after split | Business counterparties: Captain ("People" under Resources, and Xero links). Calendar events: the calendar provider; personal calendar assistance moves to Pip |
| Proposed disposition | **Contacts/companies: keep**, stop the mail-derived upkeep with triage; hand edits and Xero matching continue. **Calendar cache and `calendar-prep`: retire and freeze**, since calendar help is Pip's; the equipment timeline is a new Captain model and does not read this cache. Preparation notes stay readable until D-1/D-4. Decision D-4 covers whether any shared business calendar remains in Captain |
| Compatibility / rollback | Contacts unaffected. Calendar retirement is disabling the sync and enablement |
| First dependencies | Decision D-4; the People view in Resources (after slice 2) |

### 5. Xero, Shopify and stock counts

| | |
|---|---|
| Stores (code fact) | `xero_contacts`, `xero_invoices`, `xero_payments` (0008); `shopify_products`, `shopify_inventory_levels`, `shopify_orders`, `shopify_reorder_points` (0021); `stock_items`, `stock_counts` (0016) |
| Code paths | `apps/api/src/xero/*`, `apps/api/src/shopify/*`, `apps/api/src/stock/*`; workflows `chase-due` (Xero receivables → outbox chaser), `morning-brief` (receivables), `stocktake` (weekly Mon 08:00; counts, Purchasing tasks, supplier draft) |
| Authority now | Xero and Shopify are provider caches (they own the records); stock counts are Captain's (D15) |
| Authority after split | Xero stays accounting authority; Captain links projects to invoices and shows provider-backed status. Stock: Captain's counted list under Resources → Inventory. Shopify: **the proposal requires an explicit scope decision** (Decision D-5) |
| Proposed disposition | **Xero cache: keep** (read-only cache; syncs stay off during the pause). **Stock items and counts: keep**, unchanged by D15. **Shopify cache, reorder points and stock counts: retained (first-slice decision, conservative)** until replacement Resources views work; no removal or reassignment. Their long-term scope is D-5, which does not block additive work. **`chase-due`: decide** (D-2): the proposal keeps business chasing in Captain but moves drafting correspondence to Pip; the task-reminder half (push to owner, escalation) is plainly Captain's |
| Compatibility / rollback | No schema change needed for the first release. Project↔invoice links are additive |
| First dependencies | Decision D-2 before `chase-due` changes; Resources → Inventory view (slice 5) before any Shopify/stock change |

### 6. Connection credentials and the inference runtime

| | |
|---|---|
| Stores (code fact) | `connections` (0003; one row per organisation per provider; tokens envelope-encrypted with the per-tenant key in `organisations.data_key_wrapped`, D16), `inference_runtimes` (0007; Sprite name/region, `connection_encrypted`), `model_budgets`, `model_usage` |
| Code paths | `apps/api/src/connections/*`, `apps/api/src/xero/connections.ts`, `apps/api/src/shopify/connections.ts`, `apps/api/src/inference/*` |
| Authority after split | Captain: business connections (Xero, Shopify, any business Google scope that survives D-1/D-4). Pip: personal Google/iCloud connections, held on the person's devices. Inference: the existing Sprite until D9/D18 are amended |
| Proposed disposition | **Never copy or export credentials to Pip** (the export already strips them: `secretColumns` in `apps/api/src/organisations/lifecycle.ts`). **Xero and Shopify connections: keep.** **Google connection: decide** with D-1/D-4. If Captain no longer reads mail or calendar, the owner disconnects it after the freeze (which revokes at Google) and reconnects in Pip. Until then leave it untouched: disconnecting from development would call Google. **Inference runtime: keep** (retained by the proposal §4 until amended) |
| Unknown (live) | Which providers are connected, their status, and whose Google account backs the connection |
| First dependencies | Slice 1 amendment of D8 (connector ownership) |

### 7. Workflow enablements, runs and journals

| | |
|---|---|
| Stores (code fact) | `workflow_definitions` (catalogue synced from code on API start), `workflow_enablements` (parameters, schedule overrides, mail/sent cursors), `workflow_runs` (immutable snapshot 0013), `workflow_run_steps` (journal, `output jsonb`), pg-boss's own schema (jobs and schedules) |
| Definitions (code fact) | `inbox-triage` v7 (job 1; mail.synced, note.saved, 06:00), `discover-projects` v1 (job 4; 06:00, on request), `morning-brief` v2 (job 6; 06:30), `chase-due` v3 (job 5; 07:00), `calendar-prep` v1 (job 3; 18:00), `stocktake` v2 (job 4; Mon 08:00, manual) in `packages/steps/src/defs` |
| Unknown (live) | Which are enabled, by whom, with which parameters; runs in `waiting`/`paused` states (chase-due awaits can be up to 90 days, outbox awaits 60) |
| Proposed disposition | Per definition: **inbox-triage retire**, **calendar-prep retire**, **discover-projects retire** (depends on mail triage and D22), unless D-1 keeps a Captain mailbox; **morning-brief migrate** to a Captain brief over shared records (tasks, reservations, receivables; no outbox/calendar sources) and a Pip catch-up for personal material; **chase-due decide** (D-2); **stocktake keep**. Retire by disabling the enablement through the service so its pg-boss schedules are removed in the same transaction, then cancelling or letting waiting runs time out (each a journaled change). Never delete runs or journals: they are the audit of what workflows did |
| Retention note | `workflow_run_steps.output` holds step outputs, including classifications and draft bodies. It is mail-derived data and falls under D-1's retention answer, not "keep forever" by default |
| Compatibility / rollback | Rollback is re-enabling (owner only). A new definition version, not an edited one, for any migrated workflow |
| First dependencies | D-1, D-2; the amended job list (D1) |

### 8. Notification subscriptions

| | |
|---|---|
| Stores (code fact) | `push_subscriptions` (0011; Web Push endpoint, `p256dh`, `auth`), `push_deliveries` (every push sent) |
| Code paths | `apps/api/src/push/*`; notify steps `push.owner`, `push.taskOwner`, `push.escalate`, `push.counter`, `discovery.notify` |
| Authority after split | Captain for business notifications (task, reservation, chat). Pip for personal ones |
| Proposed disposition | **Keep** Web Push subscriptions for the web client. Add native device registrations as a new table, not by reusing Web Push rows (delivery plan: "existing web push is not native push"). **`push_deliveries`: keep** as journal. Unknown (live): whether Web Push keys were ever configured on the running app (the staging API logged them as missing when it woke on 2026-09-23) and how many subscriptions exist |
| First dependencies | Mobile session and notification design (delivery plan, slice 2) |

### 9. Identity, audit, export and deletion

| | |
|---|---|
| Stores (code fact) | `organisations`, `users`, `identities`, `sessions`, `passkeys`, `memberships`, `invitations`, `auth_requests`, `auth_events`, `audit_events` (append-only: `revoke update, delete on audit_events from app`, 0001), `organisation_deletions` (0015), `briefs` (0019), `answers` (0025) |
| Code paths | `apps/api/src/auth/*`, `apps/api/src/audit.ts`, `apps/api/src/organisations/lifecycle.ts` (export streams every table with `organisation_id`, minus secret columns; deletion revokes Shopify, Google, Xero and the Sprite, then cascades) |
| Proposed disposition | **Keep all of it.** Audit events are never migrated, rewritten or pruned. New tables (tags, equipment, reservations, conversations, messages) join the export automatically because it discovers tables by the `organisation_id` column; each new table's PR checks its export and cascade in a test. `briefs` and `answers` (brief and answer): **keep**; their `items`/`sources` jsonb may reference mail threads, so they follow D-1 for display, not deletion |
| Before any production migration | A verified database dump with a rehearsed restore (ground rule 5), and for each schema change a tested inverse migration or a documented reason it is irreversible. The organisation export is **not** a rollback: it is newline-delimited JSON with camelCase keys, covering only `public` tables that carry `organisation_id` (so not `users`, `identities` or pg-boss state), with credential columns removed (`secretColumns`), without roles, grants or constraints, and no import path exists in the code. It is a readable record of the business's data, useful for review and for a person's own copy, alongside the dump rather than instead of it |
| First dependencies | Native session handling (slice 2); deletion now needs a Pip-side counterpart for personal data, which Captain's lifecycle cannot reach |

## Order of first implementation work

1. Slice 1 amendment adopts the authority table and the conservative first-slice decisions:
   Obligations stays the default home for standalone work, existing notes stay notes, Shopify
   and stock counts are retained until replacement views work. D-1, D-2 and D-4 are
   **retirement gates**: they must be settled before the mail, invoice-chasing or calendar path
   is retired or its data changes, and they block nothing else.
2. Additive schema for the first release (tags, saved views, equipment, reservations, then chat),
   one migration per PR from `0035`, each with RLS, audit, export and cross-tenant tests, and each
   with an inverse migration tested locally. None of it touches existing rows, so it proceeds
   without waiting for D-1 to D-6.
3. Replacement views read the same projects/tasks rows; old routes stay reachable, read-only where
   their writer is retired.
4. Retirement of mail/calendar writers happens **after** the pause lifts and is an owner-run change
   (disabling enablements and flags), never a migration.
5. Deletion of any frozen data is a separate, later, owner-approved step after a verified dump
   and rehearsed restore, an organisation export for the record, and resolution of the evidence
   references in §2.

## Decisions for the owner

**Retirement gates.** Settle each before its path is retired or its data changes. None blocks
tags, views, equipment, chat or other additive work that does not touch that path.

- **D-1. Mail history in Captain.** Freeze the synced mailbox read-only, or export it and delete it
  once evidence links are resolved? And does Captain keep any business mailbox (a shared role
  account), or does all mail reading leave Captain for Pip?
- **D-2. `chase-due`.** Keep the task reminders in Captain (clearly business). For overdue invoices:
  keep Captain drafting chasers into its outbox, or have Captain flag the invoice and Pip prepare
  the reply with the person?

- **D-4. Calendar in Captain.** Retire the calendar cache and `calendar-prep` entirely, or keep a
  shared business calendar read alongside the equipment timeline?

**Deferred, with a conservative first-slice answer in place.** Revisit later; they do not block
implementation.

- **D-3. Work without a project.** First slice: the Obligations system project stays the default
  home of standalone and recurring work; `project_id` stays `not null`. Later: whether to make it
  nullable (a migration touching every query).
- **D-5. Shopify and stock.** First slice: the Shopify cache, reorder points and counts are
  retained unchanged until replacement views work. Later: keep, relocate or retire (the proposal
  requires this to be explicit).
- **D-6. Notes.** First slice: existing notes stay notes, same ids and links. Later: whether new
  item discussion absorbs notes into chat.

Not a decision here, but a dependency: the `backup` workflow's `pg_dump` must match the Neon
server before anything in production changes.
