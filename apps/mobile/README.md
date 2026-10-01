# Captain Expo client

R1b replaces the three-tab client with the chat-first shell proposed in
[plan PR #214](https://github.com/SomedaySomehowBeer/askthecaptain/pull/214). It depends on the API's
cookie-session and static-export support in R1a (#217). Production and staging deployment
remain separate R1c work.

The root opens Threads with six fixed filters, grouped cursor pages, a read-only Equipment
schedule link and an unavailable Team row. Thread screens show the fixed record card,
oldest-first messages, first unread, pending-send recovery, message actions, pins and stars.
Files and People remain unavailable. Thread responses currently follow the R2 contract using
strict client parsers; a real-Postgres API test checks them against the merged T-A payloads. Account provides organisation switching, sign out, sign out everywhere else,
and web passkey listing, naming at registration, and removal. The invitation page accepts an invitation once and reports an
uncertain response without replaying the write. Owners and admins can open Members from Settings to create and revoke invitation links, change roles and remove members. These controls currently use the web cookie session; native shows an unavailable notice. Notifications in Settings lists and removes personal devices, registers this browser and sends the displayed test notification. Native push and organisation export/deletion controls are later work.

## Sessions

On web, the API serves `dist/web` and owns the HttpOnly session cookie. The source in
`src/account/web-session.ts` checks `/v1/me`, remembers only the chosen organisation ID under
the person's ID in localStorage, and exposes token-free account snapshots to screens. All API
requests use the page origin, include cookies and `x-captain-client: web`, drop Authorization,
and refuse redirects. Identity checks respect the 30-second spacing and Retry-After. A failed
initial check keeps the requested route; a failed refresh keeps the last verified workspace
and shows a connection notice. Confirmed 401 responses end the session.

Web passkey step-up uses `@simplewebauthn/browser` and the API's step-up cookie. A verified web
response reloads the safe return path. A native step-up retains the fixed one-time PKCE handoff;
native sign-in remains disabled. The native source, SecureStore and auth-session protocol are
retained, with no browser token stored in them. Fully reload after account/platform edits:
Fast Refresh can retain the previous account instance.

The [R1b validation record](../../docs/validation/expo-web-shell-2026-09-30/README.md) contains
the local shell results and synthetic screenshots. The [R2a passkey record](../../docs/validation/account-controls-2026-09-30/README.md) covers registration and removal.

## Local checks

Run heavy commands under `flock /tmp/atc-build.lock` on a shared machine:

```sh
pnpm --filter @captain/mobile check
pnpm --filter @captain/mobile test
pnpm --dir apps/mobile exec expo export --platform web --output-dir dist/web --max-workers 2
CAPTAIN_MOBILE_HARNESS=1 pnpm --dir apps/mobile exec expo export --platform web --output-dir dist-harness --max-workers 2
node apps/e2e/scripts/mobile-shell-ci.mjs
```

The harness is a separate, web-only export. Never deploy it. Production exports leave
`CAPTAIN_MOBILE_HARNESS` unset. The source and bundle guard excludes server packages, secret
variables and harness code from production. Only the native API URL variable `EXPO_PUBLIC_API_URL` is permitted; web API requests use
the serving origin instead.

The browser suite exercises the production session source against synthetic API answers at
360, 390, 430 and 1280 pixels, plus the retained equipment and session-revocation harness at
phone widths. It covers route retention, organisation memory, sign-out failure, invitations,
passkey listing, browser WebAuthn registration and an assertion with the new credential,
removal, failures and uncertain-write reconciliation. Members checks cover invitations, roles, removals, permissions and organisation changes. Registration and verify responses are mocked; API cookie,
CSRF, revocation and step-up tests in `apps/api/src/web/session.test.ts` require real throwaway
Postgres and provide separate server evidence.

`.github/workflows/mobile.yml` also exports iOS and Android JavaScript bundles, checks SDK
compatibility, generated Android backup settings, and production/harness separation. Exports
are not native builds or device evidence. Native rendering, accessibility services, safe areas,
SecureStore, app links, WebAuthn on actual devices and hosted Google sign-in remain unverified.
