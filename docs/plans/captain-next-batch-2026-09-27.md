# Captain: code retirement and native foundation

Status: implementation in progress, 27 September 2026. The retirement contract (#180) and native
foundation contract (#183) are adopted after reciprocal review. Outcomes: **manage shared work**, **allocate resources**, and
**discuss work**. The [plan](../plan.md) remains authoritative.

## Starting point

Default business views (#159), private saved views (#153/#154), equipment scheduling API/web and real
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

## Implementation progress and current assignments

The planning assignments are complete. Cleanup R1 (#181), R2 (#182), R3 (#184) and R4a (#185)
are merged after review and green CI. They remove unused assistant code, embedding repository
assets, legacy catalogue entries and unused Google mailbox connector methods. After the recorded
read-only staging count (zero Google connections, empty attachment cache; see
[paused.md](../runbooks/paused.md)), R5a (#190) removed the attachment-expiry reader and R4b
(#191) removed the Google mailbox grant path; Google sign-in remains. R5b, the legacy storage
drop, completed in #194 after reader-free deployment, fresh empty counts and guarded migration
0045. Staging postflight confirmed removed schema and unchanged retained counts; see the
[storage release record](../validation/assistant-storage-retirement-2026-09-27/README.md). The stopped embedding resource is unchanged.

Native A1 (#186) is merged: the API handoff, default-off flag and migration 0044. A2 (#187) is merged and adds the web
native branches and a disposable, synthetic browser proof. Neither increment enables native
sign-in on shared staging or real accounts; the verified claimed-link and device gates remain.
M-shell (#188) is merged and supplies application source and exported bundles; no signed native build or device
acceptance is claimed. The M-auth pure core (#189) is merged. The server and web increments through
#191 (the cleanup slices and native A1/A2) are deployed to the single staging API and web machines;
migration 0044 was applied there on 27 September 2026 at 06:02:01Z, and native sign-in stays off.
The Expo shell, authentication core and platform/account code are not installed or usable on any
device. See the [release validation record](../validation/assistant-retirement-release-2026-09-27/README.md);
operational releases remain recorded in [paused.md](../runbooks/paused.md).

The two existing Claude Opus agents remain in Herdr's Monitor tab. Their historical names and
shell working directories do not identify the current checkout. Codex assigns explicit absolute
paths to isolated checkouts and records them in the coordinator checkpoint.

| Owner | Current mobile composition increment | Files owned |
|---|---|---|
| Claude `business-views`, `w2:pR` | Platform composition binding, retry clock adapter, validated configuration, callback mapping and harness boundary; independent account UI review | `src/platform/{account-platform,app-account}.ts`, auth retry clock contracts, configuration, links, boundary checks and `.github/workflows/mobile.yml` |
| Claude `linked-chat`, `w2:pS` | Account composition/provider, protected navigation, account screens, state pacing and test harness; independent platform review | `src/account/`, account routes/layouts and `harness/app/` |
| Codex | Browser proof, export canary, review, tests, integration and status | Test orchestration, documentation, git and issue/PR records |

The shell has no authentication, business reads or writes. Its reviewed PR #188 passed workspace,
browser, client-proof and mobile CI on the combined #187 base. Local evidence includes disposable
Postgres tests, ten workspace typechecks, SDK compatibility, web/iOS/Android exports,
exported-canary scans and browser approximation at 360/390/430 pixels. Android config introspection
verifies backup exclusions, not native compilation or device behaviour.

The [authentication-core partition](expo-mobile-auth-core-2026-09.md) (#189, merged) implements
pure protocol and serialized credential-storage logic with injected adapters. The
[platform and account increment](expo-mobile-platform-account-2026-09.md) adds the installed-SDK
adapters and the account reducer and runner; implementation and reciprocal review are complete,
merged as #193. The reviewed
[composition and account-screen contract](expo-mobile-auth-composition-2026-09.md) is the
assignment above.

**Current status (27 September 2026): implemented.**
- The app is now composed: the root layout provides one account source per process over the platform binding, and a
  protected root stack gates welcome, organisation and the tabs/Account on verified identity and a chosen organisation.
- The account screens (welcome for every state that is not signed in, the organisation chooser/switcher and Account)
  are present, with one `/v1/me` pacing rule and organisation-change tab resets.
- The tabs still show no business data: there are no business reads or writes yet.
- Native sign-in stays off on shared staging and for real accounts.
- Nothing is installed or usable on a device, and no simulator or device evidence exists.
- Two web exports are checked separately:
  - The **production** web export is web-only. It offers no sign-in and contains no harness.
  - The **synthetic harness** export is a separate test-only web export, selected only at build time. It renders the
    production screens and stack over scripted account states: no API, credentials or tokens. It is never deployed.
- A valid tab route the app was opened at is kept for that process. It is the sign-in `returnTo`, and it is opened once
  when a restored saved session becomes ready.
- All 185 mobile tests, four exports, boundary scans and browser checks at 360/390/430 px pass; see
  the [validation record](../validation/mobile-account-composition-2026-09-27/README.md).

Business reads follow separately, with real-account link/device gates still required. Browser exports are not
installed-app evidence.

Each Claude reviews the other's implementation. Codex owns git, builds, tests, integration and
release. All heavy checks remain serial under `flock /tmp/atc-build.lock`.

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
