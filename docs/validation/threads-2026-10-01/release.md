# Threads staging release, 2 October 2026

Outcome: **discuss work**. Migration 0046 and the thread screens are on staging. The dated record is in
[paused.md](../../runbooks/paused.md); this folder holds the evidence.

| File | What it is |
|---|---|
| [release-gate.mjs](release-gate.mjs) | The read-only gate script: counts only, no titles, bodies or names |
| [release-gate-output.txt](release-gate-output.txt) | Its output on the staging machine at 03:26:45Z, before the deploy |
| [release-deploy.log](release-deploy.log) | The deploy's release-command and machine-update lines |
| [release-post-check.mjs](release-post-check.mjs) | The read-only check after the migration |
| [release-post-output.txt](release-post-output.txt) | Its output at 03:31:00Z |

Both scripts ran once on the existing staging machine through `flyctl ssh console`, using the machine's own
owner connection inside a read-only transaction, and were removed from the machine afterwards. Neither prints a
connection string or any record content.

Expected against observed: 5 tags + 1 project = 6 tags; 14 + 7 + 7 = 28 record threads; 35 + 14 + 7 = 56 thread
tags; 2 series tags. All four match.

Not covered: signed-in hosted checks (the owner's), native devices, and a rehearsed rollback.
