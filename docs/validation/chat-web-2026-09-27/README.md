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
  concurrent-edit fixes. Final read-status propagation and browser acceptance are still pending.

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

Final browser results and screenshots will be recorded here after successful execution.
