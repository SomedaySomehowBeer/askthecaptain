# Xero connection and accounting sync

Jobs: chase overdue invoices and prepare the money brief (plan §2 jobs 5–6; D6, D8, D16).
These are owner setup instructions. No app, secret or production deployment was created by this PR.

## Owner setup

1. In the [Xero developer portal](https://developer.xero.com/app/manage), create an OAuth app
   with **Auth Code with PKCE** and the business's app URL. Register the exact redirect URI
   `${API_URL}/connections/xero/callback` (HTTPS in production).
2. Set `XERO_CLIENT_ID` on the API's Fly app through the owner's secret-management process.
   Keep the existing `MASTER_KEY`, `API_URL` and `APP_URL` configuration.
   **Leave `XERO_CLIENT_SECRET` unset:** Xero's PKCE app type does not issue one. This deliberately
   follows the [current PKCE flow](https://developer.xero.com/documentation/guides/oauth2/pkce-flow/),
   as clarified with the owner, instead of the older client-secret wording in the brief.
3. The client requests `offline_access`, `accounting.contacts.read`, `accounting.invoices.read`,
   `accounting.payments.read`, and these read-only report scopes:
   `accounting.reports.aged.read`, `accounting.reports.balancesheet.read`,
   `accounting.reports.banksummary.read`, `accounting.reports.budgetsummary.read`,
   `accounting.reports.executivesummary.read`, `accounting.reports.profitandloss.read`,
   `accounting.reports.trialbalance.read`, `accounting.reports.taxreports.read`.
   These replace the brief's broad transactions/report scopes for
   [new apps created since March 2026](https://developer.xero.com/faq/granular-scopes).
   No accounting write scopes, contact writes, products or stock are requested.
4. Apply migration `0008_xero.sql` through the normal owner deployment procedure, then deploy
   the API and web app. Migration gaps 0007 and 0009 are reserved for other slices.
5. As an owner/admin, open **Settings → Connections → Connect Xero**, consent, then choose
   the Xero organisation to use in Captain. Even one available organisation is selected explicitly.
   Selection expires after ten minutes; start Connect Xero again if it expires. A member can read
   the connection and cached money, but cannot connect, select, sync or disconnect.
6. Choose **Sync now**. Confirm the selected name and completed sync time. Check authorised
   outstanding invoices and payments against Xero before relying on the cache for the first brief.

## Operation and honest states

- Every API process checks connected organisations on startup and every 15 minutes. Set
  `XERO_SYNC_DISABLED=1` to pause the schedule; manual Sync now remains available. Shutdown drains
  the active run. A fenced two-minute database lease serialises runs across processes.
- Accounting calls happen outside transactions. Pages contain at most 100 records; each page's
  cache writes commit together. Contacts, invoices and payments each have an `If-Modified-Since`
  cursor in `sync_cursors`. It advances only after all pages of that resource succeed, to the
  pre-fetch time minus one minute. A partial resource is replayed idempotently on the next run.
  Missing referenced contacts/invoices are fetched individually before their dependent records.
- Sliding 60-call/minute and 5000-call/24-hour budgets are persisted per selected tenant on the
  Captain connection, including failed requests. Minute waits renew the lease outside transactions.
  A 429 saves the provider's `Retry-After` deadline; manual and scheduled attempts refuse further
  provider calls until it expires. Other integrations and lower Xero plan quotas can still cause
  a 429. The next scheduled tick after the deadline resumes sync; it does not busy-retry.
- Every refresh locks the connection row and saves **both** rotated tokens in one transaction.
  Refresh failure commits `refresh_failed` and tells the person to reconnect. No HTTP response,
  audit detail or model input contains credentials or raw provider errors. Pending selection tokens
  are encrypted with the organisation's data key too, and erased when consumed or superseded.
- Reconnecting clears the old cache and sync cursors atomically and fences any in-flight old page.
  The completed sync time resets for the new grant. Rate budgets survive reconnecting.
- Disconnect clears local credentials even when remote revocation fails. It deletes the selected
  [Xero tenant connection](https://developer.xero.com/documentation/guides/oauth2/tenants/);
  revoking the entire refresh token would remove every tenant on that user's grant, potentially
  disconnecting another Captain organisation. If revocation cannot be confirmed, the card says to
  remove Captain under Xero's **Connected apps**. Cached records remain but reads return unavailable.
- Contacts link to one unambiguous exact company name and to a normalised exact email. A new email
  may create an imported contact. Existing names, phones, company assignments, notes and archived
  records are never overwritten. An absent `companies.external_refs['xero:<tenantId>']` records
  the provider contact id; existing reference values are preserved. Unmatched/ambiguous names remain
  unlinked. Archived Xero contacts stay in the accounting cache for invoice references.
- Payments on credit notes, prepayments and overpayments are outside this invoice-payment cache;
  they are counted as skipped. Deleted invoice payments are removed. Invoice balances come from
  Xero, not from summing payments. Contact customer/supplier flags reflect Xero's returned snapshot;
  Xero does not always change a contact's modification timestamp when those flags change.

## Read API contract

Authenticated members use `/v1/organisations/:id/xero/summary` and
`/v1/organisations/:id/xero/receivables?overdueDays=0&offset=0`.

Money is a decimal **string**, grouped by currency without currency conversion. Summary includes
`overdueReceivables`, `dueThisWeek` (receivables due today through Sunday), and `overduePayables`.
Dates use the Captain organisation's timezone. Receivables include only authorised ACCREC invoices
with a positive amount due, strictly before today and at least `overdueDays` days late, plus the
cached Xero contact name/email. Results have at most 1000 rows; follow `nextOffset` until null.
Paid, draft, voided and deleted invoices cannot enter these totals.

Both reads carry `connected`, `complete`, `lastSyncedAt` and an actionable `error` where needed.
A failed/running/never-completed sync is **not** a verified zero balance. Workflows must check those
fields and freshness before interpreting cached money. An unavailable connection returns `totals:
null`; successful empty cache totals are an empty currency list. Nothing appears on Today until
its brief slice (#22) consumes this contract.

## Verification

Fixtures exercise PKCE, tenant selection, rotation, revocation, pagination, conditional reads,
429 persistence, minute/day budgets, mid-page failure/replay, account replacement, money arithmetic,
roles and hand-edit preservation. Postgres tests verify forced RLS and composite foreign keys.
The production Connections page is checked with Playwright at phone and desktop sizes, including
signed-out 307, loading, missing configuration, selection, sync, failure and member restrictions.
Live Xero consent and data reconciliation require the owner's app setup and were not run here.
