# Default business views and linked chat: next assignments

Status: By tag (default business views) shipped to staging in web-only #159. The linked-chat
contract is adopted in #160; chat implementation is the next increment.
26 September 2026. Private saved Work views are already delivered
in #153/#154; [release evidence](../runbooks/paused.md) records their actual scope. This batch
addresses the missing default business views and prepares the next linked-chat increment.
Outcomes: **manage shared work** and **discuss work**. Tracking: [default views #156](https://github.com/SomedaySomehowBeer/askthecaptain/issues/156)
and [linked chat #157](https://github.com/SomedaySomehowBeer/askthecaptain/issues/157).

## Intended result

A person can reach Production, Marketing, Sales and Admin/reporting work from the Work view
list once those tags exist, without first configuring personal saved views. These remain views over tags and existing
work, not departments, separate task stores or access boundaries. My work remains the initial
page. Personal saved views remain private. The first contract must distinguish built-in tag
navigation from editable organisation-shared saved views. The selected
[contract](default-business-views-2026-09.md) is **By tag**: list all existing organisation tags,
using their IDs and current names, linking to Everyone · Open. New organisations use the existing
explicit Tags screen; no tags, bindings or special department slots are silently created.

**The two increments are separate.** By tag ([contract](default-business-views-2026-09.md),
adopted in #158) is a web-only change in #159: no API, schema, migration or setup writes. Linked
chat ([contract](linked-chat-2026-09.md), revision 5) is a later, independent increment with its own
adopting plan PR. That PR amends `AGENTS.md` and `docs/plan.md` for participant-scoped
`chat_audit_events`. Neither PR depends on the other, and #159 carries no chat change.

Two people can discuss a task or project in one linked conversation. Full Chat and item previews
must share message identities and enforce the same audience. Chat works before summaries or
native notifications exist. Shared pins, personal stars and read positions remain distinct.

## Contract assignments (completed)

Two existing **Claude Opus** sessions are reused in Herdr's **Monitor** tab. They read the current
primary checkout, not their previous saved-view worktrees. Each owns one proposed contract file;
Codex owns this delivery document, plan integration, issues, branches and PRs.

| Agent | First deliverable | File ownership |
|---|---|---|
| `business-views` (pane `w2:pR`) | Default business-view contract: tag identity, setup, permissions, retries, route/filter semantics, UI states and acceptance tests | `docs/plans/default-business-views-2026-09.md` only |
| `linked-chat` (pane `w2:pS`) | First linked-chat contract: audience, links, messages, retries/cursors, RLS, audit/export/deletion, transport and phased API/web delivery | `docs/plans/linked-chat-2026-09.md` only |
| Codex | Review both contracts against the existing code and approved designs; settle interface choices, integrate plan amendments and tracking, organise serial verification | This document and integration files |

No implementation is implied by assigning a contract. Agents do not change application code,
merged migrations, infrastructure or each other's files. They do not run builds/tests, commit,
merge or deploy. Codex manages those operations when their implementation stage begins.

## Core chat implementation assignments

The contract was adopted in #160. Both existing Opus sessions continue in the Monitor tab,
working against `/home/nanoclaw/atc-next` on one integration branch with disjoint files:

| Agent | Owned implementation and tests |
|---|---|
| `business-views` | PR B database: migration 0041 (confirm number), chat schema and exports, direct-SQL RLS/transition/lifecycle/concurrency tests under `packages/db` |
| `linked-chat` | PR B API: chat services/routes/tests, route and rate-policy registration, membership locking/removal hooks and lifecycle export handling under `apps/api` |
| Codex | Interface coordination, real-Postgres verification under the build lock, reciprocal review, PR and staging release |

Each agent reports exported names and SQL function interfaces early, then independently reviews the
other's implementation. They do not alter each other's files, run builds/tests/install commands,
commit or deploy. No PR C pins/stars/read tables, UI, inference or new runtime process enters PR B.
Core code remains unreleased until all §17 execution gates pass, review findings are resolved and
applicable CI is green. One migration belongs to this PR. The existing monitor remains active.

## Review and implementation order

1. Both agents inspect current code and produce proposed, bounded contracts with exact acceptance
   cases. List any plan decision/table/dependency needing adoption before code.
2. Codex reviews scope and complexity. Each agent independently reviews the other's proposal,
   especially tag/default identity and chat audience/retry guarantees. Resolve findings in the
   contracts and authoritative plan; merge only after review and applicable checks. Adopt the
   small By tag contract in #158; keep chat proposed in a separate PR until its privacy, retry,
   lifecycle and reconnect findings are resolved. Chat review does not block the tag-view increment.
3. Implement the By tag web increment first once its contract is adopted; it needs no API,
   schema or migration. `business-views` owns the web implementation and pure tests; Codex owns
   the browser fixture/proof. `linked-chat` reviews it while preparing the separate chat contract.
   Preserve private saved-view semantics, independent group paging and existing Work regressions.
   There are no seeded customer changes.
4. Implement linked-chat storage/API under its adopted contract in small PRs, one migration each.
   Add web only after a stable reviewed API. Shared pins, personal stars and read positions may
   be separate increments; do not expose unfinished controls. Summaries stay explicitly unavailable
   until the D2 inference increment is implemented. Files/version links wait for their own contract.
5. Run typecheck, real-Postgres access/concurrency tests and browser checks appropriate to each
   increment, serially under `/tmp/atc-build.lock`. Compare populated mobile/desktop screens with
   the reviewed design. Obtain reciprocal implementation review, green applicable CI and squash merge.
6. Release only to the existing single staging API and web machines, with required migration/queue
   installation and rollback evidence. Preserve the demo, production pause and stopped embedding.
   Record what is actually deployed; native-device acceptance remains separate.

The default-view contract is a short addition before the previously ordered linked-chat work,
following the owner's question about missing default business views. It is not authority to add
organisation-shared editable filters, auto-classify work, or infer a new domain model. Remaining
legacy cleanup (#133), visual/accessibility follow-ups (#142) and Expo foundation remain tracked;
this assignment does not silently declare or delegate them complete.

## Background supervision

A separate local watcher at `/tmp/captain-business-chat/monitor.py` checks both named agents every
10 seconds and captures settled, blocked or missing states. It notifies this coordinator session
only when the coordinator is ready. It never answers approvals, treats readiness as completion,
or changes Captain runtime state. Codex reads snapshots, inspects actual output and checks the
work before assigning the next stage. Stop the watcher when this batch is completed or superseded.

## Gates

- [x] Both Opus agents assigned and observed working in Herdr Monitor.
- [x] Background supervisor running for these exact agents and coordinator session.
- [x] By tag contract complete and independently reviewed; chat remains proposed with review findings.
- [x] By tag contract adopted in #158 and web implementation dispatched; chat adoption remains separate.
- [x] Default business views (#159) reviewed, verified, merged and released to staging.
- [x] Linked-chat contract peer-reviewed through revision 5 (r3/r4 findings resolved).
- [x] Linked-chat adopting plan PR #160 merged, with the `AGENTS.md` and `docs/plan.md` audit amendments.
- [ ] Chat PR B execution gates proven (contract §17): owner check, Neon PostgreSQL version, trigger reads, race/lock/rollback tests.
- [ ] First linked-chat implementation slice (PR B) reviewed, verified and released to staging.
