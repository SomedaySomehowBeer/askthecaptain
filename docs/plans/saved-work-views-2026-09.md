# Saved Work views

Status: reviewed contract, 25 September 2026. Private API/web implementation merged and released
to staging in #153/#154 on 26 September; [delivery and verification](saved-work-views-delivery-2026-09-26.md).
Outcome: **manage shared work**, in Work only. Authority: plan §5 (the "Saved views" row), D6, D7, D11 and D14; next batch item 3; the mobile mockups ("Saved views" group).

**This increment covers personal saved Work views only.** Only the creator can see or change a view. Organisation-shared views, including the Marketing and Production views in the mockups, come in a later, separately reviewed increment (§10). This increment adds **no shared columns, policies or endpoints**.

## 1. What a saved view is

- **A personal saved view is a name plus a versioned Work filter.** Opening it produces the same list as the equivalent `/work?…` URL, evaluated for its owner, under their own permissions, when they open it.
- It stores no results, task IDs or counts, and never grants access to anything.
- Browser-session tab restoration stays separate.
- **The default is unchanged:** Work still opens on My work (D11). There is no per-person default override.

## 2. Filter vocabulary, version 1 (no new vocabulary)

This is exactly today's Work filter:

```json
{ "owner": "me" | "all",
  "status": "open" | "in_progress" | "suggested" | "done" | "cancelled" | "all",
  "tagIds": ["<uuid>", ...],
  "projectId": "<uuid>" | null }
```

- **Strict:** these four keys, all **required**, with no extras. The server stores the **normalised** form:
  - `tagIds` holds at most 20 unique lower-cased UUIDs, sorted.
    Incoming arrays are bounded at 100 entries before normalisation; duplicate entries within
    that bound do not consume the 20-unique-tag limit.
  - `projectId` is a lower-cased UUID or `null`.
- The encoded filter is at most 4 KB, checked in the database. No offset is stored.
- **`"me"` is the viewer.** In this increment the viewer is always the owner.
- **At save time,** each referenced tag and project must exist in this organisation. A project may be archived, matching Work's explicit-project rule. Otherwise the API returns `400 filter_reference_unavailable`, naming the field.
- **`filter_version`:** the service writes only 1. The column accepts any positive version, so that during a rolling release an older server can read a row written by a newer one and classify it.
  - A later change to the vocabulary is a new version with an up-conversion, in its own reviewed PR.
  - A server that reads a version newer than it understands returns `applicable: false` with a reason, and never guesses.

## 3. Schema (one migration)

```sql
create table saved_views (
  id uuid primary key,                          -- client-generated create identity (§5)
  organisation_id uuid not null references organisations(id) on delete cascade,
  owner_id uuid not null,
  section text not null default 'work' check (section = 'work'),
  name text check (name is null or (name = btrim(name) and length(name) between 1 and 60)),
  filter_version smallint check (filter_version is null or filter_version > 0),  -- any positive version, so an older reader can classify a newer row (§2)
  filter jsonb check (filter is null or (jsonb_typeof(filter) = 'object' and octet_length(filter::text) <= 4096)),
  deleted_at timestamptz,                       -- tombstone (§5)
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  foreign key (organisation_id, owner_id) references memberships(organisation_id, user_id) on delete cascade,
  -- A live view has all of its content; a tombstone has none of it.
  check ((deleted_at is null and name is not null and filter is not null and filter_version is not null)
      or (deleted_at is not null and name is null and filter is null and filter_version is null))
);
create unique index saved_views_name on saved_views (organisation_id, owner_id, lower(name)) where deleted_at is null;
create index saved_views_list on saved_views (organisation_id, owner_id, lower(name), id) where deleted_at is null;
```

- **Revisions** use a before-update trigger that sets `new.revision := old.revision + 1`, like 0039.
- **Fixed identity:** a second before-update trigger raises an error if `id`, `organisation_id`, `owner_id`, `section` or `created_at` changes, or if a tombstone is edited.
- **RLS**, forced, with policies for `app` only, and personal only:
  - `select`: `using (organisation_id = current_organisation_id() and owner_id = current_user_id() and <the user is an active member>)`.
  - `insert`: `with check` the same three conditions.
  - `update`: `using` and `with check` both the same three conditions. Together with the fixed-identity trigger, nothing can move a row to another owner, section or tenant.
  - There's no policy for shared rows, so nobody can read or write another member's view by any route.
  - There's **no `delete` policy**.
  - Grants to `app` are `select, insert, update` only, **with no `delete`**. Referential cascades (organisation or membership deletion) remove child rows without the runtime role holding `delete`. Withholding it means neither direct SQL as `app` nor any API path can physically remove a tombstone and so defeat the no-resurrection rule.
- **Deletion:** the API only ever tombstones (§5). Physical removal happens solely through those cascades.
- **Membership:**
  - Removing a member (status `removed`) keeps their views **stored and invisible**, since RLS and the service both require active membership. They reappear only if the same membership becomes active again.
  - Deleting the membership row (account or organisation deletion) removes their personal views by cascade.
  - Because every view here is personal, the cascade can't remove shared data.
- **Limits:**
  - At most **50 live views per person per organisation**, and names of **60 characters or fewer**.
  - The service checks the count while holding the actor's membership row `for update`, so two concurrent creates can't both pass. Over the limit is `409 view_limit`.
  - Tombstones don't count.

## 4. API (under the signed-in router; strict query and body schemas)

| Method and path | Request | Response and errors |
|---|---|---|
| `GET /v1/organisations/:id/views?offset=&limit=` (limit ≤ 50) | none | `{ views: SavedView[], nextOffset }`: the caller's live views, ordered by `lower(name), id`. |
| `GET /views/:viewId` | none | `SavedView` with `references` (§6). Unknown, another person's, another tenant's, or deleted: `404`, the same in every case. |
| `POST /views` | `{ id, name, filter }` | 201 `SavedView`, or 200 for an identical retry (§5). `409 view_id_unavailable`, `409 view_name_exists`, `409 view_limit`, `400 invalid_filter`, `400 filter_reference_unavailable`. |
| `PATCH /views/:viewId` | `{ expectedRevision, name?, filter? }` | 200 `SavedView`, `409 stale_revision`, `409 view_name_exists`, 400s as for create, `404`. |
| `DELETE /views/:viewId?expectedRevision=N` | none | 200 `{ ok: true }` and the row becomes a tombstone. `409 stale_revision`. A second delete is `404`. |

- **`SavedView`** is `{ id, name, filterVersion, filter, applicable, reason, revision, createdAt, updatedAt }`. List rows omit `references`.
- **Audit:** every write is audited in the same transaction. Actions: `saved_view.created`, `saved_view.updated`, `saved_view.deleted`. Because the views are personal, the detail carries **only** `{ viewId, filterVersion, revision }`.
  - No name, no filter, no tag or project IDs.
  - Organisation audit readers and exports see only that a member created, changed or deleted a view, with an id. They never see what it was called or what it filters.

## 5. Writes, retries and deletion

- **Retrying a create:** the client generates `id`, following the equipment reservation pattern (`id` is the primary key; a matching retry returns the stored row). This guarantees **at most one row per id**. It does not guarantee exactly-once beyond that. Outcomes:
  - **Same owner, the row is live, and the normalised `name` and `filter` match:** 200 with the stored view.
  - **Same owner, the row is live but differs,** for example renamed since, or a different body: `409 view_id_unavailable`.
  - **Same owner, the row is a tombstone:** `409 view_id_unavailable`. A deleted view is **never resurrected** by a retry.
  - **The id belongs to another person or another tenant:** RLS hides the row, so the insert hits the primary key, and that is mapped to the same generic `409 view_id_unavailable`. The response reveals nothing about the other row, not even whether it is live.
  - After any `409 view_id_unavailable`, the web explains the conflict. It generates a **new id** only for an explicit **Save as a new view** action. It never retries automatically after a delete it has observed.
- **Uncertain creates:** retain the original id and normalised payload, lock field edits, and offer a same-id retry or a read of that id to reconcile the result. Never turn an ambiguous save into a new logical create automatically.
- **Tombstones:**
  - Delete sets `deleted_at` and clears `name`, `filter` and `filter_version`, moving the revision on.
  - The row keeps content-free identity, ownership, section, revision and timestamps, so that id stays reserved.
  - Tombstones are retained, with no content, until the membership or organisation row is deleted. Purging them would need a reviewed routine; none is added.
- **Stale writes:** `PATCH` and `DELETE` require the revision the edit was based on, and a mismatch is `409 stale_revision`. The web keeps what the person entered and offers Reload.

## 6. Resolving references, with no broadening

- **`GET /views/:viewId` returns `references`,** resolved with **one bounded, batched read per kind** (at most 20 tags and one project), in the owner's tenant context:
  ```json
  { "tags": [{ "id": "…", "state": "available", "name": "Production" } | { "id": "…", "state": "missing" }],
    "project": null | { "id": "…", "state": "available", "name": "…", "projectState": "archived" } | { "id": "…", "state": "missing" } }
  ```
  - `missing` means the id no longer resolves in the tenant. It is never inferred from a tag being absent from a paged tag list, and "not on this page" never counts as missing.
- **For an inapplicable/newer-version filter, `references` is `null`.** An older server must not
  interpret unknown filter keys as version-1 references. Clients check applicability before reading either.
- **If a reference read fails, the API keeps the saved view and its filter available, returning an explicit `unavailable` state for that reference kind.** Resolve references separately from the saved-record read so a failed lookup does not discard the filter. The web shows "unavailable": "Tag names could not be read; the view still filters by them". That is distinct from "missing".
- **In every case the Work query uses the exact stored filter,** with the stored IDs, through the normal `GET /tasks`. A missing, unavailable or unreadable reference never removes or relaxes a filter term.
- A create or PATCH supplying a filter with a missing reference is refused with `400 filter_reference_unavailable`, and the person chooses what to do. References are validated only when the filter is supplied; a name-only change does not re-check them.

## 7. URLs, drafts and navigation

- **The Work views page** adds a "Saved views" group of the person's live views. It pages at 50 and has empty, loading and failed states.
- **`/work?view=<id>` is an unmodified view.** The server reads the view, including its **current** revision, and applies its stored filter. In this form the URL carries **no filter parameters**; if any are present, the page says the link is inconsistent and offers to open the view unchanged.
- **Once the person changes any filter control, the page moves to a draft URL:**
  `/work?view=<id>&base=<revision>&draft=1&owner=…&status=…&tagId=…&projectId=…`, or `tagId=none` / `projectId=none` for an explicit clear.
  - In a draft URL the filter parameters are the **complete, normalised** filter. Every key is written explicitly, including defaults, and **nothing is inherited from the stored view**. So clearing the saved tags (`tagId=none`) or the project (`projectId=none`) can't be mistaken for "keep the saved value".
  - `base` is the revision loaded **when the draft began**. Further filter navigation, browser history and tab restoration carry the same `base`; they never refresh it quietly.
  - The page shows "Changed from *Name*" with **Save changes**, **Save as new view** and **Discard**.
  - **Save changes** sends `PATCH { expectedRevision: base, filter }`. If the view was edited in another tab or on another device meanwhile, it gets `409 stale_revision`. The page then shows the draft next to the current saved filter and changes nothing until the person chooses.
  - **Save as new view** creates a view with a new id.
  - **Discard** returns to `/work?view=<id>`.
- **Unusable view ids:** an unknown, deleted, inaccessible or not-applicable `view` id gives an explicit state ("This saved view is not available" or "…needs a newer version of Captain") and a link to My work. It never falls back silently.
- **Creating a view:** "Save this view" on any Work list takes a name, shows the filter in words ("Assigned to you · Tags: Production · Open"), and generates the create id once for that new-view draft. It persists across failed or uncertain saves and retries.

## 8. Export, deletion and privacy

- **Tenant export** (available to an owner or admin) includes **only the requesting exporter's own live views**. It excludes every other member's personal views and all tombstones, and its audit rows carry only the ID-only details above.
- An export is therefore **not** a complete backup of personal views. Database backups are a separate, operator-controlled matter (runbook), and the export documentation must say so.
- **Organisation deletion** cascades. Its `rowCounts` omits `saved_views`: an RLS-limited count
  would describe only the deleting owner's visible rows, not the organisation total. Do not bypass
  RLS to count other members' private views. Export footer counts still describe the rows exported.
- **Account deletion** cascades through memberships.
- **The legacy reset script** doesn't touch this table.

## 9. Adopted plan decisions

Plan D26 adopts private saved Work filters evaluated for their owner. Saving never grants record
access; names and filters stay private in audit details and tenant exports. The plan names the
`saved_views` table before its implementation migration. Work views gains a paged Saved views
group; the default Work page remains My work. Shared views need a separate reviewed increment.

Concrete choices: retain a removed member's views invisibly until reactivation; at most 50 live
views per person per organisation; names up to 60 characters; the existing version-1 filter
vocabulary; content-free tombstones for the life of the membership, with no runtime physical
DELETE permission. No package, dependency, inference step or background process is added.

## 10. Later: organisation-shared views (separate contract, not this increment)

That contract must specify, before any schema:
- creator nullability, or a tombstone creator, so account deletion can't cascade away organisation-owned views;
- explicit transfer and deletion policy;
- curation rights for owners and admins;
- share and unshare transitions under an authorised service path;
- shared-name uniqueness and limits;
- audit and export visibility for shared rows;
- `owner: me` wording for viewers;
- tests for all of the above.

It adds its own columns and policies in its own migration.

## 11. Acceptance tests

**Real Postgres, API and DB:**
- **Privacy:**
  - Another member gets 404 through the API and zero rows through direct SQL as `app` for select/update. Physical DELETE as `app` is permission-denied for every member, including the owner.
  - Another tenant is always refused.
  - A removed member loses access immediately, and their views reappear on reactivation.
  - Attempts to change the owner, section, tenant, id or `created_at` are refused by the trigger and by RLS `with check`.
  - Editing a tombstone is refused.
  - A tombstone that keeps any of name, filter or version is rejected by the CHECK, as is a live row missing any of them.
  - `app` has no `delete` privilege: a direct `delete from saved_views` as `app` fails with a permission error, and the API offers no physical delete.
- **Export privacy:**
  - An owner or admin export contains only the exporting person's own live views, and no other
    member's views, tombstones, names or filters.
  - Audit rows for personal views carry only `viewId`, `filterVersion` and `revision`.
- **Validation:**
  - Strict keys; all four required.
  - At most 20 tags; duplicates normalised; upper-case UUIDs lower-cased.
  - Tags or projects from another tenant, or unknown ones, refused.
  - A newer filter version gets `applicable: false`.
- **Retry and deletion identity:**
  - An identical retry returns 200 with one row.
  - A differing retry gets 409.
  - A retry after a rename gets 409.
  - A retry after a delete gets 409 and does not resurrect the view.
  - A retry with another person's id gets the generic 409, with no content in the body.
  - A second delete gets 404.
- **Concurrency:**
  - Two PATCHes from the same revision: exactly one wins.
  - Concurrent creates at the limit: exactly one passes.
  - Duplicate names get 409; a deleted name can be reused.
- **References:**
  - Batched resolution distinguishes `available` from `missing`.
  - A tag on no page of the tag list still resolves as available.
  - A reference that can't be resolved leaves the Work query using the exact stored IDs.
- **Lifecycle:**
  - Organisation deletion and account/membership deletion remove views and tombstones by cascade, proven with the runtime role holding no `delete` grant on `saved_views`. Organisation-deletion
    `rowCounts` omits private saved views rather than present a partial count as a total.
  - A row with a filter version above 1 inserted by the owner role reads as `applicable: false`.
  - Paging ends with `nextOffset: null`.

**Playwright on phone and desktop:**
- Create, open, rename and delete a view.
- **Explicit clearing:** clear saved tags and the project in a draft, save it, and the saved filter has no tags and no project.
- **A concurrent edit during a draft:**
  1. Open the view in tabs A and B.
  2. Change a filter and save in B.
  3. Keep changing filters in A (`base` unchanged).
  4. Save in A: it gets `stale_revision`, with both filters shown, and nothing is overwritten.
- **Discard** returns to the stored filter.
- An inconsistent unmodified link shows its explicit state.
- An unavailable or deleted view id shows its explicit state.
- **Tag-name read failure:** shows "unavailable", and the list stays filtered.
- An uncertain create followed by a manual retry keeps the same id and normalised payload and creates no duplicate. A new id is generated only for an explicit new-view action.
- Empty, loading and failed states; no overflow at 390 pixels.

**Not claimed:** shared views, presentation modes, native state restoration, and Chat or Resources views.
