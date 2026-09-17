# Gmail sync

Job 1: collect mail so Captain can triage the inbox. This slice does not run inference or send mail.

The API checks connected Google organisations at startup and every five minutes, sequentially. Set
`MAIL_SYNC_DISABLED=1` on the API to pause automatic checks; owners/admins can still use **Inbox → Sync
now**. Tests use injected Gmail responses and throwaway Postgres databases. Never log response bodies,
mail content or credentials while diagnosing a failure.

- Initial sync and expired-history recovery use Gmail's `after:<epoch>` message-date search for the last
  30 days, paging up to **500 threads**. Gmail has no equivalent search for arbitrary label-only
  modification dates; older mail can subsequently arrive through history changes. The limit is shown
  in Inbox when reached. A full recovery replaces the cached window; incremental sync keeps earlier
  collected threads until Gmail reports deletion.
- The history baseline is captured before listing recent mail, so arrivals during the initial pass
  are replayed by the next incremental pass. History pages are exhausted before advancing the cursor.
  A Gmail history 404 starts a full recovery. Provider requests run outside database transactions; each batch commits up to 25 threads and their
  contact updates. Other failures retain completed batches and leave the history cursor unchanged.
  A content-free `mail.sync_failed` audit records committed counts; retry replays idempotently from
  the prior history cursor (or recent-mail listing for an unfinished first sync). Full-recovery
  removal of absent threads waits until the run succeeds. Retry with **Sync now**.
- `mail.synced` records system counts and whether the pass was full or capped. Each organisation has an
  in-process overlap guard plus a two-minute, renewable `gmail.sync-lock` lease in `sync_cursors`,
  matching Calendar's transaction-pool-safe pattern. Each short transaction retakes the advisory
  lock, checks lease ownership, the connected account and the original history cursor. A replaced or
  expired lease fences the old runner out; a stopped process's lease can be reclaimed after two
  minutes. Provider calls renew the lease individually, even within a slow batch. Token refresh
  uses its own connection row lock. `mail.batch_synced` journals each committed batch;
  `mail.sync_started` keeps incomplete first-sync/recovery data explicitly labelled in Inbox.
- The scheduler discovers only connected organisation IDs through `gmail_sync_organisations()`, a
  narrow security-definer function. Mail reads and writes then run as the normal RLS-constrained app
  role with tenant context. No mail or credentials are returned by the discovery function.
- Plain text is preferred over HTML alternatives. HTML is converted to text and always rendered as
  text, never HTML. Attachment metadata is saved; attachment data is never decoded or persisted and
  the attachment-download endpoint is never called. An external body unavailable in the full thread
  response is stated as unavailable, with instructions to read it in Gmail.
- Revoked/failed connections need reconnection in **Settings → Connections**. Cached mail is labelled
  as the last saved copy while access is unavailable; a disconnected/replaced account's cache is not
  exposed as the current account's mail.

## Diagnosing a failed sync

The API never logs mail, provider bodies or credentials, so a failed run is read from the Inbox card
(or `audit_events` action `mail.sync_failed`, field `detail.failure`), not from Fly logs. The card ends
with a reference such as `Reference: fetch · google · 403 · accessNotConfigured.`:

- **stage**: `access` (token refresh), `profile`, `labels`, `history`, `recent` (30-day listing),
  `fetch` (one thread), `save` (a 25-thread batch), `contacts` (contact upkeep inside that batch) or
  `finish` (cursor advance and reconciliation). Committed batches survive whatever the stage.
- **kind** `google` with the HTTP status and, when Google gives one, its documented reason:
  `accessNotConfigured` means the Gmail API is not enabled in the Google Cloud project that owns the
  OAuth client (first-deploy step 5); `insufficientPermissions` or a bare `403` means the grant lacks
  `gmail.modify` and the owner must reconnect; `domainPolicy` is a Workspace admin block;
  `userRateLimitExceeded`, `rateLimitExceeded`, `dailyLimitExceeded` or `429` wait for the next check;
  `401` or `authError` needs a reconnect; `5xx` is Google's; status `0` with `timeout` (15 s, 30 s for a
  whole thread), `network` or `unreadable` (a response Captain could not parse) is worth one retry.
  `account_changed` and `too_many_pages` are Captain's own guards.
- **kind** `database` with the SQLSTATE only, for example `22021` (an unrepresentable byte), `23505`
  (a duplicate key), `40001` (serialisation) or `57014` (statement timeout). Retry once; if it repeats
  on the same stage, open an issue with the reference and the organisation id, never the mail.
- **kind** `other` with the JavaScript error name, for a bug in Captain.

Since #64 one message with a charset the runtime does not know is read as UTF-8 and NUL bytes are
stripped before saving, so a single odd message no longer stops the whole mailbox.

Gmail Pub/Sub push and daily watch renewal are documented in [gmail-push.md](gmail-push.md).
Attachment text extraction, triage and outbox remain later slices.

Provider contracts: [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync),
[history.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list),
[threads.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get).
