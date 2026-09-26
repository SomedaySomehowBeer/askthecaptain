# Default business Work views: "By tag" navigation

Status: **proposed for adoption in #158** (26 September 2026). Choices below are root's
adopted-for-review decisions. Not implemented. Code starts only after #158 adopts this contract.
Drafted by the saved-views API agent (Claude Opus); root owns integration; peer review requested.

Outcome: **manage shared work**, in Work only. Authority: D7 (flat tags select work, never grant
access), D11 (Work view list; Work defaults to My work), D14 (reviewed designs — this document is the
reviewed plan/design change it requires), D17 (first customer only), D26 (private saved views; shared
views need their own contract). Design reference: the mobile mockups' Production, Marketing, Sales and
Admin/reporting rows (`docs/proposals/assets/captain-mobile-2026-09-22/`), which the mockups describe
as **tags**, not areas or workspaces.

## 1. The question and the answer today

The mockups show Production and Marketing as tag-filtered Work views ("Anyone · Tag: Marketing ·
Open"), with Sales and Admin/reporting as scope previews. **None of these exists as navigation today.**
The live Work view list has My work, All tasks, Tags (management), Projects, Recurring work and each
person's **private** saved views (#153/#154, D26). The filter itself already exists: anyone can open
All tasks and choose a tag, or save that as a private view — but no shared row takes people there.

## 2. Options compared

| | A. Code-only rows matched by tag name | B. Fixed four slots bound to tag IDs | C. Organisation-shared editable saved views | **D. "By tag" group of all tags (adopted for review)** |
|---|---|---|---|---|
| Stored | Nothing | Slot → tag ID table | Shared rows in `saved_views` | **Nothing** |
| Schema / API change | None / none | One table; new endpoints | New columns/policies; endpoints | **None / none** (existing `GET /tags` and `GET /tasks`) |
| Special departments | Yes (hard-coded names) | Yes (four slots) | No | **No** — Production, Marketing, Sales, Admin/reporting are ordinary tags |
| Rename | Breaks; repair duplicates tags | Survives (ID) | Survives | **Survives (links use IDs; rows show current names)** |
| New tag | Not shown unless it matches a name | Not shown until bound | Not shown until curated | **Shown immediately** |
| Setup | None, but wrong | Owner/admin binding workflow | Curation workflow | **None beyond existing tag creation** |
| Curation (choose/order a subset) | No | Four fixed | Yes | **No** — every tag, server name order |
| D26 | Unaffected | Unaffected | **Amendment + full §10 contract** | **Unaffected** |
| Plan change | — | New table + decision | New decision | **Design adoption under D14 only (§6)** |

**Adopted for review: D.** It is the smallest option and matches the owner's decision to make business
areas flat tags. Every existing organisation tag becomes a Work link by ID, so demo tags such as
Production and Marketing appear without setup, renames carry over, a newly created tag gains its view at
once, and nothing needs a slot, table, binding, name matching or special department.

**Does D meet business navigation?** Yes, for this increment: the four mockup rows exist as soon as those
tags exist, each opens exactly "Everyone · Tag · Open", and every member reaches them from the Work view
list. D deliberately provides no **curation**: every tag is listed in name order, including labels that
are not business areas, and nobody can pin or order a subset. Root has accepted that for the first
increment; a curated subset would be a new, separately reviewed contract (B with the fixes in §7, or C).

## 3. Design

**Placement.** The Work view list order becomes: **For you** · **Across the business** · **By tag** ·
**Saved views** (private). The By tag group has its own accessible heading, like the others.

**Rows.** From `GET /v1/organisations/:id/tags?offset=&limit=50` (existing; server order
`lower(name), id`; readable by every active member under tag RLS). Each row:
- label: the tag's **current name**;
- detail: **"Everyone · Open"**;
- link: `/work?owner=all&tagId=<tag id>` — by ID, never by name.

No count, star, pin, reorder, hide or preset control, and no organisation or personal state.

**Paging, with both cursors preserved.** The group pages 50 at a time with its own `tagOffset` query
parameter; Saved views keeps `offset`. Every Previous/Next link in **either** group, every "first page"
and "Try again" action, and the out-of-range state's recovery link must carry the **other** group's
current cursor unchanged (e.g. Next in By tag keeps `offset`, Next in Saved views keeps `tagOffset`).
The existing `viewPageHref`/`parseViewOffset` helper in `apps/web/src/app/work/saved-views.ts` currently
builds `/work/views?offset=…` only and would drop `tagOffset`; it may be generalised (for example to
build the views URL from both cursors). That is a URL-building change only: private saved-view data,
API calls, access, ordering, limits and states are unchanged. A malformed or out-of-range `tagOffset`
shows the By tag group's own "page does not exist" state and leaves Saved views rendering normally (and
vice versa).

**Link and filter.** The link is the plain Work URL, which already means
`{ owner: 'all', status: 'open', tagIds: [id], projectId: null }` through the existing filter parser and
`GET /tasks`. Opening it is an ordinary read under the viewer's own permissions; tags never grant access
(D7). No new URL mode: no `view`, `base`, draft or business-specific inconsistent-link rules.

**Single-tag title (Work page).** When the plain filter is exactly Everyone · Open · one tag · no
project **and** that exact tag ID is present, resolved, in the tag data the page successfully loaded,
the page title is that tag's name with eyebrow "Tag". In every other case — tag lookup failed, the tag
is beyond the loaded tag page (the Work page loads the first 100 tags), or the ID does not resolve — the
title stays **"All tasks"** and the selected-tag chip keeps its existing wording ("Tag not in the list" /
"Selected tag"). The title is never derived from a name match, a URL value or a guess. The filter and
task list use the ID in every case.

**Draft/save behaviour.** It is the plain Work URL, so changing a control produces another plain filter
URL, exactly as today. **Save this view** creates a private D26 saved view of the current filter; the tag
rows are unaffected and nobody else sees the copy.

**States.**
- Loading: the By tag group's own skeleton in its own Suspense boundary; other groups render independently.
- Failed tag read: "Tags could not be read" with Try again (preserving `offset`); fixed groups and Saved
  views are unaffected; no rows are fabricated.
- Empty (no tags yet): "No tags yet", a link to **Tags**, and the example names Production, Marketing,
  Sales and Admin/reporting **as text only**. Nothing is prefilled or created.
- Out-of-range `tagOffset`: "That page of tags does not exist" with a link to the first tag page
  (preserving `offset`).

**Setup, existing and new organisations.** No presets, seeding, migration data or setup writes. Existing
organisations see their current tags immediately; new organisations see the empty state until someone
creates tags through the existing, explicit, audited Tags page (any active member, per the tags
contract). Reads never write, and no tag is ever created or re-created by the view list.

**Renames, missing and deleted tags.** Rows always show current names and link by ID, so a rename needs
nothing. There is no runtime tag deletion today; a bookmarked link to a tag that no longer exists
(operator removal) opens Work with that ID still applied, the "All tasks" title, the existing unlisted-tag
chip and an empty result — the filter is never dropped or broadened.

**Semantics.** People: Everyone. Status: Open (the default). Projects: archived and proposed projects'
tasks are excluded, as in All tasks. My work stays the default Work page (D11).

**Permissions.** Every active member sees every tag row, because tags are organisation labels; removed
members and other tenants see nothing (existing RLS and 404s). No new write path exists.

**Private saved views.** Their data, API, access rules, audit and export are unchanged. The only saved-
view code touched is the shared views-page URL helper described under Paging.

## 4. Delivery

After #158 adopts this contract, **one web-only PR**, no migration, no API change:
- `apps/web/src/app/work/views/page.tsx`: the By tag group, its states and two-cursor paging.
- `apps/web/src/app/work/saved-views.ts` (or a new pure helper): two-cursor views-page URL/parse.
- `apps/web/src/app/work/page.tsx` (+ pure helper): the resolved-ID-only single-tag title.
- Pure tests and a browser script (§5); a staging release under the existing one-machine procedure,
  recorded in the runbook.

## 5. Acceptance

**Pure (web):**
- Row link is exactly `/work?owner=all&tagId=<id>`.
- `tagOffset` parsing mirrors the saved-view page bounds; malformed values give the error state.
- Every generated views-page link preserves the other group's cursor (Next/Previous/first page/Try
  again for both groups, including combinations with both cursors non-zero).
- Title rule: tag name only for Everyone · Open · one tag · no project with that ID resolved in the
  loaded tags; "All tasks" when tags failed, when the ID is absent from the loaded page, or for any
  other filter; never from a name.

**Browser (real local API/Postgres fixture; 360/390/430/1440):**
- The group sits after Across the business and before Saved views, listing the fixture's tags in
  server name order by ID links; opening Production shows exactly its open tasks for everyone, titled
  "Production"; `/work` still opens My work.
- Renaming the tag on the Tags page updates the row and title; the link (ID) is unchanged and shows the
  same tasks.
- A newly created tag appears on the next read of the list without other setup.
- With more than 50 tags, By tag pages by `tagOffset` while Saved views stays on its current page, and
  Saved views paging keeps the By tag page (both cursors non-zero at once).
- **A tag beyond the 100th** (outside the Work page's loaded tag lookup) opens with exactly its tagged
  open tasks, the "All tasks" title and the selected-tag chip — filtered correctly despite the
  unavailable title. The same holds when the tag read is failed by a fixture fault mode.
- Changing status from a tag row gives a plain URL; Save this view creates a private copy invisible to
  another member.
- Empty (fresh organisation, example names as text, no writes), failed tag read (fixture fault mode for
  `GET /tags`), out-of-range `tagOffset` and loading states are explicit; other groups still render.
- Existing Work and saved-view browser suites still pass.

**API/DB:** no change; existing tags/work tests remain the authority. The PR states that none were added
because no server behaviour changed.

## 6. Plan and decision changes

- **D26 amendment: avoided.** No saved view is shared, and no saved-view data or access behaviour changes.
- **No new D-number and no schema amendment.** No table, package, dependency, process or decision changes;
  D7 and D11 already allow tag filters and grouped view lists.
- **Design adoption required (D14).** The Work view list gains a group and the Work page a title rule, so
  this contract must be adopted by a reviewed plan/design PR (#158) before code. That PR may add a status
  note to plan §5 (Tags row) and the mockup status: *"Tag views: the Work view list's By tag group links
  every organisation tag to Everyone · Tag · Open; curated or shared views remain separate contracts."*

## 7. Deferred alternative B and why its first protocol was unsafe

If the owner later wants a **curated subset**, B (or C) returns as its own reviewed contract. The first
draft of B used a compare-and-set on `expectedTagId`, which has two real holes and must not be reused:

- **ABA overwrite.** A client that saw slot → X can overwrite after others changed it X → Y → X: the
  current value equals its expectation, so it silently overrides decisions it never saw. A durable,
  monotonically increasing **revision** (the trigger pattern used by 0039/0040) must be the precondition.
- **Retry-by-name after rename.** An uncertain "create tag ‘Marketing’ and bind" that did land, followed
  by a rename of that tag, makes a same-request retry resolve the name to nothing and create a second
  "Marketing" tag — a duplicate the person never asked for. Creates need a **client-generated request/tag
  ID** retained through uncertainty (as saved-view creates do), so a retry is recognised by identity.

A revived B would also need a new table, a plan amendment and a decision of its own.

## 8. Resolved choices (adopted for review by root)

1. **Group and placement:** "By tag", after Across the business and before private Saved views.
2. **Order and scope:** all tags, in the existing server order (`lower(name), id`); no curated subset.
3. **Row detail:** "Everyone · Open".
4. **Empty state:** example names Production, Marketing, Sales and Admin/reporting as text only; no
   presets, prefill or setup writes.
5. **Title rule:** adopted, restricted to a successfully resolved exact tag ID; otherwise "All tasks" and
   the selected-tag chip, never a guessed label.
6. **Owner clarification:** not required to ship ID-based tag navigation; curation, if ever wanted, is a
   separate contract.

**Not claimed:** organisation-curated or shared editable views, per-person defaults, new-task tag
prefill, native clients, chat or files.
