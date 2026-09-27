# Native section navigation implementation — 27 September 2026

Outcome: manage shared work through predictable navigation, under the [adopted contract](../../plans/expo-mobile-native-navigation-2026-09.md).

Implemented explicit native section initial routes, fresh Work `[views, index]` reset state, and
one tab-entry decision for account transitions, redirects and My work fallbacks. Web retains its
previous calls and reset payload. Account-page redirects are deliberately unanchored; the contract
records this clarification and the small router adapter. No dependency or API change.

Claude A implemented the source and tests; Claude B independently approved every call site against
the installed Expo Router. Root reviewed the diff and owns validation. Source-reading tests guard
call-site coverage; they are not evidence of native runtime behaviour.

- Workspace typecheck: 10 tasks passed, 9 unchanged cached.
- Mobile tests: 254 passed (234 pure/source tests, 20 boundary tests), zero skipped.
- Production web/iOS/Android and synthetic web harness exports passed, including secret/canary and harness-exclusion boundary scans.
- Production/harness Chromium checks at 360, 390 and 430 pixels: passed, including account transitions, tab/view history, refused links, My work and All tasks reads, no overflow and no page errors.
- CI: pending.

No database changes or local Postgres test run for this mobile-only change. CI provides the usual
server regression. No staging deployment, signed native build, simulator or device test is claimed.
Native sign-in remains off. Known L1 warm view-list duplication and L2 ready remount on the
organisation page remain open, as do all native device acceptance gates in the contract.

Representative synthetic capture: [My work at 390 pixels](390-my-work.png).
