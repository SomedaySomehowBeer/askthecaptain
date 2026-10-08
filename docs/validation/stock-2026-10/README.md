# Stock by people: S-B validation record (8 October 2026)

Client half of H3 ([stock contract](../../plans/stock-2026-10.md) §3, §4): Stocktake, Add an item, the stock card and
the Stock filter's pinned row. Local evidence only: the Expo web export with synthetic, contract-shaped API answers, and
real Postgres for the API and the client parsers. Nothing here is hosted, native or assistive-technology evidence.

## Checks

| Check | Result |
|---|---|
| Root `pnpm check` | passes |
| Root `pnpm test` (real Postgres) | api 270, db 114, mobile 471 + 20, engine 20, model 11, steps 8, connectors 5; 0 failed, **0 skipped** |
| `apps/mobile/src/resources/stock/stock.test.ts` | 8 pure tests: strict parsers (list row, card, write, stocktake answer), grouping by location, board 12's words, the item form and its changes, the persisted draft (scoped by person and organisation, strict, cleared for another person and on sign-out), the Stocktake controller (type two and skip one, uncertain save kept across leaving and retried with the same id, stale refusal, archived refusal, 429 with the unused id, a refused id, lost access, a stale scope, Cancel) |
| `apps/api/src/stock/stocktake.test.ts`, last test | real API answers through the client parsers (add, edit with the revision, archive, restore, list, card, stocktake), and the controller against the real API: a lost answer retried with the same id (written once), the change line parsed and worded, a stale item marked while the other count stays |
| `apps/e2e/scripts/mobile-shell-stock-check.cjs` | in the full suite at 360, 390 and 430 px, and dark at 390. It covers the pinned row, type two / skip the rest / save once with change lines in each counted thread, counts kept on leaving, a stale item, an uncertain save then an explicit retry with the same body, add an item, card details, archive with its confirm, Show archived and Restore. It also checks touch targets ≥ 44 and no horizontal overflow |
| Full browser suite `apps/e2e/scripts/mobile-shell-ci.mjs` | 50 PASS lines at 360/390/430/1280, exit 0 |

## Side-by-side comparisons (`compare/`, 390 px, `mockup-compare.mjs stock-2026-10 …`)

| Screen | Reference | Fixed during the work | Remaining differences |
|---|---|---|---|
| `stocktake` | board 12 | spacing between the location labels and their groups | Rows are ordered by name within a location (Citra hops first; the board draws Pale, Wheat, Citra). Units are shown as stored ("1 rolls"; the board says "1 roll"). "Show archived" is added beside "Add an item" (contract §1). The app frame is 900 px tall, the board 844. The avatar shows the signed-in person's initials. |
| `stocktake-dark` | board 12 in the dark tokens | the comparison script now swaps the board's own `<style>` rules too (board 12 keeps its row styles in the page), so the dark mockup is no longer drawn white | the same as light |
| `stocktake-stale` | not drawn; nearest board 12 | — | The status line and the row's warning are not drawn. The stale field has the warning border. |
| `stocktake-uncertain` | not drawn; nearest board 12 | — | The status line, "Save again with the same ID" and Discard are not drawn. The fields are faded while locked. |
| `stocktake-add` | not drawn; nearest board 12 | — | The in-place form (card style of the task card's fields) and the existing-location choices are not drawn |
| `stock-card` | board 1 (task card pattern) | — | The fields differ by nature: Name / Location / Unit / Reorder point / Notes instead of Title / Status / Owner / Due. Location is full width with the existing locations offered under it, where board 1 puts two fields side by side. There is no Steps section; the card has Count, Last counts, the Stocktake link and Archive instead. Its "Discard edits" label is the task card's, not board 1's "Cancel". The card is taller than one screen, so the screenshot ends before Last counts and Archive. |
| `stock-card-dark` | board 1 in the dark tokens | — | the same as light |
| `stock-archive-confirm` | not drawn; nearest board 1 | — | The warning note and "Archive it" / "Keep it" follow the Equipment screen's confirm, not a board |
| `stock-filter` | frame 1 | — | The Stocktake row is full width under the two pinned rows (frame 1 draws only two). The row facts show the list's raw status words and ISO dates ("counted · 11 bags · 2026-09-27"). This is existing list behaviour for record rows, not changed here. |
| `stock-saved` | not drawn; nearest frame 1 | — | The saved status line under the pinned rows is not drawn |

## Not covered

Hosted (staging is S-C), iOS and Android, assistive technology (labels and roles are checked in the DOM only), and a
real person walking a stocktake.
