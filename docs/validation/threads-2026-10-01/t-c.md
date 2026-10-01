# T-C — new topic/private threads and thread tags (1 October 2026)

Workspace outcome: **discuss work**. A person starts a topic by writing its first message,
starts a participant-only thread with a title and selected members, and adds/removes tags
from any visible thread. Implements D7/D25/D27/D28 and the R2 threads contract §§5–7.
This slice is stacked on T-B (#230). The published contract amendment on `origin/feat/threads-api`
(`91e504d`, #229) was read; the API worktree was not touched.

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

## Assumed shapes

As in T-B, these are strict client assumptions pending real T-A payload integration:

- Create returns the current full thread detail on 200/201, with matching thread ID and kind.
- Tag add/remove return full detail; DELETE carries `expectedRevision` in its query, as message
  deletion does. The follow-up detail read is authoritative for confirmation.
- `/tags?offset=…&limit=50` retains `{ tags, nextOffset }`. Each choice has `id`, `name`,
  `createdAt`, `updatedAt`; the amended owner/dates/archive/revision/creator fields are validated
  when present. Archived choices are excluded; attached tags come from thread detail.
- `/members` reuses the existing merged members projection, without the management-only
  invitations read. The picker itself is available to ordinary members.
- Detail has singular `pin`, no `links`; thread tags are strictly `{ id, name }`. Message/read
  wire names match the #229 amendment. `thread_id_unavailable` is handled explicitly.

## Checks

Pending final validation. Heavy work runs under `flock /tmp/atc-build.lock` with >1500 MB available.

## Not covered

Browser responses are synthetic, including the second scripted person's nonparticipant 404 and
absent private row. This proves client behavior, not database RLS or T-A endpoint integration.
No hosted round trip, real private data, inference, notification delivery, native device,
assistive-technology or cross-browser evidence. No new dependency, table, background process,
migration, deployment or merge. R2 chat creation/tag changes follow the participant-scoped audit
contract; selective reversal is not available in this client slice and remains later work.
