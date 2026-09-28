# Mobile equipment schedule, read-only (M-equipment slice 1)

Status: **adopted by the reviewed amendment #211, 27 September 2026. Slice E-1 (pure data modules) is implemented
and cross-reviewed on 28 September 2026 in #212; slice E-2 (hooks, screen, harness, browser checks) is
not started.** Claude B authored the contract from Claude A's API/web audit. Root and A independently reviewed it;
B reviewed root's corrections and status updates. Outcome: **allocate resources**, by seeing, on the phone, when shared equipment is booked
across equipment and days.

E-1 adds no dependency, API, schema, flag, deployment or native enablement, and no screen change: nothing on a device
or in a browser reads equipment yet.

## 1. Authority and root decisions

**Existing authority**
- Foundation §7 M-read authorises the equipment catalogue.
- The M-equipment row authorises a "read-only timeline (unknown or unloaded time never free; continuous
  Hours/Days/Weeks)". It also says gesture dependencies are named in that increment, and §8 excludes them until
  then.
- The approved mockups (`captain-mobile-2026-09-22` README §"Equipment planning and time zoom") define the layout.

**Root decisions (27 September), applied throughout**
1. **The layout.** It stays a multi-day, cross-equipment timeline, not an agenda substitute.
   - Days is the default scale.
   - Bars are continuous and cover the occupied time.
   - Hours/Days/Weeks buttons zoom around the centre of the view.
2. **Pinch is out of this slice.** It is a later increment, with its own named dependency and device gate.
3. **Scrolling uses React Native's own horizontal scrolling**, with:
   - explicit header arrows and a partly visible next column;
   - a sticky equipment header and time axis;
   - windowed time rendering.

   The exact geometry is decided in implementation review.
4. **Range and time zone:**
   - one calendar month back and six months ahead, in 28-civil-day chunks;
   - the organisation time zone is bootstrapped by a fixed `GET /v1/organisations/:id`;
   - a runtime refusal applies when the zone isn't supported on the device.
5. **The catalogue** uses explicit "More equipment" paging. There is **no silent cap**.
6. **Reads:**
   - only reservations for the visible equipment and window are read;
   - a sequential, bounded queue sends them, with each read's own waits and scope epochs;
   - no free capacity is ever inferred for an unread, partial, stale or failed cell.
7. **The website link** is fixed: `/resources/equipment` is added to `webPaths`. There is no dynamic detail path.
8. **The pure web helpers** (`time.ts`, `range.ts`, `loads.ts`, `geometry.ts`) are ported locally into
   `apps/mobile`, with tests. There is no new package, because the mobile boundary forbids workspace imports.

**Amendments made by adopting this contract:**
- Foundation §7's M-equipment row reads "read-only timeline, slice 1: scale buttons; pinch in a later slice with
  named gesture dependencies".
- A new fixed mobile read, `GET /v1/organisations/:id`.
- `/resources/equipment` is added to `webPaths`.

## 2. Source facts

These are from the audit, which re-checked `apps/api/src/equipment/*`, `organisations/service.ts` and
`ratelimit.ts`.

**API**
- **`GET /v1/organisations/:id`** returns `{ id, name, timezone, locale, createdAt, role }`. `timezone` is a free
  string of 1–64 characters, not validated as IANA.
- **`GET …/equipment`:**
  - the query is strict: `archived` (default false), `limit` 1–100 and `offset` 0–1 000 000;
  - the response is `{ equipment: [{ id, name, archivedAt, revision, createdAt, updatedAt }], nextOffset }`;
  - rows are ordered by `lower(name), id`; `nextOffset` is `offset + limit` when another row exists, otherwise
    `null`.
- **`GET …/equipment/:eid/reservations?from&to[&limit&offset]`:**
  - the query is strict, and it reads one equipment per request;
  - `from` and `to` are ISO instants with `Z` or an offset, in 1900–2200, with `0 < to − from ≤ 93 days`;
  - `limit` is 1–200 (default 200);
  - only `confirmed` rows whose **occupied** range intersects `[from, to)` are returned, ordered by
    `occupiedStartsAt, id`;
  - the response is `{ reservations, nextOffset, coverage: 'complete'|'partial', from, to, timezone }`, where
    `complete` means `offset 0` and everything fitted;
  - an unknown or foreign equipment ID gives 404, and a non-member gets 404.
- **Each reservation:** `id`, `equipmentId`, `title` (1–200), `kind` (`booking` or `maintenance`), `status`,
  `startsAt`, `endsAt` (the actual interval, up to 366 days) and `setupMinutes`/`cleanupMinutes` (0–10 080).
  - `occupiedStartsAt` is `startsAt − setup` and `occupiedEndsAt` is `endsAt + cleanup`, both enforced by the
    database.
  - Also returned: `projectId`, `taskId` and `ownerId` (IDs only, no names), `createdBy`, `revision`, `createdAt` and
    `updatedAt`.
- **Access:** every active member reads all equipment and **all** reservations. There is no role restriction.
- **Rate limits:** per IP 300 a minute (**the tightest for one site's shared connection**), per person 600 a minute,
  and per organisation 1 200 a minute.

**The web schedule** (`apps/web/src/app/resources/equipment`) is the behaviour being ported:
- the range and chunks (`range.ts`) and the cell states (`loads.ts`);
- scales of 576, 84 and 24 pixels per day for Hours, Days and Weeks (`geometry.ts`);
- zone-correct civil days and daylight-saving handling (`time.ts`);
- rendering only the visible window plus 1.5 viewports.

**Mobile today**
- `/resources` is the Equipment schedule placeholder, and the link map sends `/resources/equipment` there.
- The runner offers one scoped read per call (`organisationRead`), with the account scope epoch, per-read waits and
  a 1 MiB response budget.

## 3. Scope

**In scope**
- `/resources` becomes the read-only schedule:
  - the equipment catalogue, as columns in the API's order;
  - the occupancy bars;
  - Hours/Days/Weeks buttons, Today, and re-anchoring at the range ends;
  - a read-only detail panel for a tapped bar;
  - the fixed website link.

**Out of scope**
- Writes of any kind (reserve, edit, cancel) and a green plus.
- Pinch and custom pan gestures; any gesture or animation dependency. Ordinary React Native `ScrollView`
  scrolling, horizontal and vertical, is in scope and required.
- A "go to date" picker; the project reservations view.
- Owner, project and task names.
- Archived equipment; notifications; any offline or cached data.

## 4. Data rules (pure; slice E-1)

### 4.1 Organisation time zone and the device gate

**Bootstrap.** On mount, once the scope is bound, the screen reads `GET /v1/organisations/{id}` (a fixed path, via
`organisationRead`).
- The parser accepts `{ id }` equal to the scope's organisation, and `timezone`, a string of 1–64 characters.
- It keeps **only** `timezone`.

**Zone gate** (pure `zone.ts`, a port of `time.ts`):
1. `Intl.DateTimeFormat(…, { timeZone })` must construct without throwing, and `formatToParts` must return
   year/month/day/hour/minute parts.
2. A built-in self-check converts fixed instants in `Australia/Perth` and in a daylight-saving zone
   (`Australia/Sydney`, around 5 April 2026) and compares them with known answers.
3. If either step fails, the screen shows **"Times can't be shown in the business time zone on this device. Open
   the schedule on the website."** It reads no occupancy, and **never** falls back to device-local times.

The self-check covers the organisation's own zone as well as the fixed vectors. It round-trips `zonedDay` and
`displayTime` for two fixed instants, and requires the zoned civil day to map back to the instant's day boundary.

**Mount order.** The organisation read necessarily comes first, because it supplies the zone. The zone gate runs on
its answer. The first catalogue page (§4.5) follows, and only occupancy reads depend on the zone having passed the
gate. No timeline, column or bar is drawn before the bootstrap and the zone gate succeed.

**Bootstrap failures.** The organisation read goes through `organisationRead` and the screen's coordinator (§4.4).
- A 403/404 shows the access wording, and the runner does its one paced membership refresh.
- Unavailable (with or without a wait) shows "Couldn't load the schedule." with Try again, disabled while a
  screen-wide wait is outstanding.

**Zone changes**
- An occupancy response whose `timezone` differs from the bootstrapped zone is **not applied**.
- Every cell becomes stale (§4.4), the screen says "The business time zone changed. Refresh to see the schedule.",
  and the queue stops.
- Refresh bootstraps again.

### 4.2 Range, chunks and time bounds

This is a port of `range.ts`, with the same semantics.
- **The anchor** is a civil date in the organisation zone.
  - Mount uses today, captured once.
  - "Earlier dates" or "Later dates" uses the **selected edge date**, not today.
  - Refresh keeps the current anchor.
  - Today scrolls to now, and re-anchors on today only if now is outside the current range.
- **The range** runs from `anchor − 1 calendar month` to `anchor + 6 calendar months`, clamped a day inside
  1900–2200.
- **Chunks** are at most 28 civil days, aligned to the anchor.
  - Each boundary is the zoned midnight of its civil date.
  - A date skipped by a clock change moves its boundary to the next existing day, and a zero-length chunk is
    dropped.
  - Every chunk is therefore far under the API's 93-day limit, and every boundary is an exact `…Z` instant.
- **The time axis is continuous in instants.**
  - Daylight-saving days render as 23 or 25 hours.
  - Labels (the hourly ticks in Hours; the day and week ticks in Days and Weeks) come from the zone, as on the web.
- **At either end** of the range, "Earlier dates" or "Later dates" re-anchors on that edge date.
  - It bumps the generation, rebuilds the chunks, and discards every cell, payload and marker whose key isn't in the
    new chunk set.
  - It keeps the zone, the loaded catalogue pages, and the screen's wait and rate log. Any zone change is still caught
    by each occupancy response (§4.1).
  - It is the only way past the range, so reads stay bounded.
- **The pure range port proves** `to > from`, at most 93 days per chunk, and clamping inside 1900–2200.

**Query values**
- The occupancy path is `organisationPath(org, 'equipment', eid, 'reservations')` plus `?from={from}&to={to}&limit=200`.
- The key order is fixed, and `from` and `to` are the canonical `Date.prototype.toISOString()` strings
  (`YYYY-MM-DDTHH:mm:ss.sssZ`).
- `:` is left unencoded, which is legal in a query. Whether native `fetch` echoes the URL unchanged is a device gate,
  the same as for the Work query.
- A 400 is a client bug, and never means free.

### 4.3 Parsers (strict, minimal)

A parser throws a fixed `TypeError` that repeats no value, and the client then reports **unavailable**. One bad row
refuses the whole response, and the cell or page fails.

**Catalogue: `parseEquipmentPage(value, request: { offset, limit })`**
- The request is active equipment only (`archived` omitted, so false), with `limit=100`, the API maximum.
- `equipment` is an array of at most `limit` items.
- Each item has:
  - a lower-case UUID `id`, unique within the page;
  - a `name` string that is non-blank after trimming and at most 100 characters (UTF-16 `.length`), kept raw
    (`service.ts` trims and caps at 100);
  - `archivedAt: null`.
- Archived equipment is excluded, as on the web's default. Archiving requires no future occupancy, but occupancy on
  archived equipment during the month before today is not shown. The legend or a notice says so.
- `nextOffset` is either `null`, or exactly `offset + limit` with the page full. Anything else is invalid.
- Only `id` and `name` are kept.

**Occupancy: `parseOccupancy(value, request: { equipmentId, from, to, zone })`**
- `from` and `to` must equal the requested instants exactly, and `timezone` must be a string. A zone mismatch is
  reported separately (§4.1), not as invalid.
- `reservations` is an array of at most 200 items.
- **Page facts.** Mobile always reads `offset=0, limit=200`, and the API computes `nextOffset` as `offset + limit`
  only when more rows exist. Exactly two combinations are valid; anything else, including a negative, fractional or
  other `nextOffset`, is refused:
  - `nextOffset: null` with `coverage: 'complete'` and at most 200 rows;
  - `nextOffset: 200` with `coverage: 'partial'` and exactly 200 rows.
- **Each reservation:**
  - `id` is a canonical lower-case UUID, unique within the response, and `equipmentId` equals the request's;
  - `title` is a string of 1–200 characters that is non-blank after trimming, kept raw;
  - `kind` is `booking` or `maintenance`, and `status` is `'confirmed'`;
  - **timestamps:** each of the four is a canonical instant. It matches exactly
    `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`, parses to a finite time, and satisfies
    `new Date(s).toISOString() === s`. This is exactly what the API's JSON serialisation of `Date` produces;
  - **actual interval:** `startsAt` and `endsAt` are at or after `1900-01-01T00:00:00.000Z` and strictly before
    `2200-01-01T00:00:00.000Z` (the API's bounds on actual time), with `0 < endsAt − startsAt ≤ 366 days`;
  - `setupMinutes` and `cleanupMinutes` are integers from 0 to 10 080;
  - **interval consistency:** `occupiedStartsAt = startsAt − setup` and `occupiedEndsAt = endsAt + cleanup`, exactly,
    in milliseconds. The occupied instants are **not** bounded to 1900–2200: buffers may validly extend up to
    10 080 minutes beyond either bound, and must be neither clamped nor refused;
  - `revision` is a safe positive integer (`Number.isSafeInteger`, at least 1);
  - the occupied range intersects `[from, to)`.
- **Kept:** `id`, `title`, `kind`, `startsAt`, `endsAt`, `occupiedStartsAt`, `occupiedEndsAt`, `setupMinutes`,
  `cleanupMinutes` and `revision`.
- **Dropped:** `projectId`, `taskId`, `ownerId`, `createdBy`, `createdAt` and `updatedAt` (data minimisation).
- **Coverage:** a cell is **complete only if** `coverage === 'complete'` **and** `nextOffset === null`. The only other
  valid answer is partial. Any other combination is a malformed response, which fails the cell with no automatic
  retry; it is never treated as partial. Mobile reads offset 0 only and does not page within a cell.

### 4.4 Cells, queue and waits

This is a port of `loads.ts`, adapted to one read per request.

**Cell key.** A cell is keyed by `(equipmentId, chunk.from, chunk.to)`, using the chunk's exact instants and never
its index. A new anchor therefore can never map old bars onto different dates.

**Cell states**
- `unread` or `loading`;
- `failed(reason, wait)`;
- `partial`;
- `complete`;
- `conflict`;
- `stale(previous, failure?)`. This is the previous payload after Refresh, together with the failure of its re-read
  if that re-read failed.

**Free time.** Only `complete` may leave a gap undrawn, and only as a claim about the time of the read: "no confirmed
reservations when read".
- Unread, loading, failed, conflict and stale cells stripe every gap.
- A **partial** cell draws the bars it read and stripes all its other time, with "Not every reservation is shown for
  these dates. Gaps are not confirmed free."
- A partial cell has no further paging and no Try again, because re-reading gives the same truncation. Only Refresh
  re-reads it.

**Which cells are wanted**
- The visible equipment columns plus the partly visible next one, for the visible chunks, then the chunks either side.
- Wanted cells are ordered nearest the centre first. Nothing else is ever read.
- **Planning happens only when the view settles:** on scroll end and momentum end, and on completion of an arrow,
  zoom, Today or re-anchor. It never happens on every scroll frame, so fast scrolling sends nothing.

**One coordinator for every read the screen sends**
- Every read the schedule screen sends goes through one coordinator per mounted screen: the organisation read,
  catalogue pages and occupancy.
- **At most one read is in flight**, of any kind.
- **At most 30 reads start per rolling minute**, counting all kinds. That is a tenth of the per-IP limit, which leaves
  room for other screens, devices and the website on the same connection.
- Reads are sent only while mounted and not inert. Occupancy is also sent only while the zone is valid and the queue is
  neither stopped nor waiting.
- **Screen-wide waits.** An outstanding `Retry-After` from **any** read on this screen blocks **every** read the screen
  sends until it ends: bootstrap, More, Refresh, Try again and queue planning. The affected buttons are shown
  disabled, with the reason. The server's limits are per IP, person and organisation, not per endpoint.
- **Refresh and re-anchor keep the screen's outstanding wait and its rolling-minute start log**, so neither can
  bypass a wait or the budget. A server wait ends at its deadline; rate-log entries expire individually after
  sixty seconds. A wait ending never clears the rate log. Unmounting discards this screen coordinator.

**How many reads**
- **Per generation.** A generation is a mount, a Refresh or a re-anchor. It sends at most:
  - 1 organisation read;
  - the catalogue pages explicitly requested in it;
  - 1 read per wanted cell key that isn't already loaded or marked.

  Each key is automatically read at most once per generation, unless it was evicted from `complete`.
  Explicit Try again can repeat a failed organisation, catalogue or cell read in that generation, within the same
  wait and rate limits. These are scheduling rules, not a total request-count bound.
- **Over time,** only the rate bound limits reads: one in flight, 30 started per rolling minute, and every wait
  honoured. There is no total count per mount.

**Answers**
- An answer applies only to the cell still `loading` for that exact request number, under the same scope epoch and
  bootstrap generation. Otherwise it is dropped. Mount, Refresh and re-anchor each bump the generation.
- A failed cell is **never re-read automatically**. It is re-read only by its own Try again or by Refresh.

**Outcomes**

| Runner outcome | Cell | Queue |
|---|---|---|
| ok | complete or partial (§4.3) | continues |
| unavailable with a wait (429, 5xx with `Retry-After`) | failed with the wait; Try again disabled until it ends | the whole screen **waits** (see "Screen-wide waits" above), then continues with unread cells |
| unavailable with no wait (network, timeout, unusable body, parser refusal) | failed: "Captain couldn't read these dates." | **stops**; nothing more is sent until Try again or Refresh. This circuit prevents a burst of failures while offline |
| refused 403/404 | failed | **stops** at once, and the access wording is shown. The runner does its one paced membership refresh, never one per column |
| refused, another status, or client-bug (including 400) | failed: "Captain couldn't read these dates." | **stops** |
| superseded | nothing applied | **stops**; the tabs reset follows |
| contradictory equal revision | conflict, no conflicting bars | **stops** occupancy until Refresh; Try again cannot lift it |

- The transport deliberately doesn't distinguish a parser refusal from a network failure. Both get the same generic
  wording, and nothing ever says "check your connection". The transport isn't changed.
- These waits never touch the `/v1/me` wait.
- A 401 ends the session, as elsewhere.
- Scope binding and inert rules are exactly as for Inventory and Work.
- **Resuming a stopped queue.** Try again on a failed cell (or "Try again for the dates shown") is enabled only once
  any screen-wide wait has ended. It re-reads only that cell or those cells. The queue resumes planning unread cells only after one of them succeeds. A conflict stop is lifted only by Refresh;
  a 403/404 stop also requires Refresh after the runner's membership check.

**Retained data is bounded**
- **The limit.** Without a bound, 1 000 equipment × 9 chunks × 200 rows would be unbounded memory, so **at most 64
  cells keep a payload** (rows).
  - Payloads are evicted farthest from the view centre first.
  - The wanted set is about 3–4 columns × 3 chunks, about 12 cells, well inside the limit.
  - Worst case is 64 × 200 = 12 800 kept rows of ten fields, a few MB of JavaScript.
- **Eviction never weakens honesty.** Only a `complete` payload is evicted to `unread`, and it may be re-read when
  wanted again, within the budget.
- **Terminal markers.** Evicting a `partial`, `conflict` or `stale` payload leaves a **compact terminal marker**,
  with no rows. `failed` cells hold only such a marker from the start. A marker is the key, the state and any
  wait-until.
  - A marker is never demoted to `unread`, so revisiting it never retries it automatically.
  - A marker is drawn hatched over the cell's whole span, with its state wording. It shows no bars and no blank time.
  - Markers are cleared only by Try again (failed cells), by Refresh, or by re-anchoring for keys outside the new range.
- **These are payload limits, not a limit on the app's total memory.**
  - Markers grow only with the keys actually attempted.
  - The catalogue grows only through explicit More pages, keeping an ID and name per equipment.
- Cross-chunk deduplication considers retained payloads only.

**Refresh** (explicit only)
1. **Stale.** Every cell with a payload becomes `stale(previous)`: its last bars stay visible, labelled "May be out
   of date", with gaps hatched. Markers and failed cells are cleared.
2. **A new generation.** The generation is bumped, and in-flight answers of the previous generation are dropped.
3. **The screen's limits remain.** The outstanding wait and the rate log are kept.
4. **Organisation.** The organisation is bootstrapped again, keeping the current anchor (§4.2).
5. **Catalogue and cells.** The catalogue is replaced from page 0 (§4.5), and the wanted cells are re-read.
6. **Outcomes.**
   - A successful read replaces a stale cell.
   - A failed one becomes `stale(previous, failure)`: the stale bars stay, the failure is shown, Try again follows
     the failure's rules, and it **never shows free time**.
7. **If the bootstrap or page 0 fails,** everything already shown stays, labelled stale, with "Couldn't refresh. The
   schedule may be out of date." and Try again.

**Duplicates across chunks**
- A reservation returned by two cells is drawn once, at its highest revision.
- If two cells report the same `id` **and the same revision** but any kept field differs, nothing is chosen
  silently:
  - both cells become `conflict`, and their coverage is unknown;
  - the reservation is drawn from neither, and all their time is striped;
  - the note says "Captain received conflicting details for a reservation. Refresh to read it again.";
  - the occupancy queue stops; there is no Try again. Only Refresh clears this conflict and re-reads them.

### 4.5 Catalogue list

Root's ruling: pages are loaded **explicitly**, not all fetched on mount, and there is no arbitrary cap.

- **First page:** read on mount after the bootstrap, with `limit=100, offset=0`.
- **More equipment:** an explicit control at the end of the columns (and in the header), shown while
  `nextOffset !== null`. While more exist, the header says "More equipment not loaded yet", so the loaded columns are
  never presented as the whole set.
- **API ceiling:** the only stop is the API's declared maximum `offset` of 1 000 000. When `nextOffset` would exceed
  it, More is replaced by "More equipment is listed on the website" with the link. It is never silent.
- **Duplicates:** offset paging is not a snapshot. An ID already shown is dropped from the later page, and a one-line
  notice says "The equipment list changed while loading. Refresh for the current list."
- **Order:** the API order is kept and never re-sorted.
- **Empty:** "No equipment is listed yet." with the website link, and no timeline, appears only for a successful
  empty first page.
- **Failures:** a failed first page fails the catalogue. A failed later page keeps the columns already loaded and
  labelled incomplete, with its own Try again.
- **Refresh:**
  - replaces the list from page 0;
  - invalidates every earlier `nextOffset`, and drops any More answer still in flight;
  - after success, shows only page 0's columns, with later pages again behind More. Cells for equipment no longer
    listed are dropped;
  - if page 0 fails, keeps the columns already shown, labelled stale, with Try again.

## 5. Presentation (slice E-2)

**Layout**
- **The frame:** the heading is Equipment schedule, with the subtitle "Bookings for shared equipment", then the
  sticky row of equipment names, then the body.
- **The body** is a vertical time axis (sticky on the left) beside the equipment columns in a React Native
  horizontal `ScrollView`, inside one vertical scroll.
- **Horizontal navigation:** column width leaves the next column partly visible. The header arrows move exactly one
  column, and the header follows the columns' horizontal offset.
- **Windowed rendering:** only ticks, bars and hatching in the visible time window plus 1.5 viewports are rendered
  (`renderWindow`).
- **Scales:** Hours (576), Days (84, the default) and Weeks (24) pixels per day.
  - The buttons keep the instant at the centre of the view in place (`zoomScroll`), and the horizontal offset is
    unchanged.
  - Today scrolls to now.
- **Fixed requirements** (root). These are not traded away for implementation ease:
  - a fixed time axis stays visible;
  - bars are continuous across day boundaries, never visually detached daily blocks;
  - there is ordinary horizontal `ScrollView` scrolling plus the header arrows.
- **Open until implementation review** (with existing React Native primitives only):
  - the composition of scroll views and virtualisation, for example A's horizontal `ScrollView` holding a
    virtualised vertical list;
  - how the header and axis stay in place, and the exact geometry and offsets.

  Per-column date bands may be added alongside the axis, never instead of it. Whichever composition is chosen, the
  browser proof must show the approved semantics above.

**Bars**
- Each bar covers the **occupied** interval and is continuous across day lines.
- Maintenance is visually distinct, and bars too short for labels become thin marks.
- **Labels.** A bar's visible label (when it fits) holds the title. Its accessibility label is, as on the web,
  `{equipment} · {title} · {Booking|Maintenance} · {actual start–end in the organisation zone, with UTC offset}`,
  plus "includes setup N min, cleanup M min" when present.
  - The equipment name is always included, so a bar is never attributed to the wrong column, even if header alignment
    is off on a device.

**Detail panel.** Tapping a bar opens an in-screen, read-only panel built from the loaded row, with no extra read.
- It shows the equipment name, the title, the kind, the actual start–end with its UTC offset, setup and cleanup, and
  "Occupied {start}–{end}".
- It says "As of the last read. Availability can change before a reservation is saved."
- There is no route, deep link or write.

**Legend and time zone**
- The legend: "Hatched: not known. Blank time in a fully read period had no confirmed reservations when it was read;
  availability can change before a reservation is saved."
- A fixed "Times in {timezone}" line.

**Website link.** "Open the schedule on the website" goes to `/resources/equipment`, when the web origin is set.

**States and wording**

| State | Shown |
|---|---|
| Loading (bootstrap or first catalogue page) | "Loading the schedule…". No columns, no bars, nothing blank. |
| Zone unsupported | "Times can't be shown in the business time zone on this device. Open the schedule on the website." |
| Zone changed | "The business time zone changed. Refresh to see the schedule." |
| No equipment | "No equipment is listed yet." |
| Access (403/404) | "Captain couldn't read this organisation's equipment. If your access has changed, Captain will show it the next time it checks." |
| Catalogue or bootstrap failure | "Couldn't load the schedule." with Try again, disabled during any wait. |
| Cell unread or loading | Hatched, "Not loaded yet" or "Loading…" in the column's accessibility summary. |
| Cell partial | Bars read, other time hatched, "Not every reservation is shown for these dates. Gaps are not confirmed free." Refresh only. |
| Cell failed | Hatched, "Captain couldn't read these dates." (or the access wording), and Try again, disabled while any screen-wide wait is outstanding. No connection diagnosis. |
| Cell conflict | Hatched, "Captain received conflicting details for a reservation. Refresh to read it again." |
| Cell stale(previous) | Last bars, "May be out of date", gaps hatched. |
| Cell stale(previous, failure) | Last bars, "May be out of date. Captain couldn't read these dates again.", gaps hatched, Try again as for failed. |
| Terminal marker (payload evicted) | Hatched over the whole span with the state's wording. No bars, no blank time. |
| Scope changed (inert) | "Loading the schedule…". Nothing from the old scope is shown or sent. |
| Later catalogue page failed | Columns already loaded stay, labelled "Couldn't load more equipment. The columns shown aren't the whole list." with that page's own Try again. (Status edit, E-2.) |
| Archived equipment | Legend line: "Archived equipment isn't shown, including its bookings from the last month." (Status edit, E-2; wording for §4.3's "the legend or a notice says so".) |

## 6. Proof, kept separate

| Evidence | Proves | Does not prove |
|---|---|---|
| Node tests (pure modules) | Zone conversion including daylight saving, range and chunks, parsers, cells, queue, waits, duplicates, stale, refresh | Hermes `Intl` behaviour; rendering |
| Harness web export with Chromium at 360, 390 and 430 px | States and wording; bars from fixtures, continuous across days; the fixed axis; never-free rules including partial and conflict; arrows disabled at the ends; horizontal scrolling; scales keeping the centre instant; Today; re-anchor on the edge date; one read in flight across all kinds, a screen-wide wait surviving Refresh, and the network stop; no automatic retry on revisit, including evicted markers; equipment names in bar labels; the catalogue's More and page-2 columns; Refresh; the link; no overflow | Native scrolling, header sync smoothness, momentum, performance, gestures |
| Device (later, isolated synthetic environment) | Hermes zone self-check result; native URL echo of the occupancy query; scroll performance across seven months at Hours (about 120 000 px); horizontal scrolling and arrows; zoom anchoring after settling; header and axis stickiness; VoiceOver/TalkBack across nested scrolls; larger text | Not claimed by this slice's PRs |

Native sign-in stays off: real accounts can't reach this on a device. Chromium touch emulation is never claimed as
native gesture proof.

## 7. Work slices (each its own PR, peer reviewed)

**E-1: data only, no UI change**
- **Pure modules:** `zone.ts` (the self-check and gate), `range.ts`, `cells.ts` (the cells and queue decisions) and
  `geometry.ts`, ported from the web, with Node tests at least as strong as the web's own
  (`time.test.ts`, `range.test.ts`, `loads.test.ts`, `geometry.test.ts`).
- **Paths:** `organisationPath(id)` (already possible), `equipmentPagePath(scope, offset)` and
  `occupancyPath(scope, equipmentId, chunk)`, with fixed key order, exact instants, and tests.
- **Parsers:** `parseOrganisationZone`, `parseEquipmentPage` and `parseOccupancy`, with tests of every rule in
  §4.3.

**E-2: UI**
- The hooks: the bootstrap, catalogue and occupancy queue, bound to scope epochs.
- The `/resources` screen, bars, the detail panel and `stockCopy`-style wording in `copy.ts`.
- `webPaths` gains `/resources/equipment`.
- **Harness fixtures and controls**, chosen by path: the organisation, catalogue pages, and occupancy per
  (equipment, `from`). They cover complete, empty-complete, partial, a conflict, failed with a wait, a network failure,
  404, zone mismatch and daylight-saving dates.
  - A control may resolve **all currently pending** occupancy reads with a named answer set.
  - Each resolution still feeds its own request's fixture through the real parser, one response per request.
  - Later requests are sent by the real queue one at a time, and each also passes through the real parser. A bulk
    control never bypasses the queue, pre-answers future requests or injects parsed state.
- Browser checks for the §6 harness row.

**Ownership** (root's decision). No implementation starts before this contract is adopted.

| Slice | Owner | Work | Review |
|---|---|---|---|
| E-1, in parallel | Claude A | Fixed paths and strict parsers (§4.1 organisation, §4.3), with their tests; the catalogue list state (§4.5, `catalogue.ts`) | Claude B |
| E-1, in parallel | Claude B | Pure `zone.ts`, `range.ts` and `geometry.ts` ports (§4.1, §4.2), with their tests; the cell and queue state (§4.4, `cells.ts`) | Claude A |
| E-1, in parallel | Root | The screen-wide read gate (§4.4 one flight, rate log, waits, stops: `coordinator.ts`), with its tests, plus integration validation | Claude A and Claude B |
| E-2, after the E-1 interfaces are reviewed | Claude B | Hooks, screen, detail panel, copy, and the `webPaths` config | Claude A, independently |
| E-2 | Root | Harness fixtures and controls, browser checks, validation records and git | — |

Root for E-1 was Codex until 27 September 2026 (paths, parsers, ports and the gate were written under it); from
28 September Claude Fable acted as root because Codex's usage allowance was exhausted until 4 October. Root then
reassigned the cell/queue state to Claude B and the catalogue state to Claude A, each independently reviewed by the
other. **E-1 review outcomes:** the gate was corrected after both reviews (Refresh and re-anchor are allowed while a
read is in flight, with the in-flight answer dropped when it lands; conflict and zone stops block occupancy reads
only). Root accepted A's `refreshCatalogue` press-time transition (§4.5 "drops any More answer still in flight" cannot
wait for the page-0 read to start while the gate is busy) and B's conflict handling (every cell holding a disagreeing
copy is `conflict`; a conflict cell draws its uncontradicted rows with all its time striped, and the contradicted ID is
drawn from no cell until Refresh).

## 8. Acceptance criteria

1. **Read order.**
   - No read happens before the scope is bound.
   - The organisation read is the only read allowed before the zone gate, because it supplies the zone.
   - No catalogue or occupancy read happens before the gate passes.
   - Every read's path comes from the runner's own scope.
2. **Undrawn time.** Only complete cells may leave time undrawn, and only as a claim about the time of the read.
   - Unread, loading, failed, conflict, stale and marker cells stripe every gap.
   - Partial cells draw their bars and stripe all other time.
   - This holds at every scale.
3. **Reads.** Every read the screen sends (organisation, catalogue and occupancy) goes through one coordinator:
   - at most one read in flight, of any kind;
   - at most 30 started per rolling minute, counting all kinds;
   - any outstanding `Retry-After` blocks every read on the screen;
   - Refresh and re-anchor keep both the wait and the rate log;
   - no read while inert, unmounted, stopped or waiting, as in §4.4;
   - no failed, partial, conflict or stale cell is re-read without Try again (failed cells) or Refresh, including
     after being scrolled away and back.
4. **Retained data.** At most 64 cells keep a payload. Only `complete` payloads are evicted to `unread`. Every other
   state leaves a compact terminal marker, cleared only by Try again, Refresh or re-anchoring.
5. **Zone.** A zone mismatch applies nothing and asks for Refresh. An unsupported zone shows the refusal and reads no
   occupancy.
6. **Range.**
   - The range is exactly −1 month to +6 months around the anchor, in chunks of at most 28 civil days.
   - It is correct across daylight-saving changes and skipped days.
   - Nothing outside it is read.
   - The ends re-anchor on the selected edge date.
7. **Catalogue paging.**
   - More is explicit.
   - Duplicates are dropped with a notice.
   - The only stop is the API's maximum offset, and it is worded.
   - An invalid `nextOffset` is refused.
   - Refresh replaces the list from page 0, and keeps labelled stale columns if it fails.
8. **Parsers** enforce everything in §4.3: canonical timestamps and UUIDs, actual-time bounds, interval and buffer
   consistency, the two valid page-fact combinations, and only the listed fields kept. A reservation with the same
   revision but different data is never silently chosen.
9. **What's not included.** There are no writes, no custom gestures and no dynamic links. No person, project or task
   names are shown; the only names are equipment names and each reservation's own title. Every bar's accessibility
   label and detail panel name the equipment. Horizontal scrolling works with ordinary `ScrollView`, alongside the arrows, a fixed time
   axis and continuous bars.
10. **Evidence.** The Node, harness and device evidence is labelled as in §6, with no device or native claim before
    device runs. Harness answers always pass through the real parser, one per request.

## 9. Resolved and open

**Resolved (root)**
- 30 reads a minute, one in flight, and 64 payloads are accepted as conservative limits for this increment.
- The zone self-check is a source guard, not a substitute for device proof. Hermes `Intl` remains a device gate
  (§6).
- Adding the fixed organisation read to the foundation's read table is root's status edit.

**Open**
- **The only open choice:** the scroll composition, and how the header and axis stay in place. This is decided in
  implementation review (§5), within the fixed requirements, with device proof later.
