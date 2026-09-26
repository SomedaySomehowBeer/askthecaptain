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

## Demo usability correction (25 September 2026)

The first populated demo exposed missing direct checklist controls and a header that always
returned to section views. #138 established record APIs/forms, not visual or interaction parity
with the approved mockups. Its completion status above must not be read as design acceptance.

Checklist rows retain their detail links and add directly operable checkboxes. Checking completes
that item; unchecking reopens it. Each write uses the child's current revision, stays on the parent
page, and shows a confirmed state only after success. Pending writes disable the control; stale or
uncertain writes require a reload. Cancelled items remain readable and are reopened in their detail.

The header navigates **up**, independently of browser history: checklist item → parent task;
recurring occurrence → recurrence rule → project (when present); ordinary task → project;
project → Projects. Standalone work returns to Work. Task tags return to their task, and creation
from a project returns to that project. Section-level views retain the grouped view-list link.
Long parent names truncate visually but retain their complete accessible label.

Remaining mockup parity is a separate required delivery slice: compact record presentation and
primary completion action; task-list completion controls and due-date grouping; project overview,
cross-tag task context and linked scheduling. Chat, files and summaries remain planned capabilities,
not justification for omitting interactions already supported by the services. Visual acceptance
must compare populated screens with the approved references at phone and desktop widths, alongside
behavioural tests; successful CRUD tests alone do not establish it.

## Task and Work-list design alignment

The next increment implements the existing task.png/task-artwork.png/all-work.png references:
compact metadata and owner initials, a primary complete/reopen action, and secondary editors in
disclosures. The page has one accessible heading; plain record fields never impersonate generated
summaries. Evidence links stay visible; an empty evidence editor sits after the primary action.

Work, project and recurrence task rows have revision-aware completion controls with the same
confirmed/pending/stale/uncertain semantics as checklists. Completing a task may remove it from
an Open-filtered list; the current URL and filters remain unchanged. Required evidence is enforced
by the existing API for every completion control. Cancelled rows open to their detail to reopen.

Work groups the loaded page into Overdue, Due today, Tomorrow, Next 7 days, Later, No date,
Completed and Cancelled, using the organisation's timezone. An unavailable business date shows
recorded dates without relative urgency. Pagination remains explicit; group headings/counts must
not imply the rest of the database was loaded. Tasks/Projects use the approved segmented navigation.
Tag editing remains on task detail rather than adding a second action to every compact list row.

Remaining #142 work includes the project overview/schedule composition, complete filter/search
presentation and contextual equipment/chat sections as their real contracts become available.
This increment does not declare full mockup parity or build fictitious supporting records.

Confirmed row changes announce completion/reopening in a status region that survives row removal
or regrouping. Keyboard focus moves to that confirmation when it remains on the operated checkbox;
it does not interrupt someone who has moved to another control. The same behaviour applies to
checklists. Pending rows say Saving; refused evidence completion links to the task's source editor.

## Project overview and schedule alignment

Implement the existing project.png composition with Overview, Tasks and Schedule links. The
overview shows compact owner/state context, a bounded cross-tag open/in-progress task preview, and actual equipment
bookings. Tasks retains paged current/completed and cancelled work plus in-place completion.
Schedule lists this project's bookings in an explicit business-timezone window with pagination;
it links to the shared equipment timeline to inspect availability across every project. A filtered
project booking list never establishes equipment availability or implies the absence of conflicts.
No invented launch date, progress percentage, unconfirmed request, chat or file section is shown.
Description remains plain shared context; secondary editing/recurrence actions stay available.

`GET /projects/:projectId/reservations` authenticates active membership and reads under forced RLS
through the equipment service. It checks the project exists (including archived history), accepts
strict `from`, `to`, `offset`, `limit` parameters using the existing bounded reservation-window
validation, and returns confirmed reservations overlapping the window by occupied time (including
setup/cleanup), ordered by occupied start and ID. Each row includes its equipment name and archive
state. The response includes `nextOffset`, `from`, `to` and the organisation timezone. It never
returns other-project or cancelled bookings and is not an availability API. No schema change.

Overview previews label their bounds and link to full paged views. Owner/tag context comes from
authorised reads; unavailable reads render explicit failures rather than empty counts. Archived
equipment reservations remain visible. Browser checks cover all three project views, task completion,
project/task/reservation navigation, pagination, empty/failed reads and responsive populated screens.
Postgres tests cover tenant isolation, inactive members, archived/missing projects, interval bounds,
cancelled/other-project exclusions, deterministic paging and strict query validation.

The overview merges the first six open and first six in-progress tasks by due date then ID and
shows at most six. A failed source fails the preview; completed/cancelled/suggested history remains
in Tasks. Tags are shared organisation labels (migration 0035), not personal categories.

## Project task history follow-up (26 September 2026)

The project Tasks view defaults to Open, matching Work's default, with visible In progress,
Suggested, Completed and Cancelled filters. All except cancelled remains an explicit history view and preserves
suggested work. Each is an existing API status query, so completed rows cannot consume a page of
open results. A filter change resets pagination; completion/reopening keeps the chosen filter and
moves focus to the existing persistent confirmation if the row leaves it. Old cancelled URLs stay
valid; `status=all` explicitly selects the earlier mixed history. No saved-view vocabulary changes.
The schedule form uses the existing secondary button style so Show bookings reads as an action.

The overview’s Tasks links open All except cancelled, preserving access to both open and
in-progress work shown in its preview. Switching status clears previous action feedback.
