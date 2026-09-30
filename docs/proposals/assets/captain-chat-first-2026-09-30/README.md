# Captain chat-first design reference

[Open the prototype](index.html). This is the owner's HTML export of the Captain prototype,
received through Taildrop on 30 September 2026 as `Captain chat-first prototype.html`. It is
checked in byte-for-byte unchanged. It contains fictional Tidewater Brewing people and records,
not customer data or application code. The original private Claude artifact is no longer needed
to inspect the reference.

- Size: 10,516,811 bytes.
- SHA-256: `9fbc12b76ecf166cbae2813983a950b7a0fbe1b6528f4fbdf9924f25d39ca414`.
- Format: one self-contained HTML file with compressed embedded resources and 17 screen frames.
- Open in a JavaScript-enabled browser; the initial loader unpacks the embedded screens.

## Authority and limits

The export records the owner's reviewed visual direction: dense thread rows grouped by tag,
small record cards, oldest-first messages, pinned views, light and dark themes. Use it with
[plan §10 and D14](../../../plan.md) and the
[private-call and selective-undo contract](../../../plans/private-threads-and-selective-undo-2026-09.md).
The reviewed written behaviour wins where the older export differs.

In particular, private threads are never classified in the background; an explicit agent mention
exposes only the calling message. Undo selects changes and preserves unrelated later work. The
existing History and undo screen does not yet specify selective changes, preview or conflict
resolution. Those states and private-call behaviour need reviewed designs before implementation.
Do not infer application functionality, complete error/accessibility states, native acceptance
or tested business effects from this export. Keep this source immutable; author refinements in
separate files and record their relationship to it.

## Included screens

1. Threads (home)
2. New thread
3. Task thread
4. History and undo
5. Equipment
6. File, being worked on
7. Agents stuck, stopped by Captain
8. Pending booking, as the owner
9. Pending booking, as an admin
10. Agents working together
11. Worksheet scan
12. Team
13. Agent profile
14. Agent that can approve
15. Threads home, dark
16. Task thread, dark
17. Pending booking, dark

## Verification on 30 September 2026

Loaded the exact export in the shared Chromium browser through Playwright/CDP. All 17 frames
finished loading with nonempty screen content. No page errors or external HTTP requests were
observed. Visually inspected the light and dark home frames at their supplied 390-pixel width.
This was a render check, not a complete interaction, contrast, responsive or accessibility audit.
No API, database, production deployment or native-device test was needed or performed for this
documentation and reference-asset change.
