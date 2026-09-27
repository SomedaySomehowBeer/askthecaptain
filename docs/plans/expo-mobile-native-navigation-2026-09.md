# Mobile native section-stack navigation contract

Status: adopted by this planning amendment, 27 September 2026. Outcome: **manage shared work** through predictable navigation.
Source evidence is from the installed Expo Router 57.0.23 and Captain after #201/#202. This is a plan only;
no implementation or native/device evidence is included. Native sign-in stays off.

**Outcome.** On iOS and Android, a section's view list is beneath the open view for the entries E1–E12 (§3.2,
§3.2a), and in the boot and remount cases of §3.0 other than L2. The first rendered state is already that shape, so no
wrong screen renders and no extra read is sent. "Go to My work" goes to My work, without a second `(tabs)`. The web
is unchanged.

**Two unchanged known limitations** (existing behaviour, neither introduced nor fixed here):
- **L1:** a warm link to a section's view list while that section's stack is deeper pushes a second view list (§3.5);
- **L2:** an `AccountStack` remount while ready on `/organisation` with retained navigation state replaces that page
  with a second `(tabs)` route (§3.0, case R-org).

Both are data-safe. Neither is claimed fixed.

**Unchanged:**
- the routes and the link allow list;
- return-path security;
- the guards, epochs, requested-route one-use rule and destination rule;
- every read rule;
- the web export, the harness, and the browser expectations.

## 1. Source facts

**App** (current `main`):
- **`SectionStack`** (`components/SectionStack.tsx:7-13`) declares only `index`, and passes only `screenOptions`.
- **`sectionStackSettings`** (`:23`) is native `{ initialRouteName: 'views' }` and web `{}`. It is exported as
  `unstable_settings` by the three section layouts.
- **`Screen.toViews`** (`components/Screen.tsx:17-21`) calls `dismissTo(viewsHref)` if `views` is in the stack,
  otherwise `push`. The comment at `:15` ("always, on iOS and Android") **overclaims** today, and is corrected in the
  implementation (§3.6).
- **`ViewList`** rows (`components/ViewList.tsx:43`) call `router.navigate(href)`.
- **`TabBar`, first visit** (`components/TabBar.tsx:43`; `route.state === undefined`): native `{ screen: 'index',
  initial: false }`, web `{ screen: 'index' }`.
- **The reset** (`account/copy.ts:124-125`) is `RESET { index: 0, routes: [{ name: '(tabs)' }] }`, targeted at
  `findAccountStack`'s key (`AccountStack.tsx:47-51`).
- **`router.replace` sites** in `AccountStack.tsx`:
  - the verified destination (`:52-54`);
  - the requested route (`:55-56`);
  - becoming ready, `/work` (`:57-58`);
  - the fail-closed reopen, `/work` (`:64-68`).
- **`Home`** (`app/index.tsx:7-10`) renders `<Redirect href={routeFor(account)} />` whenever `/` is focused.
  `linkTarget('/')` gives `/work` (`lib/links.ts:19`), so `/` is reached only by the router's own start state, never
  by a link.
- **The other app-initiated replaces** (a complete `grep` of `router.(replace|navigate|push|dismissTo|back)` and
  `<Redirect`):
  - `components/RefusedLink.tsx:8`: `router.replace('/work')`, labelled "Go to My work";
  - `app/settings.tsx:15`: `back()` if `canGoBack()`, else `replace('/work')`;
  - `app/organisation.tsx:21`: the same, when the chosen organisation is already current;
  - `app/organisation.tsx:56`: `back()`, else `replace('/settings')`. That isn't a tab route, so it isn't a tab entry
    and is unchanged.
- **Tabs navigator:** `(tabs)/_layout.tsx:14` declares `work`, `chat`, `resources` in that order, with no
  `initialRouteName`, so `TabRouter.getInitialState` focuses `work`, the first. `backBehavior` is `firstRoute` on
  native.
- **`AccountStack` guard order** (`AccountStack.tsx:71-84`):
  - `welcome` (not signed in);
  - `organisation` (signed in);
  - `(tabs)` and `settings` (ready and not closed);
  - `index`;
  - `link-not-allowed`.
- **The account machine** starts in `starting` (`machine.ts:181`). Ready needs a storage read, `/v1/me` and the
  organisation read, all asynchronous, so **no first render at process boot is ready**. An `AccountStack` remount
  under the process-wide account can be ready (§3.0).
- **Incoming links** go through `+native-intent.tsx` → `systemLinkTarget` (`lib/links.ts:73-76`). Warm links arrive
  with `initial: false` (`link/linking.js:109,120`).

**`expo-router` 57.0.23:**
- **R1. The linking anchor.** `unstable_settings.initialRouteName` becomes the layout's linking `initialRouteName`
  (`getRoutesCore.js:651-676`, `getReactNavigationConfig.js:59-64`).
  - `getStateFromPath` inserts the anchor before the target **only when the target differs from it**
    (`fork/getStateFromPath.js:450-466, 469-498`).
  - So `/work/views` builds `[views]`, never `[views, views]`.
- **R2. What reaches the navigator.** The Stack wrapper forwards the layout's own props to the navigator
  (`layouts/withLayoutContext.js:128`), so an explicit `<Stack initialRouteName>` reaches it. Today none is passed.
  - `Stack` forces `UNSTABLE_router: stackRouterOverride` (`layouts/StackClient.js:433`), so an app can't supply its
    own router override.
  - That override changes only `PUSH`/`NAVIGATE`/`PRELOAD` (`StackClient.js:82-105, 253`). `REPLACE` and `RESET` are
    React Navigation's.
- **R3. Route-name order** (`useScreens.js:63-119`): the declared screens in order, then the remaining route files,
  sorted with `sortRoutesWithInitial(initialRouteName)`.
- **R4. The stack router** (`react-navigation/routers/StackRouter.js`):
  - `getInitialState` uses `initialRouteName` if it is present, else `routeNames[0]`, with a fresh key (`:52-70`);
  - `getRehydratedState` keeps the given routes, gives each missing key a fresh `${name}-${nanoid()}`, and sets
    `index = routes.length - 1` (`:72-118`);
  - `getStateForRouteNamesChange` only **filters** routes. It adds a route only if none remain, and then it is
    `initialRouteName` or `routeNames[0]` (`:119-139`);
  - `REPLACE` swaps the focused route for a new one from `createRouteFromAction`, with a fresh key (`:154-176`).
- **R5.** A navigator throws if `initialRouteName` isn't one of its screens (`core/useNavigationBuilder.js:220-224`).
- **R6. A navigator's first render** (`core/useNavigationBuilder.js`):
  - **route state present** (a nested state from RESET or linking): it is rehydrated (`:309-345`);
  - **`params.screen` with `initial !== false`**: the state is only `[screen]` (`:188-201`);
  - **`params.screen` with `initial === false`**: `getInitialState` (`:309-322`), then `navigate(screen)` applied
    **in the same render** (`:415-451`), and that result returned at once (`:476`). No intermediate state renders;
  - **nothing**: `getInitialState` alone.
- **R7. `withAnchor`** sets `initial = false` on every nested level of the action's params
  (`global-state/getNavigationAction.js:60-81`). The action's target navigator and payload come from the **last
  route** at each level (`global-state/stateUtils.js:10-30, 42-86`), so the linking anchor in the action's state is
  not itself dispatched. Only `initial: false` matters.
- **R8. `NAVIGATE` in a stack** (`StackClient.js:83-105`) reuses the **current** route, or a `getId` match, or the
  last same-named route when `pop` is set. Otherwise it **pushes**.
- **R9. Warm links** (`fork/useLinking.native.js:148-176`) use `getStateFromPath` and then `getActionFromState`
  (`react-navigation/core/getActionFromState.js`):
  - the nested levels become `NAVIGATE` params;
  - a level whose state is `[anchor, t]` becomes `{ screen: t, initial: false }` (`:63-69`);
  - a single-route level becomes `{ screen: t, initial: true }` (`:59-62`);
  - `pop: true` is set on navigator-containing levels (`:43-45, 74-77, 85-91`), **but not on the section leaf**.
- **R10. Tabs rehydration.** `TabRouter.getRehydratedState` builds every tab from `routeNames`, keeping the given
  routes and creating the rest with no state (`routers/TabRouter.js:121-135`).
- **R11.** `UNSTABLE_routeNamesChangeBehavior` (the "reuse the last unhandled state" behaviour) is not set by the
  app or by `expo-router`'s `Stack`, which only passes it through (`useNavigationBuilder.js:340, 363, 404, 418`).

## 2. Target stack shapes (native)

For a section with view list `views` and target `t`:
- `[views]` if `t` is `views`;
- otherwise `[views, t]`.

For example, Work default `[views, index]`, All tasks `[views, all]`, inventory `[views, inventory]`.

**Keys:**
- every route in a newly built stack gets a fresh key (R4);
- no payload carries a key.

**The first rendered state is the target shape:**
- no render of `[views]` alone on the way to `[views, t]`;
- no render of `[t]` alone;
- `views` never reads;
- `t` mounts once and reads page 0 once.

## 3. Design

### 3.0 When `(tabs)` can first render: boot and remounts

The account source is process-wide: `accountInstance` in `app/_layout.tsx:14` is composed once per process.
`AccountStack` can remount under it: `requested.ts` and `navMount` exist for exactly that. So the first `AccountStack`
render is not always the process's first render, and the account can already be ready. The app source doesn't show
whether a remount keeps the navigation container's state, so both kinds are covered.

**Case B, process boot.**
- The machine starts in `starting` (`machine.ts:181`). Ready needs a storage read, `/v1/me` and the organisation
  read, all asynchronous, so the first render at boot is never ready and the `(tabs)` guard is closed.
- **A cold link's initial state** for `(tabs)` is filtered by rehydration (R4 `getRehydratedState`). It isn't kept for
  later, because R11 is off.
- **Opening the guard later** only changes `routeNames`: R4 `getStateForRouteNamesChange` filters and never adds. Its
  empty-routes fallback is `routeNames[0]`, which is `organisation` whenever ready, because `organisation` (signed in)
  precedes `(tabs)` in the guard order.
- **So at boot `(tabs)` is created only by E3, E5, E6 or E7 (§3.2),** each of which builds a fresh, anchored
  `(tabs)`.

**Case R-kept, a remount with the navigation state retained** (the container's state survives; only the layout
remounts).
- The account stack re-renders with its existing, initialised state (R6 "route state present", stale `false`).
  - `(tabs)` and every section stack keep their current routes and keys, and nothing is rebuilt.
  - Every shape was produced by the entries of this contract, so it is already anchored.
  - Mounted screens keep their state, and no read is sent by the remount itself.
- **The remount's `navigationStep`** starts from `navMount(requestedConsumed())` (`copy.ts:70`): `route` `null`, `key`
  `null`, and `requestedUsed` true after the first ready.
  - There is no reset: the stored key is `null` (`copy.ts:94`).
  - The requested route has already been consumed, so it isn't reopened.
  - A destination is applied only if `account.destination` is still set. It is cleared by `destination-used`, which is
    sent in the same effect as the destination `replace` (`AccountStack.tsx:52-54`).
  - Otherwise the result is `replace` only when `routeHolds(route, pathname)` is false (`copy.ts:37-41, 101-102`).
- **Per pathname:**
  - **`/work/all`, or any tab or Settings path:** `routeHolds('/work', …)` is true, so nothing happens. The shape is
    kept, for example `[views, all]`.
  - **`/`:** `navigationStep` returns `none` (`copy.ts:101`). `Home`, if focused, redirects with `withAnchor` (E7).
    The account stack's focused route is `index`, and a `(tabs)` route may lie beneath it. `REPLACE` swaps `index` for
    a **new** `(tabs)` route (R4). **Source note:** `/` while ready is reachable only transiently (`Home` redirects on
    every focus, and no link maps to `/`, since `linkTarget('/')` gives `/work`). If a `(tabs)` route is beneath it,
    the result is the same duplicate as R-org, so that case is included in L2.
  - **R-org, `/organisation`** (a deliberate switcher visit while ready): `routeHolds('/work', '/organisation')` is
    false, so `navigationStep` returns `replace('/work')`.
    - The account stack is `[(tabs), …, organisation]`, and R4 `REPLACE` swaps `organisation` for a **second**
      `(tabs)` route.
    - The old `(tabs)` stays mounted beneath, still bound to the same scope, so it isn't inert but sends no reads. The
      new one is anchored (E3), and its My work reads once.
    - **This is today's behaviour:** without `withAnchor`, the new Work is `[index]`, but the duplicate is the same.
      It is recorded as **L2, unchanged**.
    - A fix (for example seeding `navMount`'s `route` from the ready account on remount, so a deliberate visit is not
      redirected) is a separate account-navigation decision (§8, 5).

**Case R-new, a remount with a new root navigation state** (the container is rebuilt).
- The state comes from the launch URL again (`getLinkingConfig.js:60-88` memoises it per config; the native launch URL
  is the same). It passes `+native-intent`, and R1 builds it with anchors.
- **The account is already ready,** so the `(tabs)` guard is open in the first render, and the linking-built state is
  **not** filtered.
  - `(tabs)` mounts in that first render, before `AccountStack`'s effect, with the anchored section state from
    `getStateFromPath`.
  - **A launch URL of `/work/all`** gives `[views, all]`. `/work/views` gives `[views]` (R1: no duplicate anchor). The
    tabs level has no anchor, and R10 fills in the other tabs with no state.
  - All tasks mounts once and reads page 0 once, under the current epoch. The old tree was unmounted with the old
    container.
  - The remount's `navigationStep` returns `none` (as in R-kept, `/work/all` holds), so there is no second navigation.
- **A launch URL of `/`, or none:** the state is `[index]`, so `Home` renders and redirects with `withAnchor` (E7).
  `(tabs)` is absent from the new state, so `REPLACE` builds a fresh anchored `(tabs)`: `[views, index]`.
  `navigationStep` returns `none` for `/`, so there is no double navigation.
- **A refused launch URL** gives `/link-not-allowed`, outside the tabs.
- **Unchanged and out of scope:** a new root state goes back to the launch URL rather than the last location. That is
  the router's behaviour today.

**What is guaranteed, and what isn't.**
- In B, R-kept (except R-org and the transient `/` case) and R-new, the first rendered section stack is anchored and
  correct.
- R-org and a ready `/` with `(tabs)` beneath are L2.

### 3.1 Explicit initial route and exact route names

- **`SectionStack`:**
  `<Stack initialRouteName={sectionStackSettings.initialRouteName} …><Stack.Screen name="index" /><Stack.Screen
  name="views" /></Stack>`.
  - The prop reaches the navigator (R2).
  - Declaring `views` rules out R5's throw.
- **The instantiated `routeNames`** (R3, with `views` declared):
  - **Work:** `['index', 'views']`, and `'all'` from merged #201;
  - **Chat:** `['index', 'views']`;
  - **Resources:** `['index', 'views', 'inventory']`.

  `routeNames[0]` is `index` on both platforms.
- **One constant** is used for the linking anchor and the navigator prop.

**The hazard.** With `initialRouteName: 'views'`, a section navigator built with **no** nested target (R6
"nothing") opens at `[views]`. §3.2 and §3.3 make sure no native entry does that.

### 3.2 Every entry, with the first rendered shape

`anchored = sectionStackSettings.initialRouteName !== undefined`: true on native, false on the web.

| # | Entry | Native mechanism (source) | First rendered stack |
|---|---|---|---|
| E1 | First visit to a tab (`route.state === undefined`) | `navigate(tab, firstVisitParams(anchored))` = `{ screen: 'index', initial: false }`; the section navigator takes R6 `initial: false`: `[views]` plus `navigate(index)` in one render | `[views, index]` |
| E2 | Person or organisation change | seeded RESET (§3.3); rehydrated (R6 state, R4, R10) | Work `[views, index]`; Chat and Resources have no state until E1 |
| E3 | Becoming ready, `tabEntryAction(anchored, 'arrive')`: `replace('/work', { withAnchor: true })` | at boot `(tabs)` is absent (§3.0 B), so R4 `REPLACE` creates a new `(tabs)` route with fresh keys. With `initial: false` at every level (R7), the tabs navigator and then Work take R6 `initial: false`. On a remount, this only fires in R-org (L2) | `[views, index]` (the new route) |
| E4 | Fail-closed reopen, `'arrive'` for `/work` | the guard closed for one commit removed `(tabs)` (R4 filter), so the same as E3 | `[views, index]` |
| E5 | Verified destination `t`, `'arrive'` for `t` | applied on the first ready after sign-in, so `(tabs)` is absent (§3.0); same as E3 | `[views, t]`, or `[views]` if `t` is `views` (the tabs level `initial: false`, then at the section `getInitialState` = `[views]` and `navigate(views)` reusing the current route, R8) |
| E6 | Requested cold-start route `t`, `'arrive'` for `t` | first ready of the process, so `(tabs)` is absent; same as E5 | `[views, t]` / `[views]` |
| E7 | `Home` at `/`: `<Redirect href={routeFor(account)} withAnchor={anchored} />` | at boot, not ready, so it goes to `/welcome`. When ready (R-new with a `/` or absent launch URL), `(tabs)` is absent, so the same as E3. A ready `/` with `(tabs)` beneath is L2 (§3.0) | `[views, index]` |
| E8 | Choosing a view in the list (from `[views]`) | unchanged `router.navigate`; R8 push | `[views, t]` |
| E9 | Breadcrumb or back to the list | unchanged `dismissTo(viewsHref)` / pop | `[views]` |
| E10 | Warm link | unchanged router path (R9); see §3.5 | see §3.5 |

- **Helpers** (pure, `copy.ts`): `firstVisitParams(anchored)` for E1, and `tabEntryAction` for every other
  app-initiated tab entry (§3.2a).
- **Divergence (F3).** `getNavigateAction` targets the navigator where the action's state and the current state
  first differ (`global-state/stateUtils.js:42-86`).
  - For E3–E7 within one mount, and for E11 and E12 (§3.2a) with `(tabs)` absent, that is the **account stack**: its
    focused route is `organisation`, `welcome`, `index`, `link-not-allowed` or `settings`, never `(tabs)`. So the
    action stays `REPLACE` or `POP_TO` at a stack (`getNavigationAction.js:51-59` converts only `PUSH` to a non-stack
    and anything to an `expo-tab` navigator).
  - No entry here relies on a divergence at the tabs level.

### 3.2a One helper for app-initiated tab entries (all sites)

`tabEntryAction(anchored, intent)` (pure, `copy.ts`) returns the call to make:

| `intent` | Native (`anchored` true) | Web (`anchored` false), exactly today's |
|---|---|---|
| `'arrive'` (AccountStack E3–E6, `Home` E7) | `replace(href, { withAnchor: true })` | `replace(href)` |
| `'return-to-my-work'` (E11 and E12 below) | `dismissTo('/work', { withAnchor: true })` | `replace('/work')` |

`Home`'s `<Redirect>` takes `withAnchor` from the same helper. Callers apply the result through `router`, so no call
site chooses its own options.

The label **Go to My work** is unchanged. `withAnchor` also leaves `initial: false` in the target
screen's route params; current screens do not read those params. This is navigation metadata, not a business filter.

**The sites:**
- **E3–E6:** `AccountStack` (`'arrive'`).
- **E7:** `Home` (`'arrive'`).
- **E11:** `RefusedLink` "Go to My work" (`'return-to-my-work'`). **Never `router.back()`**, because the previous page
  could be Chat, Settings or anything else, and the label promises My work.
- **E12:** the fallbacks in `settings.tsx:15` and `organisation.tsx:21` (`'return-to-my-work'`). Their `canGoBack()`
  then `back()` branch is unchanged: that is the Back control's meaning on those pages, and the fallback already
  targets `/work`.
- **Unchanged:** `organisation.tsx:56`'s `replace('/settings')` (not a tab route).

**Why `dismissTo` for E11 and E12, source-proven** (`StackRouter.js:336-401` `POP_TO`; `TabRouter.js:186-229`;
`useNavigationBuilder.js:397-451`):
- **P1. `(tabs)` exists beneath the current page.** For example, a warm refused link while ready gives
  `[(tabs), link-not-allowed]` (R9 pushes it at the root).
  1. `POP_TO (tabs)` at the account stack finds that existing route by searching down from the current index. It
     keeps the route and its key, and pops everything above it (`:353-363, 394-401`).
  2. The route's params are replaced by the action's `{ screen: 'work', params: { screen: 'index', initial: false } }`
     (`createParamsFromAction`, `:392`).
  3. The tabs navigator sees params it hasn't consumed and navigates to `work` (`useNavigationBuilder.js:415-433`).
     `TabRouter` focuses Work and gives it the new params, keeping the key (`TabRouter.js:191-228`).
  4. The Work navigator then navigates to `index`:
     - **if `index` is current:** it is reused (R8), with no remount and no read;
     - **otherwise:** it is pushed, giving `[views, …, index]`, one new My work with one page-0 read (R8, the same as a
       warm link in §3.5);
     - **if Work was never visited:** `initial: false` gives `[views, index]` in its first render (R6).
  - **Result:** exactly My work, **no second `(tabs)`**, and the refusal page is gone.
  - If an earlier My work sits below the current Work screen, this can push a second My work instance;
    each retains its own scope guards and the newly mounted list reads once.
  - **Today:** `replace('/work')` puts a second `(tabs)` above the old one. That is the duplicate this change removes,
    here only.
- **P2. `(tabs)` is absent.** For example, a cold refused link gives `[link-not-allowed]` (outside the guards, and
  kept because `routeHolds` is true).
  - `POP_TO` finds no `(tabs)`, so it swaps the current route for a new one made by `createRouteFromAction`, with a
    fresh key (`:365-377`).
  - That is the same as E3's `REPLACE`, and with `initial: false` the first render is `[views, index]`.
- **P3. Not ready** (the refusal page is outside the guards): `(tabs)` isn't in `routeNames`, so `POP_TO` returns
  `null` (`:343-345`), exactly like today's `REPLACE` (`:161-163`). The action goes unhandled, as today. **Unchanged,
  and not in scope** (the label's behaviour while signed out is an existing matter).
- **Web:** `replace('/work')` as today, so web history is unchanged (§4).

**The remount limitation (L2) is untouched.** `AccountStack`'s `'arrive'` stays `replace`, so R-org is tracked
separately (§8, 5). No reset or remount policy is added here.
- **When E3–E6 can meet an existing `(tabs)` (U2, resolved with a stated limit):**
  - **Within one `AccountStack` mount**, `navigationStep` (`copy.ts:90-103`) returns `reset-tabs` first on a
    tabs-key change. It issues `replace` only when `routeFor`'s answer changes, or on the first ready (destination or
    requested). The `(tabs)` guard is closed in every non-ready state, and closing removes `(tabs)` (R4). So within a
    mount, E3–E6 always find `(tabs)` absent.
  - **Across a remount**, the only `replace` is R-org's (§3.0), which is L2.
  - **Node tests pin both:**
    - within a mount, every `navigationStep` sequence that returns `replace`, `destination` or `open-requested`
      follows a non-ready snapshot or is the first ready;
    - from `navMount(true)` with a ready account, `navigationStep` returns `none` for `/work`, `/work/all`, `/chat`,
      `/settings` and `/`, and `replace('/work')` only for `/organisation`. That last result is the recorded L2, pinned
      so any change to it is deliberate.

### 3.3 Seeded fresh-tabs reset

`resetToFreshTabs(target, seedViews)`:
- **Native:**

  ```text
  RESET { index: 0, routes: [{ name: '(tabs)', state: { index: 0, routes: [
    { name: 'work', state: { index: 1, routes: [{ name: 'views' }, { name: 'index' }] } }
  ] } }] }
  ```

- **Web:** `{ name: '(tabs)' }`, unchanged.
- **No keys.** Rehydration fills in fresh keys and the missing tabs (R4, R10).
- **The new Work navigator's first render** is the rehydrated `[views, index]` (R6 state; `index: 1`). The explicit
  `initialRouteName` doesn't apply, because the routes are given.
- `AccountStack` passes `seedViews = anchored`.

**Epochs.**
1. The reset runs in `AccountStack`'s effect after the new account's first render.
2. In that render, every mounted list goes inert and sends nothing.
3. The new subtree then mounts one My work, which reads page 0 under the new epoch. `views` reads nothing, and Chat
   and Resources are unmounted and stateless.

### 3.4 Lazy tabs and fresh keys

- **Tabs stay lazy:** a tab's section stack mounts on its first focus.
- **After a reset:**
  - Chat and Resources have no `state` (R10), so their first visit is E1;
  - no route key from before survives at any depth (R4).
- **A visited tab keeps its own stack** (`navigate(tab)`). That is unchanged.

### 3.5 Incoming links (resolves U1)

`+native-intent`, `linkTarget`, the allow list, the refusal page and callback handling are unchanged.

- **Cold start:** the link's state is filtered while not ready (§3.0). The route is captured by `requested.ts` and
  opened once as E6.
- **Warm links: the target section has no state yet** (a tab never visited, or not mounted after a reset). R9 gives
  `{ screen: t, initial: false }` for `[views, t]`, and `{ screen: views, initial: true }` for `[views]`. The section
  navigator's first render is then `[views, t]` or `[views]` (R6). ✔
- **Warm links: the target section's stack exists:**
  - `t` is the current route: reused, with no remount and no read (R8). ✔
  - `t` is not current, and `t` is not `views`: pushed, giving `[views, …, t]`. The view list is still at the bottom
    and not duplicated. Two lists can then be mounted at once, both bound and both going inert on a change (the same
    as the web's two-list case). ✔ This is documented, not a defect.
  - **`t` is `views` and `views` is not current** (for example `[views, index]` plus a warm `/work/views`): R9 sets no
    `pop` on the section leaf, so R8 **pushes a second `views`**, giving `[views, index, views]`.
    - It is data-safe (`views` never reads).
    - **This is L1, an unchanged known limitation.** The same push happens today whenever `views` is beneath a
      deeper page. No second link path is added, and nothing here claims "never a duplicate view list".
- **Root pages close on a warm tab link** (F4; unchanged). R9 sets `pop: true` on the top-level payload whenever it
  carries a nested `screen` or `state` (`getActionFromState.js:89-91`). So a warm link to a tab route pops Account,
  Switch organisation or the refusal page above `(tabs)` at the account stack before acting inside the tabs. That is
  today's behaviour, and nothing here changes it.
- **While not ready:** a warm link to a tab route has no `(tabs)` to act on. That is unchanged from today, and outside
  this contract.

### 3.6 Header, back, and the `Screen.tsx` comment

- **`Screen.toViews` logic is unchanged.** On native the `dismissTo` branch applies on every E1–E12 shape.
- **The comment at `:15`** is corrected to "on iOS and Android the view list is beneath every section stack built
  through the entries in the native navigation contract", with a pointer to the device gates.
- **Back:**
  - from `t`, it pops to `views`;
  - from `views`, it follows the tabs' `firstRoute`.

  Both are unchanged, and both are device gates.

## 4. The web is unchanged (history included)

- **The inputs are the same as today:**
  - `sectionStackSettings` is `{}`, so there is no navigator `initialRouteName`, and `routeNames[0]` stays `index`;
  - `firstVisitParams(false)`, `tabEntryAction(false, …)` (always `replace`, with no options), `Home`'s
    `withAnchor={false}` and `resetToFreshTabs(t, false)`
    all equal today's inputs.
- **The declared `views` screen** doesn't change the web initial route, and adds no route that wasn't visited. So there
  is no new history entry, and no `history.go(-n)` (`SectionStack.tsx:18-22`). The tabs' `fullHistory` is unchanged.
- **Proof:** every existing browser check passes unchanged at 360, 390 and 430 pixels. Browser history is never cited
  as native evidence.

## 5. Reads and epochs

- **Read rules are unchanged.**
- **On native, ordinary switching mounts one list at a time** (E8/E9). A warm link to a non-current `t` can mount two
  (§3.5), as on the web.
- **Nothing** touches the runner, the reducer, `ReadScope`, or the requested-route and destination rules.
- The native-shape lines in the My work and All tasks contracts are updated after the device gates pass.

## 6. Tests and gates

**Node (pure):**
- `resetToFreshTabs(target, true | false)`:
  - the exact payloads;
  - no `key` at any depth;
  - names within `{(tabs), work, views, index}`;
  - Work `index: 1`;
  - `target` passes through.
- `firstVisitParams(true | false)`, exact.
- `tabEntryAction` for both intents on both platforms, exact:
  - the method (`replace` or `dismissTo`);
  - the href (`'return-to-my-work'` is always `/work`);
  - the options.

  The web results equal today's calls.
- **Pins for E3–E6 (§3.2), worded per mount and per process:**
  - **within one `AccountStack` mount started at process boot** (`navMount(false)`), `replace`, `destination` and
    `open-requested` occur only on a step whose previous snapshot in **this mount** was not ready, or on this mount's
    first ready;
  - **for a mount started while ready** (`navMount(true)` with a ready account), the first step is `none` for
    `/work`, `/work/all`, `/chat`, `/settings` and `/`, and `replace('/work')` only for `/organisation` (L2, pinned
    so any change to it is deliberate).

  Neither pin claims that a mount's first ready means `(tabs)` is absent. That is proven for process boot only
  (§3.0).
- **One constant:** the section layouts' `unstable_settings` and `SectionStack`'s prop are the same imported value.
- **Existing tests unchanged:** `findAccountStack`, `navigationStep`, links, `requested`.

**Browser:** every existing check passes unchanged (§4). No native claim.

**Device gates** (iOS and Android; development build; isolated synthetic environment; no real accounts; native
sign-in off elsewhere). These confirm the source-backed shapes. None is the only evidence for a claimed behaviour.
1. **The instantiated `routeNames`** match §3.1.
2. **E1 to E7:** the first rendered screen is the target, never the view list alone. Back reaches the view list. My
   work has exactly one page-0 read, and none before it renders.
3. **E2:** nothing from before is reachable. Exactly one read, under the new scope.
4. **Warm links, each §3.5 row,** including the decided outcome for the `views`-not-current case. Plus a refused link.
4a. **E11 "Go to My work":**
    - from a warm refused link while ready, with Work left on All tasks: My work is shown, and there is one `(tabs)`
      (back follows the prior Work stack, which may include an earlier My work beneath All tasks,
      never a second tab set);
    - from a cold refused link: `[views, index]`;
    - while signed out: unchanged (nothing happens).
4b. **E12:** the fallbacks, forced in a development build: My work with the view list beneath.
5. **Back from the list** follows the tabs' `firstRoute` (`(tabs)/_layout.tsx:14`; Work is the tabs' first route):
   back to Work, then out of the app. iOS swipe-back and Android predictive back.
5a. **Remounts,** where a development build can force them:
    - **R-kept at `/work/all`:** the shape is kept and there is no read;
    - **R-new with launch URL `/work/all` and with none:** `[views, all]` and `[views, index]`, one read each, and no
      second navigation;
    - **R-org:** L2 behaviour observed as described (not as a pass).
6. **VoiceOver and TalkBack:** the breadcrumb label and focus after back.

No simulator or device evidence is claimed by the implementation PR.

## 7. Scope and ownership

| Owner | Files |
|---|---|
| A | **All of it, in an isolated navigation checkout** (root's split, 27 September 2026): `components/SectionStack.tsx`; the pure helpers in `account/copy.ts` (`resetToFreshTabs`, `firstVisitParams`, `tabEntryAction`); every call site (`account/AccountStack.tsx` for the seeded reset and E3–E6, `app/index.tsx` for E7, `components/TabBar.tsx` for E1, `components/RefusedLink.tsx` for E11, `app/settings.tsx:15` and `app/organisation.tsx:21` for E12); the `Screen.tsx` comment; and every node test in §6 |
| B | Independent peer review of the whole navigation change. B's own implementation is the session-revocation API, in a separate API checkout, with no shared files |
| B | Independent review of all navigation changes |
| Root | Browser regression, CI, documentation, git and integration |

**Not in scope:**
- web or harness navigation;
- new routes or links;
- record links;
- gestures and animation;
- Chat or Resources reads;
- the selected-tab press;
- account or read rules;
- warm links while not ready.

## 8. Adopted choices

1. **Implement §3.1 only with §3.2 and §3.3.**
2. **One helper, `tabEntryAction`,** for every app-initiated tab entry (§3.2a):
   - `'arrive'` (`replace` with `withAnchor`) at E3–E7;
   - `'return-to-my-work'` (native `dismissTo('/work', { withAnchor: true })`, proven in P1–P3) at E11 and E12;
   - the web unchanged.

   Selected after independent source verification by both reviewers (P1–P3).
3. **L1, the warm view-list duplicate (§3.5):** kept as an unchanged, labelled known limitation, as root decided
   after revision 3. No second link machinery. If it is ever fixed, that is a separate reviewed increment.
   `dangerouslySingular` on `views` is ruled out: R8 would move the existing `views` to the top, giving
   `[index, views]`.
4. **Declare `views` on both platforms:** it doesn't change the web initial route or history (§4).
5. **L2, a remount while ready on `/organisation` (§3.0, R-org):** kept as an unchanged, labelled known limitation in
   this navigation increment.
   - It is today's behaviour, and this contract neither creates nor worsens it: the new `(tabs)` is merely anchored.
   - A fix belongs to the account-navigation rules, not to section stacks. For example, `navMount` could seed `route`
     from `routeFor(account)` when a remount finds the account already ready.
   - Recommended: a separate small reviewed change, with `navigationStep` tests. It needs a web browser check too,
     because it changes remount behaviour on both platforms.
