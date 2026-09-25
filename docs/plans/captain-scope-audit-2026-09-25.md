# Captain scope audit — 25 September 2026

Status: audit and plan correction; documentation/issue changes only. Outcome: manage shared work
without carrying the old assistant into the new Captain. The [plan](../plan.md) is authoritative.
The user's correction supersedes the earlier conservative compatibility choices in #116 and the
24 September audit. Those were product mistakes, not requirements established by live data.

## Finding and correction

The earlier review checked consistency with the plan but failed to challenge the plan itself.
It renamed the product while retaining the old six assistant jobs, Inbox/Outbox, Obligations,
mail-derived discovery and compatibility gates. It then treated possible records as a reason to
keep those features. No useful live dataset was established. This audit corrects that premise.

| Finding | Evidence before correction | Resolution |
|---|---|---|
| Old jobs remained the eligibility test for every PR | AGENTS; plan §§1–2, D1; issue #119 | Replace with workspace outcomes: work, resources, chat, business context and follow-up. Legacy job numbers are historical only. |
| Old application retained indefinitely | Plan intro, D1/D11, §10; AGENTS; delivery plan | No target Today/Inbox/Outbox/Commitments/Notes/personal-Calendar app. Scoped old-link redirects do not preserve old UI/actions. |
| Obligations turned into a storage requirement | D7, schema prose and migration inventory D-3 | Genuine optional projects for tasks/series; review all writer/query/FK dependencies. A hidden or renamed system project does not satisfy this. |
| Unverified data became a migration requirement | Migration inventory ground rules and D-1–D-6 gates; previous audit | Recast as code/dependency inventory. Establish only actual affected state before a specific change. No assumed useful records, empty database or compulsory migration programme. |
| Retirement waited for replacements/Pip | Delivery “Migration and simplification”; inventory mail/route gates | Remove those dependencies. Captain is useful independently; personal assistance belongs to Pip. |
| Drafts and “business equivalents” restored old assistant scope | D5, §2 correspondence/chase, #119 | Keep no-autonomous-mail safety; remove Captain mail-product requirement. Shared evidence via ordinary API; Pip/provider handles correspondence. |
| Mail ingestion/discovery/index and Notes were still current decisions | D20–D23; plan §§5–8/14 | Retire triage/discovery decisions; classify old mail/note index as legacy; item discussion is D25 chat. Preserve useful engine/security infrastructure without assuming a new index consumer. |
| Mixed workflows carry hidden mail requirements | Stocktake and chase-due in plan/runbooks | Keep count/reorder and task reminder functions; remove supplier/invoice drafts and unrelated Google/inference prerequisites in implementation. |
| Retirement overlooked more than scheduler toggles | Code inventory: manual routes, events, immutable run snapshots, Gmail watch/push | Require entry-point, queued/retry/waiting/paused-run policy and audit. No claim that UI removal or one flag stops everything. |
| Personal calendar and business scheduling could be conflated | Calendar-prep/sync vs D24 and Work views | Retire provider calendar assistant; keep Work due dates, recurrence and required equipment scheduling. |
| Finished goods incorrectly required commerce ownership | D15 and plan Stock/Xero prose | Counted ingredients, consumables and finished goods; optional provider ownership per quantity, never two competing authorities. |
| New task plan sends people back to Commitments | Next batch and #131 | Proper bounded Work detail; no Open in Commitments action; concurrency protection across every writer. |
| Old first-deploy consent and support are onboarding traps | first-deploy, support, contacts and legacy runbooks | Separate Google sign-in from mail/calendar consent. Label legacy maintenance; do not enable it for workspace setup. |
| Older files proposal creates an unapproved backlog | Files proposal five tabs, annotations, outbox manifests, add-on/OCR slices | Explicit historical status: adopt provider-held DAM/version links and shared chat, not the entire earlier proposal or Embrace/Lore migration. |
| Published-looking status was stale | README, mockup docs, next batch, earlier audit | Equipment/web recovery have shipped; chat/files/mobile remain pending. Staging resumed, production paused; dated evidence stays dated. |
| “Inbox” label also appeared inside Chat | Mobile navigation documentation and proposal | Keep the approved Chat grouping label and clarify it means conversations, not email. No mockup or navigation rename is introduced. |
| Second-customer issue carried old mail prerequisites | #27 | Keep verified readiness gates; remove Gmail/calendar reconnection, batching and old Phase 4 as scope. |
| Future inference issue overpromised implementation ease | #32 “small PR later, no migration” | Retain deferred server API option, require current provider/budget/key-storage contract; schema seams do not prove effort or migration needs. |
| Legal drafts describe old product/processing | `docs/legal/` | Do not edit/publish legal text. Track owner scope revision and actual processing verification in #27 (including stale Notes/Sprite lifecycle, chat access and backup claims); drafts are not current policy. |

## Coverage ledger

All tracked planning text was inventoried, including entry points, plan references outside
`docs/plans`, and closed issue bodies/comments. Dependency/vendor/generated documentation was
excluded. Historical source and technical evidence were checked for misleading authority; this
was not a new verification of every external provider API or historical test result.

| Family | Files reviewed / treatment |
|---|---|
| Entry points | `AGENTS.md`, `CLAUDE.md`, `README.md`: correct active scope and status; CLAUDE still delegates to AGENTS. No issue/PR template with another job list was found under `.github`. |
| Product authority | `docs/plan.md`: remove legacy product specification from active scope; preserve engineering/security decisions and current delivery boundaries. Exact previous revision linked in [history](legacy-assistant-history.md). |
| All eight pre-existing plans | `captain-next-batch-2026-09-25.md`, `captain-workspace-delivery-2026-09.md`, `captain-workspace-migration-inventory-2026-09.md`: correct active requirements. `documentation-audit-2026-09.md`: explicitly supersede mistaken conclusions. `engine-decision-2026-09.md`: historical experiment with reusable D19 result. `equipment-reservations-2026-09.md`, `workspace-task-tags-2026-09.md`: delivered contracts with explicit projectless-work follow-up. `workspace-web-validation-2026-09.md`: dated test evidence, legacy expectations to replace in cleanup PRs. |
| Both proposals | `2026-09-16-files-in-place-and-workspace.md`, `2026-09-22-captain-and-pip.md`: explicit supersession of old scope/gates; retain discussion history and adopted designs. |
| Design/proof planning | Mobile mockup `README.md`, `views.md` and navigation/relationship maps; client-proof `README.md`, `evidence/README.md`: distinguish reference design, fictional harness, delivered web and unverified native acceptance. No rendered assets or executable proof changed. |
| All 18 runbooks | Legacy-only: calendar-sync, discovery, gmail-push, inbox-triage, mail-sync, question-box. Mixed legacy/current: contacts, embedding, first-deploy, shopify, stocktake, support, workflow-runner, xero. Infrastructure/security: backup-and-restore, inference-sprite, paused, web-push. Label misleading scope in the first two groups; retain current infrastructure and dated operational evidence. |
| Other repository documentation | `docs/investigations/11-pending.md`, `patches/README.md`, `infra/tofu/README.md`: historical defect/fix or infrastructure setup, not workspace scope. `docs/legal/README.md`, privacy notice and terms: owner-owned unpublished drafts, scope follow-up in #27. `packages/ui/design/README.md`, marketing README and ten core prompts: verbatim historical mirror; D14 overrides its old authority. No changes to legal text, infra or mirror. |
| GitHub | REST pagination verified **20 issues: 4 open, 16 closed** at audit start. All bodies plus the three existing comments (#11/#15/#16) reviewed. Open issue corrections below; closed issues remain historical, not a roadmap. |

## Issue dispositions

The four existing open issues remain useful after scope correction; none needs closure merely
because it predates the split. All 16 closed issues remain closed. A separate cleanup issue makes
the implementation debt actionable; documentation changes do not claim that code is removed.

| Issue | State at audit | Disposition |
|---|---|---|
| [#131](https://github.com/SomedaySomehowBeer/askthecaptain/issues/131) Work task detail | Open | Correct: no Commitments escape hatch/blanket old-route promise; optional projects, authoritative Work detail and full-writer revision checks. |
| [#119](https://github.com/SomedaySomehowBeer/askthecaptain/issues/119) Pip | Open | Correct: no Captain “shared-business equivalents” of every assistant duty; independent provider consent; Captain retention/migration not a Pip milestone. Keep Apple/Siri proofs and privacy requirements. |
| [#32](https://github.com/SomedaySomehowBeer/askthecaptain/issues/32) API inference | Open | Keep deferred business-server option; remove unsupported “small/no migration” promise and obsolete plan references. |
| [#27](https://github.com/SomedaySomehowBeer/askthecaptain/issues/27) Second customer | Open | Correct title/scope; retain security/restore/export/legal/support readiness, remove old assistant prerequisites. |
| #126 Session recovery | Closed | Reusable reliability fix delivered in #130; no scope correction needed. |
| #56 Duplicate invoice chasers | Closed | Legacy outbox fix, not a new drafting requirement. |
| #38 Usage/run tenant FK | Closed | Reusable tenant isolation, keep as history. |
| #26 Stocktake | Closed | Historical mixed implementation; counts/reorder remain, supplier drafts do not. |
| #25 Xero | Closed | Business connector remains; old brief/chaser consumers do not define future scope. |
| #24 Calendar prep | Closed | Legacy personal calendar assistance; no reopened work. |
| #23 Chase-due | Closed | Historical mixed workflow; business task reminders remain, invoice drafts do not. |
| #22 Morning brief/Web Push | Closed | Push remains; old Today/mail/outbox source selection does not. |
| #21 Materialise series | Closed | Recurrence remains, system-project dependence does not. |
| #20 Mail batching | Closed | Legacy sync implementation, not second-customer readiness. |
| #19 Gmail push | Closed | Legacy ingestion; account for webhook/watch retirement. |
| #18 Inbox triage/outbox | Closed | Legacy product, not new Captain backlog. |
| #17 Engine spike | Closed | Historical fixture; D19 runner remains, no new inbox requirement. |
| #16 Subscription inference | Closed | Business runtime remains. Comment's usage-FK follow-up delivered via #38; #32 remains deferred. |
| #15 Contacts from mail | Closed | People remains; mailbox harvesting/panels are legacy. Existing comment records delivery. |
| #11 Commitments pending state | Closed | Historical defect/fix/workaround; keep relevant form reliability, not the old screen. Comment predates closure and does not reopen it. |

Implementation follow-up: [#133 — Remove legacy assistant scope and Obligations from the Captain
workspace](https://github.com/SomedaySomehowBeer/askthecaptain/issues/133) — navigation/onboarding, runtime retirement, mixed-workflow revision, optional-project
schema/services, and Work project/recurrence handoff alongside #131. Claude reviewed its issue body with this audit. The four existing open issues have been updated
and read back to verify their title/body; #133 was created. All 16 closed issues remain unchanged.

## Review and evidence limits

Claude independently reviewed the plans, all runbooks and all 20 issue bodies, then was asked to
review the completed audit, documentation diff and proposed tracker changes for omissions and
mistaken conclusions. Claude approved the documentation and all five issue drafts after reviewing them in full. His
final refinements were applied: pin the legal drafts' historical plan citations; cover stored
Google-grant retirement as well as stopping ingestion; retain the approved Chat grouping label
while clarifying its meaning; distinguish manual staging releases from disabled automatic deploy;
and record the review outcome here. He also explicitly withdrew the unsupported live-mailbox claim.

Claude's initial findings added attention to first-deploy consent, mixed stocktake/chaser
prerequisites, Chat's ambiguous Inbox heading and embedding retirement. We did **not** adopt an
unsupported claim that specific legacy jobs are currently processing the owner's mailbox: the
staging record says existing configuration resumed, but live enablements were not inspected.
Nor does keeping possible evidence references require preserving the old product.

No live database/provider data, credentials, enabled workflow rows or production service state was
queried for this audit. No records were deleted, jobs disabled, services deployed, legal text
changed or new provider capability verified. Existing API/web still contain the legacy paths;
implementation follow-up must remove them. Staging-only authorisation and reviewed-merge permission
remain in effect; production is paused.

Validation for this documentation-only change: **149 local link targets pass**, and
`git diff --check` passes. Only Markdown files change.
Application build, Postgres suites and Playwright apply to subsequent code changes, not this audit.
Historical passing tests are not claimed as fresh runs. Markdown-only changes are excluded from
runtime CI; merge review must verify that exclusion rather than claiming tests passed.
