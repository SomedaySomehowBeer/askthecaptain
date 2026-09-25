# Work record pages

Status: shipped in [#138](https://github.com/SomedaySomehowBeer/askthecaptain/pull/138),
25 September 2026. See the [staging release record](../runbooks/paused.md).
Outcome: **manage shared work**; supports **allocate resources**. Decisions D7, D11 and D25.
This amendment implements the existing task/project detail designs in
[the mobile view map](../proposals/assets/captain-mobile-2026-09-22/views.md).
It is not a chat, native-client or personal assistant increment.

## Navigation and behaviour

Work views links to Projects and Recurring work. Task rows, including cancelled tasks, open
`/work/tasks/:id`; projects and recurrence rules open `/work/projects/:id` and `/work/series/:id`.
Lists have explicit pagination, empty/failure states and create actions. Task details omit the
floating plus and show owner, due date, project (or No project), status, details, checklist, source
links and tags. Checklist items open as tasks, with their parent linked. Editing a checklist item
cannot move it independently from its parent. Finishing a parent completes its open checklist;
reopening does not silently reopen completed checklist items. Task completion does not confirm a
resource booking. Cancelled work can be read and reopened. Archived project history stays readable.

Project and recurrence pages list current/completed or cancelled tasks in separate views. Projects
can be archived/restored; recurrence rules can be paused/resumed. Editing a recurrence rule affects
future occurrences, including its evidence requirement; existing tasks keep their copied requirement.
No comments or private Notes store is introduced. Linked chat, shared pins and summaries remain a
separate delivery slice. A description is plain shared work context, not an inferred summary.

The old `/commitments` page is an authenticated compatibility redirect. Known task/project hash
links open their Work records; other links open Work. The old overview/forms are removed. Inventory
controls live under Resources; Settings uses a shared form component instead of importing legacy UI.
Tab restoration no longer remembers Commitments. No live user-created workspace data is deleted.

## Bounded contracts

All reads authenticate and check active organisation membership; RLS remains forced. New query
objects reject unknown parameters with 400. Only a changed owner must be an active member;
records assigned to someone who has left remain editable.

- `GET /tasks/:id` returns one task and bounded project/parent/series context. Checklist, evidence and
  tags have independent offsets and next offsets; page size is at most 50. Checklist rows do not
  embed their own evidence; open the item to read it. Cancelled/archived-linked tasks are readable.
- `GET /projects` pages active or archived projects, with optional name search; `GET /projects/:id`
  reads one project. `GET /series` pages rules by project/paused state; `GET /series/:id` reads one.
- `GET /tasks` accepts `seriesId` as well as existing filters. Explicit project/series reads include
  archived project history; ordinary Work still excludes archived/proposed projects.
- `GET /work/options` pages active projects and eligible top-level tasks independently, with bounded
  literal substring search; `projectId=none` narrows task choices to standalone tasks and a UUID
  narrows them to that project. Forms preserve a selected ID beyond the loaded page. A lookup failure
  must not clear an existing link. The API checks project/task compatibility on save.
- `GET /commitments` returns 410 after membership verification. The service's old overview helper
  may remain solely for tests; no runtime UI or API serves the aggregate.

## Writes and uncertainty

Migration 0039 adds integer revisions to tasks/projects/series and a database trigger that advances
revisions for every update, including workflow writes and cascades. PATCH requires `expectedRevision`;
a mismatch returns 409 `stale_revision`. There is no legacy bypass. Checklist creation requires
`expectedParentRevision` and advances the parent. Editing a checklist item advances that item, not its parent; parent status/project cascades
advance each changed child.
Tags are separately idempotent links and do not change the record revision.

Evidence add/remove requires the task revision, locks the task and advances it. Completion uses the
same lock and checks evidence after acquiring it. The last required evidence cannot be removed from
a completed task. New evidence uses deliberately shared links/file references; retained historical
mail evidence does not revive mailbox ingestion. Creating new mail evidence returns 400
`evidence_kind_retired`. Migration 0039 copies each series evidence rule
onto existing occurrences before enabling revision triggers; subsequent occurrences copy at creation. The series routine holds share locks on the rules it
uses so concurrent pauses/edits serialise with occurrence creation. Concurrent project archival may
still admit that period’s occurrence; it does not create duplicates or expose archived work in the
default Work list.

A stale save keeps entered values and asks for a reload. An uncertain save locks the form and links
to saved records for inspection. Creates without an idempotency contract are not automatically
retried. Equipment retains its existing request-ID/revision contract. Successful writes invalidate
Work and relevant resource data; one record's revision cannot authorise editing another tenant.

## Acceptance

Real-Postgres checks cover bounded reads, tenant/member isolation, missing records, concurrent/stale
writes, checklist and booking cascades, evidence/completion races, search/pagination and future-only
recurrence rules. Browser checks must exercise create/edit/reopen, checklist, evidence, project and
recurrence controls, stale/uncertain saves, off-page options, Resources links, old-link redirects and
phone/desktop layouts. Typecheck, repository tests, reciprocal review and CI precede merge. Staging
gets migration 0039 and the reviewed images on its existing single API/web machines. No reset is
run; production and the retired embedding worker stay paused.
