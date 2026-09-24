# First workspace foundation: flat task tags

Jobs advanced: **own commitments**, **brief and answer**. This implementation is based on the
workspace adoption amendment, PR #116, and D7/D6. It is additive: no existing task or project is
renamed, duplicated or moved, and no old workflow is enabled/disabled by this slice.

## Behaviour

An active member can create or rename an organisation's tag and attach/remove it on an active
project's top-level task. All active member roles can do this, consistently with existing task
editing. Names are trimmed and limited to 60 characters; uniqueness ignores case within an
organisation. A rename retains the tag ID and records old/new names in the audit event.

Repeated PUT/DELETE of the same task/tag association changes it once and audits only that change.
The link records who first attached it. Checklist steps cannot have tags in this first slice.
Archived/proposed projects cannot be tagged or untagged; restore/accept the project first.

Examples, with the organisation and actual IDs substituted:

```text
POST   /v1/organisations/:id/tags                         {"name":"Production"}
PATCH  /v1/organisations/:id/tags/:tagId                  {"name":"Operations"}
PUT    /v1/organisations/:id/tasks/:taskId/tags/:tagId
DELETE /v1/organisations/:id/tasks/:taskId/tags/:tagId
GET    /v1/organisations/:id/tags?limit=50&offset=0
GET    /v1/organisations/:id/tasks?tagId=:production&tagId=:sales&ownerId=:you&status=open
```

The final query means **Production OR Sales**, AND assigned to you, AND open. `projectId` is also
supported. No tag filter means all tags, including untagged work. Dates, saved views, project tags,
inheritance and filter UI follow later. Cancelled work is hidden unless explicitly requested;
archived/proposed projects and checklist rows are excluded. Results contain the original task IDs,
current tags and `nextOffset` (null at the end), ordered by due date (missing dates last) then ID.
Offset pagination can move under concurrent edits; clients refresh the list after changes rather
than treating it as a stable historical cursor. Limits are 1–100, default 50.

This is the API foundation, not the new workspace UI or a replacement Commitments response.
No new dependency, model call, background task, provider connection or native client is introduced.

## Integrity

Migration `0035_task_tags.sql` creates only `tags` and `task_tags`, with forced RLS on both and
active membership required for reads/writes. The runtime role cannot bypass RLS. Task/tag/actor
foreign keys include `organisation_id`. A tag never grants access. The service locks active
membership through each transaction, so removal cannot race a person-scoped write. Task tagging
locks the task and active project; concurrent repeats serialize before checking whether an audit
is needed. Name collisions return 409, invalid input 400, inaccessible records 404.

Writes and audit events share the transaction. The tests deliberately fail an audit insert and
verify its tag insert rolls back. Export automatically discovers the new tenant tables; tests
exercise their inclusion and a seeded tenant's deletion cascade.

## Rollback and operations

The production pause in [paused.md](../runbooks/paused.md) remains in force. This slice was tested
only with local throwaway Postgres databases. It neither connects to Neon nor applies a production
migration. A live migration waits for the owner's verified backup/restore and resume decision.

Application rollback uses the previous API binary and **leaves the additive tables and their data
in place**. Existing API readers do not depend on these tables. Do not drop populated labels or
links to roll back a client feature. There is intentionally no destructive down migration; if
complete schema removal is later required, preserve the data and review a separate migration.
The test harness drops only databases it created for this suite. Migration replay idempotency is
covered by the database schema suite.

## Validation

The associated PR records actual results for strict workspace typecheck, database policy/migration
checks and API regressions against Postgres. Focused tests cover duplicate-name races, attach/detach
retries and audit counts, rename identity, OR/AND filter semantics, pagination, malformed inputs,
foreign task/tag references, spoofed link authors, membership removal, archived/proposed work,
checklist exclusions, audit rollback, export and tenant deletion.

No web page is touched, so there is no page-specific Playwright check in this slice. The three-tab
web/iOS shell and native device acceptance remain subsequent work. Claude's read-only review in
Monitor identified the tag-matching mismatch and checklist/audit refinements fixed before this PR.
