# Captain: next delivery batch after equipment

Status: implementation sequence, 25 September 2026. The adopted [plan](../plan.md)
remains authoritative; the 25 September scope audit corrects this sequence. Outcomes: **manage
shared work**, **allocate resources**, and **discuss work**. Equipment API/web #125/#127 are live on staging;
[the release record](../runbooks/paused.md) distinguishes that from native acceptance.

## Outcome

Make the existing web workspace dependable, then let two people discuss shared work without
leaving its context. The task/project, its equipment reservation and its conversation keep their
own stable identities. Start the real Expo client alongside these increments, so device problems
are discovered before declaring the first-customer workflow complete.

## Ownership and immediate work

| Work | Implementer | Reviewer / completion evidence |
|---|---|---|
| Service-failure recovery, [#126](https://github.com/SomedaySomehowBeer/askthecaptain/issues/126) | Claude: session classification, retry UI, focused web tests; audit server-action behaviour | Codex: real-Postgres fixture and Playwright recovery checks, review, CI and staging release |
| This delivery sequence and chat contract preparation | Codex: scope, dependencies, permission/retry cases and acceptance ledger | Claude: independent review against D7/D11/D24/D25 and approved designs |
| Integration and deployment | Codex: small PRs, isolated browser tests, operational record | Each implementation reviewed before merge; green CI; staging only, one machine per app |

Claude and Codex share one checkout. File ownership is explicit for each assignment; Codex owns
branching, commits and PRs. Only one heavy build/test runs at a time under `/tmp/atc-build.lock`.
New assignments begin after the current one is complete; this table does not claim future work
has already been delegated or implemented.

The immediate recovery fix is delivered in reviewed #130 and deployed to staging. Claude also
completed the read-only task-handoff audit; [#131](https://github.com/SomedaySomehowBeer/askthecaptain/issues/131)
records the bounded task-detail contract and implementation, corrected to remove Commitments
compatibility. [#133](https://github.com/SomedaySomehowBeer/askthecaptain/issues/133) tracks scope
cleanup: runtime retirement (#135), optional projects/reset (#136), and Work record replacement
(#138) are implemented and deployed. Empty retired storage, the retrieval package, connector capabilities and deployment
assets still need removal. Saved-view and linked-chat contracts are the next feature increments.

The populated-demo reliability/design follow-up is now delivered through #143/#145/#147 and
#149/#150: checkable work, parent navigation, project Overview/Tasks/Schedule, continuous
month-back/six-month-forward equipment scrolling and separated project task history. These are
bounded corrections, not complete mockup or native-device acceptance. Search/filter presentation
and contextual Files/Chat remain in #142. Private saved views follow the
[reviewed contract](saved-work-views-2026-09.md) adopted in #140 and tracked in #141.

The [26 September saved-view delivery assignment](saved-work-views-delivery-2026-09-26.md)
split #141 between two Claude Opus agents: database/API and Work web, with reciprocal review.
Both implementations are merged (#153/#154) with green CI. The linked delivery document records
the real-Postgres/browser proof and staging release; this is implemented private Work filtering,
not shared views or Chat/Files delivery.

## Ordered increments

1. **Recover without signing people out.** Missing credentials or a confirmed invalid session
   lead to sign-in. A rate limit, unavailable API or server failure preserves the session and
   presents a retry state. The same distinction applies on Work, sign-in and other protected
   pages. A failed session read before a write cannot send it; an ambiguous write response still
   requires reconciliation. Do not retry writes automatically. Delivered in #130; this is completed work.
2. **Correct scope, then finish shared work.** Follow the
   [implementation inventory](captain-workspace-migration-inventory-2026-09.md): remove legacy
   Today/Inbox/Outbox/Commitments/Notes/personal-Calendar navigation and onboarding; retire
   mail/discovery/preparation paths and revise mixed business workflows, including queued and
   waiting runs. Keep business stock/reminders independent of mail. Remove the Obligations
   storage fallback with a reviewed optional-project contract covering tasks, series, checklists,
   tags, equipment links, every writer and access/export tests. Then deliver bounded Work task,
   project and recurrence detail/editing. No “Open in Commitments” action or new placeholder
   project. Old valid links may redirect to Work; other retired destinations get honest states.
   Inspect only the actual affected records/run state before a data/runtime change; do not
   invent a migration requirement or wait for Pip. Delivered through #135/#136/#138; remaining
   retired storage/code removal stays tracked in #133. Each part is a small reviewed PR.
3. **Saved Work views.** Implement the [reviewed contract](saved-work-views-2026-09.md): named,
   versioned private Work filters, with strict supported fields and bounded counts. Saving a view never grants record access. The contract defines deleted tags/projects, revoked
   membership, stale updates, default-view behaviour and migration/export/deletion handling.
   Delivered in #153 (API/RLS) and #154 (web), released to staging on 26 September. Shared
   views still require an explicit sharing contract; browser-session tab restoration is separate.
4. **Linked-chat contract, then API.** Settle the cases below before adding tables. First API
   increment establishes conversations, membership, messages and task/project links. Follow
   with shared pins, personal stars and read position using the same identities. Each migration
   includes forced RLS, audit, export/deletion handling and real-Postgres tests. No extra realtime
   service or background process is assumed; choose the smallest transport in the contract.
5. **Linked-chat web.** Use the reviewed Slack-like stream, alternating light rows and compact
   composer. Full Chat and item panels read the same conversation. Item panels show shared pins
   plus the latest six chronological messages; older history opens the full chat. Work links
   return to the same records. Missing summaries say “Summary unavailable”; snippets are labelled
   as excerpts. Do not fabricate a summary while inference is unimplemented.
6. **Expo foundation in parallel with the contract/API increments.** Audit native sign-in,
   secure session storage and deep-link return first. Introduce `apps/mobile` and only its named
   dependencies in a reviewed PR. Implement Work/Chat/Resources navigation and authenticated
   reads, then task changes and the equipment timeline. Run Android compilation/smoke checks
   alongside iOS development, and record real-device pinch/pan, keyboard and back-navigation
   evidence. Bundle export alone never closes this gate. Root coordinates this assignment after
   the immediate recovery fix; app-store publication is not part of this batch.

These are small reviewable increments, not one combined PR. The recovery fix does not wait for
chat or native work. Contract preparation and the native-session audit can run alongside work-view
implementation; dependent schema/UI work waits for its reviewed contract.

## Linked-chat contract checklist

The next chat amendment must answer these with endpoints, limits and tests, not just UI labels:

- **Audience:** explicit active-organisation participants; who can create, invite, remove and
  leave; how archived work and removed members affect reads and writes. Define admin powers
  separately from permission to read messages. A link to shared work must not expose a private
  conversation, participant names, pins, unread counts or summaries to a nonparticipant.
- **Identity and links:** stable conversation/message IDs; several discussions may link to one
  item without merging their streams. Both directions enforce the same access. Task creation
  from a message retains its source identity. File/version linking waits for the asset contract.
- **Delivery:** client request IDs, duplicate-send reconciliation, bounded cursor pagination,
  ordering under simultaneous sends, message-size/rate limits and reconnect catch-up. Unconfirmed messages remain pending.
  Define cursor behaviour after removals/edits and transport failure; never infer delivery from push.
- **Read state:** per-person monotonic acknowledgement of an observed cursor; loading a preview,
  starring or receiving push must not silently mark the full history read. Starred is personal;
  leaving, muting and starring are distinct actions.
- **Pins and changes:** shared pin/unpin permissions and auditing; latest six plus older pins;
  no duplicate message identity. Define message edit/delete revisions, tombstones, attachments,
  mentions, reactions and thread-reply scope before their controls appear. Attachments follow D13: metadata/provider links, never stored bytes. A message/reaction
  never completes a task, approves a file or confirms equipment.
- **Summaries:** a later D2 infer step with validated source IDs, cutoff and access scope. Specify
  invalidation on edits, deletion and access changes, and stale/unavailable/budget states. Plain
  messages and linked work must remain usable without inference.

## Release evidence and boundaries

For the immediate fix, test valid-session 429/503/network failures, confirmed 401, recovery,
retained cookie and return route, sign-in without loops and a form submitted while the service is unavailable.
Use the local fixture and production web build; no customer records or provider credentials.

Before calling the larger first-customer workflow ready, two members must create and update work,
reserve equipment without overlaps, discuss it in the same linked conversation, pin a message,
star privately, reconnect without duplicate sends and observe the same state on web and iOS.
Revoked access must disappear across full chat, inline previews, links, pins and summaries.
Native notifications and operational release checks remain part of that release gate.

Production remains paused. Staging deploys reuse one machine per app, run required migrations
without creating a second release machine, and record health checks and rollback. Backup
resumption remains a separate operation. Files/DAM, richer reporting and Pip implementation stay
in their existing later slices; [Pip #119](https://github.com/SomedaySomehowBeer/askthecaptain/issues/119)
does not block Captain.

## First retirement implementation

See the [runtime retirement contract](assistant-runtime-retirement-2026-09.md) for removed
assistant entry points, task-reminder v4 and stocktake v3, run/schedule cancellation and staging
cutover. Optional-project/Obligations removal and Work detail pages shipped separately in #136
and #138 (below).

The [optional-project/reset increment](optional-work-projects-2026-09.md) implements task/series
null projects, checklist and equipment links, and a separately invoked staging legacy-data reset
authorised by the owner. The [Work record increment](work-record-pages-2026-09.md) shipped in
#138; release evidence is in the [operational record](../runbooks/paused.md). Private saved views
followed in #153/#154; linked chat remains the next feature increment.
