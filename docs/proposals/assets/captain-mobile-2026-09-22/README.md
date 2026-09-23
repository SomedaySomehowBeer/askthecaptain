# Captain mobile workspace mockups

**Review concept, updated 23 September 2026.** Fifteen screens for the Captain/Pip split,
advancing **own commitments** and **brief and answer**. All data is fictional; the reference day
remains 22 September. These are documentation artifacts, not implemented application routes.

## Three sections and their view lists

The bottom bar is **Work · Chat · Resources**. Work opens at **My work**, filtered to **Assigned
to you**, across all tags. There is no Home destination. Each section has a grouped list of
views one page to the left of its main page, opened by the header's back chevron. These pages
need no visible title: their groups, rows and selected bottom tab carry context. They have
accessible headings. Choose a row to open a view to the right.

![Grouped view lists for Work, Chat and Resources](navigation-overview.png)

| Section | Groups | Main view in this concept |
|---|---|---|
| Work | For you; Across the business; Saved views | My work, assigned to you. All tasks removes the assignee filter; Marketing and Production are tag-filtered views. |
| Chat | Inbox; Projects; Team | All conversations. Task/project links open the same discussion. |
| Resources | Libraries; Planning; Business | Files & assets. Inventory and Equipment schedule are sibling views; People and Reports remain to design. |

The intended native client preserves each tab's view and scroll position, supports the normal
back gesture and returns details to the originating view. This static prototype demonstrates
explicit navigation links; tab switches reopen their defaults, detail breadcrumbs use fixed
parent examples, and native transitions/state restoration are not implemented.

Production, Marketing, Sales and Admin/reporting are **tags**, not areas or workspaces. Tasks
can carry multiple tags; people and projects span them. Filter controls cover assignee, tags,
project, status and date. Different filter types combine with AND; multiple selected tags match
any selected tag by default. Active filters remain visible. Presentation choices (List, Board,
Calendar, Timeline) do not create separate task records. Arbitrary combinations, saving filters
and the other presentation layouts remain to implement.

[View map and shared-record relationships](views.md) show the navigation and shared identities.

## Screen previews

![My work, Marketing by tag, project and equipment timeline](overview.png)

| Screen | Preview | Scope |
|---|---|---|
| My work | [Default Work view](work.png) | Assigned to you across tags, today's work, next equipment booking and a linked conversation. |
| Marketing | [Saved tag view](marketing.png) | Anyone · Tag: Marketing · Open; links to the whole project and shared files. |
| Project | [Summer lager launch](project.png) | Tasks across tags, shared bookings and discussion. |
| Equipment | [Timeline](timeline.png) | Reservations across projects, cleaning/maintenance and a conflicting request kept unconfirmed. |

![All tasks, task detail, Chat and conversation](work-overview.png)

| Screen | Preview | Scope |
|---|---|---|
| All tasks | [Task list](all-work.png) | Anyone · All tags · Open, across projects and recurring work. |
| Task | [Packaging](task.png) · [Artwork](task-artwork.png) | Owner, next decision, supporting record and discussion. Completion does not implicitly confirm equipment or approve a file. |
| Chat | [Conversation list](chat.png) | Team and work discussions with task links. |
| Conversation | [Packaging discussion](conversation.png) | One thread shared by Chat, task and project contexts. |

![Production by tag, Inventory and Files](resources-overview.png)

| Screen | Preview | Scope |
|---|---|---|
| Production | [Saved tag view](production.png) | Anyone · Tag: Production · Open, including a task also tagged Sales. Related equipment and stock links. |
| Inventory | [Counted stock](inventory.png) | Material observations, missing count, reorder threshold and separately sourced Shopify stock. |
| Files & assets | [Shared collection](files.png) | Working and ready-to-use versions in one shared library. |
| Asset | [Can artwork v3](asset.png) · [Trade pack v2](asset-trade.png) | Version-specific review and backlinks; provider-held original. |
| View lists | [Work](work-views.png) · [Chat](chat-views.png) · [Resources](resource-views.png) | Grouped navigation with no visible page title. |

[Files and review gallery](files-overview.png) · [Lower content of the first four screens](overview-scrolled.png).

## Visual direction

The supplied Taildrop tab-bar example informs the floating capsule, rounded corners, subtle
shadow and soft selected pill around both icon and label. The three rounded icons are a
briefcase, conversation bubble and folder, freshly authored for the prototype. Labels stay
visible and each tab target exceeds 44 CSS pixels. Scroll content reserves bottom space so
its final controls can clear the floating bar.

Captain's forest/paper/mint colours and Fraunces/Inter type come from `packages/ui/design`;
no design mirror files change. Compact headers contain a breadcrumb, search and avatar, with
no logo/wordmark. Screen headings are 26px, or 25px for the project at narrow widths. Search
and account/settings remain header controls, outside the three-tab navigation.

## Editable prototype

[index.html](index.html) contains the shared shell and original record layouts.
[additional-views.js](additional-views.js) and [additional-views.css](additional-views.css) contain
the record screens. [navigation.js](navigation.js) defines the grouped lists and saved tag
views; [navigation.css](navigation.css) styles the floating bar and lists.

Serve the repository root, for example with `python3 -m http.server 8769 --bind 127.0.0.1`, then
open `/docs/proposals/assets/captain-mobile-2026-09-22/index.html`. The default URL opens My work.
Use `?group=navigation`, `?group=original`, `?group=work`, `?group=resources` or `?group=files`
for review galleries. Single-screen URLs use `?screen=` with:

```text
work, all-work, marketing, production, project, timeline, task,
chat, conversation, inventory, files, asset,
work-views, chat-views, resource-views
```

Variant URLs use `?screen=task&item=artwork`, `?screen=asset&item=trade` and
`?screen=conversation&thread=artwork`. Old `day` and `browse` URLs redirect within the prototype
to My work and the Resources view list respectively. PNGs need no server. Existing font
stylesheets use Google Fonts; local serif/sans fallbacks apply if fonts cannot load.

Connected review paths:

- My work → Views → Marketing → shared files → Can artwork → artwork task → discussion.
- My work → filter control → All tasks → packaging task → discussion → task → equipment timeline.
- Chat → Views → All conversations → packaging discussion → linked task.
- Files → Views → Equipment schedule or Inventory; inventory opens honest count/source explanations.
- Work view list → Production → whole project or shared equipment and stock.

The filter sheet offers links to the illustrated combinations (My work, All tasks, Marketing,
Production). Other choices, project-list selection, dates, composition, counts and review actions
are explicit scope notes or preview sheets. They do not save data, contact providers or send
messages. Sales, Admin, Upcoming, People, Reports, Search, Settings, Board, work Calendar and the
full project list remain to design. Complete empty/loading/failed/disabled/permission states
are required before implementation.

Equipment availability includes other people and projects even when Work is filtered. On
1 October, Pale ale packaging occupies 09:00–12:00, cleaning blocks 12:00–13:00, the illustrative
open slot is 13:00–16:00 and maintenance starts at 16:00. Viewing availability does not confirm
or move a booking. An equipment reservation does not consume stock or imply a production
process model. Inventory remains a counted list, with no ledger or unrelated-unit totals.

## Validation

The fifteen layouts are checked in shared Chromium with Playwright at 360, 390 and 430 CSS
pixels, including overflow, three-tab labels/targets, scroll clearance, hidden list headings
and compact record headings. Connected list/view/filter/task/chat/asset/equipment flows and
preview sheets are exercised, and PNG exports inspected. Screen PNGs are 390 × 874; variants
and galleries are captured separately. Both Mermaid maps are parsed and exported as SVG/PNG.

No application typecheck, Postgres tests or production-route checks are claimed for these
documentation-only changes. The operative plan's D11 stays unchanged pending review.
