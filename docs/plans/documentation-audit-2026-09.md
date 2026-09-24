# Documentation and CI review — 24 September 2026

Jobs advanced: **own commitments** and **brief and answer**. #116 adopted the Captain workspace
amendment. This review aligns the documentation with that direction while distinguishing the
retained implementation, planned capabilities and historical proposals.

Captain is the shared business workspace: **Work, Chat, Resources**, flat tags across projects and
people, essential equipment scheduling, linked chat with shared pins and personal stars, and
provider-held files/accounting. Pip is the separate personal assistant tracked in
[#119](https://github.com/SomedaySomehowBeer/askthecaptain/issues/119). Captain does not wait for Pip.
Expo mobile and retained Next.js web are the adopted implementation direction; native-device
acceptance remains open. The existing five-tab assistant and its data survive until replacement
slices are ready. The [production pause](../runbooks/paused.md) remains in force.

## Coverage and corrections

Claude in Monitor read all non-generated repository documentation; final review checked proposed
corrections against code and removed claims that source configuration could not substantiate.
Historical records retain their original bodies with dated status notes where needed.

| Family | Coverage | Result |
|---|---|---|
| Entry points | `README.md`, `AGENTS.md`, `CLAUDE.md` | README now introduces the workspace/Pip split and distinguishes existing from planned functionality. AGENTS lists engine, retrieval and e2e packages, absent `apps/mobile`, and separates first-customer policy from historical phase numbers. CLAUDE's delegation to AGENTS remains correct. |
| Source-of-truth plan | `docs/plan.md` | Mark #116 adopted; distinguish ordinary record writes from workflow automation; label legacy web and future native client. Record configured hosting/pause without claiming live availability or Cloudflare proxying. Label future tables and #117's open status. Correct the triage example's historical status, backup readiness, phase/slice numbering and D10's resolution by D19. No new product decision or migration is introduced. |
| Delivery/migration plans | `captain-workspace-delivery-2026-09.md`, `captain-workspace-migration-inventory-2026-09.md` | Mark adopted, record slice status, link Pip #119 and client-proof CI #120, preserve retirement/retention gates. Tags remain in open #117; equipment, chat, saved views and production native clients are not claimed as implemented. Identify configured external callers separately from in-process schedules. |
| Earlier engine plan | `engine-decision-2026-09.md` and its evidence text | Dated decision/evidence remains applicable; no revision needed. |
| Open task-tags plan | `docs/plans/workspace-task-tags-2026-09.md` on #117 | Reviewed as proposed work, not merged state. Stable-ID labels, any-selected-tag matching, AND across filter types, tenant isolation/audit, and retained Obligations/default storage agree with D7. #117's obsolete stacked-PR instructions were removed; it now targets main. |
| Product proposals | `2026-09-22-captain-and-pip.md`, `2026-09-16-files-in-place-and-workspace.md` | Add dated adoption/supersession notes. The split feeds adopted D1/D7/D8/D11/D14/D23–D25; Pip implementation is #119. The earlier files proposal is not adopted in full: generic record parts and old file-comment assumptions do not override the current plan. |
| Mobile mockup documentation | `README.md`, `views.md` and linked navigation/relationship maps | Mark mockups as the adopted design reference while retaining fictional/not-implemented status. Maps show the three sections, grouped view lists and links among shared records. No asset/design change needed. |
| Client proof documentation | proof `README.md`, `evidence/README.md` | Document #120's CI coverage and explicit headless mode. The 23 September evidence remains a dated record of what was tested then; new CI evidence is below. No native build, performance or transactional booking claim is added. |
| Runbooks — all 18 | backup-and-restore, calendar-sync, contacts, discovery, embedding, first-deploy, gmail-push, inbox-triage, inference-sprite, mail-sync, paused, question-box, shopify, stocktake, support, web-push, workflow-runner, xero | Keep accurate legacy-operation instructions. Correct triage version 5 → 7 and implemented discovery wording, Sprite disconnect behaviour and the now-existing usage/run FK, and legacy Calendar navigation. Note paused deployment/backup instructions. Qualify external monitoring, remove Nango as an assumed Captain connector, and avoid a blanket no-data-loss claim for missed webhooks. |
| Investigation and patches | `docs/investigations/11-pending.md`, `patches/README.md` | Accurate historical diagnosis and renderer-regression instructions; unchanged. |
| Infrastructure documentation | `infra/tofu/README.md` | Read against DNS/monitor configuration. Setup instructions remain; current scope/pause clarifications live in the plan and pause runbook. No file under `infra/tofu/` changed, avoiding a remote infrastructure run from this documentation PR. #120 separately excludes Markdown from its path triggers. |
| Legal — review only | `docs/legal/README.md`, privacy notice, terms of service | Retain unpublished drafts and owner/lawyer decisions; scope update needed below. No legal text or publication changed. |
| Design mirror — audit only | `packages/ui/design/README.md`, marketing README, ten core component prompts | Retain the verbatim legacy mirror. Its old authority statement is superseded by D14 and AGENTS; no hand edits. |
| Generated/vendor material | Dependency documentation under `node_modules` and `.terraform` | Excluded from project documentation changes. |

## CI findings and repairs

[#117's reviewed run](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/35946108213)
passed in **4m13s**, with no skipped workspace tests. The preceding run passed in about four
minutes; the run was not stuck. Container setup took 24 seconds, typechecking 22 seconds, workspace
tests 157 seconds (API approximately 93 seconds, engine 37 seconds), and browser setup/check 29 seconds.

The repair is [#120](https://github.com/SomedaySomehowBeer/askthecaptain/pull/120):

- Stream Turbo output while tests execute. Previously each package's output arrived in one batch,
  making the long API run appear idle. Keep real-Postgres tests uncached and serial by package;
  do not remove coverage or change durable-workflow timings to manufacture a faster result.
- Retain browser failure evidence for seven days, and explicitly restrict CI token permissions
  to read-only repository contents.
- Add a separate path-filtered workflow for the executable Expo proof excluded by the existing
  blanket `docs/**` filter. Check locked installation, typecheck, five logic tests, all-platform
  bundle exports and headless browser behaviour without affecting the production workspace.
- Exclude Markdown-only `infra/tofu/` edits from infrastructure plan/apply triggers. Previously a
  README edit could invoke a remote plan and an apply on merge. No infrastructure run was invoked
  to test this change; actionlint validates workflow syntax.
- Repair the paused backup's demonstrated version mismatch: its
  [22 September failed run](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/35776262865)
  used pg_dump 16.15 against server 18.6. Pin dump/restore/query executable paths to PostgreSQL 18,
  and replace the plain restore image with `pgvector/pgvector:pg18` for migration 0030. A local
  throwaway rehearsal restored 31 migrations, 58 RLS policies and exact vector data. Backup
  remains disabled; this is not a rehearsal of the actual hosted database or credentials.

The first repaired [workspace run](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/35947471409)
and [client-proof run](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/35947471505)
passed. The proof run verified clean installation, exports and the headless branch. This is
an observability/coverage repair, not a measured wall-clock speedup. Later workflow-fix commits
receive their own workspace and proof CI runs; #120 carries the final check results.

## Remaining decisions and release work

1. **Migration and retirement.** Inventory decisions about personal mailbox data, credentials,
   retained stock/business context and file records remain open. Additive workspace work can
   proceed; deleting or retiring stores requires a reviewed migration and rollback.
2. **Device acceptance.** iPhone/Android gestures, keyboards, navigation, accessibility and measured
   performance remain delivery gates. Pip's Apple entitlement, Siri, Focus and multi-device proofs
   are separate in #119. Exports do not satisfy either product's native acceptance.
3. **Backups/resume.** Review/merge #120's tested tool/image repairs before the owner resumes backups.
   The manual drill ledger is empty. A production cutover must also verify application-role grants:
   the current portable dump/restore omits ACLs, and already-recorded migrations do not reapply
   grants. The automated rehearsal checks restoration/counts, not application access. Cloud
   credentials, actual archive contents and an application smoke check belong to the owner-run
   drill; no paused operational workflow was invoked here.
4. **External monitor.** `uptime.tf` configures a 30-minute `/readyz` check with alerts. Its actual
   enabled/paused state was not inspected. The owner can check it with the other resume controls;
   configuration alone does not establish current alerts or availability.
5. **Legal drafts.** Drafts describe the retained assistant. Their product/data scope needs review
   for shared chat/equipment and the separate Pip product before publication. P/T decisions
   remain the owner's. This review does not replace or relax plan §9 or the delivery release gates.
6. **Design history.** The mirror's old authority text and older files proposal are retained
   history, not competing implementation instructions. Follow D14/D25 and the current delivery
   plan; reconcile file-version review/retention in the files slice.

## Validation and evidence limits

The review used tracked code, SQL migrations, workflow definitions, Fly/OpenTofu configuration,
the pause record and read-only GitHub PR/run/workflow metadata. Sprite existence is recorded in
the pause document; current readiness was not tested. No production database, service, secret,
infrastructure state or monitoring account was queried. GitHub confirmed `deploy` and `backup`
disabled, `ci` and `tofu` active on 24 September.

Documentation validation checks relative link targets and `git diff --check`. No application
route or schema changed in this documentation PR, so no extra application build, database suite
or page-specific Playwright run is claimed for it. CI/proof validation belongs to #120: actionlint
1.7.12 passed all four changed workflows, workspace typecheck passed (10 cached packages), local
proof typecheck/5 tests/exports passed, and shared-Chromium checks passed at 390px and 1280px with
no page errors. Hosted runs above supply fresh workspace/Postgres and headless-browser evidence.

Apple's [PCC documentation](https://developer.apple.com/documentation/FoundationModels/adding-server-side-intelligence-with-private-cloud-compute/)
was checked on 24 September: eligible apps can use PCC through Foundation Models with a managed
entitlement and daily usage limits. The plan/proposal correctly retain device execution requirements;
neither an arbitrary Captain server endpoint nor execution with all devices off was established.
