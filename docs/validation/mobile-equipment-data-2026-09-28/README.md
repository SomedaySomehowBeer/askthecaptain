# Mobile equipment timeline, slice E-1 (data modules) — 28 September 2026

Outcome: **allocate resources**, implementing slice E-1 of the [adopted #211 contract](../../plans/expo-mobile-equipment-read-2026-09.md).

This slice adds only pure modules under `apps/mobile/src/resources/equipment/` and two fixed paths in
`apps/mobile/src/api/paths.ts`: the organisation time zone gate and civil-day helpers (`zone.ts`), the schedule range
and 28-civil-day chunks (`range.ts`), pixel geometry (`geometry.ts`), strict parsers for the organisation, catalogue
page and occupancy answers (`data.ts`), the cell and queue state (`cells.ts`), the catalogue list state
(`catalogue.ts`) and the screen-wide read gate (`coordinator.ts`). No screen, hook, harness fixture, copy, dependency,
API, schema, flag or export changes. Nothing reads equipment on a device or in a browser yet; that is slice E-2.

Claude A wrote the paths, parsers and catalogue state; Claude B wrote the zone, range, geometry and cell/queue modules;
root wrote the read gate. Every module was independently reviewed by the other Claude; root's gate was reviewed by
both. Review corrected the gate twice (Refresh and re-anchor while a read is in flight; conflict and zone stops
limited to occupancy reads) and added the test gaps the reviewers listed. Root's other edits to the agents' files were
two TypeScript repairs with no behaviour change (a cast in a parser test, a narrowing in `cells.finish`).

- Frozen install passed (`/tmp/captain-business-chat/mobile-equipment-install-r1.log`, 27 September).
- Mobile typecheck and client-boundary scan passed on the final tree.
- Final tests passed: 376 total, 356 pure/source plus 20 boundary, zero skipped
  (`/tmp/captain-business-chat/mobile-equipment-check-tests-r2.log`).
  Coordinator 14, catalogue 16, cells 14, parsers/paths and the three ports account for the rest of the 67 new tests
  over the 289 at #210 (plus the byte-budget scripts).
- Exports and the browser suite were not rerun locally for this UI-free slice on the shared, memory-tight machine;
  the mobile CI job runs the exports and browser suite on the PR head and is the export evidence for this slice.
- CI: pending until the PR is opened; recorded below when known.

No server source, dependency, schema or API changes, so no real-Postgres run is claimed. Native sign-in stays off.
All `Intl` behaviour proven here is Node's; the Hermes device gate in contract §6 remains open, as do the pinch,
simulator and device gates. Two E-2 notes from review are carried forward: the tick-label formatter is not exercised
by the zone gate and is not error-wrapped, and `zoomScroll` must be followed by `clampScroll` near the range end.
