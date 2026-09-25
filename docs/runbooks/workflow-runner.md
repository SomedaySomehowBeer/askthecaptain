# Workflow runner (D19)

Current workflows: Task reminders v4 and Stocktake v3. Follow the
[retirement cutover](../plans/assistant-runtime-retirement-2026-09.md) for migration 0037: stop the old
API first, reuse one staging machine, and leave production paused. Old versions remain off until
an owner reviews and enables their replacements.

The API process runs pg-boss workers, one queue per workflow key. Set `WORKFLOWS_DISABLED=1` to
stop workers and new event runs; destination wake-ups and pending jobs remain durable. This flag is an operator stop,
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
12 connections in the business-data pool (the API configures 16): workers can each hold one advisory-lock
transaction while a separate short transaction executes a step. Locks are released at waits;
pg-boss reclaims interrupted jobs and sends exhausted jobs to the failure-journal worker.

Schedules use each organisation's timezone when enabled (save parameters again after changing the
timezone). A schedule points to a real queued next run, with a pinned definition and parameters.
Its first delivery atomically installs the next occurrence's run. A missed schedule catches up
once; duplicate deliveries replay the journal. Cancel replaces a future scheduled run while
keeping the recurring workflow on. Turning it off cancels those future runs and removes schedules.
Missing installed handlers disable Turn on and Run now with an explanation. No workflow is presented as working until its full registry exists.

## Step contracts and recovery

`Registry.registerStep(key, handler)` binds plain service functions. Database read/write handlers
receive `context.tx`; destination writes and journal completion commit together. Never open another
transaction inside a database handler. Use existing services' transaction functions and record
business audit events in that transaction. Every write gets a stable JSON tuple idempotency key:
`[organisationId, runId, path, itemIndex]`. Paths include all enclosing loop indices.

External handlers declare `retrySafe: true`: they must implement desired-state writes, provider
idempotency, or reconciliation using that key. A running journal row is the durable intent; success
is recorded after the response. Inference is data-only through
`inferenceStep` / `InferenceService.infer`; each attempt records real usage, so an interrupted response
can cost another inference call. Notify uses `notificationStep` / `PushService.send` with a stable tag
(the displayed notification is replaced; receipts can repeat). Never adapt a non-idempotent send as
a workflow write. These workflows do not draft or send correspondence.

Await handlers read destination state and return `{ready, key, output}`. An unresolved await saves
its deadline and delayed job in the journal transaction. After recording a stock count, the destination
service calls `engine.wake(tx, organisationId, runId, key)` **in that same transaction**. The run lock
closes the event-before-wait race; the destination read also recognises events arriving before the
await is reached. A timed-out wait fails with the step's name. Keep registry handlers compatible with unfinished pinned versions except explicitly retired versions,
which are cancelled and fenced before execution.

Activity links show every step, loop item, state and actionable pause reason. Fix inference sign-in,
runtime availability or the allowance, then Resume. Restore an enabling person's active membership
before resuming their work; a different administrator cannot silently replace that actor. Local writes
recheck active membership under a row lock. Cancellation serializes with local steps and prevents later
steps; an already issued provider request may finish, and its result is still journaled. Inspect its
intent/result before starting replacement work. Three retries exhaust to a named failure; raw provider
errors, mail and prompts never go into the platform queue. Tenant journals retain outputs under RLS.

## Task reminders

Chase-due v4 runs daily at 07:00 in the organisation's timezone. It requires a subscribed push
device for the enabling person. It has no Google, Xero, inference or email-drafting prerequisite.
Enable it in Settings → Workflows. Run now can send real task reminders; pushes link to Work.

The task read includes open/in-progress tasks due in the look-ahead window and older overdue tasks,
with a maximum of 100. Suggested, done, cancelled and undated tasks are excluded. Each task waits
independently, so a future task does not hold up another reminder. Reminder
readiness is the local date reaching `due − remindDaysBefore`; otherwise its timer is that date's
07:00. Escalation is ready on the day after due, with its future timer also at 07:00. Both waits
re-read current status/owner/due date, and notify checks again before pushing. Completion, deletion,
cancellation or removing a due date releases the wait without a notification. Moving a due date can
reschedule it, within the original 90-day timeout. A late notification whose due date moved is
skipped; the next daily run uses the new date. The reminder goes to the owner or, for an unowned task,
the enabling person; escalation goes to the enabling person. A removed owner requires reassignment.
Push uses a stable tenant/task tag, so repeated runs replace the visible notification; delivery
receipts can repeat. Notification failure pauses with instructions to check the recipient's device.


## Stocktake

See [Stocktake](stocktake.md) for current counts, reorder tasks and recovery.
