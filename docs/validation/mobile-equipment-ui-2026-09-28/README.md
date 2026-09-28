# Mobile equipment timeline, slice E-2 (screen) — 28 September 2026

Outcome: **allocate resources**, implementing slice E-2 of the [adopted #211 contract](../../plans/expo-mobile-equipment-read-2026-09.md)
over the E-1 data modules merged in #212.

Resources → Equipment schedule is a read-only, continuous cross-equipment timeline: the organisation's time zone is
bootstrapped and self-checked first, the catalogue is read page by page on explicit More, and occupancy is read one
cell at a time only after the view settles, through the screen's single read gate (one in flight, 30 starts a rolling
minute, every server wait honoured). Only a completely read cell may leave time blank, and only as "no confirmed
reservations when it was read"; unread, loading, failed, partial, conflicting, stale and evicted time is hatched with
its words, and columns are hatched by default so render lag can never show false free time. Hours/Days/Weeks, Today,
Earlier/Later dates, a read-only detail panel and one fixed website link are the only controls; there is no reserve,
edit or cancel, no dependency, API, schema or flag change, and no deployment.

Claude B implemented the pure screen state (`schedule.ts`), the effects-only hook, the timeline and panel components,
the route, the copy and the web path, after a design note that Claude A reviewed twice. Claude A independently
reviewed the code (no blockers; six should-fix items and four notes, all resolved) and the final tree. Root wrote the
harness fixtures and controls (chosen by read path, raw API bodies through the real parsers), the browser check, the
contract §5 status edit and this record. Browser evidence found one real defect before release: the first focus and
settle depended on layout-event order, so the screen could sit at the range start and read nothing; the timeline now
focuses and settles whichever measurement arrives last and re-issues an unconfirmed focus once.

- Frozen install passed (`/tmp/captain-business-chat/mobile-equipment-ui-install-r1.log`).
- Mobile typecheck and client-boundary scan passed on the final tree.
- Final tests passed: 403 total, 383 pure/source plus 20 boundary, zero skipped (`mobile-equipment-ui-final-r2.log`; 2 new over #212).
- Production web/iOS/Android and the separate synthetic harness exports passed, with secret/canary and
  harness-exclusion scans (`mobile-equipment-exports-r3.log`).
- Full synthetic browser suite passed at 360/390/430 px (`mobile-equipment-browser-r2.log`): the existing
  account/navigation/My work/All tasks/Inventory/session-control suites plus the new equipment suite, which proves the
  bootstrap order (organisation, then page 0, then occupancy only after a settle), one read in flight across all kinds,
  never-free partial, conflict, failed and unread cells, the zone-change stop, a failed cell's Try again, the
  no-timeline states (empty, unsupported zone, access refused, failed bootstrap with Try again), a server wait that
  disables Try again until exactly its deadline, More with the list-changed notice, the detail panel, the scales, the
  fixed website destination and stale-scope suppression, with no page errors, console errors, outside-origin requests
  or horizontal overflow. A [390 px screenshot](390-equipment-loaded.png) records the loaded synthetic screen.
- CI: #213; the mobile job (typecheck, tests, four exports, boundary scans, Chromium shell suite) is recorded on the PR.

No server source, dependency, schema or API changes, so no real-Postgres run is claimed. Native sign-in stays off, so
real accounts cannot reach the screen on a device. Node's and Chromium's `Intl` are not Hermes; the device zone
self-check, native scroll-end events, sticky-row smoothness, the ~120 000 px content at Hours, VoiceOver/TalkBack across
nested scrolls, larger text, the native URL echo, pinch and gestures remain unverified (contract §6 device row).
Eviction of retained payloads is proven by Node tests only. Header controls scroll the timeline to its top in the
browser; Today returns to now.
