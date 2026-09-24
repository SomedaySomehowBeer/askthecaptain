# Proposal: Ask The Captain for the business, Pip for the person

**Status:** draft for review, 22 September 2026. Captures the product direction discussed with
the owner; no implementation, migration, deployment or replacement of the current plan's
decisions is authorised by this document. The live [plan](../plan.md) remains authoritative.

> **Update, 24 September 2026.** Merged as #114, then adopted with amendments by #116 into the plan
> (D1, D7, D8, D11, D14, D23, and the new D24 equipment and D25 chat). The plan and the
> [delivery plan](../plans/captain-workspace-delivery-2026-09.md) are authoritative where they
> differ from this text, which is kept unchanged as the record of the discussion. Its "must be
> amended before implementation" conditions (chat, tabs, design authority) are met by #116; none of
> the workspace is implemented yet. Pip's implementation is tracked in issue [#119](https://github.com/SomedaySomehowBeer/askthecaptain/issues/119): the agreed
> personal requirements (§§5–8), the native Apple model and Siri gates, no mail retention (§6) and
> the optional phone experiment (§7).

**Jobs advanced:** own commitments; brief and answer. The split also relocates inbox triage,
correspondence and personal calendar assistance, while retaining business chasing workflows.

## 1. Why split

Using Captain has exchanged one kind of complexity for another. A shared record of the
business's work and a personal assistant have different responsibilities, permissions and
expectations. Separate them into two products:

- **Ask The Captain:** the small business project management system. Where the team records
  projects, tasks, recurring obligations, ownership, progress and supporting evidence.
- **Pip:** the working name for a personal assistant on Apple devices. Helps a person with
  email, calendar, personal tasks, finding information and deciding what deserves attention.
  Captain is one of the apps it connects to.

The test is less work for the person: no duplicate task lists, competing project states or
requirement to check two apps to learn whether an action succeeded. Captain must be useful
without Pip. Initial integration effort assumes they are used together, without adding
alternative ingestion systems just to make every assistant action equally easy without Pip.

This is a product boundary first. Repository layout, deployment separation and the native
application stack need a subsequent implementation decision. The
[delivery plan](../plans/captain-workspace-delivery-2026-09.md) now sequences that decision,
a bounded client proof and the first usable release. Expo mobile plus the existing Next.js web
app is the working recommendation, subject to the proof; this proposal does not adopt it.

## 2. Ownership

| Information or behaviour | Proposed authority |
|---|---|
| Shared projects, tasks, recurring duties, owners and progress | Captain |
| Personal tasks, including private work-related reminders | Apple Reminders |
| Personal preferences, assistant context and deferred catch-ups | Pip |
| Original email, sent mail and accepted reply drafts | Email provider |
| Calendar events | Calendar provider |
| Invoices, payments and accounting | Xero |
| Project links to correspondence, invoices and other evidence | Captain |
| Personal attachment search index | Pip, synced within the person's iCloud account |
| Scheduled shared business workflows and their inference | Captain's server runtime |
| Personal interpretation and assistance | Pip's device runtime, using supported Apple models |

Pip can show personal and assigned business tasks together, with the source visible. Edits and
completion go to that source. It must not automatically copy Captain tasks into Reminders or
maintain a second project state. A work-related thought is not automatically a shared business
commitment: “consider attending the conference” may be personal; “submit the brewery's excise
return” belongs to Captain. Ambiguous destinations need a person to choose.

Xero remains accounting authority. Captain links a project to relevant customers and invoices
and presents provider-backed status. Pip can use that context to explain priorities or prepare
a chaser. This does not introduce accounting, a complete email client or a configurable domain
model into Captain. Existing stock/Shopify capabilities require an explicit scope decision
before any removal or reassignment.

### Captain's workspace and required equipment scheduling

Captain has one shared set of work, selected by tags, project and person. Production,
Marketing, Sales and Admin/reporting are **tags**, not separate areas or workspaces. A task
has an accountable owner, zero or more tags and an optional project. Projects and people can
span any tags; recurring and standalone work need no artificial project. Tags do not create
permission boundaries or duplicate records. For example, distributor samples can carry both
Production and Sales tags while remaining one task.

**Equipment scheduling is a hard requirement.** Captain must represent named equipment,
availability and dated reservations linked to tasks/projects and responsible people. The
same reservations appear in the Production schedule, project schedule and relevant personal
work views. Include equipment unavailable for maintenance/cleaning, time needed between uses,
and the organisation's timezone. For exclusive equipment, overlapping confirmed reservations
must be prevented, including concurrent booking attempts; a conflicting request stays visibly
unconfirmed until resolved. Changes/cancellations update the same reservation everywhere and
make affected work visible. Do not automatically move other people's bookings to make space.
The resource timeline is a core planning surface, not an optional report. It defaults to a
multi-day span with equipment columns across the top and time running down the page. Horizontal
swiping exposes more equipment; arrows flank the equipment header controls and a partially
visible next column signals overflow. Equipment headers stay visible while time scrolls, and
the time axis stays visible while equipment scrolls.

Pinch apart to see finer time detail (hours); pinch together to see days, weeks and eventually
longer planning periods. Explicit Hours/Days/Weeks controls provide the same choices without a
gesture. Zoom keeps the date under the gesture midpoint in place, subject to the loaded range
boundaries; it never changes bookings. Preserve the equipment position and selected reservation.
Hours, days and weeks all use the same continuous booking bars, positioned and sized by their
actual start/end times. A reservation spanning days remains one bar across the date lines. Short
reservations become thin marks as you zoom out; labels appear when space permits and exact
intervals remain accessible by selecting the bar or zooming in. Conflict markers focus the relevant
equipment and date. Exact start/end times, setup/cleaning/maintenance and unconfirmed requests
remain inspectable at every scale. Unknown or unloaded periods must never look available.

The first implementation requires availability and rescheduling controls with overlap prevention
under concurrent saves. Resource allocation must work for long reservations spanning days as
well as short reservations; a zoomed-out view cannot conceal a conflict. Show actual duration
and timezone in detail, keep selection stable when zooming and test daylight/date boundaries.
The mockup demonstrates five equipment columns and a bounded 28-day fictional dataset, with
Day as the initial scale; larger equipment sets, range loading, native gestures and live edits
still need implementation and device testing.
This introduces a fixed equipment/reservation model, not custom production processes, recipes,
stock conversions or an inventory ledger; the data model and services need a reviewed amendment.

The mobile navigation proposal has exactly three bottom tabs: **Work, Chat, Resources**.
There is no Home tab. Work opens at **My work**, the working-day view filtered by **Assigned
to you**, with all tags included and open tasks. The same Work section supports all tasks,
projects and saved filter combinations. Filters include assignee, tags, project, status and
date; List, Board, Calendar and Timeline change the presentation rather than the records.
Different filter types combine with AND; multiple selected tags match any selected tag by
default. Active filters must stay visible. Opening a project shows the whole project unless
a project-local filter is explicitly applied.

Each section has a **grouped list of views one page to the left of its selected main view**.
This is a navigation page, not another bottom tab or an extra dashboard. It needs no visible
page title: group headings, row labels and the selected tab provide context; an accessible
heading still identifies the page. A back chevron from the main view returns to this list;
the intended native interaction also supports the usual back gesture. Selecting an entry
opens it to the right. Deeper records return to the originating context. Switching tabs should
preserve each section's selected view and position; My work is Work's first-use default and
an explicit entry to return to later.

| Section | Grouped view list | Initial main view |
|---|---|---|
| Work | For you: My work, Upcoming. Across the business: All tasks, Projects. Saved views: Production, Marketing, Sales, Admin/reporting tag filters. | My work, assigned to you. |
| Chat | Inbox: All conversations, Unread, Starred. Projects: linked discussions. Team: team conversations. | All conversations. |
| Resources | Libraries: Files & assets, Inventory. Planning: Equipment schedule. Business: People, Reports. | Files & assets in the mockup; review this default before implementation. |

Marketing and Production are saved Work views, with their tag filters visible, and can offer
shortcuts to related resources. The shared Files & assets library holds the DAM direction
previously explored through Embrace; it lives under Resources and is available throughout the
business. Projects bring together work, schedules, files and discussion. Provider-held originals,
previews, version review and preservation follow the files-in-place proposal. Equipment
availability must show competing reservations, cleaning and maintenance even when a work view
is narrowed to one person, project or tag. A filtered task list must never imply occupied
equipment is free.

The bottom bar follows the supplied Taildrop reference: a floating rounded capsule inset from
the screen edges, sized to about 80% of the initial capsule by reducing spacing more than
icons or text. The selected pill uses the previous grey-green (`#d9ded6`) at 50% opacity over
the bar, placing it exactly halfway toward the visible bar background; icon and label stay green. Rounded briefcase,
conversation and folder icons identify Work, Chat and Resources, using Captain's forest/paper/
mint palette. Labels remain visible, tap targets are at least 44 CSS pixels, and content has
bottom space so the bar does not cover the last item. The compact header keeps the breadcrumb,
search and avatar, without a logo or wordmark. Search and account/settings remain header
controls, not additional tabs.

**The green plus performs the primary creation action for its current view.** It opens a
small editor with clear fields; it does not immediately write or infer an action. Show it on
collection, planning, project and grouped view-list pages. Individual tasks, individual files/
versions and individual conversations omit the green creation plus: they expose specific record
actions and, where appropriate, a chat composer. Settings, search-only results, read-only reports,
permission-restricted pages and editors are further exceptions when no meaningful creation action
exists. Consistency means a predictable action, not a decorative plus on every screen.

| Current view | Plus action | Starting context |
|---|---|---|
| Work view list | Choose New task or New project | No hidden selection; the sheet names each action. |
| Resources view list | Choose Link file, Reserve equipment or Record count | There is no generic resource record. |
| Chat view list | New conversation | Choose participants and an optional work link. |
| My work | New task | Owner: you; title, due date, project and tags editable. |
| All tasks / saved tag view | New task | Apply an unambiguous tag/project/owner filter as an editable suggestion; choose an owner when none is selected. Do not copy status/date filters blindly. |
| Projects list / project detail | New project / new task | The view determines the record type; project detail starts a task linked to that project. Editors remain previews. |
| Chat | New conversation | Choose participants and an optional task/project link. |
| Files & assets | Link file | Choose a provider-held file and collection; no attachment-byte upload into Captain. |
| Inventory | Record count | Select an existing material, quantity and observation time. Adding an item is a separate explicit action; provider-owned stock cannot be overwritten. |
| Equipment timeline | Reserve equipment | Equipment, start/end, responsible person, optional task/project and turnaround; current selection supplies editable defaults. Recheck all conflicts on save. |

Use an accessible action label even when the visible control is only a plus. If filters do
not imply one clear default, let the person choose. Saving a record that falls outside the
current filter should link to the created record and explain why it is not in the list.
The prototype opens descriptive editor previews; it does not save records.

Team chat is now proposed scope: team conversations and project/task discussions with
bidirectional links. A message can link a task or project; that record links back to the same
conversation. Creating a task from a message retains that source link. Do not duplicate threads
between Chat and project pages or treat activity logs as conversation. A link must not expose
private conversation content to someone lacking access. The current plan's exclusion of chat
must be explicitly amended before implementation.

**Item discussion is chat, not a separate comments system.** Tasks, projects and file/version
pages show a summary, shared pinned messages, then the latest **six** messages from the linked
conversation in chronological order, with an inline composer and an Open chat link. Show fewer
than six when fewer exist; show a count and a route to the full history when older messages are
omitted. Pins are additional to this six-message window, so an older important message stays
present on the item. These are references to the same message IDs and conversation shown in
Chat; replies from the item must join that conversation rather than create a parallel thread.
For items with several linked discussions, retain each discussion's identity and summary rather
than mixing messages into one unlabelled stream. The mockup shows one selected linked chat.

**Pins are shared with everyone who can access the conversation.** They are not personal stars.
Participants with chat-write permission can pin or unpin; these ordinary writes are role checked
and audited. Pinning keeps a message in a persistent section above recent messages on the item
and in full chat, even after it leaves the recent window. “Always visible” means always included
in that section, not a floating overlay that covers the conversation as the page scrolls. Pins
reference the original message and link to it. Edits update the same content, deletion removes
or tombstones the reference, and access changes remove inaccessible pins immediately. A pin
never grants access or broadens the conversation's audience. Unpinning leaves the message intact.

**Full chat follows the supplied Slack screenshot's layout:** one left-aligned message stream,
compact avatars, sender names and timestamps, date separators, reaction chips, thread-reply links,
a record backlink and a compact composer with file/record links, formatting, mentions and emoji.
Own messages use the same alignment as everyone else's.
Alternating message rows have a subtle white tint (35%), starting with the first row in each
full or inline chat list. Keep Captain's palette, type and three
tabs. The mockup's reaction, reply, pin and send controls describe intended actions without
saving anything; typing in a composer is only local preview state. Detailed reply-thread design
and implementation remain follow-up work.

File review messages replace the old comments section and retain a reference to the file version
being discussed. Opening artwork v3 from a task or from Files reaches that same version-scoped
chat. Messages and pins must not silently move to v4; switching versions selects the corresponding
context. Version history remains an audit of changes, separate from conversational messages.
A message, pin or reaction does not approve a version, complete a task or confirm equipment.

**Conversation summaries appear wherever content links to a discussion**: Chat rows,
project/task/file chat panels, personal-work previews and discussion entries in view lists.
A generic Chat tab or navigation label does not need a summary. Use a short account of the
current decision, unresolved question and next action, not just the last message. Show a
“Summary · Through [message time]” label and open the source conversation on selection.
The same summary/version is reused across views; it does not create a second conversation.

Summaries are proposed server-side, data-only `infer` steps (D2), with validated output and
source message IDs/range. Access checks must cover both the conversation and every source
message represented; invalidate summaries after relevant deletion or access changes. New
messages make the summary visibly out of date until refreshed. A missing or failed summary
must say “Summary unavailable” or “Updating summary”, with access to the discussion; a latest
message excerpt may be shown only when labelled as an excerpt. Summary text cannot create a
task, commit a decision or confirm a reservation. The prototype contains hand-authored,
labelled illustrative summaries; no live inference or refresh is implemented.

**Starred conversations replaces Following.** People follow every conversation they participate
in by default. Starring is an individual bookmark for quick access, not membership, a shared
priority or a notification setting. Unstarring does not leave or mute a conversation; muting
and leaving are separate actions. Unread and Starred filter the same accessible conversations.
The prototype shows Starred and a Star conversation action; persistence remains to implement.

Inventory remains a simple counted list for ingredients, consumables and finished product,
with an explicit authority where a commerce provider supplies a quantity. Equipment reservations
do not imply automatic stock consumption. D15's ledger exclusion remains until separately
reviewed. Products, launch projects and individual production activities remain distinct.

[Mobile mockups and review notes](assets/captain-mobile-2026-09-22/README.md) include
fifteen screens: My work, All tasks, two saved tag views, project, equipment timeline, task,
Chat, conversation, inventory, files, asset detail and the three grouped view lists. Connected
paths and version-specific variants use fictional data. The editable HTML and PNG previews
propose a replacement for D11; no application routes or design-system mirror files change.
The accompanying [view map](assets/captain-mobile-2026-09-22/views.md) shows the three sections,
the lists to their left and links between views of the same records. Full native transitions,
per-tab state restoration and arbitrary filter editing remain implementation work.

## 3. Correspondence enters Captain through its API

Start with an authenticated operation to attach correspondence to a project or task. Pip uses
ordinary user-scoped Captain access, with role checks, tenant isolation and an audit trail.
It has no privileged agent identity and cannot write across projects the person cannot access.

The attachment should carry source account/message identifiers, sender/recipient metadata,
original date, subject, a source link where available, and the selected content deliberately
shared with the business. Record who shared it and whether Pip acted for them. Distinguish
original text from a generated summary. An activity entry such as “Pip attached Jane's email”
links to this inspectable correspondence; it is not the only record.

Use source-qualified identifiers and idempotency so retrying a request does not duplicate the
correspondence. A shared record cannot grant another member access to the original private
mailbox. Sharing an excerpt with Captain is a separate business record with Captain's access
and retention rules; it does not allow Pip to retain a private mailbox copy.

No inbound forwarding address, destination headers or mail parsing service in the first
version. Forwarding might be considered later if actual use warrants it. A manually added note
or source link is sufficient initially for someone using Captain alone.

Example: a customer accepts a quote by email. Pip suggests a project update and shares the
selected acceptance as evidence. Captain links the project to its Xero invoice. Later, a server
workflow can identify an overdue invoice; Pip can help the person prepare and review a reply.
Sending correspondence remains a person's action, not a workflow's autonomous external write.

## 4. Inference and execution

The new Siri AI experience and Apple inference are hard requirements for Pip. Target supported
Apple hardware, OS versions and languages rather than make memorised command phrases the
primary interaction for older systems. Siri's system-level interpretation and action routing
use App Intents; inference requested inside Pip uses the Foundation Models framework. These
are separate integrations: choosing the Apple model does not automatically expose Pip's
actions to Siri. [Apple Intelligence integration][apple-intelligence]

Pip is **device-run**, not necessarily offline-only. Apple inference may execute locally or,
where the app and device qualify, through Private Cloud Compute (PCC). Apple's documented
interface still requires a supported device to issue the request, and PCC has availability and
per-user quota constraints. No supported server-to-server PCC interface was established in
this review. Do not make Captain's unattended business jobs depend on it. [Apple PCC][pcc]

Captain runs scheduled business workflows and their inference on the server, using a provider
reachable from that runtime. This proposal does not choose a replacement for D9/D18's existing
Sprite provider. Ordinary task management remains deterministic; inference belongs only in
explicit typed steps, with schema validation, no tools, no writes and no credentials (D2).

Pip cannot start personal work when all its devices are powered off. A locked phone is different
from a powered-off phone, but background runtime remains scheduled by iOS. iCloud sync is not a
hosted workflow executor. A previously scheduled notification does not guarantee that inference
will run at its delivery time. [Background execution][background], [local notifications][local]

Business jobs can continue over already shared evidence and directly connected business
sources. If Pip is the only reader of a personal inbox, mail arriving while its devices are
unavailable will not become Captain evidence until Pip runs and shares it. Show source
freshness, missed coverage and pending work rather than claiming continuous monitoring.

## 5. Personal tasks in Reminders

Use Reminders as the personal task authority, initially with a Pip list or lists the person
selects. Pip can present its own task view and create or complete reminders through EventKit;
the person can still use Reminders directly. EventKit supports reminders, dates, recurrence and
alarms with permission. [EventKit][reminders]

Apple requests full Reminders access rather than per-list access; Pip must enforce selected
list scope itself. Handle denied/revoked permission without silently creating a replacement
task database. iCloud Reminders supplies its own synchronisation. Local EventKit identifiers
can change after a full sync, so cross-device references need a tested identity/reconciliation
strategy. [Permissions][event-access], [identifiers][event-id], [Reminders sync][reminder-sync]

Keep assistant preferences and pending suggestions separate from accepted tasks. Suggestions
remain visibly suggestions until accepted, and accepting one writes to the chosen authority.

## 6. Email assistance and attachment search without an archive

Pip fetches relevant email on demand for interpretation, draft replies and task suggestions.
Accepted reply drafts live with the email provider. It does not persist original email bodies,
attachment files or extracted attachment text in its application store, iCloud records, logs,
prompt histories or journals. Processing must be bounded and transient, with cleanup after
errors and cancellation as well as success. Extracted content is labelled untrusted input.

The agreed exception is a private, rebuildable search index, shared between the person's
devices through their iCloud account. It may retain source identifiers, agreed metadata
(including attachment name/type, subject, participants and date), embeddings, model/version
information and indexing progress. It must not turn into a hidden email archive through
retained snippets, full-text indexes, generated summaries or diagnostic payloads.

Search should support “the packaging specification I sent before we ordered cans” without
requiring a filename or recipient. Combine metadata filters and lexical matches over retained
metadata with semantic matches derived from surrounding correspondence and supported file
contents. Retrieve candidate originals to verify matches and display excerpts at search time.
Show source, date, why it matched and incomplete indexing coverage. Similarity is not evidence
of an exact file/version match. Unsupported or encrypted files get an explicit limitation.

The original remains with the provider and is fetched when opened. Gmail exposes both message
search and attachment retrieval. Offline results may show indexed metadata, but cannot pretend
the original file is available. Remove or invalidate entries when deletion/access loss is
observed, and provide clear-index/disconnect behaviour that propagates across devices without
an offline device resurrecting deleted entries. [Gmail search][gmail-search],
[attachment retrieval][gmail-attachment]

Evaluate a Pip-managed index with private CloudKit records and local vector search. CloudKit
can sync record changes, but storage cost, conflicts, indexing ownership, initial backfill,
device compatibility and embedding-model choice need measurement. Persist model/version and
dimensions so query vectors are never compared against an incompatible index. Do not assume
Apple's language model framework supplies exportable embeddings. [CloudKit][cloudkit]

Core Spotlight supports semantic search, but its indexes are device-local and do not sync
through iCloud. It is not the shared index requested here. Any optional Spotlight projection
would need a separate retention review. The synced index is sensitive email-derived data;
“private iCloud database” is not by itself a verified end-to-end encryption claim. Choose and
document the protection of the selected record fields before shipping. [Core Spotlight][spotlight]

## 7. Quiet working sessions and calls

The desired experience is “I can concentrate; Pip will surface what matters and save the rest
for a catch-up.” A user-configured Pip Focus can allow Pip's notifications and chosen contact
exceptions. Apple can activate Focus through app/time schedules or Siri; app Focus filters
adapt the app's own behaviour, rather than grant control of all system settings. Focus state
must not be presented as proof Pip is currently checking every source. [Focus][focus],
[activation][focus-schedule], [Focus filters][focus-api]

Pip's ordinary notification APIs concern its own notifications. The newer iOS 27 Shortcuts
Notification trigger offers a possible user-configured bridge from selected apps, filtered by
title, subtitle or message. This is documented trigger support, not proof that every Phone
notification, a full transcript, or locked-device execution works for the proposed flow.
Pip's catch-up includes connected sources and successfully imported events, not an assumed
copy of the whole Notification Centre. [Notification triggers][triggers], [app notifications][notifications]

### Calls and voicemail: feasibility questions, not promised features

- Focus can silence calls; its contact, repeated-call and emergency exceptions must be understood.
  Do not promise that it routes every call immediately to voicemail in every carrier setup.
- Apple's built-in screening is documented for unknown callers. It is not a Focus setting to
  screen every call. No public interface was established for Pip to read the screening response
  and choose whether to connect the live call. [Call screening][screening]
- The alternative is voicemail triage: a Phone notification triggers a Shortcut, which passes
  available caller information and possibly a transcript into Pip. A completed voicemail
  avoids the need to decide while the caller waits, but access to the data is still unverified.
- Test caller identity separately from transcript access. A number or unambiguous contact name
  may be enough to prioritise a missed call using permitted contacts, expected appointments,
  relevant correspondence and Captain records. “The electrician for today's appointment called;
  possibly important” is useful even without a message. Do not invent a reason or treat caller
  ID alone as authenticated identity.
- No message does not mean no importance. Conversely, generic “New voicemail” text provides no
  basis for inferring who called. Apple documents viewing transcripts and sharing voicemails,
  but this does not establish automatic transcript retrieval from a notification. [Voicemail][voicemail]
- Public CallKit observation exposes identifiers and call states, not a general call-history or
  voicemail-transcript API. No working private interface for a normally signed Pip app was
  verified. Triggering Pip from Shortcuts does not change its sandbox or grant Apple's private
  entitlements. Private APIs are not an implementation dependency. [CallKit][callkit],
  [runtime security][sandbox], [App Review][review]

If native notification input is insufficient, a provider delivering voicemail through email
or an API is a separate option, subject to actual provider support. Running a telephone service,
call forwarding or a receptionist backend is not part of the agreed initial scope.

## 8. Scheduled activities, Siri and actionable notifications

Lunch is only an example. Pip should support personal scheduled activities such as a break,
walk, exercise session or concentrated work period, with an optional catch-up and an explicit
notification/Focus preference. These are personal assistant sessions, not configurable business
process definitions. An activity can start at its planned time or early by voice or a button.
Starting a session must not silently reschedule a calendar event, change a business deadline or
move the person's other appointments.

Pip should use native actionable notifications on Mac and iPhone. Apple's notification actions
can invoke an app handler without bringing its UI to the foreground. macOS may expose actions
on hover or under Options rather than show every button permanently. Notification permission,
Focus and system presentation settings still govern visibility. This does not require an
Illustrator integration. [Notification actions][actions], [handling actions][action-handler],
[Mac presentation][mac-notifications]

### Starting, postponing and ending a session

Worked example, with proposed timing semantics for review:

1. At 12:25, while the person is using Illustrator, Pip displays: “Lunch in 5 minutes. Your
   catch-up will be ready at 12:30.” Actions: **Open catch-up** and **Snooze 30 minutes**.
2. Snooze defers the planned Pip break/catch-up from 12:30 to 13:00. The five-minute reminder
   moves to 12:55. It does not merely hide the 12:25 banner or leave a 12:30 catch-up running.
   It also defers the planned Focus-off transition so the original break time does not expose
   routine interruptions while the person has chosen to keep working.
3. Pip persists the new due time, invalidates/replaces old pending notifications and prevents
   stale queued work from releasing the catch-up at the original time. It continues accumulating
   routine items; urgent items still follow the person's separate interruption policy.
4. The catch-up is assembled/refreshed when execution is available, using permitted current
   sources. Delivery of a scheduled alert alone does not run fresh inference. If unavailable,
   retain the deferred activity and show last-checked/pending status when resumed.
5. At the break, turn off the session's Focus through a user-configured Shortcut or supported
   system schedule, and let the person review the OS Notification Centre alongside Pip's
   catch-up. Restore the session Focus when the agreed break ends or the person resumes work,
   respecting any manual switch to a different Focus. The exact background invocation and
   scheduling bridge needs a device proof; do not assume a notification callback can silently
   control Focus on every platform.

Ending Focus allows subsequent notifications according to ordinary notification settings. The
OS Notification Centre is the place to inspect missed notifications from apps Pip cannot read;
it is available during Focus too. Do not promise that ending Focus replays every silenced item
as a fresh banner or automatically opens Notification Centre. A schedule must read the current
session revision so a snooze cannot leave an old Focus-off event behind. Avoid an app-based
Focus rule that immediately reactivates merely because Illustrator remains open during the
break. Test manual overrides, break end and Share Across Devices as well as the happy path.
[Mac Focus control][mac-focus], [Notification Centre][notification-centre]

The button is a Pip action with a durable activity identity and revision. Repeated delivery of
the same action must not add another thirty minutes, replay the catch-up or change a completed
activity. A genuinely new snooze on the replacement reminder can defer it again. Persist the
state change before acknowledging success, then reconcile notification scheduling after errors
or a restart. Ordinary dismissal or OS notification muting does not mean snooze, cancellation
or completion. Do not silently move a calendar event or a task deadline when snoozing Pip's
catch-up; changing those source records is a distinct action.

Cross-device activity state should reconcile via iCloud, with cancellation of obsolete alerts
when changes arrive. iCloud is not instantaneous coordination: offline devices can retain stale
banners. Define the scheduling device and stale-action/conflict policy in the implementation
design, and show pending sync instead of promising immediate cancellation everywhere. These
controls are deterministic writes; the snooze handler does not need model inference.

### A timed break with an advance warning and extension

An activity has a start, an expected end and a configurable warning lead time (five minutes by
default). During a break, the requested policy may be Focus off; a different activity may use
a different policy. The proposed user experience is:

1. Start a thirty-minute break at 12:30. Record the expected end as 13:00 and request that the
   work session's Focus turn off through the configured system integration.
2. At 12:55, show “Your break ends in 5 minutes,” with **Extend 15 minutes** and **Resume now**.
   The extension duration is an example, not a fixed product limit.
3. Extend moves the end to 13:15, the warning to 13:10 and the intended Focus restoration to
   13:15. It invalidates the old end/restore action, including an already queued action. It does
   not replay the catch-up already delivered at the start of the break.
4. Resume now ends the activity early, cancels the warning/end work and requests restoration
   of the session's Focus, unless the person has manually changed their Focus policy.

Postponing an activity before it starts and extending an active activity are different actions.
Both notification buttons and voice requests update the same durable session state; action
identity and revision checks prevent stale buttons or retries from extending the wrong session.
If the activity is shorter than the warning lead time, avoid scheduling a warning in the past;
the short-session warning policy must be decided and tested.

Timed Focus **on** has system duration options. The reviewed documentation does not establish
a symmetric public app API for “Focus off for thirty minutes, then restore the previous Focus.”
Treat that as two coordinated operations through a user-configured Shortcut/system schedule,
not as a proven atomic OS primitive. A local end-warning notification is supported; it does not
by itself execute the later Focus restoration. Do not depend on a long-running Shortcut Wait
or an iOS background timer to guarantee restoration. Until the scheduling integration is proven,
the supported fallback is an actionable **Resume work** reminder. Report incomplete Focus
changes separately from a successfully saved session extension. [Mac Focus control][mac-focus],
[background execution][background], [local notifications][local]

### Siri as an entry point

Natural conversation is the required experience. People should be able to say “Tell Pip, I'm
going to lunch now,” express the same intention in other words, and follow up with “Give me
another ten minutes” when the active activity is clear. These are acceptance examples, not
activation phrases to memorise. Apple's new Siri integration uses App Intents schemas to make
supported actions available through natural language without defining specific phrases.
[Apple Intelligence integration][apple-intelligence]

Expose typed actions for starting a named activity, extending the active activity and resuming
work. They call the same session operations as Pip's UI and notification actions. Adopt matching
system schemas where their semantics fit and expose the relevant activity context through
supported entity/context APIs. Determine schema coverage during the proof; custom capabilities
may need App Shortcuts. Typed actions describe what Pip can do internally, not a required spoken
syntax. Siri interprets the request and resolves parameters before calling an action; do not
assume Pip receives every utterance verbatim. Test natural paraphrases, conversational follow-ups
and routing to Pip on the target devices. If an action cannot support the required interaction,
record that limitation and revisit the integration rather than declare an exact-phrase demo
sufficient. [App Intents][app-intents], [App Shortcuts][app-shortcuts],
[Siri responses and context][siri-context]

Ask only when context leaves a meaningful ambiguity. If the activity's duration is known from
the selected schedule or the person's preference, use it and report the end time; otherwise ask
how long. For example, after successful execution: “Your break ends at 1. I'll remind you five
minutes before.” Confirm Focus state only when the system integration succeeds.

A native Pip intent does not acquire permission to change Focus simply because Siri invoked
it. Compose the configured Shortcut with Pip's intent and the system Focus action, and prove
the complete handoff, cancellation and manual-override behaviour. Starting early should cancel
the obsolete scheduled-start reminder and establish the actual session timing without creating
a duplicate. Later appointments stay fixed; surface a conflict rather than quietly move them.

## 9. Plan impact and migration questions

This proposal does not silently redefine the existing implementation. Before changing it, a
reviewed amendment must reconcile the following:

| Current plan | Required follow-up |
|---|---|
| D1 and the six jobs | Redefine Captain's shared project-system scope and Pip's personal assistant scope. |
| D2–D6 | Preserve data-only inference, typed workflows, person-scoped writes, person-sent correspondence and tenant isolation; specify Pip's local equivalents and provider drafts. |
| D7 / D22 / D23 | Keep Captain's business task/project/evidence authority; define tags and saved views, required equipment reservations, chat/backlinks, and how Pip suggestions and shared correspondence enter without duplicating state. Amend the chat exclusion explicitly. |
| D8 and connector ownership | Specify business connections in Captain and personal connections in Pip, scopes and revocation. |
| D9 / D18 / D19 | Retain the current server runtime until explicitly amended; document Pip's Apple model adapter and device execution limits separately. |
| D11 / D14 and mobile architecture | Review the Work/Chat/Resources mobile mockups, native Apple clients and design authority before building application screens or changing tabs. |
| D13 / D21 and mail tables | Separate transient Pip processing and iCloud-derived index from today's Captain mailbox/vector store. Plan retention, exports and removal before retiring any current data. |
| D12 / D16 / D17 | Review deployment and personal/business secret boundaries; no hosting or production changes in this proposal. |
| D15 and earlier files proposal | Explicitly retain, relocate or retire existing capabilities in later slices; no assumed adoption or deletion. |

The [files-in-place proposal](2026-09-16-files-in-place-and-workspace.md) remains a discussion
document. Its references to Captain inbox/outbox duties must be reconciled with this split if
either direction is adopted. Neither proposal authorises importing another project's code.

Existing personal mail, drafts, workflow enablements, vectors, credentials and audit records
need an inventory and migration/retention decision. Do not delete anything or disable existing
production workflows as a consequence of opening or merging a discussion proposal.

## 10. Small proofs before implementation

| Proof | Acceptance evidence |
|---|---|
| Product split | Walk through email-to-project, a personal reminder, a recurring business obligation and a daily brief; identify one authority and fewer user decisions in each. |
| Captain mobile workspace | Start at Work filtered to you, return left to its grouped view list, and select Marketing by tag. Repeat the list-to-view path for Chat and Resources; follow project → equipment, task ↔ conversation and asset ↔ task. Verify visible tag/project/person scope, the three-tab bar, conflict visibility and shared record identity. Prove native back navigation and per-tab state restoration before implementation is accepted. |
| Equipment scheduling | Required: show a multi-day resource timeline with horizontal equipment navigation, midpoint-preserving pinch and button zoom across hours/days/weeks, continuous interval bars at every scale, long bookings and conflict visibility at every scale. Prove overlap prevention under concurrent writes, maintenance/turnaround blocking, timezone handling, changes and cancellation. Conflicting requests must never appear confirmed. |
| Conversation summaries, pins and stars | Verify the same message IDs from item and full chat, latest-six windows, older shared pins and source links; file-version scope; summary cut-off times and invalidation after edits/deletion/access changes; unavailable/stale states, participant following, private conversation stars and shared pin permissions/auditing. No message or reaction performs a record action. |
| Reminders | Create/edit/complete in both apps; verify selected-list scope, denied permission, recurrence and cross-device identity after resync. |
| Shared search | Find real sent/received attachments from vague descriptions on two devices; measure retrieval quality, backfill, index size and sync conflicts without retained bodies/files/text. Test deletion, disconnect and an offline device returning. |
| Apple inference | Test required models, schemas, quotas, unavailable states and real device background behaviour. Do not assume PCC eligibility. |
| Phone bridge | On the target iOS version, test real missed calls and voicemails from known/unknown numbers with Focus active, locked/unlocked, previews hidden/shown and no message. Inspect exact Shortcut inputs and ability to call a Pip action without unlocking. |
| Actionable catch-up and break | From Illustrator, snooze without opening Pip. Verify reminder, catch-up and Focus-off transition all move, routine items remain queued and urgent policy still applies. At the break, verify Focus off, access to OS Notification Centre, and restoration when work resumes. Test manual Focus overrides, dismissal, duplicate/stale button presses, restart, unavailable inference and delayed cross-device sync. |
| Timed activities and Siri | Require the new Siri AI experience on supported devices. Test a non-lunch activity as well as lunch. Start early using natural paraphrases; resolve contextual follow-ups such as “Give me another ten minutes,” asking only when ambiguous. Confirm schema/custom-action coverage, duration resolution and no duplicate scheduled start. Verify the five-minute end warning, extension and early resume all update the same session and invalidate obsolete Focus restoration. Test locked devices, short sessions, manual Focus changes, fixed-calendar conflicts and the fallback when automatic restoration is unavailable. Memorised activation phrases alone do not pass. |

The first implementation plan should follow the product walkthrough and these bounded proofs,
not a wholesale rewrite. Keep undocumented phone access outside the critical path. No package,
table, dependency, background service or screen is added by this documentation PR.

## Sources and validation

Apple and Google documentation checked on 22 September 2026. This is a documentation review,
not an on-device proof; framework availability, entitlements, region and the target OS version
must be checked during the spikes. The mobile HTML mockups were rendered and checked with
Playwright at three phone widths; their README records the checks. No application build,
Postgres integration suite or production-route Playwright run is claimed. No runtime or
application route is changed.

[pcc]: https://developer.apple.com/documentation/FoundationModels/adding-server-side-intelligence-with-private-cloud-compute/
[background]: https://developer.apple.com/documentation/BackgroundTasks/choosing-background-strategies-for-your-app
[local]: https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app
[reminders]: https://developer.apple.com/documentation/eventkit/creating-events-and-reminders
[event-access]: https://developer.apple.com/documentation/EventKit/accessing-the-event-store
[event-id]: https://developer.apple.com/documentation/eventkit/ekcalendaritem/calendaritemidentifier
[reminder-sync]: https://support.apple.com/en-gb/guide/icloud/mmc591432bd9/icloud
[gmail-search]: https://developers.google.com/workspace/gmail/api/guides/filtering
[gmail-attachment]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments/get
[cloudkit]: https://developer.apple.com/documentation/cloudkit/deciding-whether-cloudkit-is-right-for-your-app
[spotlight]: https://developer.apple.com/documentation/CoreSpotlight
[focus]: https://support.apple.com/guide/iphone/allow-or-silence-notifications-for-a-focus-iph21d43af5b/ios
[focus-schedule]: https://support.apple.com/en-bh/guide/iphone/iph5c3f5b77b/ios
[focus-api]: https://developer.apple.com/documentation/appintents/focus
[triggers]: https://support.apple.com/guide/shortcuts/event-triggers-apd932ff833f/10.0/ios/27
[notifications]: https://developer.apple.com/documentation/usernotifications/unusernotificationcenter
[screening]: https://support.apple.com/guide/iphone/screen-and-block-calls-iphe4b3f7823/ios
[voicemail]: https://support.apple.com/en-mide/guide/iphone/iph003dae603/27/ios/27
[callkit]: https://developer.apple.com/documentation/callkit/cxcall
[sandbox]: https://support.apple.com/en-nz/guide/security/sec15bfe098e/web
[review]: https://developer.apple.com/app-store/review/guidelines/#software-requirements
[actions]: https://developer.apple.com/documentation/usernotifications/unnotificationaction
[action-handler]: https://developer.apple.com/documentation/usernotifications/handling-notifications-and-notification-related-actions
[mac-notifications]: https://support.apple.com/guide/mac-help/get-notifications-mchle7f8a9b0/27/mac/27
[mac-focus]: https://support.apple.com/en-au/guide/mac-help/-mchl999b7c1a/mac
[notification-centre]: https://support.apple.com/en-ng/guide/mac-help/mchl2fb1258f/mac
[app-intents]: https://developer.apple.com/documentation/AppIntents/AppIntent
[app-shortcuts]: https://developer.apple.com/documentation/appintents/acceleratingappinteractionswithappintents/
[apple-intelligence]: https://developer.apple.com/wwdc26/guides/apple-intelligence/
[siri-context]: https://developer.apple.com/videos/play/wwdc2026/343/
