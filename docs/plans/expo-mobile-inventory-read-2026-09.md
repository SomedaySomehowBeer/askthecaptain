# Mobile Inventory read (M-read slice 3)

Status: adopted by this reviewed plan amendment, 27 September 2026. **Not implemented.**
Claude B drafted the contract; root reviewed API fidelity and scope; Claude A independently
reviewed it, with all four findings incorporated. Repository facts were checked against the
#207 implementation with #205 navigation integrated; #206/#207 are now merged. Outcome:
**allocate resources**, by seeing counted stock by location on the phone.

Authority: [foundation](expo-mobile-foundation-2026-09.md), [next batch](captain-next-batch-2026-09-27.md)
and [main plan](../plan.md). No code, dependency, API, schema, flag or deployment changes here.

## 1. Authority, and what needs amending

**Existing authority.** No new decision is needed.
- Foundation §7's M-read row delivers "Resources: … counted stock".
- Foundation §6 lists Inventory in the Resources view list.
- The route `/resources/inventory` exists (`src/app/(tabs)/resources/inventory.tsx`, a placeholder today). It is on the
  link allow list (`lib/links.ts:21`), and `navigation/sections.ts` already routes the Inventory row.

**Amendments made by adopting this contract:**
1. **The "bounded and paginated" claim.** Foundation §1 is amended here: bounds are checked per endpoint.
   Stock is unpaginated (§2); this client applies the 1 MiB decoded-response budget.
2. **One fixed website path.** Add `'/resources/inventory'` to `webPaths` (`src/config.ts:31`), for the "Count stock on
   the website" link (decision D1).

Nothing else changes: routes, the link allow list, navigation, the account runner, `ReadScope` and the transport all
stay as they are.

## 2. The existing API, as it actually behaves

**`GET /v1/organisations/:id/stock`** (`apps/api/src/stock/routes.ts:8-11`, `service.ts:27-40`).

**Access**
- `withTenant` runs under forced RLS on `stock_items`, and the caller needs an active membership (checked
  `for share`). A non-member gets **404** `not_found`.
- There is no role restriction for reading: owners, admins and members all read.

**Query parameters**
- Optional `location` (1–200 characters) and `includeArchived=0|1`, default `0`.
- The mobile app sends **no query**: active items only, all locations.
- An invalid value for either gives 400 `invalid_request`. Unknown keys are dropped by the non-strict zod object.

**Response:** `{ items, locations, suppliers, timezone }`. JSON keys are camel-case (the API's postgres camel
transform).
- **`items`** is every active item. Each has the full row (`select s.*`) plus some extras:
  - **Row fields:** `id`, `organisationId`, `name`, `location`, `unitLabel`, `currentCount`, `countedAt`, `countedBy`,
    `reorderPoint`, `preferredSupplierId`, `notes`, `archivedAt`, `createdAt`, `updatedAt`.
  - **Extras:** `countedByName` (a person's name or email), `supplierName`, `belowReorder`.
- **Order:** `archived_at nulls first, location, name, id`, using the database collation.
- **`locations`:** the distinct active locations, in database order.
- **`suppliers`** (IDs and names) and **`timezone`** are also returned.

**Counts are exact decimal strings.**
- `current_count` and `reorder_point` are Postgres `numeric`, selected as `::text`. They are non-negative and finite
  (schema checks).
- Writes accept a JSON number or a string matching `^\d+(?:\.\d+)?$` of at most 80 characters (`quantity` in
  `service.ts`).
- Postgres `numeric` text output keeps the input scale (`12.50` stays `12.50`), drops leading zeros (`0012.500` is
  returned as `12.500`), and never uses exponent notation.
- So the returned text is never longer than what was written: at most 80 characters for anything written through the
  API. The parser's 80-character bound (§4) therefore can't refuse a value the API accepted.

**Other field rules**
- `currentCount` is `null` exactly when the item was never counted. Then `countedAt` and `countedBy` are null too
  (schema check).
- `belowReorder` is `current_count < reorder_point`, computed by the API. It is `null` when either value is null.
- **Text limits:**
  - the database only requires `name`, `location` and `unitLabel` to be non-blank;
  - the API writes cap `name` and `location` at 200 characters and `unitLabel` at 80;
  - `unitLabel` is free text chosen by the business, such as "kg", "kegs" or "bags".

**No paging, no item cap.**
- The response grows with the item count. `notes` (up to 5 000 characters each) and `suppliers` also count against the
  size.
- The mobile transport's 1 MiB decoded budget is therefore the only bound. An oversized body is `unavailable` (status
  200), which the screen can't tell apart from a malformed one or a network failure.

**The web page** (`apps/web/src/app/resources/inventory/Stock.tsx`) shows, per location:
- the name;
- `"{currentCount} {unitLabel}"` or "Not counted yet.";
- "Counted {local time} by {name}";
- "Reorder point: {reorderPoint} {unitLabel}";
- "Below reorder point.";
- supplier, notes, count and edit forms;
- archived items;
- a separate Shopify section.

## 3. What the mobile screen shows (read-only)

**Heading:** Inventory, subtitle "Counted stock, by location". Items are grouped by location.

**Per item**
- **Name**, exactly as returned, shown in full with wrapping.
- **Count:**
  - `"{currentCount} {unitLabel}"`, **character for character as the API returned both**;
  - or "Not counted yet." when `currentCount` is null.
- **Reorder point:** "Reorder point: {reorderPoint} {unitLabel}" when not null, again verbatim.
- **Flag:** "Below reorder point" only when `belowReorder === true`. The app never computes it.
- **Location group heading:** the location exactly as returned.

**Strings are raw, not normalised.** `name`, `location` and `unitLabel` are kept and shown exactly as the API returned
them, surrounding whitespace included. Trimming is used only to check that a value is non-blank.
- Grouping uses the raw `location` string, so two locations the database treats as distinct (for example
  `"Cellar"` and `"Cellar "`) are never merged on the phone.
- The API's own writes trim these fields, so in practice they arrive trimmed. The phone does not rely on that.

**Count fidelity**
- A count is never converted to a number: no `Number()`, `parseFloat`, rounding, trailing-zero trimming, locale digit
  grouping or `Intl`.
- A count is never summed, totalled or valued.
- No unit is invented, converted or pluralised: `unitLabel` is shown exactly as returned.
- Nothing is shown about cost, value, supplier or notes.

**Left out on purpose** (to keep this read's scope bounded):
- **Counted time and person** (`countedAt`, `countedByName`, decision D2). Time would need the organisation `timezone`
  and `Intl` on Hermes, which is a device uncertainty. The person goes with the time: "counted by" means little without
  "when". Either can be a later slice.
- **Also left out:** archived items, suppliers, notes, locations with no active items, and Shopify stock.

**Order**
- Groups appear in the order their locations **first appear in `items`**.
- Items keep the API's order within each group.
- The app never re-sorts, because client and database collation can differ. `locations` is not used for ordering
  (see §4).

**Read-only**
- There are no count, edit, add, archive, stocktake or restore controls, and no green plus.
- One fixed link, "Count stock on the website", opens `/resources/inventory` on the web (D1). It is shown only when the
  web origin is configured, as the existing web links are.

## 4. Parser (pure; `src/resources/stock.ts`)

**`parseStockList(value): StockList`** is strict. It throws a `TypeError` whose fixed message never repeats a value,
and the client then reports **unavailable**. The whole response is refused if any item is invalid, as with My work.

**The top level** must be an object whose `items` is an array. `locations`, `suppliers`, `timezone` and every
unknown key are ignored and never kept.

**"Characters"** throughout means JavaScript string `.length`, which counts UTF-16 code units. This is the same measure
as the API's zod `.max` write checks, so a name, location, unit or count the API accepted is judged identically here;
emoji and other non-BMP text count the same on both sides.

**Each item** must be an object with:
- `id`: a canonical lower-case UUID, unique within the response;
- `name` and `location`: strings, non-blank after trimming, at most 200 characters **before** trimming;
- `unitLabel`: a string, non-blank after trimming, at most 80 characters **before** trimming;
- `currentCount`: `null`, or a **plain non-negative decimal string**: it matches `^\d+(\.\d+)?$` and is at most 80
  characters in total. This is the same bound the API's writes accept (`quantity`: at most 80 characters, or a JSON
  number up to `Number.MAX_SAFE_INTEGER`). No split between integer and fraction digits is imposed, so any count the
  API accepts is displayable. For example, an 80-digit integer, `0.001` and `12.50` are all valid, and the string is
  kept exactly: scale, leading zeros and all.
- `reorderPoint`: the same rule as `currentCount`;
- `belowReorder`: `true`, `false` or `null`, consistent as below;
- `archivedAt`: `null` (the query excludes archived items, so anything else means the answer is not the list asked
  for).

Every other item field is ignored and never copied into state: `notes`, `countedByName`, `supplierName`, `countedAt`,
`countedBy`, `organisationId` and the rest.

**Consistency checks**, in both directions, matching the API's `case` expression:
- If either `currentCount` or `reorderPoint` is `null`, `belowReorder` must be `null`.
- If both are non-null, `belowReorder` must be `true` or `false`, never `null`.
- The parser does **not** recompute `belowReorder`. Decimal comparison is the database's job; the parser checks only
  that the flag's presence matches the nulls.

**Output**
- `StockList = { groups: readonly { location: string; items: readonly StockRow[] }[] }`, frozen.
- `StockRow` holds `id`, `name`, `count: string | null`, `unit`, `reorderPoint: string | null` and `below: boolean`.
- `name`, `location` and `unit` are kept **raw**, exactly as returned (§3). Trimming is used only for the non-blank
  check.
- Groups are keyed by the raw `location` string, and built in first-appearance order (§3).

**No item cap** beyond the byte budget. Screen state keeps only these display fields, and the screen must virtualise
the list (`SectionList`).

## 5. Path, read and list rules

**The path**
- `stockPath(scope: ScopeIds): OrganisationPath` in `src/api/paths.ts` returns exactly
  `organisationPath(scope.organisationId, 'stock')`, with no query.
- It throws the existing fixed `TypeError` for a non-canonical organisation ID.

**The read**
- It goes through the runner's single scoped entry point, as My work does: `organisationRead(expected, (s) =>
  stockPath(s), parseStockList)`. It's token-free, is never retried automatically, and nothing is cached across mounts.

**The list state** is a new pure `src/resources/stock-list.ts`, modelled on `my-work-list.ts`, with no paging. Ops are
`first` and `refresh`.
- **Mount:** one `first` read per mount. A strict-mode second effect is refused while the first is in flight.
- **Refresh and Try again:** only when asked, one at a time.
- **Waits:** a read's own `Retry-After` blocks Refresh and Try again until exactly its end (the existing `waiting`
  rule). It never touches the `/v1/me` wait.
- **Failed refresh:** the loaded groups are kept and shown under "Couldn't refresh. This list may be out of date."
- **Failed first read:** never shown as empty.
- **Superseded or a changed scope:** nothing is applied.

**The hook** is `src/resources/useStock.ts`, following `useWorkList`.
- It binds the first ready scope rendered, and every read names it as `expected`.
- If the rendered scope differs from the bound one, the hook returns the inert state and sends nothing (the tabs reset
  follows).
- **Inert, loading and not-yet-loaded states never claim anything about stock.** The empty wording ("No stock items are
  listed yet.") appears **only** for a successful answer whose `items` is empty. The inert state renders the same
  neutral loading placeholder as a pending first read, exactly "Loading stock…"; never the empty wording, and never rows
  from another scope.
- An answer applies only while mounted, not inert, and for the latest read.

## 6. States and wording

The wording lives in `copy.ts` as `stockCopy`, with exact-string tests.

| State | Shown |
|---|---|
| Loading (first read) | "Loading stock…" (no digits, so the shell check's no-numbers rule still holds while pending) |
| Loaded, no active items | "No stock items are listed yet." / "Items are added and counted on the Captain website." |
| Loaded, nothing counted yet | Items shown, with each count "Not counted yet." There is no separate banner. |
| Unavailable: network, 429, 5xx, malformed or **oversized** | First read: "Couldn't load the stock list." with Try again. Refresh: rows kept, plus "Couldn't refresh. This list may be out of date." Never "empty". |
| Unavailable with the server's wait | The same wording, with Try again or Refresh disabled until the wait ends, worded like the existing work-list waits (`workViewProblemText`: "about {time}" from the wall-clock estimate). |
| 403/404 (access) | "Captain couldn't read this organisation's stock. If your access has changed, Captain will show it the next time it checks." The runner's existing paced membership refresh applies. |
| Other 4xx | "Captain couldn't read the stock list." |
| Client bug | The same as other 4xx. |
| 401 | Nothing here: the runner ends the session with the existing wording. |
| Scope changed | Inert: exactly "Loading stock…", as for a pending first read. Never the empty wording or old rows. Nothing is sent until the tabs reset. |

Wording rules:
- No state says how much is in stock except a loaded row.
- The empty wording appears only for a successful answer with no items. A failed, pending, inert or superseded read
  never says or implies "no stock".
- Oversized is not called out separately, because the transport can't tell it apart. The contract accepts the
  generic wording.

## 7. Validation

**Pure tests**

*Parser:*
- every rule in §4, including every invalid form of a count: `-1`, `1e3`, `.5`, `5.`, ` 5`, `5,0`, `NaN`, `+5`,
  an empty string, a number type, and an 81-character decimal;
- **valid at the bounds:** an 80-digit integer, a 78-digit integer with a one-digit fraction (80 characters), and a small
  fraction (`0.001`). None makes the list unavailable;
- **kept character for character:** `"12.50"` keeps its scale. A synthetic `"0012.500"` stays `"0012.500"`: this tests
  the parser's own fidelity only, since the API never sends leading zeros;
- a duplicate ID;
- an archived item;
- `belowReorder`, both directions: `null` with both values present is refused; `true` or `false` with either value
  null is refused; `null` with either value null, and a boolean with both present, are accepted;
- **raw strings:** `" Cellar"` and `"Cellar"` are two groups, shown exactly as given; a name or unit with surrounding
  spaces is kept as is; a whitespace-only name, location or unit is refused;
- a `notes` string of 5 000 characters that is ignored;
- a first-appearance grouping order that differs from alphabetical;
- no ignored field in the output (a deep key check).

*Path:* the exact string, and refusal of a bad ID.

*List state:* first, refresh, a failed first read, a failed refresh keeping rows, waits, superseded, and the
strict-mode duplicate. The screen model shows the empty wording only for a loaded, successful empty answer: never
while pending, failed, inert or superseded.

*Copy:* every string, with no digits in the fixed wording.

**Harness**
- Stock fixtures chosen by the requested path.
- The existing controls resolve the pending read. `ok-page` answers a multi-location list with a mix of counted,
  uncounted and below-reorder items.
- New controls: `stock-uncounted` and `stock-unusual` (unusual units and decimals such as `12.50 kegs`,
  `0.125 kg`).

**Browser, at 360, 390 and 430 pixels**
- loading, loaded, empty, unavailable, a wait, 404 access, and refresh failure keeping rows;
- a scope change mid-read (nothing applied);
- exact count strings visible;
- no overflow with long names or units;
- the shell check's Inventory step updated: its placeholder expectations are replaced by the loading state, and the
  no-digits check still passes because the read is pending.

**Exports and boundary scans** unchanged: there's no new dependency.

## 8. Native gates (unchanged enablement)

- **Reachability.** It is reachable only when signed in natively, which stays off on shared staging and for real
  accounts. No flag changes.
- **Device gates:**
  - a real 403/404 (already listed);
  - `SectionList` scroll performance with several hundred items;
  - long-name wrapping with larger text;
  - VoiceOver/TalkBack reading each row as one element ("{name}, {count} {unit}, below reorder point").
- **No `Intl` or timezone gate**, because counted time is left out.

## 9. Work split

| Owner | Files |
|---|---|
| Root | `src/api/paths.ts` (`stockPath`) and tests; `src/resources/stock.ts` (`parseStockList`) and tests; harness stock fixture bodies; browser checks, including the shell-check update; docs, validation, git and CI |
| B | `src/resources/stock-list.ts` and tests; `src/resources/useStock.ts`; the screen `src/app/(tabs)/resources/inventory.tsx`; `stockCopy` in `src/account/copy.ts` and tests; harness control wiring (new controls in `harness/work-fixtures.ts` `readControls`, or a sibling file); the `webPaths` entry and its test (D1) |
| A | Independent peer review of both halves: the parser and path, and the hook, screen and copy |

B also independently reviews root’s parser and browser proof.

The order: root's parser and path land first (or on the same branch), because the hook imports them.

## 10. Decisions (accepted by root, 27 September 2026)

1. **D1. The website link: yes.** `'/resources/inventory'` is added to `webPaths`, and the screen shows "Count stock on
   the website". It is the only way to act on what the screen shows, and it is a fixed, tested path.
2. **D2. Counted time: left out.** Counted time and person are not shown in this slice. A later slice may add them, with
   the organisation timezone and a Hermes `Intl` device gate.
3. **D3. Whole-response strictness: yes.** One item outside the API's own bounds makes the list unavailable, as with My
   work; bad items are never dropped silently, because that would hide stock. The bounds match what the API accepts
   (§4), so no value written through the API can trigger this. (The database itself caps only non-blank text, so a
   value written outside the API could.)
4. **D4. Paging: none.** If a real organisation exceeds the byte budget, the fix is an API paging PR with its own
   tests, not a client workaround.
