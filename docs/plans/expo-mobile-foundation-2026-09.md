# Expo mobile foundation: native sign-in, secure session and first authenticated reads

Status: **adopted in #183 after reciprocal review**, 27 September 2026.
Assignment: [next batch, 27 September](captain-next-batch-2026-09-27.md). Tracking:
[#178](https://github.com/SomedaySomehowBeer/askthecaptain/issues/178). Delivery slice 2 of the
[delivery plan](captain-workspace-delivery-2026-09.md). Outcomes: **manage shared work**, **allocate
resources** and **discuss work**, on iPhone first with early Android checks.

The [plan](../plan.md) is authoritative. It names `apps/mobile` (§4), passkeys as a required second
factor (§9) and secure sessions/links as an open mobile question (§14). This contract authorises three kinds of change:

- an extension to authentication: a native handoff kind, a new route, a default-off enablement flag
  and one migration;
- new client dependencies;
- a new application package.

No existing decision D1–D26 changes. Under AGENTS.md, a package, dependency or migration the plan does
not name needs a plan amendment in the same PR. The adopting PR added a pointer to this
contract in plan §4 and §14, and named the dependencies.

The document keeps four kinds of statement apart:

- **Repository fact:** read from `main`, with a file reference.
- **Proposed change:** code, a migration or a dependency that a named PR adds.
- **Platform question:** behaviour that root verifies against current official documentation (§11).
- **Device/build evidence:** exports, simulator builds, real-device runs and signed builds, recorded
  separately (§10). This contract claims none of them.

**Implementation status.** A1 (#186) is merged and adds the API handoff, default-off `NATIVE_SIGN_IN` flag and
migration 0044. A2 (#187) is merged and adds the web callback/passkey branches and a synthetic browser proof using the
real API, disposable Postgres and a virtual authenticator. The proof intercepts the custom-scheme
destination; it does not establish that an installed app receives it or that a platform authentication
session closes. The M-shell increment adds `apps/mobile` with Work/Chat/Resources, grouped view lists,
SDK 57 dependencies, boundary checks and signed-out states. Three-platform JavaScript exports,
a browser approximation at 360/390/430 pixels and generated Android backup configuration are
verified; there is no signed native build or device evidence, nor mobile authentication or business
reads yet. Browser history differs from native stacks and cannot prove native back gestures. Keep the flag off on shared
staging and for real accounts until the verified-link gate passes. These increments have not been
released to staging and migration 0044 has not been applied there. The repository facts below
describe the baseline audited for this contract; §§3 and 9 define the additions and remaining work.

## 1. What exists today (repository facts)

**Sessions.** `AuthService` (`apps/api/src/auth/service.ts`) issues an opaque token: `sess_` followed
by 32 random bytes. Only the token's SHA-256 hash is stored in `sessions` (`0001_foundation.sql`),
together with `expires_at`, `revoked_at` and `passkey_verified_at` (`0018_passkeys.sql`).

- The TTL is fixed at `SESSION_TTL_DAYS`, default 30 (`apps/api/src/env.ts`). There is no refresh
  token and no sliding expiry.
- `requireSession` refuses a missing, unknown, revoked or expired token.
- The signed-in router accepts only `Authorization: Bearer sess_…` (`apps/api/src/app.ts:46,120`).
- The API sets no cookie. The web keeps the token in its HttpOnly `captain_session` cookie and
  forwards it as a bearer (`apps/web/src/lib/session.ts`).
- `POST /auth/sign-out` revokes only the token presented. No route lists sessions or revokes other ones.

**Google sign-in.**

1. `GET /auth/google/start?return_to=` stores an `oauth` auth request: the state hash, a nonce, the
   Google PKCE verifier and the checked return path, expiring in 15 minutes.
2. It redirects to Google with `prompt=select_account` (`apps/api/src/auth/google.ts`).
3. Google returns to the **API** callback, which consumes the state and verifies the id token's
   audience, issuer, nonce and verified email.
4. The API creates a two-minute `session_exchange` code and redirects to the **web**
   `/auth/callback?code=`.

The session token never appears in a redirect URL.

**Passkey step-up.** `exchange()` spends the code. If the person has at least one passkey
(`PasskeyService.required`), it returns `{ stepUp, token: pks_… }` instead of a session.

- The web `/auth/passkey` page (`StepUp.tsx`, `@simplewebauthn/browser`) fetches assertion options and
  posts the assertion to `/auth/passkey/verify`.
- Only then does `completeStepUp` issue a session with `passkey_verified_at` set.
- The current verifier configuration, `simpleWebAuthn(APP_URL)` in `apps/api/src/auth/webauthn.ts`,
  sets `rpID` to `APP_URL`'s hostname and `expectedOrigin` to `APP_URL`'s origin. Today the API
  therefore accepts only an assertion whose client data carries that exact origin. A page served from
  the web app produces one.
- Platform-native passkey APIs report other origins; on Android, for example, an app-signature
  origin. They would need a changed verifier configuration and associated-domain setup. This contract
  does not change the verifier.

**Return paths.** `safeReturnPath` (`apps/api/src/auth/return-path.ts`) and the web's `safeReturn` /
`appReturnUrl` (`apps/web/src/lib/session-state.ts`) accept only a same-origin path. They refuse:

- a leading `//`;
- a backslash anywhere;
- control characters;
- dot-segment escapes;
- anything longer than 2048 characters.

The API checks the value when it arrives and again when it reads it back from storage. The web checks
it again where it redirects.

**Short-lived secrets.** `auth_requests` is a platform table without RLS. `packages/db/test/schema-policy.test.ts`
lists it with `sessions` and `passkeys`.

- Its `kind` check currently allows `oauth`, `session_exchange`, `google_connection`,
  `xero_connection`, `xero_selection`, `passkey_challenge` and `shopify_connection` (`0021_shopify.sql`).
- Consumption is one atomic `update … where consumed_at is null and expires_at > now()`.
- Every auth outcome is written to `auth_events`, and `/auth/*` is rate-limited per address.
- **Existing non-atomicity:**
  - `exchange()` and `completeStepUp()` consume in one statement, then insert the session and the
    event in later, separate statements.
  - `PasskeyService.completeStepUp` also updates the counter separately.
  - A failure between those statements can leave a code spent with no session. It cannot leave a
    session without a spent code.
  - The web path is unchanged by this contract. The new native path must be atomic (§3.3).

**Organisation context.** Every tenant route is `/v1/organisations/:id/…`, and `roleOf`
(`apps/api/src/tenant.ts`) answers **404** without an active membership. The web chooses the
organisation from a `captain_organisation` cookie, falling back to the first membership in `GET /v1/me`.

**Failure classification.** The web ends a session only on a confirmed 401. An unreachable API, a
rate limit (429) or a server failure keeps the session and shows a retry state (`sessionFailure`, #130).

**Existing reads.** All are bounded and paginated, and the web already uses them.

| Use | Endpoint |
|---|---|
| Identity and memberships | `GET /v1/me` |
| Work list, My work (`ownerId`, `status`, `tagId` up to 20, `projectId`, `offset`, `limit` up to 100) | `GET /v1/organisations/:id/tasks` |
| Task, project and series detail | `GET …/tasks/:taskId`, `…/projects`, `…/projects/:projectId`, `…/series/:seriesId` |
| By tag and private saved views | `GET …/tags`, `GET …/views` |
| Conversations (`filter=all\|unread\|starred`, `linked`) and item conversations | `GET …/conversations`, `…/tasks/:taskId/conversations`, `…/projects/:projectId/conversations` |
| Messages, pins, catch-up | `GET …/conversations/:cid/messages`, `…/pins`, `…/changes` |
| Equipment and occupancy | `GET …/equipment`, `…/equipment/:eid/reservations`, `…/projects/:pid/reservations` |
| Counted stock | `GET …/stock` |

**Design authority.**

- `packages/ui` exports only the unedited legacy `design/` mirror (`packages/ui/package.json`) and has
  no React Native tokens.
- The [mobile mockups](../proposals/assets/captain-mobile-2026-09-22/README.md) are the approved design (D14).
- The [client proof](../proposals/assets/captain-client-proof-2026-09-23/README.md) is a fictional
  harness installed with npm, outside the workspace. It passes bundle exports and has had no
  native-device run. Its versions (Expo 57.0.24, React 19.2.3, React Native 0.86.3, as of 23 September)
  are not a pin for this work.

## 2. Sign-in choice

**Chosen: run the whole existing flow in the platform's authentication browser session, and end it
with a one-time native handoff code. The code is bound to an app-held PKCE verifier and an attempt ID.**

This follows RFC 8252 (<https://www.rfc-editor.org/rfc/rfc8252>):

- an external user agent, never an embedded WebView (§8.12);
- a code bound to its requester with PKCE (§8.1), so an intercepted private-use-scheme redirect
  (§7.1) is useless without the verifier;
- a reverse-domain private-use scheme (§7.1).

Expo's authentication guide (<https://docs.expo.dev/guides/authentication/>) requires a
**development build**, not Expo Go, for a stable native redirect. `expo-web-browser`'s
`openAuthSessionAsync` (<https://docs.expo.dev/versions/latest/sdk/webbrowser/>) provides the session:
`ASWebAuthenticationSession` on iOS and a Custom Tab on Android.

Why this is the smallest secure flow:

- **Google is unchanged.** It still returns only to the existing API callback, in a browser. There is
  no native Google client ID, no Google SDK and no new redirect registered with Google.
- **The passkey is unchanged.** The step-up runs on the existing `/auth/passkey` page, so the current
  verifier configuration accepts it. Whether passkeys work inside these browser sessions is device
  proof Q6.
- **The session model is unchanged.** Same token format, hash, TTL, revocation and bearer. The token
  reaches the device only in a TLS POST response body.

**Limitation of a private-use scheme (r3).** PKCE and the attempt ID protect a legitimate attempt
whose callback is intercepted: the interceptor lacks the verifier. They do **not** stop this attack
(RFC 8252 §8.6, client impersonation):

1. A malicious app installed on the person's device registers `app.askthecaptain.dev`.
2. It starts its own native sign-in with its own verifier and attempt.
3. The person completes the genuine Google and passkey steps on the genuine Captain pages.
4. The malicious app receives the callback and exchanges it with its own verifier, obtaining the
   person's session.

A private-use scheme gives no app-identity binding, so this attack is an account takeover.

**Root decision.** The private scheme is only for isolated development and proofs with synthetic
accounts. `NATIVE_SIGN_IN` stays **off** on shared staging and for every real account until one of
these is delivered and has passed the §10 link-association gate:

- a claimed HTTPS redirect (iOS Universal Links, Android verified App Links) whose association
  binds `app.askthecaptain.app` to the signed Captain app;
- or a separately reviewed binding of equal strength.

Nobody is asked to accept the takeover risk. The API, web, shell and tests proceed with the flag off.

Rejected for the foundation:

- **Native Google or passkey SDKs.** They need new client IDs, entitlements, verifier origin changes
  and more dependencies.
- **Embedded WebView.** RFC 8252 §8.12 rejects it.
- **Token in a URL.** Breaks the batch boundary.
- **Universal Links/App Links deferred to a later step.** They need hosted association files and
  signing identities. Only the callback URL constant changes; the API binding stays the same. They
  are **required before real-account use** (see the limitation above and §10), not optional later
  polish.

## 3. Handoff protocol (proposed API/web change)

### 3.1 Identifiers the app creates for each attempt

- `verifier`: 32 random bytes, base64url (43 characters).
- `challenge`: base64url(SHA-256(verifier)).
- `attempt`: 32 random bytes, base64url. This is the client state value.

All three live only in memory for the single pending attempt. They never go into storage or logs.
The verifier never appears in a URL; the challenge and attempt are not secrets.

### 3.2 Flow

1. **App → system browser:** `GET {API_URL}/auth/google/start?client=native&code_challenge={c}&code_challenge_method=S256&attempt={a}[&return_to={path}]`.
   - The API accepts this only when **`NATIVE_SIGN_IN=1`** (§3.4).
   - It requires `code_challenge` and `attempt` to match `^[A-Za-z0-9_-]{43}$` and the method to be
     `S256`. A `return_to` must pass the unchanged `safeReturnPath`.
   - Otherwise it answers 400 before storing anything or redirecting. It also refuses native
     parameters without `client=native`.
   - The `oauth` payload gains `native: { challenge, attempt }`.
2. **Google → API callback** is unchanged. `finishGoogle` copies `native` into the `session_exchange`
   payload and redirects to the web `/auth/callback?code=`.
3. **Web callback → `POST /auth/session/exchange`.** For a native payload the API never issues a
   session, and it rechecks `NATIVE_SIGN_IN`. If the flag is off, it fails closed with 401 and the
   code `native_sign_in_disabled`.
   - **Passkey registered:** `beginStepUp` stores `native` in the step-up payload. The API returns
     `{ stepUp: true, native: true, token, returnTo }`. The web goes to `/auth/passkey?token=…&native=1`.
   - **No passkey:** the API atomically consumes the exchange code and inserts a `native_handoff`
     request. That request expires in two minutes and carries `{ challenge, attempt, returnTo,
     passkeyVerified: false }`. The API returns `{ nativeHandoff: code, attempt }`.
4. **Passkey step-up:** the ceremony is unchanged. For a native step-up token, `completeStepUp` returns
   `{ nativeHandoff: code, attempt }` with `passkeyVerified: true`. It does this in one transaction
   (§3.3) and issues no session.
5. **Web → app:** the web navigates to the **checked-in constant**
   `app.askthecaptain.dev:/auth/callback?code={x}&attempt={a}`.
   - The target is a constant, never a request parameter or environment value.
   - The web sets no cookie on this path.
   - The web server sees `x` and `a` but never the verifier.
   - A later release scheme is added only by a reviewed code change (§5, Q7).
6. **App receives the callback.** It accepts the URL only if all of these hold; anything else is
   ignored:
   - it is the return value of the pending `openAuthSessionAsync` call;
   - the scheme is exactly `app.askthecaptain.dev`, with an empty host and the path `/auth/callback`;
   - the query contains exactly one `code` and exactly one `attempt`, and nothing else;
   - `attempt` equals the pending attempt.
7. **App → `POST /auth/native/exchange` with JSON `{ code, verifier, attempt }`.** This route sits under
   the `/auth/*` rate limits and requires `NATIVE_SIGN_IN=1`. The API returns
   `{ token, expiresAt, user, returnTo }` (§3.3).

### 3.3 Atomic native exchange

All of `/auth/native/exchange` runs in **one database transaction**:

1. Select the `native_handoff` row by `token_hash`, with `consumed_at is null and expires_at > now()`,
   `for update`.
2. Mark it consumed.
3. Compare, in constant time, base64url(SHA-256(verifier)) with the stored challenge and `attempt` with
   the stored attempt.
4. **Mismatch:** insert an `auth.native.exchange` failure event, then commit, so the code is burned.
   Answer 401.
5. **Match:** insert the session (with `passkey_verified_at` from the payload) and a success event
   `{ client: 'native', passkey }`, then commit. Return the token only after the commit succeeds.

If any statement fails, the whole transaction rolls back and the API returns an error. No session
exists, and the code remains unspent until it expires.

**Passkey-registration race (r3).** A person with no passkey gets a handoff with
`passkeyVerified: false`. If they register a passkey (from another session) before the app spends
that handoff, the handoff must no longer yield a session.

- Inside the same transaction, when the payload has `passkeyVerified: false`, the exchange re-reads
  whether any passkey exists for the user, locking the `passkeys` rows with `for share` or taking an
  equivalent lock.
- If a passkey now exists, the code is burned, an `auth.native.exchange` failure event is written with
  reason `passkey_required`, and the API answers 401 "Start sign-in again".
- A test registers a passkey between handoff creation and exchange, and asserts the refusal and that
  no session exists.
- The web path issues its session in the same request as the check, so it has no comparable window.

**Carrying native context through the passkey service (r3).**
- `PasskeyService.beginStepUp` gains an optional `native: { challenge, attempt }` stored in the
  step-up payload.
- `completeStepUp` currently parses the payload with a non-strict zod object
  (`{ purpose, returnTo, challenge? }`, `passkeys.ts:91`), which drops unknown keys. That schema must
  gain an optional `native` object with the same 43-character validation. Otherwise native context is
  silently lost, and the step-up would issue a **web session** from a native attempt.
- A test asserts that a native step-up never yields a session and always yields a handoff carrying
  the original challenge and attempt.

Native step-up completion (§3.2 step 4) is atomic in the same way. One transaction consumes the
`pks_` token, updates the passkey counter and `last_used_at`, inserts the `native_handoff` request and
writes the events. This needs a transaction-aware path through `PasskeyService`. Step 3 (consume
`session_exchange`, insert `native_handoff`, event) is also a single transaction.

**Uncertain response.** The server keeps only token hashes and never re-returns or replays a token
for a code that has been spent.

- If the app times out or loses the response after sending the exchange, it discards the attempt and
  says: "Sign-in didn't finish. Start again."
- It never re-posts the same code, and it offers a new sign-in.
- The rule for a lost response: the transaction has committed, but the only copy of the new token
  was in the undelivered response. The resulting session row is unusable, because only its hash
  exists. It expires at its TTL and can be revoked by the remote revocation in §4.
- A server failure before the commit leaves no session.

### 3.4 Rollout gate

- The API enables `client=native` only when `NATIVE_SIGN_IN=1`. The variable is non-secret and
  defaults to off.
- **Off:** native start requests answer 400 `native_sign_in_unavailable`. Native exchange,
  step-up and handoff codes created while the flag was on fail closed. They never fall back to a web
  session or a browser cookie.
- **Order:**
  1. A1: API code, flag off, inert.
  2. A2: web code understands `{ nativeHandoff }` and `{ stepUp, native }`, with the constant target.
  3. Both deployed to staging, where the **flag stays off**.
  4. M-auth device testing with the flag on only in an **isolated environment**: a local or dedicated
     API and web with synthetic accounts and no real customer data.
  5. Shared staging or any real account: the flag is turned on only after the claimed-HTTPS callback
     (or an equally strong reviewed binding) has passed the §10 link-association gate. This is a
     recorded root/owner step in `paused.md`.
- **Rollback:** turn the flag off **before** rolling the web back past A2. An old web callback cannot
  parse the new responses.
- No secret or signing configuration changes are implied by any of these steps.

### 3.5 Invariants and tests

Real-Postgres tests in `apps/api/src/auth/*.test.ts`:

- With the flag off, every native entry refuses and no auth request is stored. Codes minted while the
  flag was on fail after it is turned off.
- A native request never yields a session from `/auth/session/exchange` or `/auth/passkey/verify`.
- A web request never yields a handoff.
- The kinds are separate and the database enforces them. A `native_handoff` code cannot be spent at
  `/auth/session/exchange`, and the reverse.
- A person with a passkey cannot obtain a native session without a verified step-up.
  `passkey_verified_at` is set if and only if a step-up happened.
- These all fail and burn the code:
  - a wrong verifier;
  - a wrong attempt;
  - a replay;
  - an expired code.
  Of two concurrent exchanges exactly one succeeds.
- An injected failure after the session insert (for example, the audit insert) leaves no session and
  no spent code.
- The existing `return_to` rejection vectors are rerun through the native entry. There is no looser
  path, and stored values are checked again when read.
- No token, verifier or code appears in events, errors or logs.

**Web (`apps/web`):**

- `auth/callback/route.ts` handles the two native response shapes.
- The passkey server action returns the handoff target to the client, and the client performs
  `location.assign`. This avoids depending on `redirect()` to a non-HTTP scheme (Q4).
- With `native=1`, `auth/passkey/page.tsx` must not send an already signed-in browser to `/`. A Custom
  Tab may share browser cookies, so that redirect would stall the native attempt. The API still
  decides whether the result is a handoff or a session.
- Node tests plus a Playwright check cover the native branches against the local API fixture.

**Migration** (one, platform table): add `native_handoff` to the `auth_requests` kind check.

- Drop and re-add the constraint by its actual name. 0021 used an unnamed `add check`, so verify the
  name in a fresh test database.
- Use the next free migration number at implementation time.
- There is no `organisation_id`, so no RLS policy or cross-tenant test applies.
- The existing `app`/`captain_runtime` grants cover it. The runtime-role readiness test must still pass.

## 4. Session on the device

**Storage.** There is **one mechanism, `expo-secure-store`**
(<https://docs.expo.dev/versions/latest/sdk/securestore/>), and no other storage dependency.

| Key | Holds | Why |
|---|---|---|
| `session` | `{ token, expiresAt, userId }` | Credential |
| `org.{userId}` | chosen organisation id (not secret) | Keeps the choice across launches without a second storage library |

- iOS items use Keychain accessibility "when unlocked, this device only" (option name Q2). Android
  uses SecureStore's Keystore-backed storage.
- **Install marker dropped (r2).** SecureStore can't host a marker that disappears on uninstall, and
  adding a file or AsyncStorage dependency for it is not justified. Root verified that an iOS Keychain
  item **may survive uninstall and reinstall** (not guaranteed). Accepted consequence: after a reinstall
  on the **same device**, a still-valid session may come back.
  - Uninstalling is **not** signing out. The app says so in its sign-out copy.
  - Sign-out and the remote revocation below are the revocation paths.
  - "This device only" items should not migrate to another device (Q2).
- **Android backup.** Root verified that SecureStore entries do not survive uninstall and **must be
  excluded from backup**.
  - PR M-shell configures that exclusion and checks it in the generated manifest (Q3).
  - If a restored store is unreadable (the key is gone), the app treats it as the storage error below.
- **Storage errors.** Every read and write can fail.
  - Failed read: "Captain couldn't read your saved sign-in on this device", then offer sign-in.
  - Failed write after a successful exchange: revoke the new token with `POST /auth/sign-out`, and say
    the sign-in was not saved.
- **Never stored:** the token is never in logs, crash reports, analytics or navigation state.

**Transport.** One API client attaches the bearer **only** when the request origin equals the
configured `API_URL` origin. Development may use loopback `http:`; everything else requires `https:`.
`API_URL` and `APP_URL` are public build configuration.

**Expiry.** The existing fixed TTL applies unchanged in the foundation. There is no refresh token and
no sliding expiry.

- `expiresAt` is a local hint: when it has passed, the app treats the session as signed out.
- Only a **confirmed 401** deletes the token, with the message "Your session has ended. Sign in again."
- Status 0, 429 and 5xx keep the token and show a retry state that says what happened.
- No write is retried automatically.

**Sign-out.** The app calls `POST /auth/sign-out`, then **always** deletes the local session and clears
memory and navigation. If revocation was not confirmed, it says: "Signed out on this phone; Captain
couldn't confirm the server session ended. It expires on {date}."

**Remote revocation.** This is tracked separately and is **required before first-customer native
readiness**. It is not a foundation blocker.

- A signed-in person needs to end their other sessions, for example after losing a phone.
- The smallest API is `POST /v1/me/sessions/revoke-others`: `update sessions set revoked_at = now()
  where user_id = $me and id <> $current and revoked_at is null`, plus an auth event.
- It needs no new column. It also signs the person out of their web sessions, and the UI says so.
- Listing individual devices is a later nicety.
- Track this readiness increment in #178.

**Account switching.**

- Sign out, then sign in again. Google already shows `prompt=select_account`.
- The app *requests* an ephemeral browser session (option and platform support: Q1). This is a
  best-effort platform preference, not a guarantee: Android Custom Tabs may share the browser's
  Google and web cookies.
- No security property depends on ephemerality. Binding comes from PKCE and the attempt ID, and the
  app deletes its own token on sign-out.

**Organisation switching.**

- The chosen organisation must still appear in `GET /v1/me`; otherwise the app falls back to the chooser.
- A 404 on an organisation route, and each return to the foreground, reloads `/v1/me`. A 404 for a
  single record is not treated as losing the membership; only the `/v1/me` answer decides that.
- **Confirmed revocation (r3):** when `/v1/me` answers successfully without the active organisation,
  the app does what an explicit switch does. It discards all of that organisation's in-memory records,
  cursors, drafts and per-tab navigation stacks and deletes its stored `org.{userId}` choice. Then it
  shows "You no longer have access to {name}" and the organisation chooser, or the no-organisation
  state.
- A failed `/v1/me` (status 0, 429 or 5xx) purges nothing and shows the retry state.
- Changing organisation or account discards **all** in-memory records, cursors, drafts and per-tab
  navigation.
- A test drives the pure navigation/cache store through revocation and asserts nothing from the old
  organisation remains reachable.
- Organisation creation, invitations and passkey registration stay on the web in this slice, and the
  app says so.

**No persistent business cache.** Records, messages and drafts live only in memory. Persisted reads or
drafts need a separate reviewed amendment covering encryption, purging on sign-out and revocation,
staleness labels and organisation separation.

## 5. Native links

**Scheme.** A fixed reverse-domain private-use scheme for development builds:
**`app.askthecaptain.dev`** (RFC 8252 §7.1 form `app.askthecaptain.dev:/path`).

- It is not a generic word, and it is not a client-supplied redirect.
- The release scheme and bundle identifiers are owner decisions for a later reviewed change (Q7).
- **One scheme per build variant.** A development build answers only its own scheme, so a dev build
  cannot receive a release callback, or the reverse.
- **Limitation (r3).** Any app can register this scheme. It is therefore restricted to isolated
  development and synthetic-account proofs, with `NATIVE_SIGN_IN` off on shared staging and for real
  accounts (§2, §3.4).
- **Real-account callback.** A claimed HTTPS path on the existing web origin, for example
  `https://app.askthecaptain.app/native/auth/callback`, bound to the signed app by iOS Universal
  Links and Android verified App Links (§10 gate). Switching the callback constant is a reviewed code
  change; the API binding (PKCE, attempt, atomic exchange) is unchanged.

**Auth callback.** `app.askthecaptain.dev:/auth/callback` is handled only as the return value of the
pending `openAuthSessionAsync`, and only under the exact checks in §3.2 step 6.

- **One attempt at a time.** Starting a new attempt dismisses the browser session and discards the
  previous verifier and attempt.
- A dismissed or cancelled result discards the attempt and says "Sign-in was cancelled".
- A late, duplicate or overlapping callback, or one that arrives through the general link handler
  outside a pending attempt, is dropped without being logged with its query.

**Record links.** `app.askthecaptain.dev:/work/tasks/{uuid}` and similar links are parsed with the same
safe-return rule, then matched against an allow list:

- `/work`, `/work/views`, `/work/tasks/:uuid`, `/work/projects/:uuid`, `/work/series/:uuid`
- `/chat`, `/chat/views`, `/chat/:uuid`
- `/resources`, `/resources/views`, `/resources/equipment`, `/resources/inventory`

These mirror the web paths. Unknown links show "This link can't be opened in Captain".

- A link carries no token and never writes. Reads are re-authorised by the API.
- A 404 shows as "Not found or no longer shared with you".
- `return_to` from sign-in uses the same allow list.
- The link filtering happens in Expo Router's `+native-intent.tsx` `redirectSystemPath`. That hook runs
  outside the app's context, so it never validates auth callbacks; it drops them (§11, Q5).
- The return-path rule then exists in three copies: API, web and mobile. The mobile copy carries the
  "change together" comment and runs the API's rejection vectors.

Record links over Universal Links/App Links arrive with the claimed-HTTPS callback work (§10 gate).
They follow the same allow list.

## 6. Shell, navigation and design fidelity

**Tabs.** Exactly Work, Chat and Resources (D11).

- Work opens at **My work** (`ownerId` = me, open statuses).
- There is no fourth tab. Settings is reached from the avatar and holds account, organisation choice,
  sign-out and a web link for other settings.

**Stacks and view lists.** Each tab has its own stack with native back and swipe-back, and keeps its
view and scroll position. An **untitled grouped view list** sits one page to the left and opens from
the header chevron. It has an accessible heading.

- **Work:** For you (My work, All tasks); Across the business (By tag from `GET …/tags`, #159);
  Saved views (`GET …/views`, apply only).
- **Chat:** All, Unread, Starred.
- **Resources:** Equipment schedule, Inventory, and Files & assets shown as unavailable. No fictional
  rows.

**Visual spec** (from the mockup README):

- **Tab bar:** a floating capsule of about 290×54 pt on a 390 pt phone. Icons are 22 pt and labels
  11 pt; labels stay visible.
- **Selected tab:** a darker grey-green pill at 50% opacity, with a green icon and label.
- **Sizing:** targets are at least 44 pt, and content clears the floating bar.
- **Header:** a compact breadcrumb, search and avatar, with no wordmark. Headings are 26 pt.
- **Colours and type:** forest, paper and mint, with Fraunces and Inter.
- **Tokens** are authored in `apps/mobile/src/theme/tokens.ts`, outside `packages/ui/design`, with
  each value's source cited (D14).
- **Theme:** light only until a dark palette is reviewed.
- **Fonts:** bundled only if their licences and assets are confirmed; otherwise the system font, and
  the PR says so.

**States.** Loading, failed with retry, empty, unavailable, permission and disabled states are designed
and use words. A failed read never renders as empty. There is no green plus where creation is not
delivered.

## 7. Initial authenticated read scope and later increments

| PR | Delivers | Does not deliver |
|---|---|---|
| M-read | Work: My work, All tasks, By tag and saved-view lists with paging; read-only task, project and series detail. Chat: conversation list with unread and starred. Resources: view list, equipment catalogue, counted stock | Writes, timeline, messages, push |
| M-work-write | Task create, status and edit with existing revision preconditions; ambiguous responses reconciled by re-reading | Offline queueing |
| M-equipment | Read-only timeline (unknown or unloaded time never free; continuous Hours/Days/Weeks), then reserve/edit/cancel with existing request-ID reconciliation. Gesture dependencies named here | Offline booking confirmation |
| M-chat | Conversation, cursor paging, pins, latest six, sends with client request IDs, catch-up via `…/changes`, stars, read position | Native push (separate contract) |

Each row is its own reviewed PR over existing API routes. An API gap needs its own PR with tests.

## 8. Dependencies proposed (versions verified at install, not here)

Implementation installs the set that matches the Expo SDK chosen at that time. The PR records the
exact versions from the committed lockfile and the SDK's compatibility check (Q8). Neither the latest
tags nor the proof's versions are assumed.

| Package | Why |
|---|---|
| `expo` | SDK, config and build tooling |
| `react`, `react-native` | SDK-matched and separate from the web's React (Q9) |
| `expo-router` plus the peers the SDK docs list at install (currently expected: `expo-linking`, `expo-constants`, `react-native-screens`, `react-native-safe-area-context`) | Routes, per-tab stacks, links, back navigation |
| `expo-dev-client` | Development builds |
| `expo-web-browser` | `openAuthSessionAsync` |
| `expo-secure-store` | Session and organisation choice: the **only** storage mechanism |
| `expo-crypto` | Random bytes and SHA-256 (Q10) |

**Development dependencies:** `typescript`, `@types/react`, `@types/react-dom` for SDK-matched web-export types, `@types/node` for Node-run pure tests, and `tsx` if it is not hoisted. Pure logic
lives in React Native-free modules tested with the existing `node --import tsx --test`: return path,
link allow list, callback validation, PKCE/attempt encoding and failure classification.

**M-shell SDK selection (27 September 2026).** Expo 57.0.25 uses React/React DOM 19.2.3,
React Native 0.86.3 and TypeScript ~6.0.3. Router peers also include `expo-status-bar`,
`@expo/metro-runtime` and the transitively resolved `@expo/log-box`; web export uses `react-native-web` ~0.21.0.
The isolated pnpm workspace preserves Next.js's existing React version. The Router package includes
upstream drawer support whose peers pnpm installs transitively: Reanimated 4.5.1, Worklets 0.10.1
and Gesture Handler ~2.32.0. Workspace overrides match the SDK's bundled-module manifest and
pin React Native's Metro config to 0.86.3; these packages are not direct app dependencies or
permission to implement equipment gestures in M-shell. Mobile's DOM types are pinned separately
from the web app. Development identifiers `app.askthecaptain.dev` are unsigned placeholders;
no signing identity, association, registration or release identifier is selected by this shell.
Before the first development build, record the autolinked native modules; transitive native peers
may be included even though app code does not import them. Verify normal cold launch, per-tab
history, swipe-back and enlarged text on devices; bundle exports cannot establish these behaviours.

**Excluded:** AsyncStorage or any file/cache storage; gesture and animation libraries as direct app dependencies (M-equipment; SDK-pinned transitive peers above are allowed);
`expo-notifications`; telemetry and Sentry; `@simplewebauthn/*`; and every server package
(`@captain/db`, `model`, `connectors`, `engine`, `steps`, `retrieval`, the API).

**CI guard (M-shell), allowlist-based (r3).**

- `apps/mobile/package.json` runtime and development dependencies must match an explicit checked-in
  allowlist: the §8 table plus its SDK-listed peers.
- **No** `@captain/*` workspace package is allowed today. A client-safe shared package can join the
  allowlist only through its own reviewed amendment. Future server packages are therefore blocked by
  default, not by a denylist that has to be kept up to date.
- Source must not import `node:` built-ins or any module outside the resolved allowlist; this is
  checked from the bundler's module graph or an import scan.
- The exported bundle must not contain known secret variable names or `postgres://` URLs.
- Only `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_APP_URL` are read.

## 9. PR sequence

Root owns git, tests and merges, and every PR gets reciprocal review.

1. **A1: native handoff API and migration.** Covers §3.3–§3.5 on the API side. `NATIVE_SIGN_IN` is
   off by default, so A1 is inert.
2. **A2: web native branches.** Constant target, tests and Playwright. Inert while the flag is off.
3. **No enablement on shared staging.** The flag is on only in an isolated synthetic-account
   environment for M-auth proofs (§3.4).
4. **M-shell: `apps/mobile`.** Dependencies (§8), app config with the `app.askthecaptain.dev` scheme,
   Android backup exclusion, tabs, view lists and states, theme tokens, link allow list, CI guard,
   `check`/`test`, and web/iOS/Android bundle exports in CI.
5. **M-auth.** PKCE and attempt, `openAuthSessionAsync`, callback validation, native exchange,
   SecureStore and its errors, `/v1/me`, organisation chooser, sign-out, failure classification.
6. **Remote revocation API and web/mobile control** (§4). Required before first-customer native
   readiness.
7. **M-read**, then **M-work-write**, **M-equipment** and **M-chat**.
8. **Link association (required before any real-account use).**
   - The web serves `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` from
     the existing origin. This is a code change; no DNS change is implied.
   - The callback constant switches to the claimed HTTPS path.
   - The owner supplies the Apple Team ID, bundle identifier and Android signing-certificate SHA-256
     fingerprint. These are owner credentials and decisions.
   - It passes the §10 link-association gate; only then may root/owner record turning the flag on for
     real accounts.

M-auth is not complete without the §10 simulator and device evidence for sign-in with and without a
passkey on iOS.

## 10. Evidence and gates (recorded separately)

| Evidence | Available here? | What it proves |
|---|---|---|
| Typecheck, node tests, real-Postgres API tests, Playwright web checks | Yes (serial under `flock /tmp/atc-build.lock`) | Protocol, binding, atomicity, gate, return path and client logic |
| Expo bundle export (web/iOS/Android) | Yes | It bundles; nothing native |
| Android emulator or local development build | Only with an Android SDK host; not present here | Early Android compile and smoke |
| iOS Simulator development build | Needs macOS and Xcode; **not available here** | Navigation, links, SecureStore API, auth session. Not passkey device proof |
| Real iPhone or Android device | Needs hardware and development signing; **not available here** | Passkey in the auth session, gestures, keyboard, text scaling, screen readers, performance |
| Signed distributable build, TestFlight or Play testing, publication | **Paid accounts and credentials (owner).** Outside this batch | Distribution only |
| **Link-association gate (r3):** association files served over HTTPS with the correct content type and no redirect; iOS and Android both verify the domain for the signed app; the claimed callback opens the signed Captain app from the auth session; a differently signed or unsigned build that initiates sign-in does **not** receive the callback (the attempt stays pending or fails, and no code reaches that build) | Needs a signed build with owner identities and real devices; **not available here** | App-identity binding that makes real-account native sign-in acceptable. Until it passes, `NATIVE_SIGN_IN` stays off on shared staging and for real accounts |

This contract claims none of these. Paid enrolment, build services, signing, bundle identifiers,
association files and store listings are owner actions: prepared here, not performed. Two-person
acceptance on web **and iOS** remains the first-customer gate (plan §11).

## 11. Platform questions (root verifies against current official docs)

Documentation verification and real-device checks are different kinds of evidence. A documented
option establishes what the API offers, not that it behaves correctly on a particular device.

**Verified in documentation by root, 27 September 2026:**

| Topic | Source | What the docs establish | Still needs device evidence |
|---|---|---|---|
| Development build required for native OAuth redirect | <https://docs.expo.dev/guides/authentication/> | Use a development build, not Expo Go | The redirect on each platform |
| `openAuthSessionAsync` and `preferEphemeralSession` (Q1, part) | <https://docs.expo.dev/versions/latest/sdk/webbrowser/> | The auth session API exists. `preferEphemeralSession` is iOS-only and best-effort, depending on the default browser. §4 already treats ephemerality as a preference, not a guarantee | Actual iOS/Android cookie behaviour, cancel/dismiss results |
| SecureStore persistence and backup (Q2, part; Q3, part) | <https://docs.expo.dev/versions/latest/sdk/securestore/> | `SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY` is documented, and M-auth uses it. An iOS Keychain item may survive reinstall (not guaranteed). Android entries do not survive uninstall and must be excluded from backup. Storage errors must be handled | Reinstall behaviour, Android backup exclusion in the built manifest |
| Pre-routing URL handling (Q5) | <https://docs.expo.dev/router/advanced/native-intent/> | `+native-intent.tsx` `redirectSystemPath` sees incoming system URLs before routing, **outside the app's React context** | See below |
| pnpm monorepo (Q8, Q9) | <https://docs.expo.dev/guides/monorepos/> | SDK 54+ supports isolated pnpm installs. **Duplicate React within one app is forbidden, and duplicate React Native in the monorepo is unsupported** | A clean install and export of `apps/mobile` beside `apps/web` |
| External browser, PKCE, private-use scheme | <https://www.rfc-editor.org/rfc/rfc8252> §7.1, §8.1, §8.12 | Protocol basis for §2–§3 | Not applicable |

**Consequence for Q5.** `redirectSystemPath` is used **only** to filter record links against the
allow list, and to drop any `/auth/callback` URL that reaches it. It cannot see the pending in-memory
attempt, so it is **not** the auth validator. Auth callbacks are accepted solely from the return value
of the pending `openAuthSessionAsync` call, validated in app code (§3.2 step 6). Whether the platform
also delivers the callback URL to `redirectSystemPath` is harmless, because that hook drops it; this
is recorded as a device check.

**Consequence for Q8/Q9.** `apps/mobile` may resolve an SDK-pinned React different from `apps/web`'s,
provided each app resolves exactly one React. Only `apps/mobile` depends on React Native. M-shell
must show this with a lockfile inspection (one `react` and one `react-native` resolved for
`apps/mobile`) and a successful export. If the isolated layout cannot achieve it, M-shell stops and
reports rather than hoisting or overriding the web's React.

**Still open (documentation):**

- **Q1 (rest).** Android Custom Tab cookie sharing, and the dismiss/cancel result shape.
- **Q2 (rest).** Whether `WHEN_UNLOCKED_THIS_DEVICE_ONLY` items are excluded from migration to a new
  device. Android key invalidation.
- **Q3 (rest).** The exact Expo/Android configuration keys that exclude SecureStore from Auto Backup
  and device transfer.
- **Q7.** Private-use schemes give no app-identity binding. RFC 8252 §8.6 and §7.1 already establish
  that any app may claim one, so it is not a verification item. Still to check:
  - whether `ASWebAuthenticationSession` accepts an HTTPS callback (the OS version and API) and how
    `openAuthSessionAsync` exposes it;
  - how Android Custom Tabs return a verified App Link;
  - the current association-file requirements.
  The bundle identifier and signing identities are owner decisions.
- **Q10.** The `expo-crypto` API for random bytes and a raw-byte SHA-256 digest.

**Real-device or simulator checks only** (documentation cannot settle these):

- **Q4.** Whether page navigation to `app.askthecaptain.dev:/auth/callback` completes the auth
  session, for a 303 and for `location.assign`.
- **Q6.** WebAuthn passkeys inside `ASWebAuthenticationSession` and Android Custom Tabs for the current
  relying party. This is the key proof for required-passkey sign-in.
- Delivery of the callback to `redirectSystemPath`, reinstall/restore behaviour of stored sessions,
  and Android backup exclusion in practice.

## 12. Boundaries

- Next.js remains the web client.
- No server secret, database access, model or provider credential enters the bundle.
- No change to the web return-path rule, the required passkey, the WebAuthn verifier configuration or
  the session TTL.
- No new tenant table and no background process.
- No production deploy, DNS change, secret, signing or publication.
- A1's migration is the only schema change, and it touches a platform check constraint.
- `NATIVE_SIGN_IN` stays off on shared staging and for real accounts until the link-association gate
  passes. Turning it on is then a recorded non-secret configuration step.
