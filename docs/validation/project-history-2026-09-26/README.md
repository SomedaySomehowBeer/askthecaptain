# Project task history — 26 September 2026

Workspace outcome: manage shared work. Project Tasks now defaults to Open, with In progress,
Suggested, Completed, Cancelled and All except cancelled views. Each uses existing API filters;
completed work cannot crowd the Open page. The overview preview still includes open/in-progress
work and links to All except cancelled, retaining access to everything it showed.

Status changes reset pagination; paging retains status. Completion/reopening can remove a row from
the chosen view while the persistent Work updates confirmation retains keyboard focus. Switching
the filter clears that old confirmation. The project schedule's Show bookings uses the existing
secondary button style.

`apps/e2e/scripts/project-history-check.cjs` exercises real status transitions, keyboard focus after
row removal, suggested/cancelled history, status-preserving Previous, pagination reset, legacy
cancelled links, the overview destination and layouts at 360/390/430/1440 pixels. The existing
`project-overview-check.cjs` explicitly selects All except cancelled for its complete/reopen check.
Both run against the production web build, real API and disposable Postgres fixture.

Claude's review caught the existing overview check's dependence on the old mixed default. The
updated test and feature received a second read-only review. No new saved-view vocabulary, API,
schema, dependency or hosted data changes are involved. This is not native-device, screen-reader
or authenticated hosted acceptance. The earlier overview captures remain historical evidence;
full-page screenshots retain fixed controls at their viewport position.
