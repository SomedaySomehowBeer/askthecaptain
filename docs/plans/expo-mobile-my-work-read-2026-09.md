# Mobile My work read (M-read slice 1)

Status: reviewed implementation contract, 27 September 2026. Implementation follows account
composition in #197; this contract does not enable native sign-in or change runtime code.
It follows the [foundation contract](expo-mobile-foundation-2026-09.md) and
[account composition](expo-mobile-auth-composition-2026-09.md). Work is tracked in #178.

Outcome: a signed-in person sees their own open tasks for the chosen organisation in Work → My work, read-only, with
honest loading, empty and failure states.

Unchanged: native sign-in stays off on shared staging and for real accounts; the §8/§10 device gates remain; browser
checks are an approximation, not native proof.

The response-body budget originally left open by this increment is implemented in #202; see the
[budget validation record](../validation/mobile-response-byte-budget-2026-09-27/README.md). Native
buffering/cancellation and device proof remain open.

## 1. Scope

**Delivers.** Work → My work, with the visible fixed-filter subtitle "Open tasks assigned to you",
using the existing compact heading and notice styles. Only:
- page 0 on each mount of the screen;
- **More** for the next page;
- a visible **Refresh** control;
- non-interactive rows of title, status, up to three tags plus a count, and due date;
- loading, empty, failed, refused and "more failed" states.

**Does not deliver:**
- All tasks, By tag, saved views, project or series filters;
- detail pages; rows are not pressable and not links;
- Chat and Resources reads;
- writes;
- polling, automatic foreground reads, pull-to-refresh (a later slice with device evidence), push;
- any persisted or shared cache.

No new dependency, table, migration, API route or flag.

## 2. The existing API used, exactly

`GET /v1/organisations/{organisationId}/tasks` (`apps/api/src/tags/routes.ts:28-31`, `tags/service.ts:8-14, 98-125`).

- **Request, matching the web's My work exactly** (`apps/web/src/app/work/filters.ts:19, 67-74`; `pageSize = 50`):
  `?ownerId={me}&status=open&offset={n}&limit=50`.
  - `status=open` only: `in_progress`, `suggested` and `done` are excluded, as on the web.
  - The API returns top-level tasks only and skips tasks of archived or proposed projects.
- **Order:** `due` ascending with no-date last, then `id`.
- **Response:** `{ tasks, nextOffset }`, where each task is
  `{ id, projectId, seriesId, title, ownerId, status, due: 'YYYY-MM-DD' | null, revision, tags: { id, name }[] }`,
  and `nextOffset` is `offset + limit` when another row exists, else `null`. There is no total.
- **Stored limits** (verified):
  - **Task title.** `tasks.title text not null` has **no** database length check (`0002_commitments.sql:54`). The
    write APIs trim and cap at 200 (`commitments/routes.ts:18, 67, 71`), but series occurrences are generated as
    `titleFor(template, period)` (`commitments/series.ts:75`), which can exceed 200, and older rows may differ. The
    work endpoint does not truncate. So the client must **not** refuse a title over 200 or an empty stored title.
  - **Tag name.** `tags.name` is checked at 1–60 characters and trimmed (`0035_task_tags.sql:5`).
  - **Tags per task.** No cap: `task_tags` has only a primary key, `setLink` has no count limit, and the work query
    returns every link.
  - **Due date.** `tasks.due date` is nullable (`0002_commitments.sql:58`) and sent as `due::text`.
- **Access:** 404 with no active membership (`tenant.ts:9-11`); 401 with no valid session; 400 for an invalid query;
  429/5xx may carry `Retry-After`.

## 3. Design

### 3.1 Read scope and epoch

**A token-free scope on the snapshot.** The signed-in, ready view gains:

```ts
scope: { readonly epoch: string; readonly userId: string; readonly organisationId: string }
```

- `epoch` is **opaque and token-free**. The runner derives it from the machine's account and organisation
  generations, never from a credential handle, token or storage key. Screens must treat it as an opaque value to
  compare for equality.
- Both generations only ever increase, so A → B → A gives three different epochs, which closes the ABA case.
- The membership generation is **not** part of the epoch: a membership refresh that keeps the organisation must not
  cancel a read.
- `scope` is present only when ready; otherwise it is absent.

**Reading.** `AccountSource.read` / `runner.organisationRead` become:

```ts
read<T>(expected: ReadScope, path: (scope: ReadScope) => OrganisationPath, parse: Parse<T>): Promise<ReadOutcome<T>>
```

- **Before sending, atomically in one synchronous step of the runner:**
  - if not ready, or the current scope's `epoch`, `userId` or `organisationId` differs from `expected`, it answers
    `superseded` and sends nothing;
  - otherwise it builds the path **from its own current scope**, takes the current credential, and records the
    epoch and handle it sent under.
- **After the answer, before resolving:**
  - it applies 401 and 403/404 to the account as today, tied to the sending handle and organisation generation;
  - then, if the handle or epoch changed, it answers `superseded`.
- **Atomic in practice (keep it so).** The scope comparison, the path build and the `client.get(...)` call run
  synchronously in the runner before its first `await`, so no event can come between them. A test dispatches a scope
  change between two reads and shows that it cannot affect the first read's path.
- **`ReadOutcome<T>`:** a discriminated union:

  ```ts
  type ReadOutcome<T> =
    | { kind: 'ok'; value: T }
    | { kind: 'unavailable'; wait: Wait | null }
    | { kind: 'refused'; status: number }
    | { kind: 'client-bug' }
    | { kind: 'superseded' };
  ```

  The runner builds `wait` from this read's own `Retry-After` on the shared clamped clock,
  with a wall-clock `about` for wording only.
- **Fixed rules:**
  - **Not ready** (including before a runner exists: web-only, misconfigured, starting) → `superseded`, nothing sent.
  - **401.** The runner dispatches `unauthorised` to the account first, so the state is then `releasing`, and the
    post-answer check answers `superseded`. There is therefore no `unauthorised` outcome. The screen shows nothing for
    `superseded`, and the tabs unmount as the session ends.
  - **The path function throws** (for example `myWorkPath` refusing an offset: a client bug). The runner catches it
    before sending and answers `client-bug`.
  - **`read` never rejects.** Any unexpected throw inside it also resolves as `client-bug`. A parse failure stays
    `unavailable` (the existing `apiOutcome` rule).
- **Never exposed:** handles, tokens or credential-derived values. The harness scripted source implements the same
  signature.

**Late answers are suppressed before the React commit (hook side):**
- The hook keeps a ref holding the scope it last rendered, a per-hook request sequence number, and a mounted flag.
- When an answer arrives, it applies it only if all hold:
  - the hook is still mounted;
  - the request is the latest one;
  - the outcome is not `superseded`;
  - the answer's `expected.epoch` equals the ref's current epoch.

  Otherwise it drops the answer before any `setState`.
- The tabs reset (new key per person and organisation) also unmounts the old screen, so this is defence in depth, not
  the only barrier.

### 3.2 Pacing

- **403/404 membership refresh.** A 403/404 business answer dispatches `org-refused` (today's mechanism). The resulting
  `/v1/me` load is:
  - coalesced with any load in flight (the `refreshing` flag, as today);
  - blocked by the account server wait (as today);
  - **new:** refused inside `lastLoadStarted + 30 s`.

  A refusal inside the spacing or the wait records nothing to retry.
- **What the 30 s spacing covers, precisely.** No other `/v1/me` trigger changes. Every `/v1/me` load, from any trigger,
  sets `lastLoadStarted`: the launch check, the first check after a sign-in's save, Try again from `unverified`, a
  foreground refresh and a refusal. The triggers then differ:
  - **held to both the 30 s spacing and the server wait:** a foreground refresh (as today) and a refusal (new);
  - **held to the server wait only, not the spacing:** the launch check, the first check after sign-in, and a
    person's Try again from `unverified`. These are explicit or one-off, and their semantics are kept.

  So this increment does **not** claim "at most one `/v1/me` per 30 s" overall. It claims:
  - automatic triggers (foreground, refusal) send at most one `/v1/me` per 30 s, measured from the latest load of any
    kind;
  - nothing sends before a server wait ends;
  - every other `/v1/me` load is one-off or comes from a person.

  For example, a refusal just after launch sends nothing, and a refusal 10 s after a person's Try again sends
  nothing.
- **No request chain.** Every business read comes from a person or a mount: opening the screen, Refresh, More or Try
  again. A refused read never re-reads automatically, and a refusal never retries.
- **Separate waits.** A business read's `Retry-After` governs only that screen's Try again, More and Refresh
  controls. It does not set or read the account `/v1/me` server wait, and an account wait does not disable business
  controls.

### 3.3 Typed query path

```ts
export const workPageSize = 50;
export const maxWorkPages = 10;
/** `/v1/organisations/{organisationId}/tasks?ownerId={ownerId}&status=open&offset={offset}&limit=50`. */
export function myWorkPath(scope: ReadScope, offset: number): OrganisationPath
```

- `organisationId` and `userId` must be canonical lower-case UUIDs.
- `offset` must be an integer, a multiple of 50, and within `0 … 50 × (maxWorkPages − 1)` (the API's own limit is
  1,000,000).
- Otherwise it throws a `TypeError` that repeats nothing.
- The keys are fixed and in a fixed order, and no value needs percent-encoding, so the transport's exact
  `response.url === url` check (`client.ts:93`) stays meaningful. `expo/fetch` reporting that URL unchanged on a
  device is a device gate.
- A `nextOffset` from the server is used only after the parser has proved it equals `offset + 50`.
- `organisationPath` stays segment-only. `organisationPath` already encodes `?`; no new guard rule is needed.

### 3.4 Parser and formatting

```ts
export type WorkTag = { readonly id: string; readonly name: string };
export type WorkRow = { readonly id: string; readonly displayTitle: string; readonly status: 'open'; readonly due: DueDate | null;
  /** The first three of the task's tags, in the API's order (lower-cased name, then id). */
  readonly tags: readonly WorkTag[]; readonly tagCount: number };
export type DueDate = { readonly year: number; readonly month: number; readonly day: number };
export type WorkPage = { readonly rows: readonly WorkRow[]; readonly nextOffset: number | null };
export function parseMyWorkPage(value: unknown, request: { scope: ReadScope; offset: number }): WorkPage // throws → unavailable
export function formatDue(due: DueDate | null): string // "Due 3 Oct 2026" | "No due date"
export function displayTitle(title: string): string    // used by the parser: "Untitled task" when blank; at most 300 characters
```

**Unknown fields are ignored and never copied.** Each row and each tag is a new frozen object holding only the fields
above. Every used field is checked strictly:
- `tasks`: an array of at most 50.
- For each task:
  - `id`: a canonical UUID, unique within the page;
  - `title`: any string (no length refusal, see §2). The parser keeps **only** `displayTitle(title)`:
    - trimmed;
    - "Untitled task" when blank;
    - at most 300 code points including the ellipsis when cut (299 code points plus "…"). It is counted with `for (const ch of title)`, stopping at the
      301st code point, so a surrogate pair is never split and a huge title is never copied into an array (no
      `Array.from`).
  - `tags`: an array of **any length**. There is no per-task cap in the database or API: `task_tags` has only a
    primary key, and linking has no count limit. **Every** entry is checked strictly: a canonical UUID `id` and a
    `name` of 1–60 characters with no surrounding whitespace (the stored constraint). A bad entry fails the page.
    The row keeps only the **first three** as new frozen `{ id, name }` objects, plus `tagCount = tags.length` for
    "+N more". The full tag array is never kept.
  - `status` exactly `'open'` and `ownerId` exactly `scope.userId`. They check that the answer is the list asked for;
    a mismatch fails closed.
  - `due`: `null`, or exactly `/^\d{4}-\d{2}-\d{2}$/` with year 0001–9999 (year 0000 refused), month 01–12 and a day
    that exists in that month by the Gregorian leap-year rule, with no `Date` or `Intl`. Postgres's `BC` or
    five-digit-year text is refused by the pattern.
- `nextOffset`: `null`, or exactly `offset + 50` and only when `tasks.length === 50`.
- **Rows in memory are bounded.** The raw title and the full tag list are not kept: at most 500 rows, each with a
  display title of at most 300 code points and at most 3 tags of at most 60 characters.
- Any failure throws a `TypeError` that repeats nothing. The existing client rule turns it into `unavailable`, never
  an empty list.

**What is bounded, and what is not.**
- This increment bounds the **rows kept** (above) and the **requests**:
  - one in flight per screen;
  - at most 10 pages per mount;
  - no automatic retries.
- It does **not** bound network bytes. The transport (`src/api/client.ts`) has a 30-second timeout covering the
  request and the body read, but **no response byte cap**: `response.text()` reads a large or hostile body whole into
  memory before parsing. Unbounded titles and tag lists make a large but valid page possible.
- No transport hardening is in this increment's scope. **Open before customer readiness:** a raw response byte budget
  in the transport, for every read including `/v1/me`, as its own reviewed change.

**Formatting.** `formatDue` uses a fixed table: `Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec`, then
`Due ${day} ${month} ${year}`, from the validated components. There is no `Date`, no `Intl`, no timezone and no
locale dependence. Nothing is relative ("today" or "overdue" need the organisation timezone, a later slice).

### 3.5 Hook and screen

**Lifetime:**
- The list lives only in the My work screen's React state, in memory.
- **Every mount reads page 0**. That includes a remount after a switch, a loss that auto-chooses, or a
  root-layout remount. It is a navigation event, not polling, and the harness can count it.
- Returning to the Work tab while the screen stays mounted does not read. A foreground event does not read.

**Requests (one in flight per screen):**
- **Refresh.** A visible control that reads page 0.
  - On success it replaces the rows and resets the page count.
  - On failure it keeps the rows and says "Couldn't refresh. This list may be out of date." with Try again.
- **More.** Shown only while `nextOffset !== null` and fewer than 10 pages have been loaded.
  - It appends and drops any row whose `id` is already shown. Offset paging can shift while tasks change; the count
    of pages, not rows, bounds the requests, so duplicates cannot cause unbounded paging.
  - On failure the rows stay, with "Couldn't load more" and Try again.
- **Caps.** More stops at 10 pages loaded **or** 500 rows held, whichever comes first (after de-duplication fewer than
  500 rows can be held when the page cap is reached).
  - The website notice is shown **only when** the last answer's `nextOffset !== null` **and** a cap stopped More.
  - Its text: "Some more open tasks may be available on the Captain website.", linked to the fixed website path
    `/work`. It names no number and invents no total.
  - When `nextOffset` is `null`, there is no notice and no More: the list is complete as far as the API said.
- Every control is disabled while a read is in flight or this screen's server wait is running, and shows its reason.

**States:** the fixed subtitle "Open tasks assigned to you" is visible in every state, in
accessibility order immediately after the My work heading. Browser checks assert its text; native
accessibility order remains part of device acceptance.

| State | Shown |
|---|---|
| First load | "Loading your work…" (no rows, no empty text) |
| Empty (ok, zero rows at page 0) | "Nothing open is assigned to you" — "Tasks you own appear here while they are open." |
| Rows | `displayTitle`, "Open", the kept tag names (up to 3), then "+N more" when `tagCount > 3` (N = `tagCount − 3`), `formatDue` |
| Failed, no rows | "Couldn't load your work" + Try again. During this read's server wait: disabled, with "Try again after about {time}" |
| Refused, 403/404 | "Captain couldn't read this organisation's work. If your access has changed, Captain will show it the next time it checks." + Try again (always shown; explicit only). It claims no check is under way. If access was lost, the tabs unmount anyway |
| Refused with another status (400), or `client-bug` | "Captain couldn't read this list." + Try again; no `org-refused`, no access wording |
| Superseded (including a 401: the session is ending and the tabs unmount) | Nothing: dropped before commit |

- A failed read is never shown as empty.
- Rows are plain text, with no press handler, link role or focus as a control. Each row's accessibility label reads
  the title, status, tags and due date.

### 3.6 Website link

`src/config.ts` `webPaths` gains the fixed `/work`, becoming `/`, `/settings` and `/work`. It is still built as the
validated origin plus a fixed path, and opened with `Linking.openURL`.

### 3.7 Harness

The scripted source's `read`:
- stays **pending** until a harness control resolves it, with one control per outcome: `harness-read-ok-page`,
  `-ok-last`, `-empty`, `-unavailable`, `-unavailable-wait`, `-refused-404`, `-refused-400`, `-unauthorised` (resolves `superseded`, as a 401 does in production), `-client-bug`;
- records each asked-for path exactly, with its `expected.epoch`, in the on-page log;
- can be resolved after a harness transition (switch or lost-single), to stage the late-answer case.

The harness 401 outcome checks only that the screen applies no rows. Session release and tab unmounting
are verified separately by account-runner tests and account-transition browser cases.

Synthetic fixtures use titles and tag names outside the fictional mockup names the browser check forbids. Root narrows
the no-digits assertion on My work to the known synthetic due-date texts, not globally.

## 4. Files and owners

| Owner | Files |
|---|---|
| A | `src/api/paths.ts` (`myWorkPath`, `workPageSize`, `maxWorkPages`) and tests; `src/work/my-work.ts` (`parseMyWorkPage`, `formatDue`, `displayTitle`) and tests; `src/config.ts` `/work` web path and test |
| B | machine view `scope` (epoch); runner `organisationRead(expected, path, parse)` with pre-send and post-answer scope checks and read `wait`; reducer refusal spacing; `AccountSource.read` in `account-source.ts` and the harness `scripted-source.ts` with pending reads; `src/work/useMyWork.ts`; `src/app/(tabs)/work/index.tsx`; wording in `copy.ts`; their tests |
| Root | Harness browser checks, CI, docs, git |

## 5. Tests

- **Node:**
  - `myWorkPath`: exact string; UUID, offset-multiple and page-range refusal; nothing echoed.
  - Parser:
    - a valid page, with unknown fields ignored and absent from the result objects;
    - titles over 200 and blank titles accepted, with only the capped `displayTitle` kept (a 10,000-character title
      yields at most 300 code points in the row, and no field holds the raw title);
    - a title of emoji cut at 300 code points with no split surrogate pair;
    - tags: 0, 3, 4 and 150 entries accepted, keeping the first three plus the right `tagCount`; one bad entry
      anywhere (including after the third) fails the page; no field holds the full list;
    - each used-field violation refused;
    - duplicate ids within a page refused;
    - the `nextOffset` rules, and 51 tasks refused;
    - owner/status mismatch refused;
    - dates: `2026-02-29` refused, `2028-02-29` accepted, `1900-02-29` refused, `2000-02-29` accepted; `0000-01-01`,
      `2026-13-01`, `2026-04-31`, `10000-01-01` and `0044-03-15 BC` refused.
  - `formatDue` and `displayTitle`: exact strings, no `Date`/`Intl` involvement.
  - `webLink('/work')`.
- **Node:**
  - scope and epoch:
    - a mismatch answers `superseded` with no send;
    - a change during flight answers `superseded`;
    - A → B → A with an answer in flight is superseded (ABA);
    - the path is built from the runner's scope, not the hook's;
    - a scope change dispatched between two reads cannot affect the first read's path;
    - a 401 resolves as `superseded` after the account dispatch;
    - a throwing path function resolves as `client-bug` with nothing sent, and `read` never rejects;
    - no handle or token appears in the snapshot, the outcome or the log;
  - refusal spacing:
    - inside 30 s of launch: no load; at exactly 30 s: one load;
    - inside 30 s of a person's Try again: no load;
    - inside the server wait: no load;
    - a burst gives one load;
    - Try again from `unverified` and the post-sign-in first check are still not spaced (only the server wait holds
      them), unchanged;
  - the read `wait` is separate from the account wait;
  - the hook: sequence and epoch suppression before `setState`, a read per mount, none on tab return or foreground,
    More de-duplication, the 10-page and 500-row caps, no automatic retry.
- **Harness browser (root)**, at 360/390/430:
  - each state;
  - More, then its disappearance at the last page (no website notice) and at a cap with `nextOffset` still set (the
    "Some more open tasks may be available…" notice);
  - a cap reached with duplicates, showing fewer than 500 rows, still with no number claimed;
  - Refresh replaces;
  - more-failed keeps rows;
  - a read's Retry-After disables its controls until the deadline (clock controlled), while account controls are
    unaffected;
  - refused 404 shows the no-claim wording, with one logged read and no second read;
  - a pending read resolved after a switch or lost-single shows no rows under the new tabs;
  - a remount reads page 0 (log count);
  - the production export makes no reads.
- **Device gates (added to §8):**
  - `expo/fetch` `response.url` equals the query URL;
  - a real 403/404 on an isolated synthetic environment.

## 6. Decisions

The following choices define this increment:
- web semantics (`ownerId=me&status=open`) with a page size of 50;
- plain validated dates from a fixed month table (no `Intl`, no phone timezone);
- unknown fields ignored, used fields strict;
- no polling or automatic foreground read; a visible Refresh only;
- a 403/404 refresh paced by the server wait and 30 s;
- no shared business and `/v1/me` server wait;
- 3 tags plus a count;
- a 500-row **and** 10-page cap;
- the fixed `/work` website path;
- non-interactive rows;
- memory-only, runner-atomic scope with an opaque epoch and late-answer suppression;
- a normal remount reads page 0;
- the optional guard rule dropped.

**Open, not in this increment:** a transport response byte budget before customer readiness (§3.4).


## 7. Review and integration

The two existing Claude Opus agents in Herdr implement their owned files and independently review
each other. Codex owns integration, serial checks, browser validation and git. No implementation
starts before this contract is adopted and #197 is merged. Native sign-in remains off; no staging
release, new machine, migration, signing identity or device proof accompanies plan adoption.
