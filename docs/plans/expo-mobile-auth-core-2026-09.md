# Mobile authentication core: implementation partition

Status: merged in #189, 27 September 2026. This is the first bounded
M-auth increment under the [adopted foundation contract](expo-mobile-foundation-2026-09.md),
following merged M-shell PR #188. Outcomes: manage shared work, allocate resources and
discuss work through the same authenticated API. No new product decision or dependency.

The API and web handoff are merged in #186/#187. This increment implements only
React Native-free protocol and credential-storage logic with injected, testable
interfaces. Platform adapters and the account reducer and runner follow in the
[platform and account increment](expo-mobile-platform-account-2026-09.md); the provider,
screens, authenticated business reads and remote session controls follow after that.

| Owner | Scope |
|---|---|
| Claude `business-views` | `src/auth/` and `src/api/`: types first, then PKCE, callback validation, a single pending attempt, exchange/error handling and fixed API paths; test-only API no-redirect coverage |
| Claude `linked-chat` | `src/account/`: minimal credential-store types first, then strict stored-value parsing and a serial credential-storage queue with controlled-completion tests |
| Codex | Interface integration, plan reconciliation, tests, git and PR review/merge |

Both interface reviews are complete. Each agent also reviews the other's implementation. The initial
implementation adds no Expo adapters or dependencies that it does not yet use.

Required behaviours from the contract and implementation review:

- Only one sign-in attempt runs. A second start is refused. Callback acceptance is
  bound to the pending authentication-session result, exact destination, code and
  attempt. Cancelling holds the start gate until the existing platform operation settles; a
  hung operation stays unavailable. An exchange is sent once; a lost response requires a new sign-in.
- Browser cancellation has neutral wording. The app claims sign-in is disabled
  only on a confirmed API error, never by inferring why a browser was closed.
- API paths are fixed or built from checked identifiers and encoded segments.
  Requests reject redirects before sending where the platform supports that;
  checking the final URL is only a secondary check. Real-account release requires
  device verification of bearer handling on redirects and the existing app-link gate.
- Credentials remain private to the effect runner and storage boundary. The account
  reducer's state and effects (next increment) use opaque handles, never bearer strings. Stale successful
  sign-ins are explicitly handed to cleanup rather than silently discarded.
- Stored sessions have the exact credential schema, issued token format and canonical expiry.
  Invalid data stays unreadable until a deliberate save; errors contain no stored values.
- Every storage operation is serialized. Installs recheck their account generation
  at execution; removals compare the expected session or organisation before
  deleting. A late operation cannot erase a newer credential or organisation choice.
- New sign-in waits for previous storage and revocation cleanup. A hung operation
  produces a bounded, honest unavailable state. Timeouts do not pretend to cancel
  an underlying storage write or allow unsafe concurrent replacement.
- Confirmed revocation, uncertain revocation, failed local deletion and failed save
  have distinct outcomes. A retained copy is never reported as removed. Cleanup
  credentials stay only in private memory, with bounded attempts and explicit retry. Server
  retry delays are never shortened; pending state exposes the next permitted retry time.
  An adjustable device clock is not evidence of confirmed server revocation.

Pure tests cover callback refusal, PKCE, uncertainty, overlapping attempts, safe
destinations, secret-free public outcomes and delayed/failed storage interleavings.
Postgres-backed tests remain required for any touched API behaviour. Linux tests
do not prove system-browser return, passkeys on devices, SecureStore behaviour,
native redirect handling, signed links, simulator builds or device acceptance.

Native sign-in remains off on shared staging and for real accounts. No deployment,
signing, DNS, schema change or current business-data modification is included.

Validation of this increment: 63 pure mobile tests and 11 client-boundary tests pass,
all ten workspace typechecks pass, and the added no-redirect API regression passes
against disposable Postgres. That regression samples the native exchange, sign-out,
identity and organisation routes; it does not establish native or proxy redirect behaviour.
No screens or platform adapters changed, so the prior shell browser proof remains separate.
