# Bookings and equipment by people: the H2 contract

Status: root contract, 8 October 2026, under the owner's people-first order (rebuild plan §4, H2). Outcome:
**allocate resources** — a person can book equipment, keep the equipment list, and find the team, all from the one
client. Nothing here involves an agent, approval or the `pending` state (R5).

## 1. What a person can do when H2 is done

- Make a booking from the equipment schedule: "New booking" with the equipment and day prefilled from what is on
  screen, or from a topic thread: "Make this a booking", as "Make this a task" works today.
- Add equipment, rename it and archive it, and see archived equipment when asked.
- Open Members from the Team pinned row on the thread list.

## 2. API

Existing: `POST …/equipment` (name), `PATCH …/equipment/:id` (name, archived, expectedRevision),
`POST …/equipment/:id/reservations` (id, title, kind, startsAt, endsAt, setupMinutes, cleanupMinutes, taskId,
ownerId, tagIds, changeSetId), `GET …/equipment?archived=`. All journalled (0047).

New: `POST …/threads/:threadId/booking { expectedRevision, changeSetId?, equipmentId, startsAt, endsAt,
setupMinutes?, cleanupMinutes?, ownerId? }` on a topic thread: creates the booking titled with the thread's title,
and the thread becomes its record thread, keeping its id, messages and tags, with no second thread — the same
transition as `thread_make_task` (0048), generalised in migration 0049 (`thread_make_record` or a sibling function;
the booking's insert trigger makes no thread for it). Refusals as for make-a-task (`thread_not_topic`,
`thread_is_record`, `stale_revision`, `owner_invalid`) plus the booking's own (`equipment_archived`, overlap 409
with the holder). Journalled as the booking's creation. Returns the thread detail with the `Change-Set-Id` header.

As built in B-A (migration 0049, `thread_make_booking`, a sibling of `thread_make_task`; details this contract left open):

- The answer is `200` with the thread detail (kind `record`, the card on the new booking, its tags), as make-a-task.
- The booking's id is the server's (uuidv7); the retry identity is `changeSetId`. Its kind is `booking`, its status
  `confirmed`, its creator the caller, its task none, its tags the thread's own; `ownerId` absent or null is no owner.
  The time fields and their bounds are those of creating a booking (explicit instants, an end after the start within
  366 days, setup and cleanup 0–10080 minutes); any other key is `400 invalid_request`.
- Locks follow the global order: the caller's and owner's memberships, the equipment, then the thread. Refusals, in that
  order: unknown equipment or thread (or another tenant's) `404`; a private thread `400 thread_not_topic`; a record's
  thread `409 thread_is_record`; `409 stale_revision`; `400 owner_invalid`; `409 equipment_archived`; an overlap
  (setup and cleanup included, the 0036 constraint deciding) `409 reservation_conflict`.
- "With the holder": the overlap `409` is creating a booking's, which names no booking. The client names the holder from
  the equipment's schedule, as the booking card already does (board 2); the refusal leaves nothing written (no booking,
  no change set, no change line, the thread's revision unmoved), so the same `changeSetId` stays free for the next try.
- A retry with the same `changeSetId`, person and body answers with the thread as it is now; the same id with anything
  else is `409 change_set_id_unavailable`.

## 3. Client

- **New booking** (`/equipment/new?equipment=<id>&day=<date>` from the schedule's "New booking" button, prefilled
  from the view; also reachable with nothing prefilled): the booking card's editing fields (design board 2:
  title, equipment, date, start, end, setup, cleanup, the occupancy note that checks the slot as you type) and
  "Make the booking". One request with a client id and `changeSetId`, retry-safe like the card writes; an overlap
  shows the holder and keeps the form; success opens the new booking's thread.
- **Make this a booking** on a topic's unfolded card, beside "Make this a task" (design board 3's pattern: the
  heading, one sentence, the fields above, "Make this a booking", Cancel). Not shown on private or record threads.
- **Equipment** screen (`/equipment/manage`, from a "Manage equipment" action on the schedule): the list with
  "Add equipment" (name), rename in place, archive and unarchive with a confirm step, "Show archived". Each write
  is journalled and revision-checked; archived equipment leaves the schedule and the pickers.
- **Team** pinned row opens `/members`; the row's "Not in this version yet" copy goes.
- Design: the schedule frame (prototype frame 5) and boards 2 and 3; the Equipment screen follows the Members
  screen's list style. Every screen is compared side by side with its reference with
  `apps/e2e/scripts/mockup-compare.mjs`; where no mockup exists (Equipment manage, New booking) the comparison is
  against the nearest board and the record says so. Both colour schemes; 360/390/430; honest states.

## 4. Tests

Real Postgres: topic-to-booking (one thread, messages and tags kept, not private, retry-safe, second call refused,
overlap refused with nothing written, journalled with a change line); equipment add/rename/archive journalled and
revision-checked; archived equipment refuses new bookings. Client: pure tests for the new-booking form and
prefill; the real-API parser test extended; Playwright at 360/390/430 for new booking from the schedule (prefill,
overlap, success), make-a-booking on a topic including a refusal, equipment add/rename/archive/unarchive, the Team
row. Validation record under `docs/validation/bookings-equipment-2026-10/`.

## 5. Pull requests

| PR | Delivers |
|---|---|
| B-A | Migration 0049 and the topic-to-booking route, tests |
| B-B | Client: new booking, make-a-booking, Equipment screen, Team row; the comparisons |
| B-C | Staging release record |
