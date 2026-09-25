# Optional projects and removal of the Obligations fallback

Workspace outcome: create and schedule shared tasks and recurring work without an artificial
project. Implements #133 step 4 under D7; the bounded Work detail replacement remains step 5.

## Contract

- Task and series `projectId` is a UUID or null. Omitted on create means null; omitted on PATCH
  means unchanged; explicit null on PATCH removes the project. No organisation creation, read,
  task write or series write creates a project implicitly.
- Checklist items follow their parent's project, including null. The database compares nulls
  explicitly. A parent move carries its checklist; a child cannot move independently. An explicit
  mismatched project on checklist creation returns `400 step_project`, including null.
- Recurrence discovery and materialisation include standalone series. Changing a series' project
  affects future occurrences; existing tasks retain theirs. Completion evidence rules still apply.
- Work queries and tags include standalone top-level tasks. Named projects must still be active
  and tenant-accessible; null does not bypass membership or tenant isolation.
- An equipment reservation may link a standalone task with no project. A linked task and booking
  have the same project, null included. Moving a task moves its confirmed bookings' project links,
  increments reservation revisions and audits the change; cancelled bookings retain history.
  Time, equipment and occupied intervals do not change. Stale booking edits remain conflicts.
- Web creation defaults to **No project** unless the person explicitly supplied a project. The
  temporary detail handoff shows records without a project as a filtered group, with no synthetic
  project identity. Equipment choices include standalone tasks. Recurring forms have unique labels.

Migration 0038 makes the project columns nullable, updates checklist/series rules, removes the
reservation constraint requiring a project for every task link, and drops `projects.system_kind`.
It removes empty generated Obligations rows. It requires a migration-owner role with RLS bypass. It fails and rolls back the entire migration
if any foreign-key reference still targets a generated project. It neither migrates old tasks into the new workspace
nor deletes arbitrary task data. Stop the old API before reset/migration; old code is incompatible.

## Authorised legacy-data reset

On 25 September the owner explicitly said: “Tasks, emails, and anything else that is in the
database from old version of Captain can all be removed/deleted.” This supersedes the earlier
preservation proposal. No legacy task conversion, archived Obligations container or Pip dependency
is required. This is permission to remove Captain's stored copies, not provider originals.

Read-only staging inspection at 05:01:58 UTC found one organisation, 82 tasks in the sole generated
Obligations project, 659 mail messages in 502 threads, 266 attachment metadata rows, 2 outbox rows,
12 calendar events in 3 calendars, 236 contacts, 138 companies, 5 candidates and 5 candidate-source
rows, 12 workflow runs and 1,942 step rows. Tags, equipment, reservations, stock, Xero/Shopify caches,
notes and evidence were empty. This is a count audit, not a judgement about record contents.

`packages/db/scripts/reset-legacy-staging.ts` is a one-time operational command, never a migration
or startup hook. It checks `FLY_APP_NAME` against the staging app name and requires migration-owner access, exactly the audited
schema through 0036 and one organisation. It refuses named projects, business connections, or new
workspace/resource records. A preview reports counts and a digest; apply locks the tables and
requires that same manifest, including the organisation ID. That manifest ties apply to the inspected
database; the app-name check alone does not authenticate a database. Unexpected changes abort the
entire transaction.

It clears legacy task/project/series content, mail/calendar copies and metadata, drafts, personal
notes/answers/briefs, extracted text/vectors, imported contacts/companies, discovery, stored Google
mail/calendar tokens, sync/webhook state, old workflow enablements/runs/steps and queue jobs/schedules,
and old application audit payloads. No provider request, remote deletion or OAuth revocation occurs.
It clears code-defined workflow catalogue rows; the new API recreates current definitions disabled.
A new audit entry records the reset and counts without retaining source contents.

Accounts, Google identity sign-in, sessions, passkeys, organisation membership/settings, notification
subscriptions and inference configuration remain. Model usage and consumed budget totals remain
truthful; removing task history does not grant fresh inference spending. Mail-consent auth requests
are cleared separately from identity sign-in requests. Empty resource tables are not swept.

Run the preview and apply only with the old API stopped and autostart off, immediately before
migrations 0037/0038 and the reviewed new API release, on the existing sole staging machine:

```sh
node --import tsx /repo/packages/db/scripts/reset-legacy-staging.ts
node --import tsx /repo/packages/db/scripts/reset-legacy-staging.ts --apply <preview-digest>
```

A failed apply rolls back. A successful reset cannot be undone by rolling back code; do not deploy
the old assistant afterward. Production remains paused. Actual operations and validation results
are recorded in `docs/runbooks/paused.md`; this contract alone is not a claim that deletion ran.

## Remaining cleanup

The `/commitments` page and overview API remain temporary detail dependencies and must be replaced
with bounded Work task/project/series reads and revision-aware writes. This increment does not
rename that page and call #133 complete. Retired table definitions, old connector capabilities,
retrieval dependencies and deployment assets still need removal. Stocktake's explicitly configured
named Purchasing project remains a workflow parameter; it is not an Obligations fallback.
