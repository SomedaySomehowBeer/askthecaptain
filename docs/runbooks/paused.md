# Staging resumed; production paused (2026-09-24)

Captain's staging workspace is available at **https://app.askthecaptain.app/work**. API and web
retain the reviewed workspace, including private saved Work views (#153/#154) and By tag navigation (#159):
API image source `6be8321d`, web image source `2e0aa1b`. Continuous equipment scheduling and
project task-history filters remain included.
The earlier Work record and task/list corrections remain included.
Tasks, projects and recurring work have their own Work pages; the Commitments overview is retired.
The old-version database content was reset earlier on 25 September under explicit owner
permission; **this release did not run another reset**. Embedding and production remain stopped.
The original 23 September pause is recorded below as history.

## Staging authorisation (24 September 2026)

The owner authorised restarting infrastructure **when needed**, deploying **only to staging**,
and keeping **at most one machine per app**, plus merging PRs after review. This supersedes the
owner-only resume instruction below for those staging actions. Production remains stopped.
The authorised restart was performed on 24 September. Existing enabled in-app workflows and
provider syncs resume with the API; their settings and secrets were preserved. This is distinct
from GitHub's deploy and backup workflows, which remain disabled.

Before a staging resume, inspect live machine counts and deployment targets, constrain rollout
and standby behaviour to the one-machine limit, and record what changed here. Do not enable a
workflow that could promote production. Backups remain disabled pending their separate restore
checks and operational decision.

## By tag Work views release (26 September 2026, UTC)

Outcome: **manage shared work**. [#159](https://github.com/SomedaySomehowBeer/askthecaptain/pull/159)
was independently reviewed by Claude Opus and the coordinator, passed
[CI](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36214459102), and squash-merged
as `bcc3155bd5ebafbde1b16ee345c70783677ad6dc`. Every existing organisation tag now appears under
Work → views → By tag, linking by stable ID to Everyone · Open. Production, Marketing, Sales and
Admin/reporting remain ordinary tags, created explicitly through Tags if missing. No seeding occurred.

Only web machine `9185776e7cd3d8` changed image, to
`registry.fly.io/askthecaptain-web-staging:git-2e0aa1b@sha256:a6b581dbe2ecc0abb00c202bd0f8d4d8d2d1da4a9056c11d4118495ae6b7401c`.
It was built/pushed from a clean detached checkout at `2e0aa1b29965384b9a7343256f3d09f48eb0ead8`,
whose committed tree exactly matches the merge. Comparing `7e60a1e` with `bcc3155` also confirmed
all Docker inputs outside `apps/web` were unchanged (including API, packages, manifests, lockfile
and patches). The machine configuration was copied and only its
image replaced, then the existing machine was updated and started. No migration, queue installation,
API restart, reset or customer-record mutation was needed or performed.

Before/after comparisons confirmed one API and one web staging machine and unchanged configuration
apart from the web image. API remains at the #153 image below. Production's existing two API and
two web machines, and the single embedding machine, stayed stopped with unchanged configuration.
Deploy and backup workflows remain disabled. No DNS, secret or infrastructure change occurred.

API `/readyz` returned `200 {"ok":true}`. Shared Chrome at 390 and 1440 pixels rendered the hosted
Google sign-in entry, without overflow or browser exceptions. There was no authenticated hosted
session; authenticated functionality was checked against the isolated real API/Postgres fixture,
not the customer's hosted data. The demo was not independently re-read on staging.

Validation: web typecheck, 74 web tests and production build passed; all seven focused browser
groups, all 16 saved-view regression groups in one run, and all 10 existing Work groups passed.
The focused and saved-view suites used the existing opt-in disposable-fixture rate-limit clock;
Work regression used ordinary limits. The first focused run found an ambiguous test selector;
its corrected full rerun passed. No loading-timing or native-device acceptance is claimed.
[Evidence and populated captures](../validation/tag-views-2026-09-26/README.md) are retained.

Rollback is an image-only update on the same web machine to the previous `git-7e60a1e` digest
`sha256:2a88aa7468032c224b387e1ea0a5ac0768270c7a54426b270bbf03afde9a8ac1`, preserving its current
configuration. The API and database do not change.

## Private saved Work views release (26 September 2026, UTC)

Workspace outcome: **manage shared work**. Backend [#153](https://github.com/SomedaySomehowBeer/askthecaptain/pull/153)
and web [#154](https://github.com/SomedaySomehowBeer/askthecaptain/pull/154) received reciprocal
Claude Opus/coordinator review and green CI before squash merge. Backend merge is
`6be8321d1d07002c152d9058060f1e731054c39d`; web merge is
`0e54baf55ab3dae0d36c6d5b2e0e27edfad65106`. Final web
[CI](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36212100605) passed in 2m52s.

Only the existing staging machines were updated:

| App | Machine | Image source | Image digest |
|---|---|---|---|
| API | `80e39ea6416e18` | `git-6be8321d1d07002c152d9058060f1e731054c39d` | `sha256:8b2a1b15c692bfb739ab47c183e6475c21fe7fbf54784b81b360246a1f67308b` |
| Web | `9185776e7cd3d8` | `git-7e60a1e` | `sha256:2a88aa7468032c224b387e1ea0a5ac0768270c7a54426b270bbf03afde9a8ac1` |

Images are in their respective `registry.fly.io/askthecaptain-<app>-staging` repositories,
built and pushed from clean worktrees. Every web Docker input was compared with the final merge
and was identical: `7e60a1e` preceded the final reviewed head `162f41e` by only the
browser-harness correction outside the image.
API runtime inputs are unchanged by the web PR. No fixture data or credentials entered either image.

Both staging machines were stopped with autostart off. The existing API was updated with the
new image and a one-shot migration/queue-install command, restart policy `no`, and both autostart
and autostop disabled for that command. Only `0040_saved_views.sql` applied at **02:38:55Z**.
Queue installation completed and `SAVED_VIEWS_MIGRATION_READY` appeared at **02:38:56Z**;
the process exited naturally with **0**, no OOM and `requested_stop=false`. No extra release
machine was created. Normal API/web commands, restart-on-failure, autostart, idle stop and minimum
zero were restored. Before/after configuration comparison showed only the intended image changes.

API `/readyz` returned `200 {"ok":true}`. Live Chrome at 390 and 1440 pixels confirmed Work
redirects signed-out visitors to the rendered Google sign-in entry, without overflow or browser
exceptions. There was no authenticated hosted browser session, so saved-view acceptance used the
real local API/Postgres fixture; authenticated hosted and native-device acceptance are not claimed.
No reset or customer-record mutation was run; the additive migration does not touch demo tasks or
projects. The demo was not independently re-read through an authenticated hosted session.

Validation and populated captures are in the [delivery record](../plans/saved-work-views-delivery-2026-09-26.md):
60 database tests, 151 API tests, 66 web tests, production build, 16 saved-view browser groups across
the final run/targeted continuation and all 10 existing Work regression groups. Both Opus agents
reviewed each other's implementation and the coordinator's corrections; the web agent also reviewed
the sole-machine release configuration.

Exactly one API and one web staging machine remained after release. Production's pre-existing two
API and two web machines, and the sole embedding machine, remained stopped with their configurations
unchanged. No DNS, secret or infrastructure apply occurred. Deploy and backup workflows remain
disabled. No new backup/restore proof was established by this release.

Rollback: restore the preceding API `git-ac28154` (digest
`sha256:00823060f5fb7b0e63d3de14c4fedd06be7ba64afbb2305ca07865db82dc39db`) and web `git-709f89e`
(digest `sha256:4adc477af6914c0339b1d6cdb257e3522d1b2df343abe4c29357afcacccc5300`) on these same
machines, preserving normal settings. Keep additive migration 0040 and saved records; do not reset
or drop the new table to roll back code.

## Equipment scrolling and project task-history release (26 September 2026, UTC)

Workspace outcomes: **allocate resources** and **manage shared work**. Both increments received
reciprocal Claude/root review and green CI before squash merge:

- [#149](https://github.com/SomedaySomehowBeer/askthecaptain/pull/149), merged as
  `126ed437a5e30a6d155bf7cc341dceb712384c4c`; [CI](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36204078160)
  passed in 3m27s. Equipment scrolls one calendar month before through six months after the opened
  date, with date navigation beyond it, bounded lazy occupancy reads and virtualised hourly rendering.
- [#150](https://github.com/SomedaySomehowBeer/askthecaptain/pull/150), merged as
  `e0f016b61efc1c57bdd551a354a4b171baf7e031`; [CI](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36204696471)
  passed in 2m50s. Project Tasks defaults to Open and separates In progress, Suggested, Completed,
  Cancelled and All except cancelled. Paging and keyboard feedback preserve the selected view.

By **00:28Z**, only existing web machine `9185776e7cd3d8` was updated to
`registry.fly.io/askthecaptain-web-staging:git-709f89e`, digest
`sha256:4adc477af6914c0339b1d6cdb257e3522d1b2df343abe4c29357afcacccc5300`.
The image was built from clean archive `709f89e22fc671959cc1ba383a17a9d5ea293d8b` before the
last test-harness-only correction. Every Docker input (web, packages, patches and root build
configuration) was compared against the final merge and was identical; the source Git trees as a
whole are not claimed identical. No local fixture data or credentials entered the image.

API remains the sole `80e39ea6416e18`, image `git-ac28154`, digest
`sha256:00823060f5fb7b0e63d3de14c4fedd06be7ba64afbb2305ca07865db82dc39db`.
Before/after configuration comparison passed: exactly one machine per staging app, only the web
image changed. Normal commands, autostart, idle stop and zero minimum-running settings remain.
API readiness returned `200 {"ok":true}`. Idle stopping is expected; hosted checks woke the web.
Production's existing machines and the embedding machine were observed stopped and not modified.
No migration, reset, customer-record write, secret change or additional application machine was
part of this release; the demo remains the user's test data.

Validation: workspace typecheck, 44 web tests and production builds passed. All **14 local browser
groups** passed against the real API and disposable Postgres: three scrolling, five existing
equipment, two task-history and four existing project overview/schedule groups. The final runs
exited 0. Browser checks found and corrected range re-anchoring after URL changes and oversized
hourly rendering after zoom. Test-only fixes wait for routed requests on teardown and use monotonic
read counts despite a bounded statistics buffer. The first overview process ended with SIGTERM
after its four PASS lines; a fresh rerun then exposed setup exhausting the normal per-IP request
window. Moving its existing cooldown before bulk booking setup preserved all assertions and
application limits; the final complete rerun exited 0. Task-owned local servers were stopped and
the disposable fixture removed; shared Chrome was left running.

[Calendar screenshots and scope](../validation/equipment-scroll-2026-09-26/README.md) and
[task-history proof](../validation/project-history-2026-09-26/README.md) cover 360/390/430 and
1440-pixel layouts. Hosted Chrome checks passed signed-out equipment/Work/project/recurrence
redirects, Google sign-in entry, phone/desktop layout and absence of browser exceptions. They do
not establish an authenticated hosted session or a full Google round trip. Native-device gestures,
screen-reader acceptance and remaining search/filter/Files/Chat work remain outside this release.

## Project overview and schedule release (25 September 2026, UTC)

Workspace outcomes: **manage shared work** and **allocate resources**.
[#147](https://github.com/SomedaySomehowBeer/askthecaptain/pull/147) merged as
`ad74d7e838a41201f1dea73712b8f8e3c410a4a1` after reciprocal Claude/root review and green
[CI](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36149762198) (check job 2m58s).
Image source `ac28154a22a5980d7b08b957b82890229eed85c1` has the same Git tree as the merge.

At approximately **14:52–14:53Z**, the existing staging machines were updated in API-then-web
order. API readiness returned `200 {"ok":true}` before the web update. Verified inventory:

- API: only `80e39ea6416e18`, `registry.fly.io/askthecaptain-api-staging:git-ac28154`, digest
  `sha256:00823060f5fb7b0e63d3de14c4fedd06be7ba64afbb2305ca07865db82dc39db`.
- Web: only `9185776e7cd3d8`, `registry.fly.io/askthecaptain-web-staging:git-ac28154`, digest
  `sha256:4778c3f25052215df47c8d09821d1bf8c03170df6eecf062c7914a0773c8a0dc`.

Before/after configuration comparisons showed only each image changed. Normal API/Next.js commands,
autostart, idle-stop and zero minimum-running settings remain unchanged. No migration, queue install,
data reset, customer-record write, secret change, production/embedding update or new application
machine was part of this release. Existing demo tasks and bookings remain the user's test data.

The project now has Overview, Tasks and Schedule views. Overview previews open/in-progress work
across shared tags; Schedule uses an authenticated, RLS-protected bounded project-booking read.
Archived history remains readable. Project-filtered bookings never claim equipment availability;
the shared timeline retains competing occupancy across projects. No invented chat, files or conflicts.

Validation passed: workspace typecheck, production build, 24 real-Postgres equipment tests, four
reminder tests and 11 local browser groups (four project and seven existing Work-record groups).
Groups were run in bounded sessions: bulk pagination exhausted a normal request window before one
fault check, and the earlier regression fixture stopped before booking creation. Those remaining
groups passed after the request window/fresh fixture, without changing application limits. The
project script now waits one request window between bulk setup and fault injection. The task-owned
local servers were stopped after validation and their throwaway databases disposed.

CI exposed an existing reminder-test race: it asserted two independent waits after observing only
the first. The test now waits for both; its original assertions remain and production workflow code
is unchanged. [Populated screenshots and design scope](../validation/project-overview-2026-09-25/README.md)
record comparisons at 360/390/430 and 1440 pixels. Claude implemented the API/test fix, root reviewed
them, and Claude approved the UI and final proof.

Hosted browser checks passed for signed-out Work/project/series and project-detail/schedule routes,
Google sign-in entry, phone/desktop layout and absence of browser exceptions. An authenticated
hosted session and full Google round trip were not exercised. Remaining search/filter presentation,
task-history ordering and contextual Chat/Files stay in [#142](https://github.com/SomedaySomehowBeer/askthecaptain/issues/142);
this is not complete native-device, screen-reader or mockup acceptance.

## Task and Work-list design release (25 September 2026, UTC)

Workspace outcome: **manage shared work**. [#145](https://github.com/SomedaySomehowBeer/askthecaptain/pull/145)
merged as `77a1f022096cb59e3b3933b161e4ffa92cc767fe` after reciprocal Claude/root review
and green [CI](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36142422926)
(2m54s). Reviewed image source `ba393bdf1e2339f6ea28ed30212849ac140cf963` has the same
Git tree as the merge. Task details now have compact metadata, checklist-first layout and a primary
complete/reopen action. Work/project/series lists have revision-aware completion controls;
Work groups the loaded page by due date and links Tasks/Projects.

By **13:47Z**, only existing web machine `9185776e7cd3d8` was updated to
`registry.fly.io/askthecaptain-web-staging:git-ba393bd` (digest
`sha256:db0217e03f66ea98e370d6737622082a2e02807fa308ef926a72b5f99c70f5d8`). The before/after
configuration comparison showed only its image changed. Its normal Next.js command, autostart,
idle-stop and zero minimum-running setting remain intact. Exactly one web and one API staging
machine remain; API `80e39ea6416e18` retains image `git-806f507215017f11c9e885e5ef680e54fb0dee6e`
and unchanged configuration. No migrations, resets, customer-record writes, secret changes,
production/embedding updates or additional application machines were part of this release.

Validation: production build/typecheck and the web unit suite passed. All 23 local browser groups
passed against a real API and disposable Postgres: ten workspace, seven Work-record, three
checklist/navigation and three design groups. The three design groups passed again on the final
image source, including the completed-task due-date tooltip, required-evidence refusal and
keyboard focus after list removal/regrouping. Populated screens were checked at 360/390/430 and
1440 pixels; [screenshots and scope](../validation/work-design-2026-09-25/README.md) are recorded.
The task-owned local web server and fixture were stopped; the fixture removed its temporary database.

A real browser checked hosted signed-out Work/project/series routes and Google sign-in entry at
phone/desktop widths without overflow or browser exceptions. An authenticated hosted session and
Google round trip were not exercised. The demo remains available without a reset. Project overview,
full search/filter presentation and contextual features remain in [#142](https://github.com/SomedaySomehowBeer/askthecaptain/issues/142);
this increment does not claim full mockup, native-device or screen-reader acceptance.

## Checklist and parent-navigation web release (25 September 2026, UTC)

Workspace outcome: **manage shared work**. [#143](https://github.com/SomedaySomehowBeer/askthecaptain/pull/143)
merged as `7bbdc10d17c1fbae39d0c029c6f075c211e3c25e` after Claude's independent final review
and green [CI](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36136161548)
(3m10s). The clean source commit `08a6145` has the same tree as the merge.

At approximately **12:44Z**, only existing web machine `9185776e7cd3d8` was updated, to
`registry.fly.io/askthecaptain-web-staging:git-08a6145` (digest
`sha256:9876d71b3d3cf6029ebf93eaf3a06fd571375414c44edd8f2e05bcf40fd2ac6d`). Its normal
`pnpm --dir apps/web exec next start` command, autostart and idle-stop configuration were retained.
The live inventory still contains exactly one web and one API staging machine. API image
`git-806f507215017f11c9e885e5ef680e54fb0dee6e` is unchanged. No migration, reset, record mutation,
production update, secret change or new application machine was part of this release.
The previously created demo project and resource records remain intact.

All ten local browser groups passed against a production web build, real API and disposable
Postgres: three focused checklist/navigation groups plus seven existing Work-record groups.
Checks covered persistent checkbox completion/reopen, parent hierarchy including recurring work,
stale and uncertain writes, phone/desktop layouts, editing, archive/restore and equipment links.
The local fixture was stopped and its throwaway database removed afterward. Broader visual
parity is explicitly unfinished and tracked in [#142](https://github.com/SomedaySomehowBeer/askthecaptain/issues/142).

## Work record release (25 September 2026, UTC)

Workspace outcomes: **manage shared work** and **allocate resources**. [#138](https://github.com/SomedaySomehowBeer/askthecaptain/pull/138)
merged at **07:01:55Z** as `f6b45cfa1af6094b01859c5d27e53d42f67a890a`, after reciprocal
Claude/root review and a green [final CI run](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36105328447)
(2m56s). Both images were built from clean reviewed head `806f507215017f11c9e885e5ef680e54fb0dee6e`;
its Git tree equals the merge. CI's raw concurrent-insert test was corrected to verify an exclusion
conflict after retrying a PostgreSQL deadlock loser; production booking code was unchanged by that fix.

The existing API/web machines had autostart disabled and were stopped. The sole API machine ran
migration/queue installation with restart policy `no`. At **07:04:47Z**, only
`0039_work_revisions.sql` was applied. At **07:04:48Z**, the queue installer and
`WORK_RECORDS_MIGRATION_READY` marker completed and the process exited **0**. Release commands performed no old-content reset,
provider request or record purge. Existing records received initial revisions and occurrence evidence
requirements; no database rollback or downgrade was attempted.

The normal API and web commands were then restored explicitly, with autostart on and idle-stop
behaviour unchanged. Verified machine inventory:

- API staging: only `80e39ea6416e18`, image `git-806f507215017f11c9e885e5ef680e54fb0dee6e`,
  command `node dist/index.js`.
- Web staging: only `9185776e7cd3d8`, the same image-source suffix, command
  `pnpm --dir apps/web exec next start`.
- Embedding: only `82d1dd0b021908`, still stopped with autostart off and its previous image.
- The two pre-existing production API machines and two production web machines remain stopped
  with autostart off, unchanged. No application machine was created.

After release, API `/readyz` returned `200 {"ok":true}` and Google identity entry returned 302 to
`accounts.google.com`. A real browser verified signed-out Work/project/recurrence routes reach a
working sign-in page at phone and desktop widths, with no browser exceptions. No hosted identity
or customer records were used to bypass sign-in; an interactive Google round trip was not tested.
Validation included 279 passing repository tests and 22 passing local browser groups,
including task/checklist/evidence changes, stale/uncertain saves, selector pagination, project and
recurrence controls, booking conflicts, DST, and old-link redirects.

Migration 0039 is additive and stays applied. Prefer a reviewed forward fix for release problems;
older application images lack the new revision and copied-evidence contracts. Do not reset the
workspace or remove columns as an automatic rollback. Production deployment and backup workflows
remain disabled.

## Workspace cleanup release and legacy reset (25 September 2026, UTC)

Workspace outcome: remove the personal-assistant runtime and mandatory Obligations container;
allow shared tasks and recurring work without a project. #135 merged as `aa09691a2ce2bf11919f4788f37be30f16401519`;
#136 merged as `d11fcdfcedc0b3840b7e9634d60181b6c475fb5c` after independent Claude/root reviews and
a green final CI pass (2m53s). Both deployed images were built from clean reviewed head
`7b77ba9782e23a6cee9f2d52d861804f9e4c257e`, whose Git tree equals that merge.

The owner explicitly authorised deleting tasks, emails and other data from the old Captain.
The reviewed [reset contract](../plans/optional-work-projects-2026-09.md) governs the separate
operational command; it is never an automatic migration or startup operation.

The old API and web were stopped with autostart off. The existing API machine ran the new image's
read-only reset preview at **05:22:53Z**, with restart policy `no`. It found 82 tasks, one generated
Obligations project, 660 mail messages in 502 threads, 266 attachment metadata rows, 2 drafts,
12 events in 3 calendars, 236 contacts, 138 companies, 5 project candidates and 5 candidate-source
rows, 12 runs and 1,942 run steps, 24,594 old application audit rows, 15 queue jobs and one schedule.
The mail/audit counts had advanced since the earlier inventory while the old API was still allowed
to wake. The final preview, not the earlier count, was used for apply.

At **05:23:52Z**, the reset transaction verified the same locked manifest and completed. Its digest
was `30d7b01905e749acc8b3a7d41bdd3a389d95cdae95158340e2be989bbef19b4a`.
All targeted content tables were verified empty inside that transaction. Old mail/calendar copies,
tasks, drafts, all contacts and companies (236/138), discovery data, workflow history, local Google
mail/calendar credentials, sync state and application audit payloads were deleted. The reset
wrote one new audit entry containing counts and authorisation, without old source contents.

Identity sign-in, the organisation and membership, four existing session rows (none used for these checks), inference runtime
configuration, the budget and 78 model-usage records remain. Run links on those usage records
became null; costs/tokens and consumed budget were not reset. No Gmail/calendar/provider request,
remote deletion or OAuth revocation occurred. This is a reset of the live application database,
not a purge of provider originals, backup/PITR history, service logs or the inference Sprite's disk.

Migrations **0037** and **0038** applied at **05:23:52Z**, then queue installation succeeded and
`CAPTAIN_RESET_CUTOVER_COMPLETE` appeared at **05:23:53Z**. The normal API command was restored
and the matching web image was deployed via updates of the existing machines. No release VM,
standby machine or additional application machine was created.

| App | Sole machine | Released state |
|---|---|---|
| `askthecaptain-api-staging` | `80e39ea6416e18` | `git-7b77ba9782e23a6cee9f2d52d861804f9e4c257e`, normal `node dist/index.js`, autostart on, idle stop/minimum zero |
| `askthecaptain-web-staging` | `9185776e7cd3d8` | same Git tag in its web registry, normal Next start, autostart on, idle stop/minimum zero |
| `askthecaptain-embed` | `82d1dd0b021908` | previous image retained, stopped with autostart off; its mail/note consumers are gone |

Validation: 266 workspace tests passed locally against PostgreSQL 18. The reset suite then grew
from two tests to three and passed separately; final CI passed all **267 tests** (55 DB, 124 API,
19 engine, 29 web, 17 connectors, 11 model, 7 retrieval, 5 steps). Typecheck and the production web
build passed. The final Chrome regression covered standalone create/tag/filter/complete, recurring
materialisation, unique form labels, booking a standalone task, moving the task and rejecting a
stale booking edit. Phone/desktop forms had no overflow or browser exceptions. A browser-discovered
old save-action project requirement was fixed and independently reviewed before the final pass.

Hosted checks passed: API `/readyz` returned 200 with `{"ok":true}`, signed-out `/work` returned
307 to sign-in, Google sign-in initiation returned 302, and Chrome rendered sign-in at 390px/1440px
without overflow or exceptions. No hosted session was used for task/booking writes and no test
records were added to the customer's database. Existing identity rows plus local reset tests are
not a claim of a completed hosted Google OAuth round trip.

Final machine inspection confirmed one API, one web and one stopped embedding machine. All four
production machines stayed stopped with autostart off; their images were unchanged. GitHub deploy
and backup workflows remain disabled. No production deployment, DNS, secret or infrastructure apply
occurred. **Do not roll back to the old assistant images:** the reset is destructive and 0038 drops
`system_kind`. Use a forward fix or hold the staging API stopped. No data restore was performed.

The next cleanup replaces the temporary Commitments detail/overview handoffs with bounded Work
routes and revision-aware writes (#133 step 5 / #131). Empty retired schema/modules still need
removal. This release does not claim that those remaining code paths have been retired.

## Legacy-data inventory (25 September 2026, UTC)

Before the optional-project cleanup, the sole staging API machine ran a temporary read-only count
command using its existing image and migration-owner connection, with autostart off and restart
policy `no`. No old workers ran during the check. The first targeted count completed at 04:51:51Z;
the full table count at 05:01:58Z. One full-count attempt failed on identifier quoting before any
write; it was corrected and repeated. No database content or credentials were printed.

The counts and the owner's subsequent authorisation to delete old-version Captain data are in the
[reset contract](../plans/optional-work-projects-2026-09.md). No database reset or new code deployment
is claimed by this inventory entry. After inspection, the machine was verified stopped with its
original image, original service/restart settings and explicit normal command `node dist/index.js`.
Fly merges an empty `init` object, so restoring `{}` did not clear the temporary command; setting
that normal command explicitly did. One API machine remained throughout. Production was untouched.

## Session recovery release (25 September 2026, UTC)

Job: **own commitments**. Reviewed #130 passed full CI and merged as
`3fb10954da8d4e3c001f7565aa5230f95e182891`. The web image was built from clean reviewed PR head
`f87098b8fb6f9a6a45210db46f8409d0c68fcd17`, verified to have the same Git tree as that merge.
Only the existing staging web machine `9185776e7cd3d8` was deployed, using
`registry.fly.io/askthecaptain-web-staging:git-f87098b8fb6f9a6a45210db46f8409d0c68fcd17`
and `--ha=false --strategy immediate --update-only`. No migration or API/embedding deployment
was needed. The API still uses `git-dc32eeae888b75390388c7112449d1517f61d53f`.

Live API readiness, signed-out protected-route redirects, the rendered retry page on phone and
desktop, and normal sign-in after Try again passed. Hosted failures were not injected and no
customer records were changed. The real-Postgres local proof covers rate limits, server failures,
dropped connections and write recovery; all four groups and 25 web tests passed.

Machine lists confirmed one web, one API and one embedding machine, with autostart enabled.
All four production machines remain stopped with autostart off. GitHub deploy and backup workflows
remain disabled. Rollback is web-only to `git-dc32eeae888b75390388c7112449d1517f61d53f` on the same
machine with the same rollout flags; no schema rollback is involved.

## Equipment release (24 September 2026, UTC)

Jobs: **keep the calendar** and **own commitments**. Reviewed #127 passed the full CI check and
was squash-merged as `5986b93ba34a6c15f8c39feba9b342613e19ac79`. API and web images were built
from a clean archive of reviewed PR head `dc32eeae888b75390388c7112449d1517f61d53f`; its Git tree
was verified identical to the squash merge before deployment. Both apps now use
`registry.fly.io/<app>:git-dc32eeae888b75390388c7112449d1517f61d53f`.

The existing sole API machine `80e39ea6416e18` was stopped with autostart off, updated to the
image with restart policy `no`, and started with the one-shot migration/queue-install command.
Migration `0036_equipment_reservations.sql` applied at **14:35:54Z**; the completion marker and
normal exit **0** followed at **14:35:55Z**. This adds equipment/reservations and the `btree_gist`
extension; it does not rewrite existing work. No temporary release machine was created. Existing
backup recovery coverage remains unverified; no new backup or Neon recovery branch was created.

API deployment used `--skip-release-command --ha=false --strategy immediate --update-only`
after that confirmed migration. Web used the same single-machine deployment flags on
`9185776e7cd3d8`. Both finished with normal empty command overrides, `on-failure` restart,
autostart enabled, idle stop and minimum zero. Embedding machine `82d1dd0b021908` was unchanged.
Machine lists confirmed exactly one machine in each staging/embedding app; all four dormant
production machines stayed stopped with autostart off. Deploy and backup workflows remain disabled.

Live checks passed: API readiness, embedding health, signed-out redirects for the new equipment
routes, and the rendered Google sign-in action on phone and desktop with no overflow or browser
exceptions. There was no existing hosted session, so authenticated hosted booking writes were
not tested and no fixture records were added to customer data. All five equipment browser groups
passed locally against real Postgres and the production web build; see the
[validation record](../plans/workspace-web-validation-2026-09.md).

Open **Resources → Equipment schedule** (or `/resources/equipment`) to add equipment and create,
edit or cancel reservations. Continuous hours/days/weeks views include maintenance and buffers.
This is the web increment; native-device gesture acceptance and the rest of the first-customer
workflow remain open. Chat and the file library are still unavailable. Temporary API failures
being treated as sign-out are tracked in [#126](https://github.com/SomedaySomehowBeer/askthecaptain/issues/126).

Rollback uses the preceding `git-2c63030efd832f3d2ab87ada2a96907fee65d875` API/web images with the
same single-machine flags, rolling back both apps together. Migration 0036 is additive; retain its tables and any reservations if
rolling back code. The older UI will not expose equipment records until the new image is restored.

## Actual resumption (24 September 2026, UTC)

Job: **own commitments**. Make the reviewed Work, task creation, filters and shared tag controls
available to the first customer. At this initial resumption, chat, equipment scheduling and the file
library were not delivered; the later equipment release is recorded above.

| App | Existing machine | Result |
|---|---|---|
| `askthecaptain-api-staging` | `80e39ea6416e18` | new image, autostart on, stop when idle, minimum zero |
| `askthecaptain-web-staging` | `9185776e7cd3d8` | new image, autostart on, stop when idle, minimum zero |
| `askthecaptain-embed` | `82d1dd0b021908` | existing image unchanged, autostart restored, stop when idle |

Both new image tags are `git-2c63030efd832f3d2ab87ada2a96907fee65d875` in their respective
`registry.fly.io/<app>` repositories. Previous staging images, and the unchanged embedding image,
are tagged `git-ad43f401f97fd2f2327e327af2a6c0f2afdebab6`.

Images were built with Depot and pushed without deploying. To avoid a second temporary release
machine, the existing stopped API machine was updated to the new image with autostart off,
restart policy `no`, and a one-shot command running `packages/db/src/migrate.ts`, then
`packages/engine/src/install.ts`. It was explicitly started. Migration `0035_task_tags.sql`
applied at **10:51:53Z**, `CAPTAIN_MIGRATION_COMPLETE` appeared at **10:51:54Z**, and the process
exited **0**. Only this additive migration was pending. No new backup or Neon recovery branch
was created; existing backup recovery coverage remains unverified.

API and web deployments then used their staging configs and the built images with
`--ha=false --strategy immediate --update-only`; API also used `--skip-release-command`, because
the migration and queue installer had already succeeded. The API's command override was cleared
and restart policy restored to `on-failure`. No additional app machines were created.

The API started normally at **10:53:06Z**. `/readyz` returned HTTP 200 with `{"ok":true}`;
the embedding `/healthz` returned its healthy encoder/version/dimensions response.
Web Push is not configured in this environment, as reported by API startup; notifications that
require it remain unavailable. Existing schedules only run while the API is awake, including
catch-up after an idle period. A successful readiness check does not establish provider sync or
inference completion. Better Stack's live monitor state was not inspected or changed.

Live Chrome checks at 390×844 and 1280×900 confirmed `/work` redirects signed-out visitors to
the rendered sign-in page, with the Google action present, no failed notice, no horizontal
overflow and no browser errors. Sign-in initiation returned a redirect to `accounts.google.com`.
There was no existing hosted browser session, so authenticated hosted checks were not run and
no test records were added to the customer's database. The task/tag write flows were previously
checked against isolated real Postgres in #122/#123; that is not hosted-session evidence.

Production's two API and two web machines remain stopped with autostart off. Their counts and
images were not changed. No production deployment, DNS, secret or infrastructure apply occurred.
GitHub deploy and backup workflows remain disabled. Future code merges do not deploy themselves.

For rollback, redeploy the previous staging images with the same single-machine flags. Migration
0035 is additive and compatible with those images; do not drop the new tables to roll back code.
Future API releases must run migrations and the queue installer on the sole machine before
skipping the release command; never skip those operations merely to avoid the extra machine.

## Original pause: what was stopped (23 September)

| What | State | How it was stopped |
|---|---|---|
| `askthecaptain-api-staging` (1 machine) | stopped, autostart off | `flyctl machine update <id> --autostart=false --skip-start` then `flyctl machine stop` |
| `askthecaptain-web-staging` (1 machine) | stopped, autostart off | same |
| `askthecaptain-api` (production, 2 machines) | stopped, autostart off | same |
| `askthecaptain-web` (production, 2 machines) | stopped, autostart off | same |
| `askthecaptain-embed` (1 machine) | stopped, autostart off | same |
| `deploy` workflow | disabled | `gh workflow disable deploy.yml` |
| `backup` workflow (nightly 00:30 Perth) | disabled | `gh workflow disable backup.yml` |

**Why autostart had to go.** Every app scales to zero (`auto_stop_machines`, `min_machines_running
= 0`), so a stopped machine was never really off: Fly's proxy starts one for any incoming request
(the phone app, webhooks, crawlers). On the morning of 2026-09-23 the staging pair was being woken
every few minutes. With autostart off, requests to `app.askthecaptain.app` and
`api-staging.askthecaptain.app` time out instead of starting a machine.

**Why the deploy workflow had to go.** Any push to `main` touching `apps/`, `packages/` or `infra/`
deployed staging and started it again, and a deploy re-applies autostart from `fly.toml`.

**The backup workflow.** It never touched Fly, but it woke Neon every night. It had also been
failing since 2026-09-21 (`pg_dump: error: aborting because of server version mismatch`: the job's
`pg_dump` is older than the Neon server), so the newest good dump in `backups/` predates that. Fix
the client selection before re-enabling it. [#120](https://github.com/SomedaySomehowBeer/askthecaptain/pull/120)
prepares explicit PostgreSQL 18 executable paths and a pgvector-capable restore image; the changes
passed a disposable local restore. They do not resume backups or establish a fresh hosted backup.

## Original pause: what still ran or could be reached

- **CI and tofu workflows** stay enabled: they run on pull requests and pushes and deploy nothing
  to Fly (`tofu` applies only on changes under `infra/tofu/`).
- **Neon** scales to zero on its own; nothing on a schedule reaches it now.
- **The inference Sprite** (`captain-01a0a335-…`, org `somedaysomehowbeer`) was not touched. It
  sleeps when idle, and the only caller, the API, is stopped.
- **The Better Stack uptime monitor** is configured in `infra/tofu/uptime.tf` to request
  `https://api-staging.askthecaptain.app/readyz` every 30 minutes, with email and push alerts.
  Its live state was not checked in the 24 September documentation audit. If still enabled, it
  will see the stopped API as unavailable; with autostart disabled it cannot wake that machine.
  Check whether it also needs pausing as an owner operation; resume it with the apps.
- **Inbound deliveries** to the stopped API fail: configured Gmail push via Pub/Sub
  ([gmail-push.md](gmail-push.md)) retries according to its subscription policy. Nango is not a
  Captain connector under D8; investigate any old external sender separately. Mail catch-up uses
  the provider cursor, with full sync if history expired. Reconcile provider state on resume rather
  than assuming missed webhooks guarantee no data loss.
- **The in-app schedulers** (five-minute mail poll, morning brief, triage) live in the API process
  and do not run while it is stopped.

## Original resume procedure (superseded for staging)

Historical instructions follow. For the current staging scope, use the single-machine procedure
above and leave GitHub deployment/backup workflows disabled. Production resumption still belongs
to the owner.

1. Owner only: review the resume and backup repairs, then `gh workflow enable deploy.yml` and,
   once the backup tooling/restore checks pass, `gh workflow enable backup.yml`.
2. Turn autostart back on, either by deploying (Actions → deploy → Run workflow; a deploy applies
   `fly.toml` again) or per machine:
   ```bash
   for a in askthecaptain-api-staging askthecaptain-web-staging askthecaptain-embed; do
     for m in $(flyctl machines list -a $a --json | jq -r '.[].id'); do
       flyctl machine update $m -a $a --autostart=true --yes
     done
   done
   ```
   Production (`askthecaptain-api`, `askthecaptain-web`) has not been promoted since 2026-09-05;
   leave it off unless it is being promoted.
3. Unpause the Better Stack monitor if it was paused.
4. Check: `curl https://api-staging.askthecaptain.app/healthz`, then sign in on the phone and let the
   mail poll catch up.
