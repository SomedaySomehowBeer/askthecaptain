# T-C — new topic/private threads and thread tags (1 October 2026)

Workspace outcome: **discuss work**. A person starts a topic by writing its first message,
starts a participant-only thread with a title and selected members, and adds/removes tags
from any visible thread. Implements D7/D25/D27/D28 and the R2 threads contract §§5–7.
This slice is stacked on T-B (#230). Main `b9b09fb` (#229) was merged into both branches. The merged service, routes and tests
were inspected, and T-B’s actual-wire corrections are included; the parallel API worktree
was not touched.

The list has the fixed New thread button. `/threads/new` opens a focused, empty composer.
Private reveals the title and member choices, fetched with the existing member-readable API;
the creator is implicit, at most 49 others. No agents, classifier or inference are called.
Only members chosen in the request can gain access through the server's private-thread policy.

Creation is one atomic request with two client UUIDs. A pending draft is saved in tab sessionStorage
before sending, under the existing person/organisation pending namespace. An uncertain result
locks text, kind, title and selections across reloads; manual retry preserves both IDs and the exact
normalised request. A 429 preserves editable fields and IDs, including its wait across reloads.
`thread_id_unavailable` preserves text for an explicit new-ID action or discard. Completion,
404, sign-out and a different signed-in person clear the applicable pending data. A scope switch
hides and preserves the original person's draft and suppresses late navigation/results.
No message history or successful thread title/ID is cached in browser storage.

Tag choices are bounded, paged and active-only. Attached tags remain removable when archived.
Each add/remove carries the displayed thread revision; the controller reads detail after the
write and confirms only if the requested attachment state holds. A stale revision shows current
state and requires another explicit choice. Unknown writes are never replayed automatically.

## Assumed shapes and merged API reconciliation

The initial assumptions are now confirmed against the merged T-A service and routes:

- Create returns the current full thread detail on 200/201, with matching thread ID and kind.
- Tag add/remove return full detail; DELETE carries `expectedRevision` in its query, as message
  deletion does. The follow-up detail read is authoritative for confirmation.
- `/tags?offset=…&limit=50` retains `{ tags, nextOffset }`. Each choice has `id`, `name`,
  `createdAt`, `updatedAt`; the amended owner/dates/archive/revision/creator fields are required and validated. Archived choices are excluded; attached tags come from thread detail.
- `/members` reuses the existing merged members projection, without the management-only
  invitations read. The picker itself is available to ordinary members.
- Detail has singular `pin`, no `links`; thread tags are strictly `{ id, name }`. Message/read
  wire names match the #229 amendment. `thread_id_unavailable` is handled explicitly.

## Checks

Heavy work ran under `flock /tmp/atc-build.lock` with >1500 MB available.

- Mobile and API typechecks passed.
- **413 mobile pure tests + 20 boundary/config tests**, no skips.
- **49 real-Postgres thread/list/session tests**, no skips, including the new client-controller
  uncertain-create integration and actual tag/member picker parsing.
- SDK compatibility, Android backup configuration, fresh web/iOS/Android/harness exports,
  bundle boundary and canary guards passed.
- Playwright at **360/390/430 px** passed: focused composer, topic/private creation, member
  selection, persisted locked retry, 429 editing and same IDs, explicit unavailable-ID restart,
  stale-revision tag retry/add/remove, second-person private row/content absence, and empty,
  failed, waiting, pending and refused harness states. No page errors, overflow or external requests.
- T-B’s full existing shell regressions and corrected-shape thread checks remain the baseline;
  CI also runs the newly added T-C helper in that full suite. The suite watchdog is 900 seconds
  to accommodate the additional three-width creation checks (job limit remains 25 minutes).

Logs: [typecheck/tests/exports](t-c-export.log), [Postgres](t-c-postgres.log),
[browser](t-c-browser.log). Screenshots: [360 topic](t-c-360-topic.png),
[360 private](t-c-360-private.png), [390 topic](t-c-390-topic.png),
[390 private](t-c-390-private.png), [430 topic](t-c-430-topic.png),
[430 private](t-c-430-private.png).

## Not covered

Browser responses are synthetic, including the second scripted person's nonparticipant 404 and
absent private row. This browser check proves client behavior; database/API evidence is recorded separately below.
A new real-Postgres test exercises the client create controller against the API, including
a committed private create whose response is lost and a same-ID retry after remount; it
asserts exactly one first message and nonparticipant exclusion. It also parses actual tags
and member picker payloads. No hosted browser round trip, real private data, inference, notification delivery, native device,
assistive-technology or cross-browser evidence. No new dependency, table, background process,
migration, deployment or merge. R2 chat creation/tag changes follow the participant-scoped audit
contract; selective reversal is not available in this client slice and remains later work.
