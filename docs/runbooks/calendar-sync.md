# Calendar sync

Job 3: Keep the calendar. D3 system housekeeping, D6 forced RLS, D8 first-party REST, D11 Calendar tab.

## Setup and operation

Google connections now request `calendar.calendarlist.readonly` alongside `calendar.events` and Gmail.
Existing connections need an owner/admin to reconnect and consent to the additional permission. The
Calendar tab explains this; token refresh cannot add a scope. No real Google credentials are used by tests.

The API checks connected organisations at startup and every five minutes. `CALENDAR_SYNC_DISABLED=1`
disables that schedule; owner/admin `POST /v1/organisations/:id/calendar/sync` still works. Members can
read `/calendar/calendars` and `/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD` (exclusive end). Dates
mean midnight in the organisation timezone; RFC3339 timestamps are also accepted. Ranges are limited
to 370 days. The API returns coverage and last-attempt status so an incomplete cache is never a quiet week.

Primary calendars always sync. Other calendars initially inherit Google's `selected` flag; subsequent
syncs preserve the stored selection. A calendar-selection editor waits for a later slice. Removed
calendars are removed from the cache after a complete calendar-list read. Account changes hide the old
cache immediately, and the next sync replaces it. Revoked/failed connections show the last saved copy.

## Cursors and failures

Events expand recurring instances (`singleEvents=true`). Initial sync reads 30 days back to 90 days
ahead. Incremental requests use only the saved sync token and compatible flags; `410 Gone` falls back
to a full replacement. A daily full sync advances the finite window, including unchanged recurring
occurrences. The UI shows a warning for weeks outside the confirmed window. All-day events keep
exclusive start/end dates; timed events use instants and render in the organisation timezone.

Each provider page is fetched outside a transaction, then committed under tenant context. The final
page alone advances `calendar.events:<internal-calendar-uuid>`. On failure earlier pages may already
be visible; the failed run is shown, the cursor remains retryable, and upserts/deletes are idempotent.
Full replacement clears the old cursor and coverage with its first page. Each page and run is audited
as system with counts only. Descriptions, attendees, tokens and provider errors are never logged.

`calendar.sync-lock` in `sync_cursors` holds a two-minute renewable lease. Each short write transaction
renews and verifies its random run id, and locks the connection against account replacement. A new
runner can recover an expired lease, while the old runner cannot commit or remove the new lease. This
works through transaction pooling without session advisory locks or an open transaction across HTTP.
The local scheduler also guards overlapping ticks and waits for active work before database shutdown.

Provider calls time out after 15 seconds. Calendar lists stop at 1,000 entries/100 pages; event reads
stop after 101 pages of at most 250 events. Hitting a bound is a visible failure, never silent truncation.
No API route calls the exposed event insert/patch client methods. Nothing sends an invitation here.
Preparation notes have an insertion point in each event card, with no fabricated content.

## Validation and references

Run `DATABASE_URL=postgres://postgres@127.0.0.1:32783/postgres flock /tmp/atc-build.lock pnpm test` and
`flock /tmp/atc-build.lock pnpm check`. Browser checks use local production Next.js, synthetic provider
responses and throwaway PostgreSQL. `/calendar` and `/settings/connections` must return signed-out 307s.

Provider contracts: [incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync),
[events list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list),
[calendar list](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list),
[event insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert) and
[event patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch).
