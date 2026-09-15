# Support

Plan §11 Phase 4 asks for a support runbook before the second customer. This is what to do when a
person says Captain is not doing what they expect. Everything here is read from the product or the
database; nothing needs a code change. Never read mail bodies to answer a support question unless
the person has asked you to look at a specific thread.

## Where to look first

- **Settings → Workflows → Activity** (in the product, as the person): every run, its state, and the
  reason in words when it paused or failed. Most "Captain did nothing" reports end here.
- **Settings → Connections**: each provider's status. `needs attention`, `refresh_failed` or `revoked`
  means the person must reconnect; nothing downstream runs until they do.
- **Settings → Inference**: the runtime's state (`provisioning`, `needs sign-in`, `ready`, `failed`) and
  this month's token allowance and use. `budget spent` pauses every infer step until the month rolls
  or the allowance is raised.
- **The audit log** (`audit_events`, as the owner connection, filtered by `organisation_id`): who or
  what wrote what, when. System routines write as `actor_kind = 'system'`; workflow runs record the
  enabling person.

## Common reports

| The person says | Check | What to do |
|---|---|---|
| "Nothing arrives in the Inbox" | Connections → Google status; Inbox's last sync line; `audit_events` actions `mail.sync_failed` | Reconnect if the status is not `connected`; *Sync now*; if push is configured, *Start live updates* renews the watch. Polling every five minutes is the fallback. |
| "Triage says nothing needs me" | Workflows → Inbox triage is on and has runs; Inference is `ready`; allowance not spent | Turn it on; finish sign-in on the Sprite; raise the allowance. A run paused for `needs_login` resumes with *Resume* after sign-in. |
| "A draft was never sent" | Outbox on the Inbox tab | Nothing is sent by a workflow (D5); a person sends from the outbox. If *Send* failed, the thread page shows the reason; Gmail send needs the `gmail.modify` scope, which reconnecting restores. |
| "The calendar is missing a meeting" | Calendar → covered range and last sync; the account connected before the calendar scope was added must reconnect | Reconnect Google (the scope list grew in #14); *Sync now*. Events outside the 30-days-back/90-days-ahead window are not synced. |
| "A duty did not appear this month" | Commitments → the series is not paused and its project is not archived; `audit_events` action `task.materialised` | The materialise routine runs hourly; a paused series makes nothing. Editing the series materialises immediately. |
| "No morning brief" | Notifications → a device is subscribed; Workflows → Morning brief is on; push keys set on the API (Settings says if not) | Subscribe the device; turn the workflow on; the owner sets `WEB_PUSH_*` per `web-push.md`. |
| "Workflows are unavailable" | Settings → Workflows says the runner is stopped; API logs `workflow runner unavailable` | The queue schema is installed by the deploy's release step; if a deploy failed there, rerun it. `WORKFLOWS_DISABLED=1` is an operator stop. |
| "I cannot sign in" | `auth_events` (platform table) for the address: `auth.google.finish` with `success = false` and a reason | The Google account must have a verified email; an invitation must be accepted with the invited address. |
| "Too many requests" | 429 with `Retry-After`; `rate_limited` in the API's response | The per-address, per-person and per-organisation limits in `apps/api/src/ratelimit.ts`. A runaway client or script is the usual cause. |

## Doing things for a person

- **Re-sync** mail, calendar or Xero: the *Sync now* buttons, or `POST /v1/organisations/:id/{mail,calendar,xero}/sync` as an owner or admin.
- **Resume or cancel a run**: Settings → Workflows → Activity.
- **Export their data**: Settings → Your data → *Download everything* (owner or admin). Newline-delimited
  JSON, no credentials in it.
- **Delete their organisation**: only the owner, by typing its name, from Settings → Your data. It
  cannot be undone; the platform keeps a one-line record in `organisation_deletions`.
- **Restore lost data**: `backup-and-restore.md`. Neon's point-in-time history first.

## What you must not do

- Do not read or hand over provider tokens, sprite secrets or the master key; they are encrypted for
  a reason and support never needs them.
- Do not run a workflow's steps by hand against a provider; the outbox and the journal exist so that
  a person, not support, sends and decides.
- Do not edit `docs/plan.md` decisions to explain a behaviour; open an issue.

## Escalation

Issues go to the repository's tracker with the organisation id, the run id where there is one, the
time in the organisation's timezone, and what the person expected. A production incident (the gate
red, the API down, data wrong) is the owner's call to page on; Better Stack watches the API's health.
