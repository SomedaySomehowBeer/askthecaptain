# Gmail push notifications

> **Legacy assistant maintenance reference (25 September).** This describes code still present,
> not current Captain scope or workspace onboarding. Its old job/decision/plan-section references
> belong to the [historical plan](../plans/legacy-assistant-history.md). Do not enable this path
> as a prerequisite for Work/Chat/Resources; retirement does not wait for Pip. Follow the
> [implementation inventory](../plans/captain-workspace-migration-inventory-2026-09.md) for cleanup.
> This status note does not itself stop a running process or establish live enablement.

**Job 1: Triage the inbox as mail arrives.** This is system housekeeping (D3, D6, D8), not a
workflow. Gmail watches and Pub/Sub delivery supplement the existing five-minute mail poll.

## Owner setup — prepare these resources; do not run infrastructure changes from an agent

Use the **same Google Cloud project that owns Captain's OAuth client**. The `gmail-pubsub` service
account already exists there. No downloadable service-account key is needed.

1. In Google Cloud Console, enable Pub/Sub and create a topic, for example
   `projects/PROJECT_ID/topics/captain-gmail`.
2. On that topic, grant **Pub/Sub Publisher** (`roles/pubsub.publisher`) to
   `gmail-api-push@system.gserviceaccount.com`. If domain-restricted sharing blocks the grant, the
   project owner must arrange the documented exception.
3. Create a **push subscription** on the topic, with message wrapping enabled and endpoint
   `${API_URL}/webhooks/gmail`. Enable OIDC authentication using
   `gmail-pubsub@PROJECT_ID.iam.gserviceaccount.com`. Set its audience to the exact public endpoint
   URL, including its path; no trailing-slash changes.
4. The person creating the subscription needs `iam.serviceAccounts.actAs` on that service account.
   The Pub/Sub service agent `service-PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com` needs
   `iam.serviceAccounts.getOpenIdToken` (for example via **Service Account Token Creator**) on the
   push-auth service account. Check existing IAM before adding a grant.
5. Configure these **API** environment variables on Fly using the owner's deployment procedure:
   - `GMAIL_PUBSUB_TOPIC=projects/PROJECT_ID/topics/captain-gmail`
   - `GMAIL_PUSH_AUDIENCE=https://YOUR_API_HOST/webhooks/gmail`
   Set both together. With both absent, push is off. The expected OIDC email is derived from the
   topic project and fixed service-account name above; a different push-auth account is rejected.
6. Leave `MAIL_SYNC_DISABLED=0` for fallback polling. In **Settings → Connections → Mail updates**,
   an owner/admin can select **Start live mail updates**. Connected accounts also start automatically
   on the next maintenance tick. Members can read status but cannot start watches.
7. Send a test email through the owner's mailbox and check Inbox plus `mail.push_received`,
   `mail.push_processing`, `mail.push_processed` and `mail.synced` audit entries. A successful watch
   also immediately emits a notification. Do not log tokens or mail contents while diagnosing.

## Runtime behavior

- `POST /webhooks/gmail` requires a Google-signed RS256 OIDC bearer. Node crypto verifies the
  signature against Google's cached rotating public certificates, exact audience, issuer, expiry,
  issue time, verified email and the expected service-account identity. Unknown key refreshes are
  bounded; certificate outages return 503 so Pub/Sub retries. Invalid authentication returns 401;
  malformed envelopes return 400 and oversized bodies 413.
- A valid known-account delivery is committed to `webhook_events` under the Pub/Sub `messageId`
  before returning **204**. Duplicate IDs are acknowledged without starting more work. The payload
  contains only the account address and string history ID; notification/watch IDs never replace
  the actual mail-sync history cursor.
- Tenant matching reuses the narrow connected-organisation discovery function and checks each
  account under RLS. Unknown/disconnected accounts return 204 without storing anything. A mailbox
  connected to multiple organisations is ambiguous: push is ignored and those organisations
  continue polling. This avoids choosing an arbitrary tenant or changing the existing global
  provider-ID deduplication constraint. No migration is needed.
- A bounded asynchronous worker records `webhook_attempts`, calls `MailSync.run`, and marks events
  processed only after success. Notifications received during a run get a follow-up pass. Failed
  or overlapping runs remain pending; the minute maintenance tick retries them, including after
  restart. Up to 100 receipts are coalesced per pass. A process crash after receipt is safe because
  the event is durable. A crash during processing leaves an unfinished attempt and a pending event.
- Replaced/disconnected-account receipts are retired with an explicit ignored attempt. MailSync's
  existing database fence prevents simultaneous sync writers across API processes. All event,
  attempt and cursor writes use the normal tenant-constrained runtime role.
- The minute maintenance tick checks watches, renewing after one day or near expiry. Watch expiry,
  account, topic and the last error live in `sync_cursors` under `gmail.watch`; the Gmail history
  cursor remains independent. A watch response reports an epoch-millisecond expiry, normally up to
  seven days. Renewal failures appear in Settings and `mail.watch_failed`; polling remains available.
- No new package, migration, external queue or model call. No infrastructure was provisioned by this
  PR. `GmailClient.stop(token)` is available for explicit connector housekeeping; local disconnection
  continues to revoke credentials, excludes that account from renewal and ignores its notifications.

## Troubleshooting

- **401:** confirm the subscription uses the exact configured audience and the expected
  `gmail-pubsub` service account. A Google-signed token for another identity is deliberately rejected.
- **Watch failure / expired:** check the topic's project, Gmail publisher grant and OAuth access;
  reconnect Google if access was revoked, then start live updates again.
- **Pending receipts:** inspect attempts and Inbox. Overlap retries on the next minute; repeated
  provider errors need connection repair. Five-minute polling still collects mail if enabled.
- **Disable push:** remove both push variables together and remove/disable the subscription in the
  owner-controlled GCP project. Keep polling enabled. Existing Gmail watches expire unless renewed;
  disable/remove the subscription to avoid repeated delivery attempts to the disabled endpoint.

## Provider references

- [Gmail push setup, renewal, delivery and polling fallback](https://developers.google.com/workspace/gmail/api/guides/push)
- [users.watch and its response](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch)
- [Pub/Sub authenticated push and IAM](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions)
- [Google ID token verification and certificate caching](https://developers.google.com/identity/sign-in/web/backend-auth)
