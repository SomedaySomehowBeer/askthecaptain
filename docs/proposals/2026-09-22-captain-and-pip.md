# Proposal: Ask The Captain for the business, Pip for the person

**Status:** draft for review, 22 September 2026. Captures the product direction discussed with
the owner; no implementation, migration, deployment or replacement of the current plan's
decisions is authorised by this document. The live [plan](../plan.md) remains authoritative.

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
application stack need a subsequent implementation decision; this proposal creates none.

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

## 8. Notification buttons control the underlying activity

Pip should use native actionable notifications on Mac and iPhone. Apple's notification actions
can invoke an app handler without bringing its UI to the foreground. macOS may expose actions
on hover or under Options rather than show every button permanently. Notification permission,
Focus and system presentation settings still govern visibility. This does not require an
Illustrator integration. [Notification actions][actions], [handling actions][action-handler],
[Mac presentation][mac-notifications]

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

## 9. Plan impact and migration questions

This proposal does not silently redefine the existing implementation. Before changing it, a
reviewed amendment must reconcile the following:

| Current plan | Required follow-up |
|---|---|
| D1 and the six jobs | Redefine Captain's shared project-system scope and Pip's personal assistant scope. |
| D2–D6 | Preserve data-only inference, typed workflows, person-scoped writes, person-sent correspondence and tenant isolation; specify Pip's local equivalents and provider drafts. |
| D7 / D22 / D23 | Keep Captain's business task/project/evidence authority; define how Pip suggestions and shared correspondence enter it without duplicating state. |
| D8 and connector ownership | Specify business connections in Captain and personal connections in Pip, scopes and revocation. |
| D9 / D18 / D19 | Retain the current server runtime until explicitly amended; document Pip's Apple model adapter and device execution limits separately. |
| D11 / D14 and mobile architecture | Review navigation, native Apple clients and design authority before building screens or changing tabs. |
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
| Reminders | Create/edit/complete in both apps; verify selected-list scope, denied permission, recurrence and cross-device identity after resync. |
| Shared search | Find real sent/received attachments from vague descriptions on two devices; measure retrieval quality, backfill, index size and sync conflicts without retained bodies/files/text. Test deletion, disconnect and an offline device returning. |
| Apple inference | Test required models, schemas, quotas, unavailable states and real device background behaviour. Do not assume PCC eligibility. |
| Phone bridge | On the target iOS version, test real missed calls and voicemails from known/unknown numbers with Focus active, locked/unlocked, previews hidden/shown and no message. Inspect exact Shortcut inputs and ability to call a Pip action without unlocking. |
| Actionable catch-up and break | From Illustrator, snooze without opening Pip. Verify reminder, catch-up and Focus-off transition all move, routine items remain queued and urgent policy still applies. At the break, verify Focus off, access to OS Notification Centre, and restoration when work resumes. Test manual Focus overrides, dismissal, duplicate/stale button presses, restart, unavailable inference and delayed cross-device sync. |

The first implementation plan should follow the product walkthrough and these bounded proofs,
not a wholesale rewrite. Keep undocumented phone access outside the critical path. No package,
table, dependency, background service or screen is added by this documentation PR.

## Sources and validation

Apple and Google documentation checked on 22 September 2026. This is a documentation review,
not an on-device proof; framework availability, entitlements, region and the target OS version
must be checked during the spikes. No build, Postgres integration suite or Playwright run is
claimed by this proposal. No runtime or web route is changed.

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
