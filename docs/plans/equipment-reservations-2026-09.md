# Equipment reservations — API and web

> **Scope correction, 25 September:** equipment remains core. The task-requires-matching-project
> rule below describes the delivered API, not a requirement to fabricate a project for standalone
> work. D7's optional-project implementation must amend this contract and its link checks/tests
> together. Allocation is a workspace outcome, independent of personal calendar assistance.

Jobs: **allocate resources** and **manage shared work**. Implements the scheduling integrity part of
D24 and delivery slice 3. The API increment merged as #125. Web timeline and booking controls
now follow the existing reviewed continuous timeline design; a native client remains pending. Slice 2's saved
views and native work also remain open. Equipment integrity can be built against the existing
shared work API without waiting for either.

## Shared records and access

Migration 0036 adds `equipment` and `equipment_reservations`, with forced tenant RLS, active
membership policies, tenant-qualified foreign keys, and audited writes. It also installs the
Postgres `btree_gist` extension for the exclusion constraint. No package or background process is
added. All active organisation members can manage this shared equipment and its reservations.
There are no private equipment records or role-specific maintenance privileges in this increment.
A removed member cannot read or write. Export includes both tables and organisation deletion
cascades to both; normal equipment and booking operations never hard-delete records.

Equipment has a name (trimmed, 1–100 characters, case-insensitively unique including archived
names), revision, timestamps and optional archive timestamp. Reservable equipment is exclusive:
its capacity is one. Named rooms, machines and vehicles use the same record; this is not a
configurable domain model. Archiving requires no current or future confirmed occupancy. Cancelling
future reservations permits archival; previous history is retained. Restoration is explicit.

A reservation has a client-generated UUID, equipment, title (trimmed, 1–200 characters), kind
`booking` or `maintenance`, status `confirmed` or `cancelled`, actual start/end instants, integer
setup/cleanup minutes, calculated occupied boundaries, revision and creator. It may link a project,
a task and an accountable person. Under the [optional-project increment](optional-work-projects-2026-09.md),
a task link requires the same project as its task, including null for standalone work. New/edited
links require a top-level, non-cancelled task, an active project when one is named, and an active
member respectively. Moving a task updates its confirmed reservation links and revisions;
cancelled reservations keep their historical links.
An edit rechecks all links: clear or replace a now-ineligible link before saving. Cancellation and
an unchanged create retry still work after linked work is archived or an owner is removed.

## Time, conflicts and retries

Inputs require ISO timestamps with an explicit `Z` or numeric offset, normalised to UTC instants.
Actual starts/ends are at least 1900-01-01T00:00Z and strictly before 2200-01-01T00:00Z. Duration
must be positive and at most 366 elapsed days. Setup and cleanup are each 0–10,080 elapsed minutes;
occupied time may extend beyond the actual-time bounds. The organisation timezone is returned for
display, never guessed from the API machine. Clients must deliberately resolve local-time DST
ambiguities before sending instants. Web forms resolve local times in the organisation timezone, refuse DST gaps and require a
chosen offset occurrence in repeated hours. A changed organisation timezone requires reloading
the form before saving. Recurring reservations remain later.

Occupied time is `[start - setup, end + cleanup)`. Adjacent occupied ranges may touch; overlap
is forbidden. One GiST exclusion constraint covers all confirmed reservations for the same tenant
and equipment, including maintenance. Database checks ensure occupied boundaries match the buffer
values, so callers cannot omit cleanup to evade the constraint. Client previews are advisory.

Equipment row locks serialize archive/create/edit/cancel operations. Database overlap enforcement
also protects against concurrent direct writes without those application locks. A conflicting edit
rolls back and preserves the old reservation. Every edit/cancel supplies `expectedRevision`;
changes from another client produce 409 `stale_revision`, with no lost update. Cancelled records
cannot be edited/reconfirmed; create a new UUID to book again. Repeating cancellation using the
current revision is a no-op, while an old revision is stale.
An individual reservation read includes cancelled records so clients can reconcile an uncertain
cancel or edit response and obtain the current revision before retrying.

Creation requires a client-generated UUID kept through uncertain network failures. A retry with
the same creator, equipment and canonical payload returns the original revision-one confirmed
record without another audit. Changed input or a record already edited/cancelled yields
409 `reservation_id_exists`. A foreign tenant's colliding UUID produces the same generic conflict
without exposing its contents. Equipment creation does not yet have a retry key: after an uncertain
result, reload the catalogue before trying again; name uniqueness prevents duplicate named equipment.

Writes and audit entries commit together. Overlap returns 409 `reservation_conflict` without any
other booking's title, owner or ID. Archive-with-occupancy returns 409 `equipment_in_use`; booking
archived equipment returns `equipment_archived`, and editing a cancelled booking returns
`reservation_cancelled`. Missing/foreign/ineligible links return 404, absent authentication 401,
and malformed inputs 400. Unknown JSON fields and range filters are rejected.

## HTTP contract

All paths below are relative to `/v1/organisations/:id`. Responses are plain equipment/reservation
records unless described otherwise; timestamps are ISO strings.

| Method and path | Input / result |
|---|---|
| GET `/equipment` | `archived=true/false` (default false), `limit` 1–100 (default 50), `offset` 0–1,000,000; `{equipment, nextOffset}` |
| GET `/equipment/:equipmentId` | One equipment record, including archived |
| POST `/equipment` | `{name}`; 201 |
| PATCH `/equipment/:equipmentId` | `{expectedRevision, name?, archived?}` with at least one change field |
| GET `/equipment/:equipmentId/reservations` | Required `from`, `to`, optional `limit` 1–200 (default 200), `offset` 0–1,000,000; see coverage below |
| GET `/equipment/:equipmentId/reservations/:reservationId` | One reservation, including cancelled; stable read for reconciliation |
| POST `/equipment/:equipmentId/reservations` | `{id, title, startsAt, endsAt, kind?, setupMinutes?, cleanupMinutes?, projectId?, taskId?, ownerId?}`; 201 new / 200 unchanged retry |
| PATCH `/equipment/:equipmentId/reservations/:reservationId` | Full replacement schedule payload (same as creation without `id`) plus `expectedRevision`; equipment cannot change |
| POST `/equipment/:equipmentId/reservations/:reservationId/cancel` | `{expectedRevision}`; cancelled record |

Defaults: kind `booking`, buffers zero, links null. Replacement uses these same defaults for omitted
optional fields, so clients submit the full desired schedule and links. Record revisions start at one.
No endpoint hard-deletes equipment, hides occupancy by project, or changes work when a booking is saved.

## Honest availability reads

A query window is half-open, positive and at most 93 elapsed days. Reads select confirmed **occupied**
ranges that intersect it, including setup, cleanup and maintenance even when actual work falls outside
the window. There are no tag, project, owner or task filters. Archiving linked work or cancelling a
task never silently removes a reservation: explicitly cancel the booking to release its equipment.

The response is `{reservations, nextOffset, coverage, from, to, timezone}`. Rows are ordered by
occupied start then ID. `coverage: complete` means the first page contained every confirmed interval
in that window at the moment of the read. Truncation or any nonzero offset yields `partial`; a last
page alone cannot declare the whole window free. Outside the requested window remains unloaded.
Offset paging is not a stable snapshot under concurrent edits. A client seeking a complete availability
picture should narrow a dense window and reload an untruncated first page; only an accepted write
confirms a booking. The web timeline preserves these distinctions when zooming or scrolling. It reads at most
200 reservations per column; partial columns stay unknown and ask for a narrower date window.
