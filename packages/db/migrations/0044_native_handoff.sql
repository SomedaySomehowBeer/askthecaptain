-- Native sign-in handoff (docs/plans/expo-mobile-foundation-2026-09.md §3, A1). A `native_handoff` is the
-- one-time code the web hands a mobile app at the end of Google and any passkey step-up. It is bound to the
-- app's PKCE challenge and attempt, and it is spent only at /auth/native/exchange. Platform table: no
-- organisation, no RLS; the existing app/captain_runtime grants on auth_requests already cover it.
-- 0021 re-added the check without a name, so Postgres named it auth_requests_kind_check again.
-- Every existing kind is kept.
alter table auth_requests drop constraint auth_requests_kind_check;
alter table auth_requests add constraint auth_requests_kind_check
	check (kind in ('oauth', 'session_exchange', 'google_connection', 'xero_connection', 'xero_selection', 'passkey_challenge', 'shopify_connection', 'native_handoff'));
