# R2a account controls — passkeys (30 September 2026)

First of three screen PRs for [#221](https://github.com/SomedaySomehowBeer/askthecaptain/issues/221).
Outcome: **manage shared work** — people protect their own Captain account from the one
Expo client (D37). Members/invitations and push devices remain the next two PRs.
Based on main `654a608`; no deployment or hosted account was used.

The second slice is recorded separately in [Members and invitations](members.md).
The third slice is recorded in [Push devices](push.md).

## Behaviour and scope

Settings extends its existing passkey section using the current account layout, components and
mobile theme tokens. People can name a passkey when adding it through the browser, list their
passkeys and remove one. The API has no rename endpoint; this slice adds none. iOS/Android
keep the existing browser-only notice, with no registration action.

The existing APIs own registration, removal and the next-sign-in step-up. The client sends
cookies with `x-captain-client: web`; it never stores a session token. The registration
challenge is transient call-local data, excluded from observable state and storage. The bounded
transport gains DELETE without changing redirect refusal or the response byte limit.

Only one control request runs at a time. A person change discards late answers; leaving the
screen before a browser ceremony completes prevents its registration write. Failed reads are
not empty lists. An uncertain write is never replayed and requires a successful list refresh
before another change; Retry-After disables requests until its deadline. Removing a passkey
is a personal security operation recorded by the existing auth audit, not a business-record
version. Restoring it requires a new authenticator ceremony, not snapshot undo.

## Checks

All heavy commands used `flock /tmp/atc-build.lock`.

- Frozen offline install and `pnpm --dir apps/mobile check`: passed.
- `pnpm --dir apps/mobile test`: **353 pure tests + 20 boundary/config tests passed**, zero skips.
- Expo SDK compatibility and generated Android backup-configuration checks: passed.
- Fresh production web, iOS and Android JavaScript exports, plus the separate web harness: passed.
- Source/bundle boundary, secret-canary and production/harness separation scans: passed.
- Browser: passkey flows and four harness list states at **360/390/430 px**; existing shell
  checks at **360/390/430/1280 px**, with equipment/revocation checks at phone widths. No page
  errors, external requests or overflow. See [browser.log](browser.log).
- Existing API passkey and cookie-session suites against disposable real Postgres databases:
  **12 passed**, zero skips. See [postgres.log](postgres.log).
- `git diff --check`: passed.

The browser run exercises a real virtual-authenticator registration followed by the existing
step-up using that credential, successful removal, scripted prompt cancellation, expired
registration, unknown removal with Retry-After and list reconciliation, pending-action
controls, leaving during a pending options request, a 401, unavailable/failed/empty lists,
unsupported browsers and the native notice. Pure tests additionally cover stale person
responses, disposal during the browser prompt, duplicate requests, challenge parsing and
DELETE redirect refusal.

Synthetic screenshots: [added, 360 px](passkey-added-360.png),
[uncertain removal, 390 px](passkey-uncertain-390.png), [failed list, 430 px](passkey-failed-430.png).

## Limits

Browser registration and assertion use Chromium's virtual authenticator, with synthetic API
responses. The server tests use real disposable Postgres and the existing injected WebAuthn
adapter. These are separate proofs, not an end-to-end hardware-authenticator/production-server
round trip. The cancellation check scripts a browser NotAllowedError. No hosted evidence until
the owner deploys and completes real Google/passkey checks.

No iOS/Android build, simulator, installed app, SecureStore, native sign-in, hardware passkey,
assistive-technology or other-browser claim. Platform exports prove JavaScript bundling only.
No members/invitation management, notification registration/delivery, DNS or deployment changes.
