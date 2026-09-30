# Mobile sign-in composition, account provider and account screens

Status: **reviewed implementation contract**, 27 September 2026. The contract was adopted in #195.
Its implementation adds app code, build configuration and the CI harness export; it changes no
dependency, runtime flag, DNS or deployment. Next M-auth increment under the adopted
[foundation contract](expo-mobile-foundation-2026-09.md) (§4 session, §5 links, §6 shell, §9 step 5),
after the [platform adapters and account state](expo-mobile-platform-account-2026-09.md) (#193,
merged as e91d258).
The approved [mobile mockups](../proposals/assets/captain-mobile-2026-09-22/README.md) (D14) leave
account/settings screens "still to design" (`views.md`); this designs them in the mockups' existing
header, notice and page language, with no new visual vocabulary.

Outcome: on a development build a person can sign in, see honestly where that stands, choose an
organisation and sign out, so later increments can show real Work, Chat and Resources.

Root decisions already taken: gate with `Stack.Protected`; a bounded, coalesced foreground refresh
(30-second spacing; a longer server `Retry-After` wins); record links not yet supported stay deferred,
while valid tab destinations are kept through sign-in; the test harness is selected only by
`CAPTAIN_MOBILE_HARNESS` in build configuration (§7.1).

## Implementation status (27 September 2026)

**Implemented.** Ownership is as in §9, with reciprocal review. All 185 mobile tests, the four
exports, boundary scans and browser checks at 360/390/430 px pass; see the
validation record (validation record removed in the chat-first rebuild; see git history). Sections 1–9 below remain the
reviewed contract and its starting point. Where the implementation settled a detail differently, this section is
current.

- **Composed app.** `src/app/_layout.tsx` renders the account provider over the one per-process source
  (`src/account/instance.ts`, composing through `src/platform/app-account.ts`) and `AccountStack`. The routes are
  welcome, organisation and Account (`settings`), plus the index redirect.
- **What it does not do.** The tabs show no business data: no business read or write exists. Native sign-in stays off on
  shared staging and for real accounts. Nothing is installed or usable on a device, and no simulator or device evidence
  exists (§8 gates remain open).
- **Two web exports.**
  - The production web export (default router root, harness variable unset) is web-only: no sign-in, no native
    authentication, and no harness marker or `harness/app` path. Its bundles are scanned for that.
  - The synthetic harness is a separate web-only export (`dist-harness`). It renders the production `AccountStack`,
    screens and tabs over a scripted, token-free account source. It uses no API, credentials or account data, and is
    never deployed.
- **Organisation changes (§4.1, as implemented).** When the person or organisation changes while ready (a switch, or a
  loss that auto-chooses the one remaining membership), the root stack is reset by its navigator key to one new tabs
  route with no nested state. This replaces the planned `getId` keying: `getId` is not consulted on replace and is
  deprecated. Losing ready (to the chooser, sign-out or a 401) is handled by the guard, which removes the tabs route and
  its state. If the stack is ever not found, the tabs guard closes for one commit and a fixed console error is logged
  (fail closed).
- **Cold-launch destination (§4.7, as implemented).**
  - A valid tab route the app was opened at is captured once, before any guard redirect, and kept for the life of the
    process.
  - It is the `returnTo` of every sign-in in that process, including one after a later sign-out.
  - It is opened once, when a restored saved session first becomes ready with no sign-in destination.
  - A later sign-in's own verified destination is applied as before. Record links are still not carried.
- **Clock (§3, as implemented).** `Cleanup.retryAfterMs()` replaced `retryAt()` (and
  `Attempts.pendingCleanupRetryAfterMs()` replaced `pendingCleanupRetryAt()`). One clamped monotonic clock, created in
  `compose`, is shared by the runner, both cleanups, the attempt core and the source's `now`.
- **Wording (§4.2, as implemented).**
  - `unverified` claims no failed request: "Captain can't check your saved sign-in yet." under a server wait (nothing
    was sent); otherwise "Captain couldn't check your saved sign-in with the server. It is still saved on this phone."
  - The releasing heading is "Ending the session…" only while a revocation is under way; otherwise "Removing the saved
    sign-in…" or "Signing out…".
- **Tab notices.** Work, Chat and Resources now say that the app doesn't read that data yet, rather than asking the
  person to sign in.

## 1. Starting point (#193 as merged, e91d258; installed SDK source in the platform checkout)

- `src/auth/`: attempt core, exchange, callback check, cleanup helper (#189).
- `src/platform/`: `authPlatform` (null off iOS/Android), async `openDeviceStorage()`, `nativeSend`
  (the only `expo/fetch` binding); nothing runs at import.
- `src/api/client.ts`: `apiOrigin`, `createTransport({ origin, send })`, `createApiClient`.
- `src/account/`: `createCredentialStore`, the reducer, `createAccountRunner` (`start`, `snapshot`,
  `send`, `subscribe`, `organisationRead`), `parseMe`. **`snapshot()` currently builds a new object on
  every call** (`viewOf(machine)`), which §3 fixes before any React subscription.
- `src/app/`: `(tabs)`, `settings` placeholder, `link-not-allowed`, `index` → `/work`;
  `+native-intent.tsx` sends sign-in callbacks to the refusal page.
- Browser coverage today: `apps/e2e/scripts/mobile-shell-check.cjs` over the web export (tabs,
  per-tab history, back, view lists, refused links, 360/390/430 pt).
- Installed facts: `redirectSystemPath` may return `null` for no navigation
  (`expo-router/build/types.d.ts:35-46`, `link/linking.js:117-124`, `getLinkingConfig.js:67-82`);
  `Stack.Protected` with `guard: boolean` (`views/Protected.d.ts`); the router root is the app
  config's `extra.router.root`, default `src/app` (`@expo/cli/build/src/start/server/metro/router.js:107-123`).

## 2. Composition

A pure `compose(deps)` (`src/account/compose.ts`) builds the graph from injected parts, so node
tests cover it; one typecheck-only binding (`src/platform/app-account.ts`) passes the installed
modules.

1. **Platform.** Not iOS/Android, or `authPlatform === null`: result `web-only`. No runner, no
   native auth on the web.
2. **API address.** `apiOrigin(process.env.EXPO_PUBLIC_API_URL, __DEV__)`, read only in
   `src/config.ts`. Refused: result `misconfigured`, no runner.
3. **Storage.** `await openDeviceStorage()` exactly once. While it has not answered, the account
   state is `starting` (§4.2), with the same ten-second slow wording. It is never timed out into
   another attempt: no second composition, no second runner, no second storage open. `available:
   false` gives `createStore: null`.
4. **Transport and client.** `createTransport({ origin, send: nativeSend })`, `createApiClient`.
5. **Two cleanups.** `attemptCleanup` and `runnerCleanup`, both `createCleanup({ transport })`.
   `compose` throws if they are the same object; a test asserts it.
6. **Attempts.** `createAttempts({ platform: authPlatform, transport, cleanup: attemptCleanup })`.
7. **Runner.** `createAccountRunner({ createStore, attempts, client, cleanup: runnerCleanup })`,
   then `start()` (the reducer ignores a second boot).

`compose` returns `{ kind: 'web-only' } | { kind: 'misconfigured' } | { kind: 'ready'; runner }`.

**If composition fails.** Anything that rejects the composition promise (an unexpected throw from a
platform module, say) gives one fixed, frozen `startup-failed` snapshot: "Captain couldn't start
sign-in on this phone. Close and reopen Captain." No error text is shown or logged. Nothing composes
again automatically; only a full restart tries again. This is distinct from storage being reported
unavailable, which is a normal composed result.

### 2.1 How many runners exist: the actual guarantee

- **Release and production-mode builds** evaluate `src/account/instance.ts` once per app process.
  That module holds the single composition promise; a re-render or a React strict-mode double effect
  reuses it. One runner per process: this is the guarantee.
- **Development with Fast Refresh** is different: editing a module can re-execute it and its
  importers, so a module-level value alone does not guarantee a single instance. The plan does not
  claim it does. Instead:
  - `instance.ts` exports no React component and keeps the promise on
    `globalThis[Symbol.for('captain.account.instance')]` in development. A re-executed module finds
    the existing instance and reuses it, never composing a second one.
  - That reused instance still runs the code it was built with. So the development rule, stated in
    the provider's comment and the device checklist, is: **after editing anything under
    `src/auth`, `src/account` or `src/platform`, fully restart the app** (reload the JavaScript
    bundle). A full reload is equivalent to killing the app: in-memory tokens and pending cleanups
    are lost, and remote revocation remains the remedy (foundation §4).
  - No hot-dispose hook is relied on.

## 3. Provider and a stable snapshot

**Snapshot identity (runner change, B's file).** `useSyncExternalStore` requires `getSnapshot` to
return the same value until the store changes. The runner will keep `current = viewOf(machine)`,
recomputed only when `dispatch` produces a machine that is a different object from the previous one,
and before listeners are notified. `snapshot()` returns `current`. Reducer steps that return the same
machine therefore neither allocate nor notify. Still token-free.

`src/account/AccountProvider.tsx` takes an `AccountSource`: `{ subscribe, snapshot, send }`, the
token-free surface the runner already has. Production passes the composed source, and the harness a
scripted one (§7.1). Before and outside a runner, the provider is itself the source:

- **Before composition answers:** frozen `starting` snapshots, one normal and one slow. The provider's
  own ten-second timer switches to the slow one ("Still opening this phone's secure storage. If this
  continues, close and reopen Captain.").
- **After a result without a runner:** frozen `web-only`, `misconfigured` or `startup-failed`
  snapshots.
- **With a runner:** it hands over to the runner's cached snapshot. The runner's own `starting` state
  continues the same wording; once the slow notice has appeared, it stays slow until starting ends.

The provider passes stable `subscribe` and `snapshot` functions directly to `useSyncExternalStore`, without inline wrappers.

Every snapshot the provider returns is a stable object, changed only when the state changes, so
`useSyncExternalStore` never loops. `useAccount()` returns that snapshot and `send`, and never the
runner, handles or tokens. The slow timer never starts a second composition.

- **Foreground refresh.** On an `AppState` transition to `active` it sends `refresh`. The provider
  does no timing of its own; the reducer paces it (below), so repeated transitions cannot bypass it.
- `organisationRead` is not exposed yet (no business read in this increment); the next increment adds
  `useOrganisationRead`, enabled only when ready.

**Pacing of every `/v1/me` load (runner and reducer change, B's files).** One rule covers all four
triggers: the launch check, Try again from `unverified`, a 403/404 refusal and a foreground
`refresh`.

- **Clocks.** Pacing uses a monotonic clock the runner injects (`performance.now()` on Hermes), passed
  in every event that needs time. The runner clamps it so it never goes backwards: a reading lower
  than the last one is treated as the last one. A change to the phone's date or time therefore
  cannot make a wait end early. The wall clock is used only to display a time: when an answer
  arrives, the runner records "about {time}" as wall-now plus the server's delay, for wording only.
- **The revocation cleanups use the same clock.** `createCleanup` already accepts an injected `now`.
  `compose` passes the clamped monotonic clock to both cleanups, so a changed phone clock cannot bring
  a revocation retry before the server's `Retry-After` either.
  - `Cleanup.retryAt()` currently formats its deadline as a date. On a monotonic clock that is not a
    wall time, so a small change in A's file is needed.
  - Replace `retryAt()` with `retryAfterMs(): number | null`. The runner maps the remaining
    duration to a monotonic `waitUntil` for pacing/timers and a wall-clock `about` for display only.
    The token-free account source exposes the same clamped `now` function to screens and harness.
  - One clamped monotonic clock instance is shared by the runner and both cleanups. No date is
    used to decide whether a request may be sent.
- **State kept by the reducer:**
  - `lastLoadStarted`, set whenever any trigger sends `load-me`, including the launch check;
  - `serverNotBefore`, the latest deadline any unavailable answer from any trigger named through
    `Retry-After`. It only ever moves later, never earlier, and is cleared only by a successful
    answer.
- **Rule:**
  - **No send before `serverNotBefore`, from any trigger.** Try again stays disabled, and a refusal
    or a foreground event before then sends nothing; the screen already shows its own refusal.
  - **Foreground `refresh`:** additionally ignored before `lastLoadStarted + 30 s`, and while a load
    is in flight (coalesced).
  - **A refusal:** coalesced with a load in flight. It isn't subject to the 30-second spacing, but it
    is subject to `serverNotBefore`.
  - No other retry limit is added: nothing ever sends before the server's time.
- **Boundary:** a send is allowed at exactly `now >= serverNotBefore` (and `>= lastLoadStarted + 30 s`
  for a foreground refresh), and never at any earlier value. Tests cover both sides of each boundary
  and a clock that goes backwards.

A wait remains in memory across sign-out and a subsequent sign-in: if it blocks the new session's
first membership check, show `unverified` with the wait and Try again, never a silent checking
state. A full process restart resets this in-memory pacing state; test both cases.

A refresh never removes anything by itself. Its answer is applied like any fresh membership list:

- **Still a member:** the organisation and its screens stay.
- **No longer a member:** the organisation generation advances and `forget-org-if` runs. The reducer
  records `orgNotice: { kind: 'lost', name }`, where `name` comes from the membership that was chosen
  (already in the token-free state). `ready` becomes false, the tabs unmount (§4.1), and the chooser
  shows "You no longer have access to {name}."
- **401:** the session is released, and the person sees the ended-session notice.
- **Unavailable:** nothing changes, and `serverNotBefore` takes the server's time if it is later.

**Access loss invalidates business views.** Every business read will go through `organisationRead`,
which answers `superseded` if the handle or organisation generation changed while it was in flight.
All business state lives under the tabs subtree, keyed by `userId:organisationId`, so an organisation
change, loss or sign-out unmounts it: no record, cursor, draft or tab stack from before stays
reachable (foundation §4).

## 4. Navigation and screens

### 4.1 One route hierarchy

All root navigation logic lives in one production component, `src/account/AccountStack.tsx`: the
protected `Stack`, `routeFor` and the destination step. Production's `src/app/_layout.tsx` renders
`<AccountProvider source={composed}><AccountStack /></AccountProvider>`, and the harness layout renders
the same `AccountStack` inside a provider given a scripted source. Neither layout contains any other
routing logic, so the harness tests the production code and nothing is duplicated.

Two derived flags: `signedIn` is `account.kind === 'signed-in'`; `ready` is `signedIn` with
`org.kind === 'chosen'`. `AccountStack`'s `Stack` is flat:

```
<Stack>
  <Stack.Protected guard={!signedIn}>  welcome                  </Stack.Protected>
  <Stack.Protected guard={signedIn}>   organisation             </Stack.Protected>
  <Stack.Protected guard={ready}>      (tabs)   settings        </Stack.Protected>
  link-not-allowed
</Stack>
```

- `welcome` renders every state that is not signed in (§4.2).
- `organisation` is available whenever signed in: as the chooser while not ready, and as "Switch
  organisation" from Account while ready.
- `(tabs)` and `settings` exist only when ready. `(tabs)` is keyed by `userId:organisationId`.
- One pure `routeFor(view)` decides where the person should be: `(tabs)` when ready, `organisation`
  when signed in but not ready, otherwise `welcome`. `AccountStack` calls `router.replace` when that
  answer changes, never `push`, so Back never returns to a state that no longer holds.
- **The index route cannot bypass the guards.** `src/app/index.tsx` no longer redirects to `/work`
  unconditionally. It redirects to `routeFor(view)`, so an unready person reaching `/` lands on
  `welcome` or `organisation`, never on a tab.
- **The destination is replaced once.** When `ready` becomes true with a non-null `destination`,
  `AccountStack` replaces to it once, then sends `destination-used`. A ref keyed by the account and
  organisation generation stops a strict-mode double effect or a re-render from replacing twice, and
  `routeFor` does not also replace in that same step.

### 4.2 `welcome`: every state that is not signed in

`PlainScreen` language (26 pt heading, notices, 44 pt targets), no tab bar, no fictional data. Copy
comes from one pure table (`src/account/copy.ts`).

| Snapshot | Heading | Body | Actions |
|---|---|---|---|
| web-only | Captain | Signing in isn't available in this preview. Use Captain on the web. | Open Captain on the web (§4.6); none when the web address is not valid |
| misconfigured | Captain | This build has no valid Captain address. | none |
| `starting` (provider before composition, then the runner's own) | Captain | Opening… / slow (the provider's or the runner's ten-second timer): Still opening this phone's secure storage. If this continues, close and reopen Captain. | none |
| `startup-failed` | Captain | Captain couldn't start sign-in on this phone. Close and reopen Captain. | none |
| `storage-unavailable` | Captain | This phone can't keep a saved sign-in, so Captain can't sign in here. | none |
| `storage-unreadable` | Couldn't read your saved sign-in | Captain couldn't read the sign-in saved on this phone. | **Try reading again** (primary); Sign in again (secondary: "Signing in again replaces the saved sign-in on this phone. If that sign-in was still active, it stays active until it expires.") |
| `signed-out` | Sign in to Captain | You'll continue in your browser with Google, and a passkey if you have one. | **Sign in with Google** |
| `signed-out` with a sign-in notice | as above | cancelled: Sign-in was cancelled. callback-invalid: Sign-in didn't come back to Captain correctly; nothing was sent. native-disabled: Signing in from this app isn't available on this Captain. cannot-finish: Captain couldn't finish signing in; start again. start-again: …; start again in a moment. uncertain: Captain couldn't confirm the sign-in; start again. busy: Captain is still finishing a previous step. | Sign in; busy: Try again |
| `signed-out` with a released notice | Signed out | §4.3 | Sign in |
| `signing-in` browser / closing / saving | Continue in your browser / Closing the sign-in window… / Saving your sign-in… | slow wording after ten seconds | browser: Cancel |
| `checking` | Checking your saved sign-in… | | none |
| `unverified` | Couldn't check your saved sign-in | Captain couldn't reach the server. With a server wait: "Try again after about {time}." Never "signed in". | **Try again** (disabled until the wait ends), Sign out |
| `releasing` | Signing out… / Ending the session… | §4.3 | Try again when `canRetry` |
| fault or strays (any state) | adds: "Captain hit an unexpected problem with a sign-in on this phone." Then, only from the stray's actual state: revoking: "Captain is ending that session."; pending or refused: the §4.3 not-ended wording; no stray (fault only): nothing more. It never says a session is being ended unless a revocation has begun. | §4.3 per stray | Try again when `canRetry` |

A button the state forbids is shown disabled, with its reason, never hidden.

**Buttons that wait for a time.** A button disabled until a server wait ends (`unverified` Try again,
and a release's Try again while its cleanup reports a retry time) needs a re-render when the wait
ends, because nothing else changes then. The screen sets one UI-only timer for the remaining time,
measured on the same monotonic clock as the snapshot, and cleared on unmount or change. When it
fires, the component re-renders and enables the button. The timer only re-renders: it sends nothing,
and the reducer still refuses a press made before the deadline. The harness asserts the button is
disabled just before the boundary and enabled just after it (§7.1).

### 4.3 Sign-out wording

As reviewed:

- **Deleted or no usable copy:**
  - ended: "Signed out."
  - pending or refused: "Signed out on this phone. Captain couldn't confirm that the session has
    ended." With Try again. No expiry date is shown, and nothing is inferred from the phone's clock.
- **Copy may remain:**
  - ended: "Signed out. A saved copy may remain on this phone, but it no longer works."
  - pending or refused (the close-app warning): "Your saved sign-in may still be on this phone and the
    session hasn't ended. If you close Captain now, you may still be signed in the next time you open
    it." With Try again.
- **Prefixes by reason:** `session-ended` adds "Your session has ended. Sign in again." `save-failed`
  begins "Captain couldn't save this sign-in on this phone."
- **Sign-out confirmation:** it says "Uninstalling Captain doesn't sign you out."

### 4.4 `organisation`

- **Choose:** "Choose an organisation", one row per membership (name and role) from the latest
  applied list.
- **Loss notice**, from the reducer's token-free `orgNotice`, cleared when an organisation is chosen:
  - `{ kind: 'lost', name }`: the organisation was chosen and named in an earlier applied list, and
    the fresh list no longer has it. "You no longer have access to {name}."
  - `{ kind: 'lost-unnamed' }`: at launch only the stored ID is known, and the fresh list doesn't
    include it. "The organisation Captain remembered for you isn't available to you any more." No
    name is invented or fetched.
- **None:** "You aren't in an organisation yet. Organisations are created and joined on the Captain
  website." With Open Captain on the web, and Sign out.
- **Switching from Account:** the current organisation is marked. Choosing another remounts the tabs
  and lands on `/work`.
- **Not remembered:** "Captain will use this organisation now but couldn't remember it for next
  time."

### 4.5 Account (`settings`)

- Name and email, the organisation and role.
- Switch organisation, and Sign out (with the confirmation).
- "Organisation creation, invitations, passkeys and other settings are on the Captain website", with
  a link.
- `refreshing` shows "Checking your access…" without hiding the page.

### 4.6 Opening the website

Every "Open Captain on the web" and "other settings" link opens only the configured web origin:
`apiOrigin`'s rule applied to `process.env.EXPO_PUBLIC_APP_URL` in `src/config.ts` (https, or loopback
http in development; no path, query, credentials or default port), plus a fixed path from a small
allow list (`/`, `/settings`). The URL is built as text from those two parts, never from anything a
server or link supplied, and opened with the platform's external browser (`Linking.openURL`), not the
authentication session. If the configured value is refused, the links are not shown and the page says
"The Captain website address isn't set in this build."

### 4.7 Return destination

- Sign-in passes a valid tab route when the person started from one (`/work`, `/work/views`, `/chat`,
  `/chat/views`, `/resources`, `/resources/views`, `/resources/inventory`). The attempt core and the
  API refuse anything else.
- The snapshot exposes `destination` only when ready. `AccountStack` calls `router.replace` with it
  once, then sends `destination-used`.
- Record links, which the link rule does not allow yet, are not carried through sign-in in this
  increment.

## 5. The sign-in callback without a refusal flash

- iOS returns the callback only to `openAuthSessionAsync`, so there is nothing to route. Android also
  delivers it as a system link (A's adapter notes).
- `redirectSystemPath` returns **`null`** for the exact callback forms
  (`app.askthecaptain.dev:/auth/callback` with or without a query, and the empty-host `//` form). The
  router then does not navigate and never sees the code or attempt; the welcome screen keeps showing
  "Continue in your browser" until the attempt core, the only acceptor, settles.
- Every other `/auth/*` path and every lookalike still goes to the refusal page. Nothing is logged.
- A cold start from the callback (the app killed mid-sign-in) opens the normal initial route.

## 6. Dependencies and configuration

- **No new dependency.** Uses the installed `expo-crypto`, `expo-web-browser`, `expo-secure-store`,
  `expo/fetch`, `expo-router` and React Native's `AppState`. No AsyncStorage.
- **No new runtime environment variable** (still only `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_APP_URL`).
- **No production `app.json` change.** The harness's build-time selection is in §7.1.
- **No API, schema, flag or DNS change.** `NATIVE_SIGN_IN` stays off on shared staging and for real
  accounts; proofs use an isolated synthetic environment (foundation §3.4).

## 7. Tests

### 7.1 Test-only account harness (browser, existing tooling)

Keeps today's Work/Chat/Resources browser coverage and adds rendered proof of the account screens and
their action wiring, without any native auth on the web and outside production routing.

- **A separate router root.** `apps/mobile/harness/app/`, used only when the web export runs with a
  harness app config.
  - `app.config.ts` spreads `app.json` and, only when `CAPTAIN_MOBILE_HARNESS` is exactly `1` at build
    time, sets `extra.router.root` to `harness/app`. Any other value, or none, leaves the default
    `src/app`.
  - Production exports run with the variable explicitly unset: CI's production export step clears it,
    and the harness export is a separate step with its own output directory.
  - The production export never includes the harness files, because the router root decides the
    bundled route context.
  - The boundary guard (A's file) gets one narrow allowance: that variable, read in `app.config.ts`
    only, and nowhere in `src/` or the harness routes.
  - **Web export only.** `app.config.ts` throws when the variable is `1` and any native build signal
    is present (`EAS_BUILD` set, or a native `expo run`/prebuild). The guard also fails if
    `eas.json` (should one ever be added) or any CI step other than the web harness export sets it.
    Local prebuild/run detection is best effort, not a guarantee against every invocation. The
    harness CI export explicitly uses `--platform web`; clean production iOS/Android exports and
    their canary scans provide the recorded bundle evidence. Actual native artifacts remain a
    separate device/build gate.
  - **A marker that survives minification.** The harness layout exports and renders a fixed marker
    (`CAPTAIN_MOBILE_HARNESS_7f3a`) as the `testID` of an element it puts on the page. Because the
    value is used at run time, the minifier can't drop it.
    - The harness export check asserts the marker **is** present, proving detection works on minified
      output.
    - The production web, iOS and Android canary asserts it, and any `harness/app` path, **is not**.
- **Harness routes re-export the real ones.** For example, `harness/app/(tabs)/work/index.tsx`
  exports `default` and `unstable_settings` from `src/app/(tabs)/work/index.tsx`, and likewise for
  `welcome`, `organisation`, `settings`, `index` and the tabs layouts. The screens under test are
  the production components.
- **The harness layout** renders the production `AccountStack` (§4.1) inside the real
  `AccountProvider`, given a scripted `AccountSource`: the same `subscribe`/`snapshot`/`send` surface
  as the runner, never a token. It adds only the marker and the command log, never routing logic.
  - **The scenario survives route changes.** The scenario is read once from the initial page URL
    (`?scenario=ready`, `signed-out`, `unverified-retry-at`, `releasing-warning`, `choose`, `none`,
    `lost-named`, `lost-unnamed`, `storage-unreadable`, `startup-failed`, `fault`, …). It is kept in
    the harness provider's state, so an `AccountStack` replace that drops the query doesn't reset it.
    Playwright selects a scenario only by loading a new page.
  - Every `send` is recorded to an on-page, harness-only list that Playwright reads.
- **Playwright** (`apps/e2e/scripts/mobile-shell-check.cjs`, extended; same loopback server):
  - `scenario=ready`: every existing tab, history, back, view-list and refused-link check, unchanged.
  - Each account state: the heading, notices, enabled and disabled buttons, and the close-app
    warning at 360/390/430 pt.
  - **Action wiring:** tapping Sign in, Cancel, Try again, Try reading again, Sign out, the confirm
    step, choosing and switching an organisation, and the web links records exactly the expected
    commands. A disabled button records nothing.
  - **Transitions:** scripted snapshot changes (ready to lost organisation, ready to releasing)
    replace the route and unmount the tabs.
  - **Subscription stability:** with a steady snapshot, the harness's render counter stays constant
    for two seconds (no render loop).
  - **Time boundaries:** Playwright's clock control drives the page's timers. `unverified-retry-at`
    shows Try again disabled 1 ms before the scripted deadline, with a press recording nothing, and
    enabled after it, with a press recording `retry`. The same applies to a release with a retry
    time.
  - **Guards:** loading `/` or `/work` in a scenario that isn't ready lands on `welcome` or
    `organisation`, never a tab. A scripted destination is replaced exactly once and followed by
    one recorded `destination-used`.
- **The production web export** is still checked separately: web-only welcome, no sign-in button, no
  native auth, no harness marker.

### 7.2 Node tests

- **`compose` and the provider source:**
  - web-only;
  - misconfigured, without repeating the value;
  - storage unavailable, meaning no store and no sign-in;
  - a storage open that never answers stays `starting`, turns slow after ten seconds on the provider's
    own timer, and builds nothing twice;
  - a rejected composition gives the fixed `startup-failed` snapshot and no second attempt;
  - the provider's snapshots are identical objects until they change;
  - the two cleanups are distinct (and `compose` throws when given one object twice);
  - `start` runs once.
- **`instance.ts`:** a second evaluation with the development global present reuses the instance.
- **Runner snapshot:**
  - `snapshot() === snapshot()` with no event;
  - a new object after a changing event;
  - the same object after an ignored event;
  - listeners are not notified for an unchanged machine;
  - token-free.
- **`/v1/me` pacing (§3):**
  - the launch check counts as a load start, so a foreground refresh within 30 s of launch sends
    nothing;
  - an unavailable answer from each trigger (launch, Try again, refusal, refresh) sets
    `serverNotBefore`, and a later shorter `Retry-After` never moves it earlier;
  - no trigger sends before it, and each sends at exactly the boundary;
  - a clock reading that goes backwards is clamped, and a wait never ends early;
  - a successful answer clears it;
  - a burst of 20 `active` transitions sends one `load-me`;
  - coalescing with an in-flight load, including one from a refusal;
  - loss sets `orgNotice` to the named form when a chosen membership disappears, and the unnamed
    form when a stored ID alone is not a membership; the notice clears on choosing;
  - 401 releases; unavailable keeps state.
- **Pure logic:** `routeFor` (including the index route for every state), the copy table (every state,
  with no expiry date or clock-based claim in any wording), the tabs key, the destination applied once
  only when ready, and the wait-timer calculation (remaining time from the monotonic deadline; nothing
  sent when it fires).
- **Links:** the callback forms map to `null`; lookalikes and other `/auth/*` paths go to the refusal
  page; existing vectors unchanged.
- **Website links (§4.6):** only the configured, validated `EXPO_PUBLIC_APP_URL` origin plus an
  allow-listed path. A refused or missing value hides the links, and the error never repeats the
  value.
- **Fault copy:** a fault with no stray, and a stray whose revocation has not begun, never produce
  "ending" wording.

## 8. Device gates (not provable on Linux)

With the flag on only in an isolated synthetic environment, on iOS (simulator or device) and Android
(emulator or device):

1. Sign in, cancel, dismiss and back; `closing` after cancel; a second tap while the browser is open.
2. Android: no refusal flash on the callback; no query in any route, state or log.
3. SecureStore:
   - a saved sign-in survives restart;
   - reading on a locked device shows unreadable, with Try reading again;
   - a delete is confirmed by reading back;
   - reinstall (on iOS `/v1/me` decides);
   - a slow first storage open shows the waiting notice.
4. `expo/fetch` refuses redirects, including on an encoded organisation path.
5. Offline and 429 at launch and on foreground: "couldn't check", with Try again at the right time;
   refresh bursts send once.
6. Organisation switch and loss: the tabs remount, and nothing from before is reachable.
7. VoiceOver and TalkBack read every state's heading, notice and action.
8. Development rule: after editing auth, account or platform code, restart fully before testing sign-in.

No simulator or device evidence is claimed at merge.

## 9. Ownership and decisions

| Owner | Files |
|---|---|
| Claude `business-views` | `src/platform/app-account.ts` (including the monotonic clock binding), the `auth/cleanup.ts` change that separates monotonic pacing from the displayed retry time (§3), `src/config.ts`, `+native-intent.tsx`/`lib/links.ts` callback mapping and tests, the guard allowance and native/EAS refusal for the harness variable, `app.config.ts` |
| Claude `linked-chat` | `src/account/{compose,instance,copy}.ts`, `AccountProvider.tsx`, `AccountStack.tsx`, the reducer and runner changes (snapshot caching, one pacing rule for every `/v1/me` load, `orgNotice`, the clamped monotonic clock), the `welcome`/`organisation`/`settings`/`index` routes and `_layout.tsx`, `harness/app/**`, node tests |
| Codex | The Playwright harness run and export canary, integration, evidence, docs |

Decided by root: `CAPTAIN_MOBILE_HARNESS` in build configuration only, with production exports
explicitly unset (§7.1); 30-second foreground spacing, with a longer `Retry-After` winning (§3).
Claude A reviewed revision 4 and approved the direction; root resolved the small implementation
notes above (one clock, remaining-delay cleanup API, explicit wait UI and honest native-build
limits). Claude B authored the contract. Implementation still requires reciprocal code review,
applicable tests and green CI. In the later business-read increment, repeated 403/404 refreshes
must have their own spacing or an explicit no-automatic-retry rule; do not introduce a read loop.
