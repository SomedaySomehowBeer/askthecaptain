# Chat web verification — 27 September 2026

Outcome: **discuss work** (D25), following the adopted [web contract](../../plans/linked-chat-web-2026-09.md).
This is browser and API verification against synthetic, disposable local workspaces; it is not a
claim of a staging web release. The [operational record](../../runbooks/paused.md) records deployments.

## Implementation and review

The two Claude Opus sessions in Herdr reviewed each other's implementation. Review corrections
include bounded polling and gap recovery, sign-in return paths, unknown write outcomes that stay
locked until read back, pending identities preserved across session expiry, and controls locked
when any conversation read detects expired access or a changed sign-in/organisation.

Edits and delete confirmations capture the message revision the person saw. A later live update
does not silently advance that revision. A stale response preserves the draft and shows the
specific version read back before the person chooses again. Pins are shared; conversation stars
and read positions are personal. Lists show labelled latest-message excerpts, not generated summaries.

## Completed checks

- Workspace typecheck: ten packages passed; seven unchanged package checks came from cache.
- Full suite against local pgvector/Postgres 18: **471 passed**, zero failures/skips, no cached test
  tasks. API 188, database 97, web 126, engine 20, steps 5, connectors 17, retrieval 7, model 11.
- A subsequent web typecheck and all 126 web tests passed after the first session-stop and
  concurrent-edit fixes. The final production build passed after the read-status and Start again fixes. Both complete browser suites then passed on that frozen app, with the test harness in `dd50c6d`.
  The full/pure suites were not rerun after `fc4416e`; its changes were covered by the final build
  and both browser suites. CI subsequently reran all 471 tests on the final source.

## Browser execution

`apps/e2e/scripts/chat-ci.mjs` starts a built production web server on loopback and runs
`chat-views-check.cjs` and `chat-check.cjs` sequentially, each with a fresh disposable database and
private fixture directory. It waits for fixture cleanup between suites. CI has a separate
`chat-browser` job; existing workspace checks remain unchanged. Only synthetic screenshots and
redacted logs are retained, never fixture session files.

The suites exercise two participants, independent list paging, creation and linking, shared pins,
latest-six item panels, send retry identities, access changes, sign-in return paths, concurrent
edits, and mobile/desktop layouts. The ten-minute idle timer is verified by deterministic poller
unit tests rather than a ten-minute browser wait. Native devices and generated conversation
summaries are outside this slice.

Both suites passed sequentially on 27 September Perth (26 September UTC), with exit code 0 and
confirmed cleanup of both disposable databases. The views suite covered 110 conversations,
independent filtered cursors, uncertain creation, cross-organisation pending identities and session
expiry. The thread suite covered two participants, paging and gaps, hidden/blurred polling,
commit-with-lost-response recovery, 429 waits, locked uncertain writes, stale edit/delete snapshots,
links, people, access loss, reads and writes discovering expiry, sign-in recovery and explicit sign-out.

Layout assertions and captures passed at **360, 390, 430 and 1440 pixels** without horizontal
overflow; the thread composer clears the tab bar. The views, new-conversation, thread and task
panel captures were visually inspected. Full-page panel/details captures overlay sticky navigation
on content, so those captures are omitted here; their functional browser assertions passed. These are synthetic acceptance states, including an
intentionally uncertain send; they are not customer conversations.

- [Grouped Chat views](chat-views-390.png)
- [New linked conversation](chat-new-390.png)
- [Thread and preserved uncertain send](chat-thread-390.png)

[CI 36272989702](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36272989702)
passed both jobs on source `dd50c6dc24eb50def58da4575cbd4e5785c6947c`: workspace typecheck,
all **471** tests against Postgres, 13 infra-service tests, React retry browser regression,
production web build and both complete Chat browser suites. PR #174 merged as
`c2a6d8b998cb8fe094eadd62b6209e17fdc091e8`; both commits have tree
`a280cb5f04fd13ab8a417fb16ea087e8d40e71a6`. The clean-source Linux/amd64 Docker build passed. No hosted signed-in
session, staging multi-user polling capacity, native-device acceptance or inferred summaries are
claimed. Conversation-list time titles identify the reader's local time; the thread uses the
organisation timezone.


## Hosted release boundary

Web #174 is deployed on the existing staging web machine, with API #173 unchanged. The
[release record](../../runbooks/paused.md#chat-web-release-27-september-perth--26-september-2026-utc)
contains the exact image manifests and fleet comparison. Anonymous Chrome checks passed for the
six Chat destinations at 390/1440 pixels, preserving sign-in return paths without overflow or page
errors; API readiness was 200. No hosted signed-in session or business-data writes were used.
The first hosted run found an older Work-layout task/project return-path bug; the follow-up adds
local signed-out and signed-in regression cases and leaves reads guarded by each Work page.
