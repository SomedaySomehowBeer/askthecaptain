# T-E — thread presentation, 1 October 2026

Workspace outcome: discuss work. Presentation-only changes from main `49163c2` after
#230 and #232. Authority: D14, the [reviewed prototype](../../proposals/assets/captain-chat-first-2026-09-30/README.md),
frames 1–3 and 15–16, and the proposal's Navigation and Threads decisions.
No controller, parser, request, storage, route, permission or database changes.

## Comparison with the reviewed design

- List: one white card per tag, thin row dividers, bold titles and unread pips for
  needs-you rows. Counts sit beside the heading; owner and readable calendar dates
  sit below it. Status and two nonempty facts remain dot-separated. Retry appears
  beside a failed status; Show more is a quiet text action.
- Thread: the star is a labelled header icon. The folded card contains title/status,
  two equal fact columns and the fold chevron. White messages use a compact author/time
  line and inset separators. The message area hides scrollbar chrome. Earlier messages
  and retry use quiet actions; the unread marker is a small label and thin line.
  A growing input and compact Send share the fixed bottom composer.
- New thread: Send shares the growing input's row. Private choices retain their existing
  layout; member refresh and selection clearing are compact text actions. Existing
  disabled, locked, uncertain-send and retry guards remain unchanged. Compact Retry text
  retains the full accessible label (“Retry same message” / “Retry same thread”).

The checked-in system font remains: no licensed prototype font files are bundled.
Screenshots use identical synthetic data, a light scheme, a 900px viewport height,
and the production Expo web export in isolated Chrome contexts. Before is unmodified
main; after is this presentation pass. These are browser evidence, not native/device
or live-customer evidence.

| Width | List | Thread | New thread | Private choices after |
|---|---|---|---|---|
| 360 | [before](t-e-360-before-list.png) / [after](t-e-360-after-list.png) | [before](t-e-360-before-thread.png) / [after](t-e-360-after-thread.png) | [before](t-e-360-before-new.png) / [after](t-e-360-after-new.png) | [after](t-e-360-after-private.png) |
| 390 | [before](t-e-390-before-list.png) / [after](t-e-390-after-list.png) | [before](t-e-390-before-thread.png) / [after](t-e-390-after-thread.png) | [before](t-e-390-before-new.png) / [after](t-e-390-after-new.png) | [after](t-e-390-after-private.png) |
| 430 | [before](t-e-430-before-list.png) / [after](t-e-430-after-list.png) | [before](t-e-430-before-thread.png) / [after](t-e-430-after-thread.png) | [before](t-e-430-before-new.png) / [after](t-e-430-after-new.png) | [after](t-e-430-after-private.png) |

Rendered immutable prototype references: [1, list](t-e-reference-1.png),
[2, new thread](t-e-reference-2.png), [3, thread](t-e-reference-3.png),
[15, dark list](t-e-reference-15.png), [16, dark thread](t-e-reference-16.png).
The brief's explicit white grouped-row requirement governs the list treatment.

## Contrast and dark-scheme deferral

Dark mode is deferred in full under the brief's permitted exception. The app has a
single static palette referenced by 19 shared screens/components, with colors baked
into `StyleSheet.create`; it has no reactive theme provider. A reliable native/web
scheme switch requires a separate theme pass, including account and record screens.
This PR neither implements nor claims dark-scheme support.

Measured light-palette contrast uses sRGB relative luminance and
`(lighter + 0.05) / (darker + 0.05)`. Ratios below cover opaque text used by the new
presentation; decorative dividers deliberately remain faint. Existing inactive
shared shell controls are unchanged; these figures are not an app-wide accessibility audit.

| Foreground | White surface | Page `#f1f5ee` | Sage `#dbe6d4` |
|---|---:|---:|---:|
| Heading `#142619` | 15.90:1 | 14.41:1 | 12.32:1 |
| Body `#1f3a2c` | 12.35:1 | 11.20:1 | 9.58:1 |
| Secondary/placeholder `#54655a` | 6.20:1 | 5.62:1 | 4.81:1 |
| Action/star `#276744` | 6.75:1 | 6.12:1 | 5.24:1 |
| Fact/chip `#2d4c36` | 9.55:1 | 8.66:1 | 7.41:1 |

White Send text on action green is **6.75:1**; white unread-pip text on
`#2d4c36` is **9.55:1**. Disabled Send uses body on sage, **9.58:1**,
without an opacity reduction. Quiet disabled actions use secondary text.

## Validation

All heavy commands ran under `flock /tmp/atc-build.lock`. Mobile tests were run with
one worker after the initial default parallel run was terminated (exit 143); that
partial run does not count as passing.

- Mobile TypeScript and source boundary checks: pass.
- Mobile tests: **413 passed**, plus **20** configuration/boundary tests; none skipped.
- SDK dependency check, Android backup configuration introspection, production web,
  iOS and Android exports, separate web harness export, and bundle canary/boundary check: pass.
- New presentation browser checks: **360, 390 and 430px**. Verify compact folded card,
  equal fact columns, header star/accessibility label, shared row cards and thin dividers,
  white messages with 12px inset separators, readable dates,
  no normal-state refresh buttons, hidden scrollbar, side-by-side composers, growing input
  capped at 120px, compact failure retry, no page errors or horizontal overflow.
- Full existing browser regression suite: **360, 390, 430 and 1280px passed**.
  Includes unchanged thread writes/retries, private creation/tags, account controls,
  session expiry and equipment; no page errors or horizontal overflow.
- API typecheck and real-Postgres thread list/thread/session regression: **49 passed**,
  none skipped.

Logs: [mobile checks/tests](t-e-tests.log), [exports](t-e-exports.log),
[final layout checks](t-e-layout.log), [browser regressions](t-e-browser.log),
[Postgres regressions](t-e-postgres.log). Final layout checks and all platform exports
were repeated after the single-line card-title/disabled-star presentation adjustment.

Not covered: native runtime/keyboard/SecureStore, installed apps, screen-reader or
assistive-device testing, dark mode, hosted API/deployment or real business data.
Exports alone do not establish native runtime behavior. No merge or deployment performed.
