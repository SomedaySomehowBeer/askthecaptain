# Mobile Inventory read — 27 September 2026

Outcome: **allocate resources**, implementing the [adopted #208 contract](../../plans/expo-mobile-inventory-read-2026-09.md).

Resources → Inventory shows active stock grouped in the API's location order. Decimal strings and
units are preserved, including trailing zeros; missing counts say “Not counted yet.” The server owns
the below-reorder comparison. No notes, supplier/person details or other unused fields enter list state.
The existing API is unpaginated; the response byte budget applies and the page uses one virtualised
SectionList, without a parent ScrollView. Only Inventory opts into the shared Screen list variant; other screens retain their existing ScrollView. The website link appears after a successful load, including
an empty answer. It is the only action beyond refresh/retry; this increment adds no business writes.

Claude B implemented list state, hook, screen, copy, fixed website link and harness wiring. Root
implemented the path, parser, fixtures and browser scenarios. Claude A approved B's source and root's
browser checks; both Claude agents approved the parser. Review fixed an overlong synthetic fixture
name and added a grouping test that distinguishes API order from alphabetical order.

- Frozen install passed; all 10 workspace typechecks passed (8 unchanged cached).
- Final tests passed: 289 total, 269 pure/source plus 20 boundary, zero skipped.
- Production web/iOS/Android and separate synthetic harness exports passed, with secret/canary and
  harness-exclusion scans.
- Full synthetic browser acceptance: running at 360/390/430 px. The 360 px pass includes parser-driven
  malformed failure, empty/uncounted states, exact decimal strings, refresh failure retaining rows,
  retry waits, fixed website destination and stale answers after organisation changes.
- CI: pending. No implementation PR is merged yet.

No server source, dependency, schema or API changes. No real-Postgres rerun is claimed for this
client-only increment. Native sign-in stays off, so real accounts cannot reach it on a device.
Exports and browser results are not signed-build, simulator, VoiceOver/TalkBack, native performance
or device evidence. Existing device and claimed-link gates remain open.

The browser proves old stock answers are discarded after the organisation-change tab reset. The
brief inert loading frame before that reset is covered by pure screen-state tests, not a captured
browser frame. Other 4xx and client-bug wording are also covered by pure tests.
