# Mobile response byte budget validation — 27 September 2026

Outcome: **manage shared work** through bounded mobile reads. Implements the
[contract adopted in #200](../../plans/expo-mobile-response-byte-budget-2026-09.md).

The transport counts decompressed response bytes before UTF-8 decoding and refuses a response
that exceeds 1,048,576 bytes. A declared oversized Content-Length is refused before touching the
body. One 30-second timer covers headers and body. Cancellation is best effort; a stop flag prevents
late reads from decoding, parsing or requesting another chunk. No retry is added. Status and
Retry-After still determine the account/read outcome when a body is unusable.

## Evidence

- Initial isolated validation: **236 tests passed, zero failed or skipped** (216 pure tests and 20 boundary tests).
  After integrating merged All tasks #201: **247 passed, zero failed or skipped** (227 pure and 20 boundary tests),
  with mobile typecheck and boundary check passing again.
  Coverage includes exact limit/one byte over, oversized first chunks, misleading Content-Length,
  split UTF-8 sequences, invalid UTF-8, incomplete characters, empty/null bodies, stalled reads,
  synchronous cleanup throws, rejected or non-settling cancellation, late resolutions/rejections,
  stop-before-decode/parse and existing HTTP/exchange outcome mapping.
- Scoped-read regressions use the real transport and client with synthetic streams. Oversized
  refresh preserves previous rows and the account scope, reports unavailable rather than client-bug,
  stops on the crossing chunk, and keeps a 429's retry wait separate from account state.
- All ten workspace typechecks passed (eight unchanged tasks cached). Client boundary and Expo
  SDK compatibility checks passed.
- Production web, iOS and Android JavaScript exports and the separate synthetic harness export
  passed. Secret-canary scans and harness-exclusion checks passed.
- Initial boundary verification rejected test-only process event hooks. They were removed without
  changing the guard. Node's test runner catches unhandled rejections/exceptions; afterEach waits
  let late promise activity settle. The complete checks and test suite then passed.

Claude A implemented the transport/tests, Claude B independently reviewed them and wrote the
scoped-read regressions, and A reviewed those regressions. Root reviewed and integrated the fixes
and ran checks serially. Both agents reviewed the documentation. No production screen changed;
no additional local browser run was needed for this transport-only increment. CI runs the combined shell/account/My work/All tasks browser regression on the updated branch.

## Limits

This is a policy limit on accepted/decoded body bytes, **not a bound on total process memory**.
Native buffering before JavaScript streaming, an individual delivered chunk, string/JSON overhead
and native cancellation behaviour remain device gates. No native/simulator/device evidence is
claimed. Native sign-in remains disabled; no app is installed or released by this change.

No local Postgres suite was run for this mobile-only change. No API, SQL, dependency, migration,
staging deployment or fleet change is included. Repository CI runs database regressions separately.
