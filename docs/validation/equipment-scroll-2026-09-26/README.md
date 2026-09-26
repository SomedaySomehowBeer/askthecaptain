# Equipment schedule scrolling — 26 September 2026

Workspace outcome: allocate resources (D24). The schedule now has a continuous scroll range
from one calendar month before the opened date through six calendar months after it. It opens
at the selected date. Today, date entry and arrows can move or re-anchor beyond that range.
Hours, Days and Weeks retain the same continuous interval presentation and focal zoom.

Bookings load in bounded 28-civil-day chunks for the current eight equipment columns, through
an authenticated server action. Unread, loading, failed and partial time stays striped and
unknown; failed reads have an explicit retry. Only a complete read can establish coverage.
Axis labels, gridlines and booking links render around the viewport rather than across all
seven months. The list below follows the whole days in view.

The first browser pass caught an interaction between URL date replacement and Next server-action
responses that could re-anchor the schedule after loading. Scrolling now keeps the original route
anchor stable; explicit Refresh availability and equipment-page links use the date in view.
A copied address/browser reload reopens its original anchor. A second pass found that zooming
to Hours retained a wider rendered window; zoom and resize now recompute that window, and the
browser check asserts a bounded tick count after zoom.

Reproducible local checks:

- `pnpm check --log-order=stream`
- `pnpm --filter @captain/web test` (includes range, DST, bounded reads, coverage and stale-response tests)
- Production Next build with the disposable fixture API.
- `apps/e2e/scripts/equipment-scroll-check.cjs`: actual scrolling backwards and six months forward,
  lazy/failed/partial reads, retry without loops, stable position after loading, focal zoom,
  bounded hourly DOM, date entry, sideways equipment navigation and responsive widths.
- `apps/e2e/scripts/equipment-check.cjs`: existing catalogue/reservation lifecycle, conflict,
  stale/uncertain writes, DST handling and layout checks.

Browser checks use the real local API and a disposable Postgres database, with a fixture identity;
no hosted customer records are written. They do not establish native-device gesture acceptance,
screen-reader acceptance or an authenticated hosted Google round trip. Full-page captures include
fixed bottom navigation at its viewport position; this is a capture artifact, not a second tab bar.

[Opened date on phone](phone.png) · [Scrolled six months ahead](six-months-ahead.png).

Final result: typecheck, 44 web tests, production build and all eight browser groups passed.
The final browser processes exited 0; reciprocal review and CI cleared #149 before merge.
