# Retiring the personal-assistant runtime

Implementation increment for [#133](https://github.com/SomedaySomehowBeer/askthecaptain/issues/133),
under D1–D8, D11, D13, D20–D23 in the [current plan](../plan.md).
Workspace outcome: shared tasks, recurring work, stock, equipment and people remain usable while
Captain stops offering or running the old personal assistant. This increment does not complete #133.

## Product and runtime contract

- Today, Inbox/thread, personal Calendar and Notes URLs show a signed-in retirement state. Their
  actions, data reads, onboarding and links are removed. Contact details move to
  `/settings/contacts/:id`, reached through Resources; old contact URLs redirect to that record.
- Authenticated, tenant-authorised old mail/calendar/outbox/notes/answers/briefs/discovery routes
  and project-discovery accept/discard return `410 legacy_feature_retired`. Unknown tenants return
  404 and missing sessions 401. Google connection start is refused; its old callback and the Gmail
  webhook return 410 without a provider request. A stale Google consent callback lands on that
  explicit API response. Google identity sign-in and Xero/Shopify connections remain separate.
- Google mail/calendar consent, callback, token refresh, ingestion, push/watch, indexing, triage,
  discovery, morning briefs, calendar preparation and the synchronous answer implementation are
  removed. Existing Google grant metadata and owner/admin disconnection remain available. No grant
  is silently revoked. Expiry of previously extracted attachment text continues as housekeeping.
- The offered workflow catalogue contains **Task reminders (`chase-due` v4)** and **Stocktake v3**.
  Task reminders read shared tasks, wait independently, notify their owners and escalate overdue
  tasks to the enabling person. Stocktake requests counts, journals submitted counts and creates
  reorder tasks; optional Shopify stock can also create reorder tasks. Neither definition uses
  email, Xero, inference, a supplier draft or an outbox. Push availability is checked for the enabling
  person. The selected named Purchasing project is still used until the optional-project increment.
- Migration 0037 disables old enablements and cancels queued/running/waiting/paused runs for the
  four fully retired definitions, chase-due <=3 and stocktake <=2. It preserves snapshots, terminal
  history and source records, records system audit events, and removes old schedules and pending
  queue deliveries. Current-version enablements/runs and unrelated jobs are preserved.
- Runtime version fences reject resume, prevent wake and replacement schedules after cancellation,
  and cancel old delivered snapshots before any handler or successor runs. Immutable snapshots for
  unrelated definitions retain their existing semantics. Historical engine fixtures exercise crash,
  replay, inference validation and waits without making the old workflow a product option.
- Project/contact APIs stop reading personal-source titles and mail summaries. Existing project
  brief text/citations remain; a save may preserve an unchanged cited line from that same project,
  remove its citation, or add uncited text. It cannot create a new mail/note citation. Future selected
  business evidence needs its own authorised source contract. Retained records are not asserted to
  exist on staging, or to be useful, solely because their tables exist.

## Deliberate next increments

The old `/commitments` overview still provides task/project/series controls, and the mandatory
project/Obligations schema still exists. This is a temporary dependency, not an approved workspace
model. Remove the schema fallback with a reviewed, inspected data migration, make project optional
for tasks and series, then replace the old overview with bounded Work detail pages (#131).

Legacy storage, the old step-catalogue metadata used by generic validation fixtures, embedding
package/deployment assets and unused connector capabilities need subsequent deletion once their
remaining dependencies and operational state have been checked. No mailbox replacement or Pip
release is required. This increment adds no chat, files/DAM, personal search or new inference step.

## Staging cutover and recovery

Only staging is authorised, reusing the existing single API and single web machine. Production
stays paused. Do not use a second release machine for migration 0037.

1. Before deployment, inspect counts by definition/version/state, enablement state, queue and
   pending schedules; record counts without source text, credentials or tokens. Record the existing
   Google grant status, embedding caller/deployment state and migration level separately.
2. Build and test the reviewed images. Stop the old API machine **before** applying 0037; an old
   worker already in provider I/O cannot be safely fenced by a new image. Run migrations/queue
   installation using the existing staging machine's release mechanism with its API worker stopped.
3. Start the new API and deploy the web to its existing machine. Confirm readiness, retirement
   responses, catalogue, Google identity, shared tasks/stock/equipment/contacts, pending queues and
   the one-machine limit. Automatic deployment/backup workflows and production remain paused.
4. The old mail/note index has no caller after this release: stop the staging embedding machine
   and prevent automatic restart. Retain its deployment record until the infrastructure removal PR.
   Inspect/remove the obsolete Gmail Pub/Sub push subscription/topic and unused runtime settings
   deliberately; a 410 response can otherwise cause retries until the old watch expires. Do not
   revoke a Google grant on the user's behalf during deployment.
5. Old task-reminder and stocktake enablements remain **off**. An owner/admin must review the new
   definition and enable it; no automatic transfer of old parameters or authorisation is assumed.

Do not roll back to an old API image that can re-enable personal ingestion or execute retired
snapshots. Prefer a forward fix; an outage fallback keeps the API stopped. Database snapshots and
historical runs are retained for inspection; do not reconstruct enabled schedules from them.

## Later deletion authorisation

After #135 merged, the owner authorised deletion of all old-version Captain data. The
[optional-project/reset contract](optional-work-projects-2026-09.md) supersedes preservation as an
operational requirement. Migration 0037 remains immutable; the separate reset is run before it
and 0038 during cutover. Historical rendering remains defensive code, not a requirement to retain
legacy customer content.
