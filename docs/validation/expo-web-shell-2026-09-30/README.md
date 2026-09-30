# R1b Expo web shell — 30 September 2026

Workspace outcome: people can sign into the Expo web client, switch organisations, manage
sessions and open the read-only equipment schedule. The thread shell has no thread records
or business writes yet. Implementation review: [PR #218](https://github.com/SomedaySomehowBeer/askthecaptain/pull/218),
dependent on [plan #214](https://github.com/SomedaySomehowBeer/askthecaptain/pull/214) and
[API #217](https://github.com/SomedaySomehowBeer/askthecaptain/pull/217).

## Evidence

- `pnpm --filter @captain/mobile check`: TypeScript and the source boundary guard passed.
- `pnpm --filter @captain/mobile test`: 373 pure-logic tests and 20 boundary-guard tests passed,
  zero skipped. Includes late identity responses after sign-out, organisation/person changes,
  paced retries and Retry-After, invitation reconciliation, stale passkey reads, revocation races
  and the fixed native handoff parser. Native protocol/storage tests use injected adapters.
- Production and harness Expo web exports passed. The harness remains a separate test-only
  export, never part of production.
- iOS and Android JavaScript exports passed, as did the guard over all production bundles
  and the harness. Generated Android backup exclusions and `expo install --check` passed.
  These are bundle/configuration checks, not native builds or device proof.
- [Browser results](browser.log): all checks passed at 360, 390, 430 and 1280 px. The production
  source uses synthetic API responses; checks cover token-free storage, request headers,
  organisation switching, no-membership Account, sign-out failure, unavailable route retention,
  invitation outcomes, passkey listing, browser WebAuthn and no overflow/page errors. The three
  phone widths also exercise the retained equipment timeline and session-control harness.
- [Postgres results](postgres.log): all eight `apps/api/src/web/session.test.ts` tests passed,
  zero skipped, against an isolated database created and dropped by the repository harness.
  They cover callback cookies, CSRF, bearer compatibility, step-up, cookie clearing, native
  handoff and export/API routing. This is separate from the browser test's mocked verify response.

The local browser export/screenshots were captured at `1f710a4`; `feebaf7` then adds automatic
paced retry after a failed signed-in identity refresh, covered by the final pure tests. Final
PR CI rebuilds from source and runs the browser suite again.

## Screenshots

Synthetic accounts only: [360 px home](home-phone.png), [1280 px home](home-desktop.png).
The light shell uses system fonts. The supplied prototype's dark theme is not implemented in R1b.

## Limits

No hosted Google sign-in, staging/production deployment, native sign-in enablement, installed
app, simulator, device accessibility or SecureStore evidence. The Chromium test creates a
virtual authenticator and submits a real browser assertion, but its verify response is mocked;
it is not an end-to-end hardware-passkey proof. R1c still needs hosted auth and Web Push checks.

Threads, selective undo/change history, agents, business writes and the remaining account
controls belong to later rebuild increments. No private thread data is read by this shell.
