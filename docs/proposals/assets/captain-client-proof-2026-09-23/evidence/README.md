# Client proof evidence — 23 September 2026

**Decision status:** retain Expo mobile / Next.js web as the working recommendation. The isolated
Expo universal client passes the checks below. Neither native interaction acceptance nor a web
framework replacement is established. The delivered artifact is a runnable bounded proof, with
the hardware/production gates still open in the [delivery plan](../../../../plans/captain-workspace-delivery-2026-09.md).

## Executed

Environment: Linux workspace, Node 22.22.1, Expo 57.0.24, React Native 0.86.3 and React 19.2.3.
The npm lockfile records the complete dependency set. Checks ran sequentially under the shared
build lock. Browser checks used the existing shared Chromium context via CDP and closed their tab.

| Check | Result |
|---|---|
| `npm run check` | Pass; strict TypeScript, including native/web-compatible source |
| `npm test` | 5/5 pure client-logic tests pass; continuous geometry/clipping, focal zoom, adjacent/overlapping intervals, a 23-hour DST interval, replay/update identity and older pins |
| `CI=1 EXPO_NO_TELEMETRY=1 npm run export` | Pass; web JavaScript plus iOS and Android Hermes bundles generated |
| `browser-check.mjs` | Pass at 390 × 874 and 1280 × 960; no page errors or horizontal document overflow |
| Browser timeline | Continuous duration ratio across scales, focal time on button zoom, conflict marker, selection persistence, horizontal equipment navigation |
| Browser chat | Latest six, older shared pin, alternating tint, local history paging, draft retained between phone panels, local append visible on item, composer inside viewport |
| State controls | Loading/empty/failed/disabled hide sample data; failed-state retry returns ready |
| Visual inspection | Phone timeline and desktop chat captures inspected; technical harness retains the proposal's cream/green palette |
| `git diff --check` | Pass |

The first test command used the tsx CLI and hit the sandbox's Unix-socket restriction before
running tests. The committed script uses `node --import tsx --test`; the five tests then ran and
passed. This was a runner issue, not a passing test result.

## Screenshots

| View | Phone | Desktop |
|---|---|---|
| Timeline after selecting the conflict, zooming out and moving equipment | [Phone](timeline-390.png) | [Desktop](timeline-1280.png) |
| Same chat on the item | [Phone](inline-chat-390.png) | [Desktop](inline-chat-1280.png) |
| Full chat after a local-only message | [Phone](chat-390.png) | [Desktop](chat-1280.png) |

These are screenshots of the technical proof, not replacements for the polished mobile design
mockups. Full chat uses virtualised rows; loaded history is a local fixture slice, not a live API.

## Not executed / not established

- No Xcode, Android SDK, emulator or physical device is available here. Native **bundle exports**
  do not prove installable native builds, signing, real pinch/pan, software-keyboard clearance,
  platform back gestures or frame-rate performance. The JS responder gesture is pending device review.
- Older history loading works in Chromium, but precise reading-position preservation across
  platforms and remote arrivals still needs acceptance work.
- No Next.js production route changed; no representative Next.js integration comparison was run.
  Expo web passing this harness does not decide the eventual web architecture.
- No API, table, provider, production dependency, workflow or migration changed. No Postgres
  integration tests ran for this client-only proof. Scheduling overlap checks here are advisory
  fixture logic, not a claim of transactional booking enforcement.
- Root application typecheck/tests were not repeated: the production workspace is unchanged.
  This docs-contained proof has its own check/test scripts; existing CI ignores docs-only changes.
- Authentication, push, persistence/offline sync, multi-user chat, inference and real file handling
  are delivery slices, not implemented or simulated as successful operations here.
