# Versions and undo staging release, 3 October 2026

Outcome: **manage shared work**. Migrations 0047 and 0048, the history and undo API and the client screens are on
staging. The dated record is in [paused.md](../../runbooks/paused.md); this folder holds the evidence beside the
increment's own records (v-d.md, v-e.md).

| File | What it is |
|---|---|
| [release-deploy.log](release-deploy.log) | The deploy's release-command and machine-update lines |
| [release-post-check.mjs](release-post-check.mjs) | The read-only check after the migrations: counts only |
| [release-post-output.txt](release-post-output.txt) | Its output at 08:00:33Z |

The check ran once on the existing staging machine through `flyctl ssh console`, using the machine's own owner
connection inside a read-only transaction, and was removed afterwards. It prints no connection string or record content.
