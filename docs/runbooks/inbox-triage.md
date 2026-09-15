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
