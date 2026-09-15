# Connect Shopify (owner runbook)

Jobs: **Own commitments** and **Brief**. Captain reads shop stock and orders; Shopify remains
responsible for quantities. This runbook prepares the owner's setup; no production app or secret
has been created by this change.

Migration `0021_shopify.sql` follows the passkey migration and preserves all existing OAuth kinds,
including `passkey_challenge`.

## Create the app

1. In Shopify's **Dev Dashboard**, create a standalone app with **custom distribution** for the
   customer's shop. Use the OAuth client ID and secret from that app, not an admin-created custom
   app token. Set the app URL to Captain's web URL and allow this exact redirect URI:
   `${API_URL}/connections/shopify/callback` (HTTPS in production).
2. Grant `read_products,read_inventory,read_orders,read_customers`. Obtain the applicable protected
   customer data access for order/customer names and emails. Missing access can make GraphQL return
   errors; Captain will say sync failed instead of reporting a complete summary.
3. Configure `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` together through the owner's existing
   secret-management procedure. Captain also needs its existing `MASTER_KEY`, `API_URL` and `APP_URL`.
   Do not put any of these secrets in source, screenshots, logs or a model input.
4. Use non-expiring **offline** access for this custom-distribution app. Captain omits online grant
   options and exchanges the code with `expiring: 0`; it rejects online or expiring token responses.
   It encrypts the token under the organisation's wrapped data key. There is no refresh routine.
   This setup is for custom distribution: Shopify's public-app expiring-token requirements need a
   separate implementation, not a change to these environment values.
5. In **Settings → Connections → Shopify**, an owner/admin enters the shop's permanent
   `your-shop.myshopify.com` domain, without `https://` or a path, and chooses **Connect Shopify**.
   The browser first visits Captain's API to set its short-lived nonce cookie, then Shopify.
   Allow the scopes and return to Captain. The callback checks HMAC, cookie, one-use state, shop,
   expiry and the person's current role.

See Shopify's [standalone OAuth guide](https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps)
and [access-token guidance](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens).

## Check the first sync

Choose **Sync now**. Check the completed-sync timestamp, then **Commitments → Stock → Shop stock**.
Active and unlisted products appear in shop stock; drafts and archived products stay hidden.
See Shopify’s [product statuses](https://shopify.dev/docs/api/admin-graphql/latest/enums/ProductStatus).
Compare a known variant and location with Shopify's available quantity. Untracked inventory and
missing quantities are stated explicitly. Set a reorder point and verify the quantity stays the
same. Members can read stock and set thresholds; only owner/admin can manage or manually sync the
connection.

The API process checks products, inventory locations and orders every 15 minutes, with no extra
process. `SHOPIFY_SYNC_DISABLED=1` pauses the automatic checks; manual sync remains available.
Pages are bounded, and a fenced lease prevents overlapping runs. Provider requests run outside
transactions. GraphQL cost/restore-rate information and HTTP 429 responses persist a cooldown;
long pauses end the run with a retry time. A failed or interrupted run remains visibly incomplete,
retains its last completed timestamp, and does not advance the order cursor.

Order details are incremental by `updated_at`, with a one-minute overlap. A full product/location
snapshot and an order-ID sweep remove records missing from Shopify only after traversal succeeds.
Orders cover the accessible **last 60 days**; this app does not request `read_all_orders`.
`GET /v1/organisations/:id/shopify/summary` counts today/week in the organisation's timezone,
excludes cancelled orders, and keeps monetary totals separate by currency. Its unfulfilled count
covers the same window, including partially fulfilled orders, not the shop's lifetime backlog.
Do not interpret incomplete cache results as a quiet trading day.

A separate `shopify_reorder_points` table owns person-entered thresholds per variant, applied
separately at each location. Provider rows never become counted `stock_items`. Reconnecting the
same shop retains thresholds; switching shops clears the old cache and thresholds. Removed
variants lose their thresholds after a complete snapshot. Organisation export includes these
four tenant tables and deletion cascades through them.

## Troubleshooting and disconnect

- **Not configured:** check both Shopify variables and the existing master key, then restart via
  the owner's deployment process. **Failed callback:** start Connect again; check the exact redirect
  URI, requested permissions and browser cookies.
- **Access refused:** reconnect and check app/data permissions. **Rate limit:** wait until the
  displayed retry time. Repeated **Sync now** clicks honour the persisted cooldown.
- **Disconnect Shopify** clears local credentials even if Shopify is unavailable. If uninstall
  could not be confirmed, remove Captain in Shopify's Apps settings as the UI requests. Local
  cached rows remain hidden while disconnected and are covered by organisation export/deletion.
- Admin GraphQL is pinned to **2026-07**. Review Shopify's schema/version schedule before its
  support window ends. See [API limits](https://shopify.dev/docs/api/usage/limits).

Validation uses injected provider fixtures and a throwaway Postgres database. The owner still
needs to perform the real app installation and compare real shop data; this runbook has not been
executed against Shopify.
