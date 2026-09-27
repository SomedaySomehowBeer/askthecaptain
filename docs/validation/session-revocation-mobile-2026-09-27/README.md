# Mobile session control — 27 September 2026

Outcome: manage shared work through secure account access, implementing [increment 3](../../plans/mobile-session-revocation-2026-09.md).

Account adds **Sign out everywhere else** with confirmation. The runner binds the operation to a
person/account generation, ignores old answers after account changes, and holds progress, slow
wording, result and retry waits across screen remounts. It does not share the organisation read
scope or the `/v1/me` wait. Only a current-handle 401 ends this session; other 4xx are refusals.
A malformed, oversized or unconfirmed answer is never presented as a count.

Claude B implemented the mobile source, pure tests and synthetic harness. Root integrated merged
navigation #205, preserving its imports and My work fallback, and added the browser scenarios.
Claude A approved the implementation and browser scenarios. A final narrow robustness repair
clears progress after unexpected client/timer errors; Claude A independently approved the repair and its regressions.

- Initial combined workspace checks passed, after updating an old composition test double for the
  two new runner methods. No cast was weakened.
- Initial combined mobile tests: 275 passed (255 pure/source tests, 20 boundary tests), zero skipped.
- Final failure-cleanup repair: all 10 workspace checks passed (9 unchanged cached), and 276 mobile tests passed (256 pure/source, 20 boundary), zero skipped.
- Production web/iOS/Android and synthetic web harness exports passed, including secret/canary and harness-exclusion scans.
- Synthetic Chromium checks passed at 360/390/430 px, including confirmation/cancel, remount-persistent progress and results, slow responses, counts, retry waits and session expiry. The full existing navigation/account/task-read suite also passed with no overflow or page errors.
- [390 px synthetic Account screenshot](390-account.png). Harness controls visible beneath the app are test-only.
- CI: pending.

The browser harness is a scripted account source and provides UI proof only. Real API concurrency,
expiry and isolation evidence is in #204; real web session revocation is covered separately.
No signed native build, simulator, device test, native enablement or deployment is claimed.

The real control is reachable only after native sign-in and organisation selection. Native sign-in
remains off on shared staging and for real accounts, so this is not yet an available device feature.
