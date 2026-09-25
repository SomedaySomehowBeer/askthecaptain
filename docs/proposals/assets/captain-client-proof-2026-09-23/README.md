# Captain client architecture proof

Bounded, fictional proof for [the delivery plan](../../../plans/captain-workspace-delivery-2026-09.md).
Jobs: **manage shared work** and **understand and follow up**. This is a technical harness, not a replacement
for the [mobile mockups](../captain-mobile-2026-09-22/README.md), which the plan adopted as the
workspace design reference (D14).
Its buttons select experiments; they are not the proposed Work/Chat/Resources navigation.

## What this evaluates

One Expo/React Native implementation renders an equipment timeline and chat on web, with native
entry points for iOS and Android. Pure TypeScript shares interval geometry, zoom anchoring and
message identity. Desktop shows both panels; phone size switches between them without discarding
the draft or timeline selection. The same message list supplies full chat, shared pins and the
latest six on an item. Alternating rows begin with a 35% white tint.

The timeline contains 77 fictional intervals on six resources over 28 days in Australia/Perth.
Bookings remain continuous at Hours/Days/Weeks. Exact details, an unconfirmed conflicting request,
horizontal equipment controls and short-interval inspection remain available at coarse scales.
The proof has a JS PanResponder pinch implementation to evaluate on real devices; this is not
an assertion that its gesture arbitration or frame rate is production-ready.

Chat starts with 180 fictional messages, a 40-message history window and virtualised rendering.
An older pin stays above the latest-six view. Loading older history expands the local window.
“Add local message” appends only in memory, clears the draft and updates both views. Reload clears
these changes. No send, booking write, persistence, multi-user transport, inference or provider
connection exists. State controls exercise ready/loading/empty/failed/disabled views. Empty and
unloaded data are not described as available equipment.

## Isolation and dependencies

This directory is outside `pnpm-workspace.yaml`; it has its own npm lockfile. Expo 57.0.24 selected
SDK-matched React 19.2.3 / React Native 0.86.3. These versions do not change the production Next.js
workspace or require moving its React version. Expo development-client and safe-area support are
included for the native proof. TypeScript/tsx and React/Node typings are development dependencies.
The optional browser check uses the repository's existing Playwright package.

There is no EAS project, hosted build, deployment, telemetry requirement or credential in the proof.
Generated `node_modules`, `.expo` and `dist` are ignored. Do not submit this harness to an app store.

## Reproduce

From this directory, with Node 22:

```sh
npm ci
npm run check
npm test
CI=1 EXPO_NO_TELEMETRY=1 npm run export
```

On the shared development machine, wrap builds/tests in `flock /tmp/atc-build.lock` and run one
at a time. The export produces **JavaScript/Hermes bundles**, not signed installable apps.

`npm run web` starts a local-only browser dev server. On a machine with Xcode or the Android SDK,
`npm run ios` / `npm run android` generate and build a local native development app. Actual SDK,
simulator/device and signing requirements must be met there. `npm start` connects an already
installed development client. Native build prerequisites are not present on the current Linux
workspace; no hardware run is claimed.

After exporting, the repository/shared-browser review command is:

```sh
flock /tmp/atc-build.lock node docs/proposals/assets/captain-client-proof-2026-09-23/browser-check.mjs
```

Run that command from the repository root after its normal `pnpm install`. By default it attaches
to the existing shared Chromium at loopback `9222` (override `CHROME_CDP_URL` if needed), opens one
tab, serves exported files through Playwright interception and closes only its own tab. It does not
start a network server or change Tailscale routes. With `--headless` it launches its own headless
Chromium instead, for isolated machines such as CI. PNG evidence is written into `evidence/`, or
into `PROOF_EVIDENCE_DIR` when set; a failed check also saves `failure.png` there.

## Continuous integration

The `client-proof` GitHub Actions check (`.github/workflows/client-proof.yml`, added in
[#120](https://github.com/SomedaySomehowBeer/askthecaptain/pull/120)) runs when this
harness's code, the workflow or the shared Playwright dependency changes; Markdown and `evidence/`
edits alone do not trigger it. It runs `npm ci`, `npm run check`, `npm test`, the web/iOS/Android
bundle export and `browser-check.mjs --headless`, and keeps the browser screenshots as a workflow
artifact for seven days. Like the local run, it proves the fictional harness and the bundle
exports in Chromium on Linux; it does not install, sign or run anything on an iPhone or Android
device, so native-device acceptance below stays unverified.

## Acceptance still required

- iPhone/Android installable development builds, real pinch/pan arbitration, software keyboard,
  rotation, back navigation, safe areas, screen reader and text scaling.
- Actual device performance with representative first-customer data, slow loading and long history.
- Correct reading-position preservation during older-history loading and incoming remote messages.
- Integration into a representative Next.js page and comparison with this Expo web surface before
  changing the web recommendation. This harness has not proved that Next.js should be replaced.
- Production auth, cache/offline policy, push, deep links and per-tab navigation restoration.
- Server/API schema, RLS and concurrent booking writes. Pure interval tests cannot establish
  transactional scheduling correctness; no Postgres integration suite applies to this harness.

See [evidence](evidence/README.md) for executed checks and the decision status.
