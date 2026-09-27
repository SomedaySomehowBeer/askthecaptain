# Mobile My work read validation — 27 September 2026

Outcome: **manage shared work**. Implements the first read-only list from the
[adopted contract](../../plans/expo-mobile-my-work-read-2026-09.md) (#198), on top of
merged account composition #197. No server, database, dependency or deployment change.

The list requests the signed-in person's **open** tasks in the chosen organisation,
50 per page, with explicit Refresh/More/Try again. At most ten pages or 500 distinct
rows are retained in memory. Each row retains a capped title, three tags and a tag
count, status and validated calendar date. Rows are not yet interactive. The subtitle
states the filter, including in loading and failure states.

Reads compare the expected account/organisation epoch before sending and after
settlement. A switch makes the old screen inert during the render before the tab
reset. No old rows or callbacks can become the new organisation's list. A read's
retry wait remains separate from account checks; automatic membership refresh after
403/404 uses the existing 30-second spacing and server wait.

## Evidence

- Typecheck and source/client boundary guard passed.
- 198 pure tests and 20 boundary guard tests passed: **218 passed, zero skipped**.
  Regression coverage includes invalid/oversized fields, Gregorian dates, paging,
  duplicate IDs, account epochs/ABA, stale responses, before-send mismatch, thrown
  path/client code, separate retry waits and 403/404 pacing.
- Production web, iOS and Android exports and the separate synthetic web harness
  export passed. Server-secret canaries and harness-exclusion checks passed.
- All ten workspace typechecks passed (eight unchanged tasks cached); Expo SDK compatibility passed.
- Chrome checks passed at **360, 390 and 430 px** with no page/console errors,
  horizontal overflow or requests outside the export origin. Existing account,
  guarded history and shell checks remain. The new checks cover loading versus
  empty/failure, title/tag/date rendering, failed refresh/More preserving rows,
  retries at the exact deadline with no automatic read, deduplication to a ten-page
  cap at 475 distinct rows, the fixed website link, explicit refresh replacement,
  tab/foreground return without reads, and delayed answers after switch/loss/sign-out.
- The full browser run finished within the former five-minute limit. Its bounded
  CI limit is now ten minutes to accommodate the expanded suite; the job retains
  its 25-minute outer limit and process-group/server cleanup.

Screenshots: [populated My work](work-populated-390.png), [empty state](work-empty-390.png).
These deliberately include the test-only control panel and synthetic data.

Both existing Claude Opus agents in Herdr independently reviewed the implementation.
A reviewed the parser/path/config and wrote account regression tests; B reviewed
those tests and the scope guards. Both reviewed the browser checks. Root reviewed
and integrated the code and ran all checks serially under the shared build lock.

## Limits

The browser uses the production screens/hook/parser with scripted pending reads,
synthetic records and no credentials. It is a Chromium approximation at phone widths,
not a native build or device proof. The artificial 401 harness control proves only
that data is dropped; runner tests prove session release, with browser account
transitions proving tab removal.

No Postgres suite was run locally for this mobile-only change; it changes no API,
SQL or database code. Required repository CI still runs its own database regression
suite. No schema migration, staging deployment or fleet change accompanies this PR.

Native sign-in remains disabled on staging and for real accounts. No signed app is
installed or usable on a device. Claimed HTTPS links, device transport query URLs,
real 403/404 behaviour, gestures/accessibility and performance still need native
proof. The transport's whole-response byte budget remains an explicit gate before
customer readiness; bounded retained rows are not a raw-response memory limit.
