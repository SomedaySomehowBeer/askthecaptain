# Card fixes, 7 October 2026

The owner's findings on staging (https://app.askthecaptain.app, the real API), 7 October: "Cancel this booking" is
always disabled; "Save changes" looks live while a warning box is shown. Branch `fix/booking-card` from `main` at
`ccc219a`.

## Bug 1: the root cause

Against the real API, the `booking-cancel` button ("Cancel this booking") was never disabled: in every state tried it
rendered enabled (no `aria-disabled`, the `<button>` enabled, opacity 1, pointer cursor) and cancelled the booking.
On a phone, the control in view that reads as cancelling the booking is the button labelled **"Cancel"** beside
"Save changes". That button only undoes edits, so it is disabled until something is edited. "Cancel this booking"
sits below the card's scroll area: at 390×664 and 390×844 its top is 125 px and 20 px below the fold, on a card that
does not say it scrolls. The owner's own steps were not available. This explains "always disabled" from what the app
shows, but it was not seen happen on staging.

Each suspect was checked against the real API and ruled out:

| Suspect | Result |
|---|---|
| `locked`: the thread's phase not `ready` | The phase changes only in `load()`, which runs at mount and from "Try again". It stayed `ready` through polls, a message, a star, a card save, a cancel, History and back, Equipment and back, and a page reload. |
| `busy`/`uncertain` stuck in a saver | Each unfold mounts a new saver. Both flags were false after a save and after a cancel; no uncertain answer happened. |
| A pending write kept in sessionStorage | The card savers keep nothing. sessionStorage holds only composer drafts, new-thread creates and the History page's pending undo. None of these reaches the card. |
| `waiting` left by a 429 | No 429 under the production limits. A wait that ended still kept its button disabled until the next render. That is fixed below (`useDeadline`). |
| The quiet/warn style looking disabled | Computed style: opacity 1, pointer cursor, text `rgb(107, 74, 12)` in light mode (the design's `#6b4a0c`), pale amber in dark mode. |

## How it was reproduced

- A throwaway real API: `freshDatabase()` on the test cluster (`atc-pgvector-pg18`, as `captain_runtime`), with
  `createApp` serving the production web export from `apps/mobile/dist/web`. It was seeded through the API's own
  routes: Google stand-in sign-in, an organisation, equipment and bookings. A second run used the production entry
  point `src/index.ts` against the same database, with production rate limits.
- Chromium (Playwright) was signed in with the `captain_session` cookie set to the seeded session's token, and drove
  the app at 390×664, 390×844, 430×932, 420×900 and 1280×800, in light and dark, with and without 250–750 ms of
  added latency.
- Booking shapes: future, past, in progress, tagged, linked to a task, maintenance, two days and four months, in
  Australia/Sydney and Australia/Perth.
- The same reproduction showed one more real-data defect. A booking that spans days, opened after its record had
  loaded, was read as one day. Its card showed "The end must be after the start on the same day." when nothing had
  been touched, or offered to shorten the booking to one day. The synthetic check never had one.
- The new browser check `apps/e2e/scripts/real-api-cards-check.mjs` runs this reproduction on its own. Against the
  `main` export it fails at its first finding: the button beside Save reads "Cancel".

## What changed

- **Booking card.**
  - The edit-revert button is now "Discard edits" (label "Discard your edits"). The only control on the card that
    says Cancel is "Cancel this booking".
  - `bookingControls` (forms.ts) decides every action on the card. An action is enabled only when it can succeed.
  - Save is off while the invalid-time warning or the overlap warning shows. The overlap note now ends "Choose another
    time to save."
  - Checking, partial and unchecked are cautions, not refusals. Save stays on, and the note says "Captain checks it
    again when you save." These notes are drawn neutral, not in the green "free" style.
  - A booking that spans days opens with its end date (`bookingStart`).
  - The occupancy read moved into `reads.occupancy` (records.ts), so the API test drives it.
- **Every editor and Make a task.**
  - A server wait now re-renders when it ends (`useDeadline`). Before, Save, Save again, step ticks and "Make this a
    task" stayed disabled after a 429 until something else re-rendered.
  - A refusal that holds (`forbidden`, `reservation_cancelled`, `equipment_archived`, `stock_archived`,
    `thread_is_record`, `thread_not_topic`) keeps that action off until the person changes something. Before, it was
    offered again and refused again.
  - `reservation_cancelled` and `stock_archived` now reload the record, so the card shows the cancelled booking or
    the archived item.
- **Task card.**
  - "Cancel" is now "Discard edits".
  - The owner list is choosable while members load. Keeping or clearing the owner can succeed. Before, it was
    disabled, and stayed disabled if the members read failed.
  - Step ticks also stop after a refusal that holds.
- **Stock card.** "Cancel" is now "Clear" (label "Clear the count and note").
- Audit with nothing to change: MakeTask's Cancel and owner and due fields; the booking's retry, discard, keep and
  confirm buttons; the stock count's archived state; the task's add-step controls.

## Checks

| Check | Count |
|---|---|
| `pnpm --dir apps/mobile check` | pass |
| `pnpm --dir apps/mobile test` | 455 + 20 pass, 0 fail, 0 skipped (3 new card tests) |
| Web export and harness export (`expo export --platform web`, with `CAPTAIN_MOBILE_HARNESS=1` for the harness) | pass |
| Browser suite `apps/e2e/scripts/mobile-shell-ci.mjs` | 42 PASS lines, exit 0, 0 skipped |
| `pnpm --dir apps/api check`; `booking-card.test.ts` (new), `list.test.ts`, `equipment.test.ts` on the test cluster | 40 pass, 0 fail, 0 skipped |
| Real-API browser check `real-api-cards-check.mjs` (390×844) | PASS; against the `main` export it fails |
| `pnpm --dir apps/e2e check` | pass |

The synthetic cards check now also asserts:

- an untouched booking: "Cancel this booking" is on and is the only Cancel;
- Save is off under the invalid and the overlap warnings;
- the task card's Save is off under its stale warning.

## Screenshots (real API, 390×844)

- [Untouched booking](card-fixes/real-booking-open.png): "Cancel this booking" on; Save and "Discard edits" off.
- [Overlap warning](card-fixes/real-booking-overlap.png): Save off; "Discard edits" and "Cancel this booking" on.
- [Invalid time](card-fixes/real-booking-invalid.png): Save off.
- [Cancel confirmation](card-fixes/real-booking-cancel-confirm.png) and [cancelled](card-fixes/real-booking-cancelled.png).
- [Booking over two days](card-fixes/real-booking-multiday.png): opens with its end date and no warning.
- [Task stale warning](card-fixes/real-task-stale.png): Save off.

## Not covered

- The owner's exact staging data and steps; staging was not touched. Nothing was deployed.
- WebKit and iOS Safari (only Chromium is installed here), native iOS and Android, and assistive technology.
- The card's scroll area still clips "Cancel this booking" at phone heights. Moving it, or showing that the card
  scrolls, changes the reviewed design (board 2) and is left to the H1 fidelity work.
- The real-API browser check runs locally against a test cluster. It is not in CI; `booking-card.test.ts` is.
