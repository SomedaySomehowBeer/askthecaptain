# Web session control — 27 September 2026

Outcome: manage shared work through secure account access, implementing [increment 2](../../plans/mobile-session-revocation-2026-09.md).

Settings adds **Sign out everywhere else**, with inline confirmation and Cancel. It calls the
person-scoped API added in #204, without requiring an organisation. A preflight that cannot verify
the session sends no write. Refusals and unconfirmed responses never claim nothing changed.
Browser-to-Next action failures show the same unconfirmed result; Next router exceptions retain
normal redirect handling. Tokens stay in the existing HttpOnly cookie and server action.

Claude A implemented the web source and pure tests. Root wrote the independent fixture/browser
suite; A approved it and the three-minute CI suite cap. Claude B independently approved the complete source, fixture, browser suite and documentation.

- Final workspace check: 10 tasks passed, 7 unchanged cached.
- Web tests: 141 passed, zero skipped.
- Production Next build passed.
- First Chromium run passed all cases against real disposable Postgres: two sessions, Cancel,
  duplicate prevention, real count and second-browser sign-in, zero, rate-limit and refusal copy,
  committed-call lost reply, aborted action request, preflight expiry, and post-preflight expiry
  preserving the Next redirect. No page errors or token/hash exposure in checked HTML/action replies.
- Layout checks passed at 360, 390, 430 and 1440 pixels. The fixture and database were cleaned up.
- Final recovery-link production rebuild and full browser rerun passed, including actual sign-in navigation. Both final [CI jobs passed](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36313202687) before merge.

The delayed/failed replies and expiry at POST are explicit loopback-only fixture modes, not
production hooks. The lost-reply case commits a call ending zero sessions; it is not evidence of
a lost reply with a positive count. Current sessions on other screens can retain visible content
until their next server check. Pending and later sign-ins can still create sessions.

No mobile control, native enablement or deployment is claimed in this record. The API was merged
separately; any eventual release remains staging-only on one existing machine per app.

[Settings after revocation, 390 pixels](390-settings.png).

CI exposed an older Chat browser selector that matched both sign-out buttons. The regression now names the plain Sign out button exactly; Claude A independently approved this test-only repair. The new session-control suite itself passed on CI.

The exact-selector repair passed the full affected Chat suite locally with fixture cleanup confirmed. Final CI passed both workspace and browser jobs before #206 merged.
