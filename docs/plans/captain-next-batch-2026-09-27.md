# Captain: code retirement and native foundation

Status: retirement complete; mobile reads in progress, 27 September 2026. The retirement contract (#180) and native
foundation contract (#183) are adopted after reciprocal review. Outcomes: **manage shared work**, **allocate resources**, and
**discuss work**. The [plan](../plan.md) remains authoritative.

## Starting point

Default business views (#159), private saved views (#153/#154), equipment scheduling API/web and real
web Chat (#174) are delivered. Sign-in fixes #175/#176 are also deployed; #177 records release
evidence. Local/CI two-person Chat acceptance passed. Hosted signed-in acceptance, measured
multi-user polling capacity and native acceptance remain open in #157 and the delivery plan.
This batch does not repeat the completed business-view/chat assignments.

Retirement in [#133](https://github.com/SomedaySomehowBeer/askthecaptain/issues/133) is complete.
The current priority is the real Expo client already named in delivery slice 2, tracked in
[#178](https://github.com/SomedaySomehowBeer/askthecaptain/issues/178). The completed retirement removed obsolete mail/notes/retrieval code; native foundation lets the same work become usable on iOS, with early Android checks.
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

| Owner | Completed mobile composition increment (#197) | Files owned |
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

**Composition status (27 September 2026): merged as #197 after reciprocal review and green CI.**
- The app is now composed: the root layout provides one account source per process over the platform binding, and a
  protected root stack gates welcome, organisation and the tabs/Account on verified identity and a chosen organisation.
- The account screens (welcome for every state that is not signed in, the organisation chooser/switcher and Account)
  are present, with one `/v1/me` pacing rule and organisation-change tab resets.
- At #197 the tabs showed no business data: there were no business reads or writes (historical; see My work below).
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

The [first My work read contract](expo-mobile-my-work-read-2026-09.md) was adopted in #198 after
independent review.

| Owner | Completed My work assignment (#199) |
|---|---|
| Claude `business-views`, `w2:pR` | Task-query path and tests; runner/machine regression tests; independent parser/configuration and read/UI review |
| Claude `linked-chat`, `w2:pS` | Atomic expected account/organisation scope, read facade and pacing, My work list and pending-read harness, tests; independent parser/path review |
| Codex | Task parser/date/title helpers and fixed website link completed during Claude quota; browser checks, validation, documentation, git and integration |

The list uses the existing API and shows open tasks assigned to the person, with explicit refresh and
bounded pagination. Real-account link/device gates remain required. Browser exports are not
installed-app evidence.

**My work status (27 September 2026): merged as #199 after independent review and all three CI jobs passed.**
- **Account side:** reads go through one runner entry point bound to a token-free read scope (the verified user, the
  chosen organisation and an opaque epoch from the account and organisation generations). The scope is checked before
  sending and after the answer. A 403/404 membership refresh is now also held to the 30-second spacing.
- **Screen:** Work → My work shows the person's open tasks read-only, under the fixed subtitle "Open tasks assigned to
  you":
  - page 0 on each mount, and explicit Refresh, More and Try again;
  - at most 10 pages and 500 rows;
  - each list bound to its first scope, so a scope change before the tabs reset shows nothing and sends nothing.
- **Harness:** synthetic pending reads (`work-read-log`, `work-read-pending`, `harness-read-{control}`) for the browser
  proof. The production web export still makes no API requests.
- **Review:** A reviewed the parser and path code and wrote the runner and machine regression tests. Root owns the
  parser, the browser checks and integration. All 218 mobile tests pass (zero skipped), all ten workspace checks pass, and all four exports and scans pass.
  Browser checks at 360/390/430 px and Expo SDK compatibility pass; see the
  [validation record](../validation/mobile-my-work-read-2026-09-27/README.md).
- **Remaining:**
  - other reads, and all writes;
  - native transport buffering/cancellation evidence (the response byte budget is implemented in #202);
  - the device gates: `expo/fetch` reporting the query URL unchanged, and a real 403/404 on an isolated synthetic
    environment;
  - native sign-in stays off.

Each Claude reviews the other's implementation. Codex owns git, builds, tests, integration and
release. All heavy checks remain serial under `flock /tmp/atc-build.lock`.

## Completed mobile read increments

The [All tasks contract](expo-mobile-all-tasks-read-2026-09.md) and
[transport response-budget contract](expo-mobile-response-byte-budget-2026-09.md) were adopted in #200 and define
separate implementation PRs. All tasks merged in #201 and the transport budget merged in #202
after independent review and green CI; see its [validation record](../validation/mobile-response-byte-budget-2026-09-27/README.md) and #202.

**All tasks status (27 September 2026): merged in #201 after independent review and green CI.**
- **Written:**
  - Codex: paths, parser, links, sections and configuration, with tests;
  - Claude B: the shared screen and hook (one bound view per screen), per-view copy and owner facts, the `/work/all`
    route and the harness fixtures by view, with tests;
  - Codex: the All tasks browser check;
  - peer reviews done.
- Tests, exports and browser checks passed; see the [validation record](../validation/mobile-all-tasks-read-2026-09-27/README.md).
  Native, simulator and device evidence remain unavailable; native sign-in stays off.

Completed ownership:

- Claude A implemented the transport budget and its regressions; Claude B independently reviewed it.
- Claude B implemented the shared My work/All tasks screen, hook, copy and harness. Codex supplied
  the paths, parser, links/configuration and browser checks; Claude A independently reviewed them.
- Codex owns serial tests, integration, documentation and git. Combine the latest reviewed main
  before final checks; no overlapping file ownership or simultaneous heavy tests.

The [navigation contract](expo-mobile-native-navigation-2026-09.md), now implemented and independently reviewed,
specifies native initial routes, anchored entries and freshly seeded resets to put the view list beneath the open view.
Before this navigation increment, an empty reset started My work without its view list beneath it.
The new native reset explicitly seeds that view list and focuses My work. Native behaviour, gestures and shape require device evidence. Neither read contract changes
native navigation or enables sign-in.

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

## Next foundation batch after #201/#202

All tasks (#201) and the response byte budget (#202) are merged after reciprocal reviews and all
applicable CI passed. Combined validation passed 247 mobile tests with zero skipped; #202 CI also
ran the combined mobile exports and browser suite. No deployment or native enablement followed.

Two independently reviewed contracts define the next batch; adoption is not implementation:

- [Native section navigation](expo-mobile-native-navigation-2026-09.md): Claude A owns helpers,
  call sites and tests in one isolated checkout. Claude B reviews the complete change. Source-level
  initial routes and fresh reset state put the view list beneath native defaults; device proof remains
  open. Existing warm view-list duplication and the ready remount edge are explicitly tracked.
- [Remote session revocation](mobile-session-revocation-2026-09.md): Claude B first implements the
  API/service/rate-limit increment and its real-Postgres tests. Claude A reviews it. Web and mobile
  controls follow in separate PRs after the API is reviewed. This ends other existing sessions of
  the authenticated person; it does not lock the account or cancel sign-ins in progress.

Root owns browser fixtures/checks, all serial validation, integration, documentation, CI and git.
Reviewed green PRs may merge. Any server release remains staging-only on one existing machine per
app. Native sign-in, production, signing, DNS and secrets remain untouched. No source implementation
is complete merely because a draft or agent state is ready.

### Native navigation implementation

The source changes and reciprocal review are complete; validation and remaining device gates are
recorded in [the evidence](../validation/mobile-native-navigation-2026-09-27/README.md). Native initial
routes, fresh reset state and app-initiated tab entry share one platform decision. Web history keeps
its previous behaviour. L1/L2 remain open; native sign-in stays off.

### Session controls and completed foundation corrections

The API increment merged in #204 after independent review and both CI jobs passed; native
section navigation merged in #205 after all three CI jobs passed. The API passed 219 real-Postgres
tests locally; navigation passed 254 mobile tests, four exports/scans and Chromium at all three
phone widths. Neither merge deployed or enabled native sign-in.

Claude A has implemented the web **Sign out everywhere else** control, independently approved
by Claude B. Root's real two-session browser check passes, including preflight failure, lost
responses and Next redirect handling; [web evidence](../validation/session-revocation-web-2026-09-27/README.md)
records final validation and pending CI. Claude B's separate mobile control is in review with A;
root integrated #205 and owns combined checks, exports and the synthetic browser proof. Native
build/device gates stay open. A later server release remains staging-only on the existing machines.
