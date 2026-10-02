# History and undo: design reference for R3

Eleven phone screens (390 × 844) for the [versions contract](../../../plans/versions-and-undo-2026-10.md),
drawn by root and reviewed by the owner on 2 October 2026 ("That looks great"). They are the design
authority for V-D and V-E (D14), beside the [chat-first prototype](../captain-chat-first-2026-09-30/README.md).
The data is the fictional Tidewater Brewing set; nothing here is customer data or application code.

The files are the canvas's own sources: one `.dc.html` per screen, a shared `captain.css`, and
`canvas.json` with the layout. They are authored for a design canvas, so open them there to see them
rendered; read them here for exact copy, structure, labels and colours. Colours are the light tokens
of `apps/mobile/src/theme/tokens.ts` plus a warning pair (`#fbe8c4` / `#6b4a0c`, border `#b98a2b`) and
a neutral pair (`#e4e8e1` / `#434a44`), which V-D adds to both palettes with a contrast test. Fraunces
and Inter appear in the drawings; the app keeps its system fonts.

| # | File | Screen |
|---|---|---|
| 1 | Main.dc.html | Task card, editing |
| 2 | Booking.dc.html | Booking card, editing |
| 3 | Topic.dc.html | Topic: make this a task |
| 4 | Lines.dc.html | Thread with change lines |
| 5 | History.dc.html | History |
| 6 | Selected.dc.html | History, two changes ticked |
| 7 | Preview.dc.html | Preview |
| 8 | Conflict.dc.html | Preview with a conflict |
| 9 | Blocked.dc.html | Preview, booking slot taken |
| 10 | Stale.dc.html | Preview that went out of date |
| 11 | Applied.dc.html | History after an undo |

## Behaviour the drawings imply

- **Navigation.** "‹ Threads" always returns to the thread list. On History the back link names the
  record and returns to its thread. The card's chevron folds and unfolds the card in place; it is
  not navigation. History opens from the clock button in the thread header, from the History link
  in the unfolded card, and from any change line.
- **Edits save together.** The unfolded card's fields share one "Save changes": everything changed
  at once is one change set and one line in the thread. Ticking a step saves at once, as its own change.
- **A booking's time is one change.** Start, end, setup and cleanup are shown as one "Time" line and
  are undone together.
- **Change lines** are worded by code from the changes, with the actor's first name, and open History.
- **States of a change in History:** tickable; "Changed since" (still tickable, explained); "Undone"
  (no tick box, says by whom and when); "Can't undo" (no tick box, says why). The last row says when
  history starts and links to the record as it was then.
- **Preview** shows now and after for each ticked change, says what stays untouched, and that nothing
  is erased. With a conflict the undo button is disabled until the person chooses: also undo the
  later change, or set the value themselves. Captain never chooses.
- **A stale apply** undoes nothing, says what moved, and shows the preview again.
- **After an undo** the new change set sits at the top, tickable like any other, and the changes it
  reversed are marked "Undone".

Not drawn: the stock count edit (the task card's pattern with a count and a note), the dark scheme
(use the dark tokens), loading, empty and failed states (the shell's existing ones).
