# Inbox triage

Jobs 1 and 2; D2/D4/D5/D6/D13. The API release applies `0012_triage.sql` and installs queues.
Migration 0013 may already be installed: the migrator applies every missing migration, not just
numbers greater than the latest one. No additional resources or credentials are needed.

Connect Google, verify the tenant's inference runtime, set a token allowance, and enable Inbox
triage in Settings → Workflows. `gmail.modify` already authorises labels and sending. Set reply
style and whether drafts should be created. Run now reads up to 100 newly cached messages;
mail sync and the 06:00 schedule also trigger runs. The cursor and read journal commit together.
A waiting reply parks the sequential workflow; the rest of that batch continues after Send
or Discard; its seven-day timeout fails the run with an explicit reason. Review Activity before
cancelling: cancellation skips the rest
of its claimed batch. Remaining mail still shows Awaiting triage. The operator can recover a
cancelled batch by reviewing its journal and resetting the enablement cursor; this can re-infer
mail and create new drafts, so prefer Resume for paused runs. Failed runs require operator review
before replay.

Unknown senders need the owner even if the model says otherwise. Only a contact edited/created by
hand or imported, or prior sent correspondence, counts as known. Task confirmation must match one
open task's title and reference exactly, with the reference stored as the whole task body and both
values quoted in the mail. Otherwise it becomes a suggestion; recurring duties gain mail evidence
before completion. Contacts update from actual mail headers, preserving human edits.

PDFs, unsupported types, oversize files and missing attachment references produce explicit skip
notes. Plain text/CSV bytes exist only in memory. Text is limited to 20,000 characters and 24 hours;
hourly expiry runs even when mail/workflows are disabled or disconnected. Text is never copied to
the step journal. An inference retry after expiry fetches allowed text again.

Only the authenticated outbox HTTP service can call Gmail send. Review recipients and body, save
edits, then send. A committed send intent freezes the draft. Lost responses offer Check send: search
Sent by the draft's stable RFC Message-ID and record the result; a missing search result is never
proof that sending failed, so Captain never automatically resends an ambiguous attempt. Check
Gmail directly if it remains unconfirmed. Definitive Gmail 400/401/403/404/429 rejections release the
intent for correction and another person-initiated attempt. Google account changes block old drafts.
Older cached threads without RFC Message-ID require another sync before a reply can be prepared.

Gmail contracts: [messages.send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)
and [reply threading](https://developers.google.com/workspace/gmail/api/guides/threads).

The opt-in Playwright regression in `apps/e2e/tests/inbox.spec.ts` requires a disposable fixture
from `apps/api/test/triage-fixture.ts`, a member session, `E2E_TRIAGE_THREAD` and
`E2E_TRIAGE_FIXTURE=1`. Run it only against fake Gmail; it edits and sends a draft.

## The gate (D20)

Before any model call, `triage.gate` decides by rules whether a thread is bulk or automated mail:
Gmail's Promotions, Social or Forums category; a List-Unsubscribe or List-Id header; Precedence
bulk, list or junk; an Auto-Submitted header other than `no`; a no-reply, notifications or
mailer-daemon sender; a sender whose three or more earlier verdicts were all information with
needs-owner off and whom nobody has replied to or starred; or Gmail's Updates category from a
sender the business does not know. A filed thread gets a `mail_triage` row with category
`information`, needs-owner off, a summary that names the rule in words and a `model` of
`gate:<rule>`, plus a `mail.filed` audit event. Sync keeps the four headers on `mail_messages`;
nothing else new is stored. The Inbox shows filed threads last, under **Filed**.

Sender priors live in `mail_senders` (counts only): every verdict, filed or modelled, bumps the
sender; a send from the outbox bumps `replies` for each recipient; a star seen on the thread bumps
`stars`. A reply or a star means the sender's mail always reaches the model again.

The model sees each message's own text only: quoted reply blocks, forwarded header blocks and
signatures are cut, the latest message keeps up to 20,000 characters and earlier ones 500.

## Notes (D23)

A note is plain text a person writes at `/notes` (title optional, body up to 20,000 characters, at
most one link each to an event, contact, company, project and task; archived, never deleted).
Saving emits `note.saved`, which starts this workflow. `notes.new` reads notes not yet read, or
changed since (a different digest and at least 20 characters of difference), skipping bodies under
160 characters (about 40 tokens). `classifyNote` returns category (plan, request, information,
other), summary, facts and tasks; the person is the author, so there is no needs-owner and no draft.
`notes.record` writes `note_triage`; `tasks.suggestFromNote` puts the tasks in Obligations with
source kind `note`. The Notes page shows what Captain read under each note.

## Weighted drafting (no model)

Before the large model is asked for a reply, `triage.draftScore` decides by rules whether a draft
is worth making, and the run's steps show the outcome with its reason:

- **already_replied**: a message from the mailbox follows the latest incoming one.
- **older_than_a_day**: the latest incoming message is more than 24 hours old when the run reaches
  it. On a first run this is the backlog; in steady state mail is triaged at each sync, so fresh
  threads always qualify.
- **needs_owner_off**: the verdict found nothing that needs the owner.
- **below_threshold**: the draft score is under the workflow's `draftThreshold` parameter
  (default 3). Score: needs owner 2; request category +1; known sender +1; a sender the person has
  replied to +1; per past draft to the sender: sent or edited-then-sent +2, discarded −2, not
  needed −3, a draft the person asked for +3; clamped to 0–10. So before any outcomes exist the
  rule is: needs owner and (known sender or request).
- **run_cap**: twenty drafts already made in this run on the large tier.

Classification, tasks and confirmations still run for these threads; only the draft is skipped.

Every draft records its **outcome** in `outbox.outcome` when it closes: `sent`, `edited_sent`,
`discarded`, `not_needed` (no reply wanted; also turns the thread's needs-owner off and counts as
an information verdict for the sender) or `expired` (untouched for seven days; neutral). The
counts roll into `mail_senders.drafts_*`. On a drafted thread the control is a split button: Send,
with Edit, Remind me tomorrow morning, Remind me next week, Not needed and Discard in its menu.
Remind me later sets `remind_at` and keeps the draft; edits and reminders restart the seven days.

On a needs-you thread **without** a draft the split button is **Draft a reply**, with Remind me later
and Not needed in its menu. Draft a reply runs the same draft instruction and style note on the
large tier at once (`POST /mail/threads/:id/draft`), places the draft in the outbox for the person,
and counts as `drafts_requested` for the sender, the strongest up signal in the score. Remind me
later sets `mail_triage.remind_at`; the thread sits under **Later** in Inbox until then. Not needed
turns needs-owner off and records an information verdict for the sender.
The reply-style parameter is optional: left blank, the draft instruction asks for plain, brief
replies in the voice of the owner's own messages in the thread.

The definition is version 5 (version 2 added the gate; version 3 the drafting rules and the
optional style note; version 4 the draft score, threshold parameter and outcomes; version 5 notes). An organisation that enabled an earlier version must save the workflow's
parameters again in Settings → Workflows before a new run will start; the runner says so.

