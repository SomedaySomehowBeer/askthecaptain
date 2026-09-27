# Captain: code retirement and native foundation

Status: active assignments, 27 September 2026. Detailed contracts remain proposals until their
reviewed adopting PRs merge. Outcomes: **manage shared work**, **allocate resources**, and
**discuss work**. The [plan](../plan.md) remains authoritative.

## Starting point

Default business views (#159), private saved views (#153/#154), equipment scheduling and real
web Chat (#174) are delivered. Sign-in fixes #175/#176 are also deployed; #177 records release
evidence. Local/CI two-person Chat acceptance passed. Hosted signed-in acceptance, measured
multi-user polling capacity and native acceptance remain open in #157 and the delivery plan.
This batch does not repeat the completed business-view/chat assignments.

The next priorities are the unfinished retirement in [#133](https://github.com/SomedaySomehowBeer/askthecaptain/issues/133)
and the real Expo client already named in delivery slice 2, tracked in
[#178](https://github.com/SomedaySomehowBeer/askthecaptain/issues/178). Removing obsolete mail/notes/retrieval code reduces maintenance
confusion; native foundation lets the same work become usable on iOS, with early Android checks.
Files/DAM, summaries and broader reporting retain their later slices and separate contracts.
Pip remains independent in #119.

## Assigned work

The two existing Claude Opus agents are running in Herdr's Monitor tab. Their historical agent
names are retained; their old saved-view working directories are not the source for this batch.
Both read the current `/home/nanoclaw/atc-next` checkout using absolute paths.

| Owner | Deliverable | Files owned in this planning stage |
|---|---|---|
| Claude `business-views`, `w2:pR` | Source-grounded retirement contract: callers, exports, schema dependencies, retained business capabilities, and a first independently removable code slice | `docs/plans/assistant-code-removal-2026-09.md` |
| Claude `linked-chat`, `w2:pS` | Expo foundation contract: native session handoff, secure storage, links, three-tab navigation, authenticated reads, named dependencies and device/build acceptance | `docs/plans/expo-mobile-foundation-2026-09.md` |
| Codex | Scope/status reconciliation, current platform-document verification, review, tracking issues, small adopting PRs and implementation sequencing | This assignment record, authoritative plan/status links and issue/PR records |

Agents do not edit each other's files, application code or merged migrations during this stage.
Codex owns git, builds, tests, integration and release. All heavy checks remain serial under
`flock /tmp/atc-build.lock`.

## Review and execution sequence

1. Inspect actual current sources and write each bounded contract. Separate verified repository
   facts, proposed changes, live-state prerequisites and unavailable device evidence.
2. Codex reviews both against the adopted plan and approved mockups. Each Claude independently
   reviews the other's contract; the author resolves findings. Review auth, evidence identities
   and retained business dependencies explicitly, not just document wording.
3. Merge reviewed planning PRs separately when useful. A contract is not implemented merely
   because it is adopted. Name new dependencies/tables in the relevant adopting amendment;
   any decision change also edits `docs/plan.md`.
4. Begin the smallest independent code-removal increment after its contract is reviewed. Remove
   imports/tests/configuration with the dead capabilities; preserve tests for retained behaviour.
   Later schema removal gets its own dependency-ordered migration and real-Postgres proof.
5. Begin the native sign-in/API increment after the secure handoff contract is adopted, then
   `apps/mobile` shell and authenticated reads. Task writes, equipment and full native Chat
   follow in bounded increments. The device does not acquire model/provider/database secrets.
6. For each implementation, run applicable typecheck, real-Postgres integration/access tests and
   browser checks, obtain reciprocal review, then merge with green applicable CI. Native bundle
   exports, simulator builds and real-device runs are recorded as different evidence.

The retirement and mobile contracts can advance independently. If a device/signing prerequisite
blocks a native acceptance step, continue permitted API/client work and code retirement without
claiming that device acceptance passed.

## Boundaries and acceptance

- Preserve current demo/work/chat records, identity, sessions, Google sign-in, Xero, optional
  Shopify, People, counted stock, equipment, business reminders, inference and the generic runner.
  The authorised old-data reset already ran; it is not a reusable deployment step.
- Historical migrations and immutable run snapshots are history, not permission to keep the old
  product. Identify actual references before removing tables or source identity handling. Never
  infer current database emptiness from the past reset or an unused code path.
- Retain Next.js web. The native app uses the same authoritative API and approved workspace
  design. No personal inbox/calendar, autonomous correspondence or offline booking confirmation.
- Audit existing passkey/session behaviour before proposing mobile changes. A native callback
  must not bypass the existing required passkey or weaken the web return-path guard. Long-lived session/provider credentials
  never enter a callback URL, log or normal device storage; any one-time handoff code needs
  explicit expiry, single-use enforcement and binding to the initiating app.
- Existing web design follow-ups remain in #142. Hosted Chat acceptance/capacity remains in #157;
  this batch does not mark either complete. No fake summaries or file assets fill those gaps.
- Release only to existing staging machines, at most one API and one web machine. Production,
  embedding, automatic deployment and backups remain paused. No DNS/secrets/signing changes or
  app-store publication are implied by a planning assignment.

## Supervision

The existing `/tmp/captain-business-chat/monitor.py` watcher is retargeted to these assignments,
with the same named agents and coordinator session. It checks every ten seconds and captures
settled, blocked or missing states, notifying the coordinator when ready. It does not answer
approvals or infer completion from a ready state. Codex reads actual output, reviews changes and
assigns the next stage. The watcher has a twelve-hour expiry; renew or stop it when appropriate.

Completed work and new assignments are recorded in the coordinator checkpoint so an old monitor
notification cannot restart a finished release. No new Captain runtime process is introduced.
