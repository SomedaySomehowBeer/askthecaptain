# Mobile All tasks read validation — 27 September 2026

Outcome: **manage shared work**. Implements the [All tasks contract](../../plans/expo-mobile-all-tasks-read-2026-09.md)
adopted in #200, extending merged My work #199. No API, SQL, dependency or deployment change.

Work → Views → All tasks lists the organisation's open top-level tasks using the existing Work API.
The fixed query omits ownerId and explicitly sends status=open. In progress, Suggested and Done tasks,
checklist steps and tasks in archived/proposed projects are outside this list. Rows show title, tags,
due date and one owner fact: Assigned to you, Assigned to someone else, or No owner.

My work and All tasks share one screen, parser and hook, with the view bound at mount. Each screen
keeps its own in-memory list; remounts read page zero. Refresh, More and Try again remain explicit.
The existing bounds, 50 rows per page and at most ten pages, apply to both lists. Scope changes make
all old instances inert before the tab reset and drop delayed answers. Rows remain read-only.

## Evidence

- All ten workspace typechecks passed (eight unchanged tasks cached), including the mobile client boundary check.
  Expo SDK compatibility passed.
- **229 tests passed, zero failed or skipped:** 209 pure tests and 20 boundary guard tests.
- Production web, iOS and Android exports and the separate synthetic harness export passed.
  Secret-canary scans and harness-exclusion checks passed.
- Chrome checks passed at **360, 390 and 430 px**, including the existing account/My work suite.
  All tasks checks cover the exact query, three owner facts, empty/loading/failure states, refresh
  and More retries preserving rows, overlapping pages reaching a ten-page cap at 475 distinct rows,
  the fixed website link, exact retry deadlines, tab return without reads, new reads on remount,
  both mounted lists becoming inert on scope loss, delayed responses, and guarded deep links.
  Production `/work/all` remains the web-only guard; no external requests or page errors occurred.

Screenshot: [All tasks at 390 px](all-tasks-390.png). It includes synthetic data and test-only controls.

Both existing Claude Opus agents in Herdr independently reviewed the implementation and browser
checks. Root reviewed the shared UI and transport boundaries and ran checks serially under the
shared build lock.

## Limits

These exports are JavaScript bundles, not signed apps or native builds. Browser checks use the
production screen/hook/parser with synthetic queued responses, not live accounts or a real API.
Native sign-in remains disabled. No simulator/device proof, native gesture acceptance or native
transport proof is claimed. Explicit native stack seeding remains a separate navigation increment.

No local Postgres suite was run for this mobile-only change; no database code changed. Repository
CI still runs its database regressions. No staging deployment, fleet change or migration accompanies
this work. The response byte budget is a separate implementation; see its own contract and evidence.
