# Workflow runner (D19)

> **Scope, 25 September:** D19 infrastructure remains. Morning brief, invoice drafting and calendar preparation sections below describe legacy definitions. Revise or retire them under the current plan, including queued and waiting snapshots; they are not workspace onboarding.
> [Current plan](../plan.md) · [operational record](paused.md).

The API process runs pg-boss workers, one queue per workflow key. Set `WORKFLOWS_DISABLED=1` to
stop workers and event emission; pending jobs remain durable. This flag is an operator stop,
not a workflow switch. Settings → Workflows says the runner is stopped. Turning a workflow off
removes its schedules and stops subsequent steps; use Cancel to terminate a particular run.

## Release installation and manual fallback

Both API Fly configurations run the database migrations and then the idempotent queue installer
in their release step, before the new version takes traffic. `MIGRATION_DATABASE_URL` is already
configured on the app; deployments need no separate queue command. The API image includes
`packages/engine` and its dependencies, and its build checks the installer and engine imports.
**0013** contains runner support; **0012** contains the triage/outbox tables.
Migrations apply all missing files, including lower numbers delivered later.

For recovery outside the release step, apply the database migrations and run
`MIGRATION_DATABASE_URL=… pnpm --filter @captain/engine queue:install` using the migration-owner
connection. The installer safely reruns pg-boss **12.32.0** migrations, creates missing queues and
reapplies grants without replacing existing jobs or schedules. It installs metadata in
`workflow_queue`, workflow queues and a failure queue, and grants the non-bypassing `app` role
access. The running API uses `DATABASE_URL` with that app role, never the owner connection.
Production deployment and the manual fallback remain the operator's actions.

The worker refuses schema creation/migration at startup. If startup fails, the API stays available
and Workflows reports unavailable. Fix the queue installation and restart the API. Use at least
12 connections in the business-data pool (the API configures 16): five workflow workers can each hold one advisory-lock
transaction while a separate short transaction executes a step. Locks are released at waits;
pg-boss reclaims interrupted jobs and sends exhausted jobs to the failure-journal worker.

Schedules use each organisation's timezone when enabled (save parameters again after changing the
timezone). A schedule points to a real queued next run, with a pinned definition and parameters.
Its first delivery atomically installs the next occurrence's run. A missed schedule catches up
once; duplicate deliveries replay the journal. Cancel replaces a future scheduled run while
keeping the recurring workflow on. Turning it off cancels those future runs and removes schedules.
The generic runner ships before the domain handlers: missing catalogue keys disable Turn on and
Run now with an explanation. No workflow is presented as working until its full registry exists.

## Step contracts and recovery

`Registry.registerStep(key, handler)` binds plain service functions. Database read/write handlers
receive `context.tx`; destination writes and journal completion commit together. Never open another
transaction inside a database handler. Use existing services' transaction functions and record
business audit events in that transaction. Every write gets a stable JSON tuple idempotency key:
`[organisationId, runId, path, itemIndex]`. Paths include all enclosing loop indices.

External handlers declare `retrySafe: true`: they must implement desired-state writes, provider
idempotency, or reconciliation using that key. A running journal row is the durable intent; success
is recorded after the response. Gmail labels reconcile desired state. Inference is data-only through
`inferenceStep` / `InferenceService.infer`; each attempt records real usage, so an interrupted response
can cost another inference call. Notify uses `notificationStep` / `PushService.send` with a stable tag
(the displayed notification is replaced; receipts can repeat). Never adapt a non-idempotent send as
a workflow write. Outbound correspondence remains a person's action in the outbox (D5).

Await handlers read destination state and return `{ready, key, output}`. An unresolved await saves
its deadline and delayed job in the journal transaction. After recording sent/discarded, the destination
service calls `engine.wake(tx, organisationId, runId, key)` **in that same transaction**. The run lock
closes the event-before-wait race; the destination read also recognises events arriving before the
await is reached. A timed-out wait fails with the step's name. Keep registry handlers backward
compatible with pinned definition versions while their runs remain unfinished.

Activity links show every step, loop item, state and actionable pause reason. Fix inference sign-in,
runtime availability or the allowance, then Resume. Restore an enabling person's active membership
before resuming their work; a different administrator cannot silently replace that actor. Local writes
recheck active membership under a row lock. Cancellation serializes with local steps and prevents later
steps; an already issued provider request may finish, and its result is still journaled. Inspect its
intent/result before starting replacement work. Three retries exhaust to a named failure; raw provider
errors, mail and prompts never go into the platform queue. Tenant journals retain outputs under RLS.

## Morning brief (job 6)

Migration `0019_briefs.sql` and morning-brief version 2 make the 06:30 brief available. The release
step applies the migration and installs the queue as above. In Settings, verify the subscription
inference runtime, set a sufficient token allowance, and subscribe a device **as the person who will
turn on Morning brief**. Then enable it under Workflows and choose Run now for a first check.
Google and Xero are optional: disconnected, incomplete and truncated source data is explicitly marked.
The saved date and calendar window follow the organisation's timezone; push goes to the enabling
person, with the brief title and `/` (Today), using a stable replacement tag per run/step.

Today displays the latest saved brief first, with its date/time and links to Commitments, Inbox,
Calendar and Xero connection status. Invoice amounts retain their currency; no mail bodies enter
this inference. At most 100 items per source enter the brief. Items are selected by validated kind/id,
and code supplies their link labels/destinations. This is a snapshot: the source records may change.
A push receipt means the push service accepted it, not that someone read it. At least one accepted
push is required for notification success; other failed devices remain in the delivery journal.

If inference pauses, fix the runtime/login/budget and Resume in Workflows. If push fails, the brief
has already been saved and remains in Today. The queue retries only the unfinished push, with the
same tag; it does not redo successful inference or insert another brief. After retries exhaust,
check Notifications and use Run now for a new brief (and a new inference charge). An interrupted
inference response can also incur a second charge. Off, paused, failed and old-date states are shown
without presenting the last saved brief as today's summary.

## Chase what is due (job 5)

Chase-due version 2 runs daily at 07:00 in the organisation's timezone. It requires a connected
Google mailbox, connected Xero organisation, ready inference and a push device. Enable it in Settings
→ Workflows; Run now is a real run and can push reminders and create drafts. No migration or new
process is needed. The existing release installer registers its queue.

The task read includes open/in-progress tasks due in the look-ahead window and older overdue tasks,
with a maximum of 100. Suggested, done, cancelled and undated tasks are excluded. Each task waits
independently, so a future task does not hold up another reminder or the invoice drafts. Reminder
readiness is the local date reaching `due − remindDaysBefore`; otherwise its timer is that date's
07:00. Escalation is ready on the day after due, with its future timer also at 07:00. Both waits
re-read current status/owner/due date, and notify checks again before pushing. Completion, deletion,
cancellation or removing a due date releases the wait without a notification. Moving a due date can
reschedule it, within the original 90-day timeout. A late notification whose due date moved is
skipped; the next daily run uses the new date. The reminder goes to the owner or, for an unowned task,
the enabling person; escalation goes to the enabling person. A removed owner requires reassignment.
Push uses a stable tenant/task tag, so repeated runs replace the visible notification; delivery
receipts can repeat. Notification failure pauses with instructions to check the recipient's device.

The shared Xero cache read applies `chaseInvoicesAfterDays`. A missing/incomplete sync or more than
100 candidates pauses with an explanation; fix the source or narrow the window and start a new run.
Invoices with no contact email are skipped. Inference receives only labelled invoice data (number,
amount/currency, date, days overdue and contact), never credentials or tools. The outbox write checks
the current cached invoice and recipient again. Paid or changed invoices skip the write; the next
daily run reads them afresh. A saved cache is not live Xero: a person reviews the draft before Send.

Drafts use the existing outbox's tenant/run/step/item idempotency key, pin the connected mailbox,
and have no thread/reply headers. Open Inbox → Outbox to edit, save, send or discard. A workflow never
sends mail. Daily runs may make another draft for an invoice still overdue; discard unwanted drafts.
An interrupted inference can cost another call, but replay of a completed write reuses the draft.

For handler authors: `WaitResult.wakeAt` is a recheck time, distinct from the persisted timeout.
The queue timer and journalled next-check time commit in one transaction; identical rechecks do not
create duplicate timers. Only `each(..., { independent: true })` continues other items after a wait;
sequential loops and all pauses/failures still stop. Await output saved `as: 'item'` refreshes data for
following predicates. Never mutate the pinned input list. Activity shows next-check times in UTC,
actionable pause reasons and skipped-action explanations. Resume retries the same pinned run after
the runtime, budget, connection or device is repaired; Cancel prevents further steps.

## Calendar preparation

Migration `0020_calendar_notes.sql` adds local notes to the synced events. The release step applies it;
no extra queue, secret or resource is needed. With Google connected, Calendar and Inbox synced, and
inference verified, turn on **Prepare for tomorrow** in Settings → Workflows. It runs at 18:00 in the
organisation's timezone, or use **Run now** to prepare tomorrow immediately. Primary and selected
calendars are included, even when their Google access is read-only.

Calendar and Today show each saved paragraph and its preparation time. They also say when the workflow
is off or unavailable; existing notes remain dated. A Google event revision clears its old note.
If a run paused, follow its message, then Resume. If the event changed during the run, Activity explains
why the write was skipped; start a new run to read the new event. An older resumed run cannot overwrite
a newer run's note. Preparation reads at most ten recent threads' subjects/snippets, so it never proves
that nothing else is owed. All writes stay in Captain; the workflow makes no Google API call.

### One invoice chaser at a time

Chase version 3 adds **Wait this many days after sending before drafting another chaser**
(`chaseAgainAfterDays`, default 7, whole days from 1 to 365). Save the workflow's parameters to use
this version. A pending chaser, including an unconfirmed send, blocks another for that invoice.
Activity says which invoice already has a draft waiting. After sending, the interval is measured
from `sent_at` in elapsed 24-hour days. Discarding an unsent draft permits replacement, but does not
bypass the interval from a recent sent chaser. No workflow sends email.

Migration `0024_outbox_invoice.sql` links existing chasers using their run journals and keeps the
provider invoice id on new drafts, independent of editable subjects or invoice-cache row ids.
