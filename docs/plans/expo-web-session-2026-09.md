# R1: the web session and the new shell

Status: **contract, 30 September 2026**, for increment R1 of the
[chat-first rebuild](chat-first-rebuild-2026-09.md). Outcome: **manage shared work** on the web without Next.js.
Decision D37 (owner, 30 September): the API serves the Expo web export from its own origin with an HttpOnly cookie
session and a CSRF check.

## What exists (verified at `2d3f1ef`)

- The API accepts only `Authorization: Bearer sess_…` (`apps/api/src/app.ts`). It has no CORS and reads no session
  cookie. `POST /auth/session/exchange` returns the token in JSON; the Next.js route `apps/web/src/app/auth/callback`
  spends the code and sets `captain_session` (HttpOnly, Secure, SameSite=Lax, path `/`). `captain_organisation`
  remembers the chosen organisation. Google returns to `${APP_URL}/auth/callback`.
- The passkey step-up returns `{ stepUp: true, token: pks_… }`; the web page calls `/auth/passkey/options` and
  `/auth/passkey/verify` with that token in the body.
- Return paths are checked by `apps/api/src/auth/return-path.ts` (`safeReturnPath`).
- The Expo app has no web sign-in: `authPlatform` is `null` off iOS and Android, and the account composition answers
  `web-only`. Its transport (`src/api/client.ts`) sends `credentials: 'omit'`. Its CI already exports the web bundle
  and checks it in Chromium (`.github/workflows/mobile.yml`, `apps/e2e/scripts/mobile-shell-*`).

## A. The API serves the app and the session (R1a)

1. **Static export.** The API serves `apps/mobile/dist/web` at `/` with `@hono/node-server`'s `serveStatic`:
   hashed assets under `/_expo/` cached for a year, everything else `no-store`, and any path that is not `/auth/*`,
   `/v1/*`, `/connections/*`, `/webhooks/*`, `/healthz`, `/readyz` or a file falls back to `index.html` (Expo Router
   is a single-page export). The Docker image builds the export (`expo export --platform web`) in the build stage.
   `APP_URL` becomes the API's own origin.
2. **Callback.** `GET /auth/callback?code=…` on the API spends the code exactly as the Next.js route did:
   - a session: set `captain_session` (HttpOnly, Secure, SameSite=Lax, path `/`, max-age = session TTL) and redirect
     303 to the safe return path;
   - a step-up: set `captain_stepup` (HttpOnly, Secure, SameSite=Lax, path `/auth`, max-age 10 minutes) holding the
     `pks_` token and redirect to `/auth/passkey`; the options and verify routes read the token from that cookie when
     the body has none, and verify sets the session cookie and clears the step-up cookie;
   - a native handoff: unchanged, redirect to the app's fixed callback;
   - an error: redirect to `/welcome?error=<code>` with the same error vocabulary as before.
3. **Cookie sessions on signed-in routes.** The signed-in middleware accepts, in order, a bearer token or the
   `captain_session` cookie. A cookie request is accepted only when it carries the header `x-captain-client: web`.
   The API sends no CORS headers, so a cross-site page cannot add that header, and SameSite=Lax keeps the cookie off
   cross-site subrequests. `POST /auth/sign-out` with the cookie ends the session and clears both cookies.
4. **Organisation.** The chosen organisation is client state (below), not a cookie; the API needs no change.
5. **Tests.** Real-Postgres tests for: callback sets the cookie and redirects; step-up round trip through the cookie;
   cookie without the header is refused; bearer requests are unchanged; sign-out clears cookies; the static fallback
   never shadows an API path; `index.html` is served with `no-store`.

## B. The Expo app signs in on the web (R1b)

1. **A web account source**, not the native machine. On web the app has no token: the cookie is the truth.
   - On load, `GET /v1/me` with `credentials: 'include'` and `x-captain-client: web`. 200 → signed in; 401 → welcome;
     anything else → an "unavailable" state that keeps the person where they are and retries with the existing
     30-second pacing.
   - The chosen organisation is kept in `localStorage` under the person's user id, falling back to the first
     membership.
   - The transport (`src/api/client.ts`) keeps its byte budget and outcomes; `native-send.ts` gains a web variant
     that sends cookies and the header. `paths.ts` allow-lists the existing passkey options/verify,
     passkey-list and invitation-accept routes needed by these screens; R1b adds no server endpoints.
   - The native account machine, SecureStore and the PKCE handoff stay as they are and stay dormant.
2. **Screens.** A new root layout with no tabs:
   - `/` — the thread list, empty in R1: the header, the filter row, the pinned rows (Equipment schedule, Team) and an
     honest empty state; no data reads yet;
   - `/welcome` — one "Sign in with Google" link to `/auth/google/start?return_to=…`, and the error copy from the
     Next.js sign-in page;
   - `/auth/passkey` — the WebAuthn step-up with `@simplewebauthn/browser` (web only; the native build shows a notice);
   - `/organisation` — the existing chooser and switcher, re-hosted;
   - `/settings` — the existing Account page (sign out, sign out everywhere else, passkeys list), re-hosted;
   - `/invitations/accept` — accepting an invitation link while signed in, re-expressed from the Next.js page;
   - the equipment schedule stays reachable at `/equipment` from its pinned row, buttons only (D38).
   Organisation export and deletion controls move in R2. The three-tab layout, `SectionStack`, `ViewList`, `TabBar`, `tab-entry` and the navigation half of `copy.ts` are
   removed in this increment, as are `webPaths` and every "on the website" notice.
3. **Harness.** The synthetic harness keeps its mechanism (`CAPTAIN_MOBILE_HARNESS=1`, scripted sources) and gains
   scripted web sessions: signed out, signed in with one organisation, with several, unavailable, step-up. The
   browser check exercises welcome → (scripted) callback → thread list → organisation switch → sign out at 360, 390
   and 430 px, and a 1280 px desktop pass that only asserts nothing overflows.
4. **Boundary guard.** Unchanged in what it forbids. Any new `EXPO_PUBLIC_*` read is refused unless the allow-list
   is amended in the same pull request with the reason.

## C. Release (R1c, after A and B are merged)

- The staging API image serves the export; `app-staging` (or the `app` CNAME, owner's choice) points at the API app.
  The Next.js staging machine is stopped once the hosted check passes, then `apps/web` and its Fly apps are removed
  from the repository.
- Hosted checks: `/healthz`, `/readyz`, `/` returns the shell, sign-in round trip with a real Google account, passkey
  step-up for an account that has one, sign out. Web Push registration is re-proved on the export (the service worker
  ships in `apps/mobile/public`).
- DNS and Fly changes are the owner's; the pull request prepares them.

## Not in R1

Threads and their data (R2), versions (R3), agents (R4), native sign-in (still off), Android and iOS evidence, gestures.
