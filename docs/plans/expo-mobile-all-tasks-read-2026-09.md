# Mobile All tasks read contract (M-read slice 2)

Status: adopted in #200 (a82e293), 27 September 2026. Outcome: **manage shared work**.
My work (#199) is merged. This contract extends [My work](expo-mobile-my-work-read-2026-09.md)
and the [foundation](expo-mobile-foundation-2026-09.md) link allow list.

**Implementation status (27 September 2026): implemented and independently reviewed; local validation passed.**
- Codex's paths, parser, links, sections and configuration, and Claude B's shared screen, hook, copy and harness,
  are written, with peer review done.
- Local checks, exports and browser validation passed; see the [validation record](../validation/mobile-all-tasks-read-2026-09-27/README.md).
  Native sign-in remains off, with **no native, simulator or device evidence**.

**Outcome.** From Work → Views, **All tasks** (previously unavailable) opens, read-only, the open tasks the
existing Work API lists for the chosen organisation, whoever they are assigned to. Those are the **top-level** tasks
(no checklist steps) whose status is **Open**, excluding tasks of **archived or proposed projects**
(`service.ts:104-109`), exactly as on the web's All filter.
- It is **not** every stored task, and **not** everything in progress. `status=open` is an exact match, so tasks that
  are In progress, Suggested or Done are not included. The wording says "open tasks" and nothing broader.
- It has My work's states, bounds and scope guarantees.

**Unchanged:**
- native sign-in stays off;
- the §8/§10 device gates remain;
- no API, schema, flag, dependency or migration change;
- the production web export makes **no API requests** (it loads only its own assets).

## 1. Facts checked in the repository (not assumed)

- **Task payload** (`apps/api/src/tags/service.ts` `WorkTask`): `{ id, projectId, seriesId, title, ownerId, status,
  due, revision, tags }`. It carries `ownerId` (a UUID or null) and **no owner name**.
- **The web's All filter** (`apps/web/src/app/work/filters.ts`):
  - `owner=all` drops `ownerId`;
  - `status` defaults to `open` and is sent;
  - page size 50;
  - web URL `/work?owner=all`.
  - Its view title is "All tasks" (`apps/web/src/app/work/tag-views.ts:34`).
- **API without `status`:** every status except `cancelled` (`service.ts:109`). So `status=open` is sent
  **explicitly** as a fixed constant; omitting it would silently widen the list.
- **Without `ownerId`,** the API still returns only top-level tasks, skips archived or proposed projects, and keeps the
  same order and `nextOffset` rule (`service.ts:104-123`).
- **Owner names on the web** (`apps/web/src/app/work/page.tsx:26, 150, 157`):
  - the web reads `GET /v1/organisations/:id/members` (`apps/api/src/app.ts:176`, `organisations/service.ts:65`);
  - that route is unpaged, and returns every active member with `name`, `email`, `role`, `status` and `since`.
- **Return paths** (`apps/mobile/src/auth/attempt.ts:31-35`, `account/machine.ts` `destinationFor`, `lib/links.ts`,
  `account/requested.ts`): a `returnTo`, a returned destination and a cold-start request are each accepted only if
  they pass `safeReturnPath` and `linkTarget` maps them to an exact app route. `routeHolds('/work', '/work/all')` is
  true, so a ready transition does not bounce it.
- **`webPaths`** (`src/config.ts:31-38`) is a closed constant tuple, with exact membership in `webLink`.

## 2. Scope

**Delivers:**
- The Work view-list row "All tasks" becomes openable, at the exact app route `/work/all` in the Work stack.
- The **All tasks** screen shows:
  - page 0 on each mount;
  - a visible Refresh, More, and Try again;
  - at most 10 pages and 500 rows;
  - non-interactive rows of title, "Open", owner, up to three tags plus a count, and due date;
  - loading, empty, failed, refused, "more failed" and cap states, with the wording in §5.
- **Owner, an explicitly limited display.** Each row says only one of:
  - "Assigned to you" (`ownerId` equals the verified user);
  - "Assigned to someone else" (any other UUID: a current or former member alike);
  - "No owner" (null).

  That is the whole owner display in this slice. It does not show who owns a task, and it is not a member-name view.

**Does not deliver:**
- member names (a later slice over the members list, with its own paging or bound, byte budget and email handling);
- In progress, Suggested or Done tasks; By tag; saved views; project or series filters;
- detail pages;
- Chat and Resources reads;
- writes;
- any change to My work's behaviour or wording.

## 3. API use, exactly

`GET /v1/organisations/{organisationId}/tasks?status=open&offset={n}&limit=50`
- no `ownerId`;
- `status=open` fixed;
- the same order (due, no-date last, id), response shape, access rules and `Retry-After` as My work.

## 4. Design (one path builder, one parser, one hook and one screen, parameterised by a view fixed at mount)

### 4.1 Path (Codex, `src/api/paths.ts`)

```ts
export type WorkView = 'mine' | 'all';
export function workListPath(scope: ScopeIds, view: WorkView, offset: number): OrganisationPath
// mine: …/tasks?ownerId={userId}&status=open&offset={n}&limit=50   (today's exact string)
// all:  …/tasks?status=open&offset={n}&limit=50
```

- The same checks as `myWorkPath`: canonical lower-case UUIDs, and an offset that is a multiple of 50 within the
  10-page cap. `view` must be exactly `'mine'` or `'all'`, or it throws a `TypeError` that repeats nothing.
- `status=open` is a fixed constant in both views. No query value is ever taken from input, and none needs
  percent-encoding.
- `myWorkPath(scope, offset)` becomes an alias for `workListPath(scope, 'mine', offset)`. Its existing path tests keep
  their exact strings.

### 4.2 Parser (Codex, `src/work/my-work.ts`)

`parseWorkPage(value, { scope, offset, view })`. `parseMyWorkPage(value, r)` becomes an alias for
`parseWorkPage(value, { ...r, view: 'mine' })`.
- **`ownerId` must be present** in both views, as an own key; a missing key fails the page.
  - **mine:** it must equal `scope.userId` exactly (as today).
  - **all:** `null`, or a canonical **lower-case** UUID. An empty string, an upper-case UUID, a non-string, or a
    missing key fails the page.
- **Both views:**
  - status exactly `'open'`;
  - every other rule unchanged (tags, title, dates, `nextOffset`, de-duplication within a page, unknown fields
    ignored and never copied).
- **Every `WorkRow` gains `owner: 'you' | 'someone-else' | 'none'`,** derived at parse time: `'you'` exactly when
  `ownerId === scope.userId`, `'none'` for `null`, `'someone-else'` otherwise. The raw `ownerId` is never kept. For
  mine it is always `'you'`, and that screen does not show it.
- **R1 (A's review): the existing mine parser tests change.** Their whole-row deep-equality expectations (for example
  `my-work.test.ts:16`) gain `owner: 'you'`. No other mine expectation changes. This plan does not claim the tests are
  unchanged.

### 4.3 List, hook and screen (B)

- `my-work-list.ts` is view-independent. Unchanged.
- **One bound view per screen (invariant).** `WorkListScreen({ view })` captures `view` **once**, on its first render
  (`boundView`), and never reads the prop again. Everything on that screen derives from `boundView` only:
  - the hook (`useWorkList(boundView)`), so every read, path and parse;
  - the heading, subtitle, loading, empty, failure and cap wording, and the cap link;
  - whether the owner is shown, and the owner labels;
  - the row detail line and each row's accessibility label.

  A later change to the prop is simply ignored; nothing is logged. So rows read for one view can never be shown under
  another view's heading, owner display or link. The routes pass a constant (`index.tsx` passes `'mine'`, `all.tsx`
  passes `'all'`), so the prop never actually changes. The invariant only makes a change harmless by construction.
- **Hook.** `useMyWork()` becomes `useWorkList(view)`, and `useMyWork()` stays as `useWorkList('mine')`.
  - Its `view` argument is the screen's `boundView`, a mount-time constant.
  - Reads use `workListPath(current, view, offset)` and `parseWorkPage(value, { scope: expected, offset, view })`.
  - The bound-scope, inert, sequence and mounted rules are identical to My work's.
- **Screen.** The current body of `src/app/(tabs)/work/index.tsx` becomes one `WorkListScreen({ view })`. My work
  renders it with `'mine'` (the output doesn't change), and the new `src/app/(tabs)/work/all.tsx` with `'all'`.
  - Wording comes from the per-view table (§5), looked up once with `boundView` as a single `workViewCopy(boundView)`
    object. The screen never picks individual strings by the prop.
  - The pure presentation helpers take the bound view explicitly: `rowDetail(row, boundView)`,
    `rowLabel(row, boundView)` and `capLink(boundView)`.
- **Each list lives only in its mounted screen, and no list is cached across views.**
  - While a screen stays mounted, it keeps its rows and reads nothing on tab return or foreground.
  - Every new mount reads page 0.
  - Nothing is kept between mounts.

  Whether a view stays mounted when the person switches views is the section stack's existing behaviour, which this
  slice does not change. **It depends on how the Work stack was built, not simply on the platform:**
  - **A native stack retaining the linking anchor** can have the view list **beneath** the open view.
    This is not every cold link: at process boot the closed account guard discards linking state, then the
    requested-route replace opens the target alone. When the anchor is present, the header's breadcrumb
    (`Screen.toViews`) calls `dismissTo` on the view list, which unmounts the view above it. Switching views then
    unmounts the previous one, and returning to it reads page 0 again.
  - **A stack that starts empty,** on the web and also on native after the #197 tabs reset (a fresh `(tabs)` with no
    nested state) or a first visit through the tab bar, starts at `index` (My work) with **no view list beneath**. The first header use **pushes** the view
    list above My work, and opening All tasks stacks above both, so **both lists can be mounted at once**. Later header
    use from All tasks dismisses back to that view list, unmounting All tasks. Choosing a view with
    `navigate` pushes it unless it is current; the same view may have two mounted instances. Each new
    instance reads page zero, and every mounted instance becomes inert on a scope change.

  The seeded view list is the **intended** section-stack convention, not what every native path currently does. A
  seeded reset, explicit `SectionStack` initial route and anchored entries are specified by the
  [separate navigation contract](expo-mobile-native-navigation-2026-09.md), not implemented by this read slice. No list cache is added to keep a view across switches.
- **A scope change makes every mounted list inert.** On a switch or lost-single, every mounted list (one or two,
  depending on the stack above) compares its own bound scope, goes inert in the same render, shows no rows and sends
  no read. The #197 tabs reset then installs fresh tabs with no nested state. By source reading, the new Work stack
  starts at `index` on every platform, so a new My work mounts and reads page 0 under the new epoch, with no view list
  beneath, and All tasks is gone until opened again.
  - **Web:** proven by the browser check.
  - **iOS and Android:** source evidence only (installed router inspection); **native proof pending** as a device gate.

### 4.4 Links and navigation (Codex, plan amendment to foundation §5)

- **`src/lib/links.ts`:** add the exact route `['/work/all', '/work/all']`.
  - It is linkable under the unchanged rules: `safeReturnPath` first, an exact path, query and fragment dropped, and no
    pattern or query-bearing route.
  - So a sign-in started from All tasks sends `return_to=/work/all`, the returned destination opens it, and a
    cold-start saved session opens it once (`requested.ts`).
  - Nothing else about return-path security changes.
- **Incoming web link.** `/work?owner=all` maps to `/work` (My work), because the query is dropped. The amendment states
  this; no query is parsed.
- **`src/navigation/sections.ts`:**
  - The Work group's "All tasks" row gets `href: '/work/all'` and the detail "Open tasks assigned to anyone".
  - My work's row detail "Assigned to you, across all tags" is unchanged.
- **`src/config.ts` (root decision):** `webPaths` gains the fixed constant `/work?owner=all`. It is never built from
  input, and has no dynamic query. The existing refusal of `/settings?x=1` still holds.

## 5. Wording (B, `copy.ts`: exact strings)

| Key | My work (unchanged, today's strings) | All tasks |
|---|---|---|
| Heading | My work | All tasks |
| Subtitle | Open tasks assigned to you | Open tasks assigned to anyone |
| Loading | Loading your work… | Loading open tasks… |
| Empty title | Nothing open is assigned to you | No open tasks in this organisation |
| Empty body | Tasks you own appear here while they are open. | Tasks appear here while they are open, whoever they are assigned to. |
| First read failed | Couldn't load your work | Couldn't load open tasks |
| Refresh failed | Couldn't refresh. This list may be out of date. | Couldn't refresh. This list may be out of date. |
| More failed | Couldn't load more | Couldn't load more |
| Refused 403/404 | Captain couldn't read this organisation's work. If your access has changed, Captain will show it the next time it checks. | (same as My work) |
| Other refusal or client bug | Captain couldn't read this list. | Captain couldn't read this list. |
| Cap notice | Some more open tasks may be available on the Captain website. | Some more open tasks may be available on the Captain website. |
| Cap link label → path | Open My work on the web → `/work` | Open All tasks on the Captain website → `/work?owner=all` |
| Row status | Open | Open |
| Row owner | (not shown) | Assigned to you / Assigned to someone else / No owner |
| Row detail line | Open · {tags} | Open · {owner} · {tags} |
| Row accessibility label | title, Open, tags, due | title, Open, {owner}, tags, due |
| Buttons | Refresh / More / Try again | Refresh / More / Try again |

- "Open All tasks on the Captain website" is tied to the checked web title ("All tasks", `tag-views.ts:34`). If that
  title changes, this label changes with it.
- No wording says "in progress", "everything", a total, an access check under way, or anything about a person beyond
  the three owner facts.

## 6. Ownership

| Owner | Files |
|---|---|
| Codex | `src/api/paths.ts` (`WorkView`, `workListPath`, the `myWorkPath` alias) and tests; `src/work/my-work.ts` (`parseWorkPage` with `owner`, the `parseMyWorkPage` alias) and tests, **including the mine deep-equality updates**; `src/lib/links.ts` exact route and tests; `src/navigation/sections.ts` row and tests; `src/config.ts` `/work?owner=all` and test |
| B | `src/work/useMyWork.ts` → `useWorkList(view)`; `WorkListScreen` with its `boundView` (hook, wording, owner display, row text and cap link all from it); `workViewCopy`, `rowDetail`, `rowLabel`, `capLink`; `src/app/(tabs)/work/index.tsx` and the new `all.tsx`; the per-view table in `copy.ts`; the harness (fixtures by view, the `all.tsx` re-export); tests |
| Claude A | Independent review of the domain and UI; owns the separate transport increment |
| Codex | Plan amendment and adoption, browser checks, docs, CI, git |

## 7. Tests

- **Node (Codex):**
  - `workListPath`:
    - the exact mine string, identical to today;
    - the exact all string, with no `ownerId` and with `status=open`;
    - a bad view, UUID or offset is refused, and nothing is echoed.
  - `parseWorkPage('all')`:
    - accepts `ownerId` equal to the user (`'you'`), another lower-case UUID (`'someone-else'`) and `null`
      (`'none'`);
    - refuses a missing key, `''`, an upper-case UUID, a number, and a non-open status;
    - every shared rule still applies.
  - `parseWorkPage('mine')`: the existing tests, with row expectations gaining `owner: 'you'`; another owner is
    still refused.
  - Links (today's `linkTarget` rules, unchanged):
    - `/work/all` → `/work/all`;
    - `/work/all/` → `/work/all`;
    - `/work/all?x=1` → `/work/all`;
    - `/work/ALL` → refusal page;
    - `/work/all/../views` → `/work/views`;
    - `/work/all/../chat` → refusal page (`/work/chat` is not a route);
    - `//work/all` and `/work\all` → refusal page;
    - `/work?owner=all` → `/work`;
    - `startUrl` keeps `return_to=/work/all`.
  - Sections: the All tasks row href and detail. Config: `webLink(origin, '/work?owner=all')`, and that dynamic queries
    are still refused.
- **Node (B):**
  - the pure list rules, unchanged;
  - **bound view (pure):**
    - `workViewCopy('mine')` and `workViewCopy('all')` match §5 exactly;
    - `rowDetail(row, 'mine')` never includes an owner label, and `rowDetail(row, 'all')` always includes exactly one;
    - `rowLabel` likewise;
    - `capLink('mine')` is `/work`, and `capLink('all')` is `/work?owner=all`.
  - **Bound view integration:** review that the screen captures its view once and uses it for both reads and
    presentation. Browser navigation must pair the mine query with My work text and the all query with All tasks
    text. Do not add an identity helper solely to unit-test returning its first argument.
  - the per-view copy table matches §5 exactly, with no "in progress" or "everything", no digits in cap notices, and no
    access claim;
  - requested destination: `/work/all` is captured and opened once.
- **Harness (B).** Fixtures are chosen **from the requested path**: the query has `ownerId` or not. No harness state is
  involved.
  - Mine: every task's `ownerId` is the user (as today).
  - All: a deterministic mix by global index. Index 0 (AA) is the user, index 1 (long title) another fixed lower-case
    UUID, index 2 (blank title) `null`, then repeating by `index % 3`.
  - The expected rows are exported for root.
- **Harness browser (root)**, at 360/390/430:
  - the view list opens All tasks; the read log shows the all path (no `ownerId`, `status=open`);
  - loading, empty, rows with each owner label, paging to the cap, and the cap link to `/work?owner=all`;
  - Refresh, More and Try again failures, the read-wait boundary, and refusal wording;
  - a scope change with a pending All tasks More drops the old page;
  - **both lists mounted** (the empty-stack path: My work → header, which pushes the view list → All tasks): a `switch`
    gives no rows and no further All tasks read, and the fresh My work reads page 0 under the new epoch. This is
    browser-stack evidence only;
  - **returning from All tasks to My work, platform-neutral rule:** My work either shows its previous rows with
    **zero** new reads (still mounted), or shows loading with **exactly one** new page-0 read (remounted), never more.
    On the web export's empty-stack path the installed router predicts a new My work mount: `navigate` without
    `pop` does not reuse the earlier non-current route. The browser verifies one page-zero read per new mount,
    while the earlier mount sends nothing. The linked-stack (native anchor) case is a device check;
  - All tasks after dismissing back to the view list and reopening: exactly one new page-0 read;
  - no native back-stack claim (browser history is not native stack evidence);
  - `/work/all` opened cold (`checking`, then `verify`) lands on All tasks once, and signed-out Sign in carries
    `returnTo: '/work/all'`;
  - the production export makes no API requests.
- **Device gates:** unchanged (`expo/fetch` reporting the query URL unchanged, a real 403/404). Plus, with native
  navigation:
  - view switching on both stack shapes (a link-built stack with the view list beneath, and the empty stack after
    launch or a tabs reset): each new mount reads page 0 once, a still-mounted list reads nothing, and no list ever
    shows under another scope;
  - **after an organisation change, the Work tab opens at My work with no view list beneath**, and reads page 0 under
    the new scope (source evidence only; **native proof pending**).

  A seeded reset and an explicit `SectionStack` initial route are the coordinator's separate future contract, not claimed or
  changed here.

## 8. Decisions

**Taken by root (27 September 2026):**
- the exact app-only route `/work/all`;
- the fixed website constant `/work?owner=all` in `webPaths`, with no dynamic query;
- owner wording as an explicitly limited slice (the three facts, no names);
- open only: the wording never implies In progress work is included.

**Adopted design:**
- one `WorkRow` type with `owner`, and the mine test expectations updated ;
- a shared parser and hook, with one `boundView` per screen, captured at mount and driving the reads, the wording, the
  owner display and the cap link together.

**Separate, not in this slice (root):** a seeded tabs reset, and an explicit `SectionStack` initial route, so that native
stacks built without a link also have the view list beneath. It is a future navigation contract with its own device
checks. This slice neither relies on it nor changes navigation.

**Still open:**
- The [transport response byte budget](expo-mobile-response-byte-budget-2026-09.md) is a separate
  implementation, not a blocker for this slice. The same exposure as My work.
