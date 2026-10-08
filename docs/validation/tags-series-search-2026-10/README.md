# Tags, recurring work and search: T-B validation record (8 October 2026)

Client half of H4 ([contract](../../plans/tags-series-search-2026-10.md) §3, §4): search in the list header, Tags and
a tag's details, "Repeat this task" and the series screen, and the equipment schedule's header (frame 5). Local
evidence only: the Expo web export with synthetic, contract-shaped API answers, and real Postgres for the API and the
client parsers. Nothing here is hosted, native or assistive-technology evidence.

## Checks

| Check | Result |
|---|---|
| Root `pnpm check` | passes |
| Root `pnpm test` (real Postgres) | api 281, db 114, mobile 482 + 20, engine 20, model 11, steps 8, connectors 5; 0 failed, **0 skipped** |
| `apps/mobile/src/threads/search.test.ts` | strict search answer (words and filter echoed, row shape plus match, 50 cap); `«»` to emphasis, unpaired marks shown as written; the debounce (nothing sent while typing, one search for the latest words, under 2 characters back to the list), a stale answer dropped, a filter change searching again, 429 wait and Try again |
| `apps/mobile/src/resources/tags/tags.test.ts` | strict list with counts and one tag; the form's problems; only changed fields sent; the write answer must match what was asked |
| `apps/mobile/src/resources/series/series.test.ts` | the Repeat form's defaults from the task; the rule and its problems; the due wording; which period the task becomes; strict series answers; the repeat body with `fromTask`; series edits send only changes; pause |
| `apps/mobile/src/resources/equipment/header.test.ts` | the day in view, in the zone; ‹ and › by a day or a week to midday, across a clock change, stopping at the loaded range; the day and "Today is" wording |
| `apps/api/src/threads/search.test.ts`, last test | real answers through the client parsers: tag add, list with counts, one tag, rename, archive; search title and message matches with filters; repeat a task through the client's write, then the task detail's `series` and the series' pause |
| `apps/e2e/scripts/mobile-shell-h4-check.cjs` | 360, 390, 430 and dark at 390: search (results with marked words, no match, clear, filter, one character keeps the list), Tags (counts, archived, add with owner and dates and the date rule), tag details (one change, an uncertain save retried with the same id and body, archive and restore with confirm), the heading menu, Repeat this task (defaults, a bad rule, the exact POST), Repeats / Part of, the series (edit, pause, resume); touch targets ≥ 44, no overflow, no page errors |
| `apps/e2e/scripts/mobile-shell-schedule-check.cjs` | 360, 390, 430 and dark at 390: the heading in view on open and still there after a scale change, Hours/Days/Weeks, ‹ › and Today (a week on Weeks), the key, setup and cleaning blocks, bar times, Manage equipment and New booking kept; targets ≥ 44 |
| Full browser suite `apps/e2e/scripts/mobile-shell-ci.mjs` | 58 PASS lines at 360/390/430/1280, exit 0 |

Existing tests changed: the schedule's heading is now "Equipment" (frame 5), so three checks that looked for the heading
"Equipment schedule" look for "Equipment". No test id was removed.

## Side-by-side comparisons (`compare/`, 390 px, `mockup-compare.mjs tags-series-search-2026-10 …`)

| Screen | Reference | Fixed during the work | Remaining differences |
|---|---|---|---|
| `schedule-header` | frame 5 | heading, Hours/Days/Weeks, stepper and key drawn as frame 5 and fixed above the timeline (it used to scroll out on open); setup and cleaning drawn as their own blocks with "to 3:30 pm"; bar times; axis "6 am"; the names row's corners no longer show what scrolls under them | The timeline opens centred on now, so it shows the evening before and the morning (frame 5 shows 6 am to 6 pm). Hourly ticks, not two-hourly. The key adds Maintenance and has no Pending (R5). The cleaning block is a plain pale block, not hatched. Bars have no second detail line ("Batch 213"). No grid lines across the columns. The third column is cut at 390 px (columns are wider than frame 5's). "Today is" is underlined (it is a control). |
| `schedule-header-days` | frame 5 (drawn at Hours) | day axis labels lose their comma | Days is not drawn; bars are short at 84 px a day |
| `schedule-header-dark` | frame 5 in the prototype dark tokens | — | the same as light |
| `equipment`, `equipment-dark`, `schedule-new-booking` | frame 5 | re-run: they now show the fixed header | the harness scenario has no bookings in view |
| `search` | not drawn; frame 1 | the field's height to 44; the open magnifier on a round sage | Frame 1 draws only the magnifier. The field, Clear, "1 result" (in the group-heading face) and the marked words (bold on sage) are not drawn. Pinned rows are hidden while results show. |
| `search-none`, `search-dark` | frame 1, frame 15 | — | as `search` |
| `group-menu` | frame 1 | — | The ⋯ button and its menu are not drawn; frame 1's heading has no menu. The ⋯ at the end of the filter row is not drawn either. Headings in the app's own order (by count, then name). |
| `list-light`, `list-dark` | frames 1, 15 | — | the filter row is 44 pt shorter on the right for the ⋯ button |
| `tags`, `tags-dark` | no mockup; frame 12 as the Equipment screen | the section label is "Active tags" (it duplicated the heading) | Rows have a chevron and no avatar; "Show archived", Refresh, the help line and "Counts are the threads you can see" are not in frame 12 |
| `tags-add` | no mockup; board 1 fields | — | The add form in place is not drawn |
| `tag`, `tag-dark`, `tag-archive` | no mockup; board 1 fields | — | Fields differ by nature (name, owner, starts, ends); "Clear both dates" and "Archive this tag" are not drawn; the archive confirm is the Equipment screen's |
| `repeat`, `repeat-dark` | no mockup; board 1 (the task card) | the "Days" label says "Days from the end" | The form sits under the card's details, so the card's top is above the screenshot; "Repeat it" and the period line are not drawn |
| `repeats` | no mockup; board 1 | — | "Repeats …" and "Part of … · Edit the series" are not drawn |
| `series`, `series-paused` | no mockup; board 1 fields | — | The screen is not drawn; its back link says "Back" |
| `task-editing` | board 1 | — | re-run: the task card now ends with "Repeat this task" |

## Not covered

Hosted (staging is T-C), iOS and Android, assistive technology (labels and roles are checked in the DOM only), polling
pause during search in a browser (covered by the controller's pure test), and a person using these with real data.
