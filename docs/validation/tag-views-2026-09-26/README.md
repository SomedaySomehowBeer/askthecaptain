# By tag Work views acceptance

Implementation #159, source `2e0aa1b`, merged `bcc3155`, released 26 September 2026.
See the [operational record](../../runbooks/paused.md) for the image, review and release limits.

- [Focused browser checks](tag-browser.log): seven groups against real API/Postgres.
- [Private saved-view regression](saved-regression.log): all 16 groups in one run.
- [Existing Work regression](workspace-regression.log): all 10 groups, ordinary rate limits.
- [Hosted read-only smoke](hosted-smoke.log): signed-out entry at phone/desktop widths.
- [Populated Work views, phone](work-views-phone.png).
- [Maximum-length tag heading, 360px](long-tag-phone.png).

Populated images contain disposable local fixture data, not customer records. Focused layouts
passed at 360, 390, 430 and 1440 pixels. The focused/saved suites use the existing opt-in local
rate-limit clock; Work regression does not. Loading timing and native-device acceptance remain
unverified. Hosted checks do not establish authenticated feature acceptance.
