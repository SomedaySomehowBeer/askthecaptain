# Captain implementation inventory and scope cleanup

Status: corrected 25 September 2026. Supersedes #116's compatibility and retention gates.
The [first code retirement](assistant-runtime-retirement-2026-09.md) implements removal of the
assistant UI/runtime/API paths and revises task/stock workflows. Rows below record the audited
starting state and remaining cleanup contracts; they do not claim every listed source file remains.
Outcome: manage shared work without keeping the old personal-assistant application.
The [plan](../plan.md) decides product scope; the [audit](captain-scope-audit-2026-09-25.md)
records why this inventory was corrected. The [original inventory](legacy-assistant-history.md)
is preserved as history, not an active migration mandate.

## Evidence boundary

This inventory describes schema, services and trigger paths in the repository. It is **not a live
data audit**. Useful customer records, pending drafts, provider connections, enabled definitions
and waiting runs have not been counted. “Existing business data” was an unverified assumption,
not evidence supporting a migration requirement. Neither “there is useful data” nor “there is no
data” follows from the presence of tables.

Remove legacy product requirements now. When an implementation change affects actual stored state,
check that bounded dependency and specify its treatment. Do not require a whole-database migration
programme, Pip release, replacement inbox or owner product decision already settled by the split.
This documentation change deletes no records, disables no jobs and changes no credentials.
Irreversible deletion is separate from removing a route or stopping a writer.

Production remains paused. Staging was authorised and resumed on 24 September, with at most one
machine per app. The [operational record](../runbooks/paused.md) supersedes the original inventory's
blanket “nothing may resume” language. Backups remain a separate operation; #120 fixed tooling
and rehearsed a local fixture, not the hosted database or its application-role grants.

## Product and code disposition

| Area and code evidence | Target / required work | What does not follow |
|---|---|---|
| `projects`, `tasks`, `task_series`; `apps/api/src/commitments/`; migrations 0002/0032/0033 | Reuse legitimate work services. Deliver Work detail/projects/recurrence. Remove mandatory project and `system_kind = obligations` dependence through reviewed schema/services. Audit all writers, checklists, tags and booking references. | A folder name or NOT NULL constraint is not a product requirement. No hidden/renamed Obligations project. |
| Tags 0035 and equipment 0036 | Keep their integrity, access and audit contracts. Update eligibility/joins when project becomes optional. | Optional projects must not exclude tasks from tag lists or equipment links. |
| `evidence.reference` is text, including legacy mail/note IDs | Keep shared evidence source identity. For an affected real reference, use an authorised provider locator, explicit mapping or honest unavailable state as appropriate. | No blanket guarantee that all old URLs/rows are needed, or that deleting a table is harmless. |
| `notes`, `note_triage`; `apps/api/src/notes/` | Notes UI/triage is legacy. Item discussion uses one D25 conversation identity. Review an actual evidence dependency before changing its source. | No automatic conversion into chat, fabricated messages or requirement for Notes to remain a product. |
| `mail_*`, `mail_triage`, `sent_triage`, `mail_senders`, `outbox`, `attachment_text` | Retire mailbox sync, triage, drafting and send surfaces. Deliberately shared business correspondence enters normal APIs. Preserve expiry while any temporary extraction cache exists. | No business-mailbox loophole, replacement-inbox gate, auto-send, or assumed pending drafts. |
| `content_vectors`, thread/note vectors; retrieval/index routines | Retire old mail/note ingestion. Future business retrieval needs its own source/access contract. | Do not transfer vectors to Pip or keep private mailbox ingestion merely to justify an embedding service. |
| `calendars`, `calendar_events`; Google sync/preparation | Retire personal-provider calendar product. Keep task due-date views, equipment planning and business recurrence. | A Work Calendar presentation is not continued personal calendar sync. |
| `contacts`, `companies`; hand edits and Xero references | Keep shared counterparties; detach mail-derived upkeep and “recent private threads” presentation with mailbox retirement. | Google mailbox harvesting is not required for People. |
| `xero_*`; `shopify_*`; `stock_items`, `stock_counts` | Keep Xero accounting context, optional commerce caches and counted inventory for ingredients/consumables/finished product. One explicit authority per quantity. | Shopify is not mandatory for finished goods; email drafting is not required to count stock or create reorder tasks. |
| `connections`; Google OIDC and inference credentials | Keep approved business connections and auth. Separate Google sign-in from Gmail/Calendar provider scopes. Stop use of retired mail/calendar grants and prepare explicit owner-approved revocation/disconnection after checking actual consent and disconnect side effects; do not leave unused credentials live by default. | No blind revocation of login/other valid scopes, credential copying into Pip, or assertion that an account is connected. |
| Runner, enablements, immutable runs/steps, pg-boss schedules | Reuse engine for shared business workflows; retire/revise definitions below with trigger and in-flight policy. | Removing UI or registry handlers alone does not stop schedules, events or existing run snapshots. |
| `briefs`, `answers` and their JSON source references | Shared business summaries/questions need revised authorised sources and destinations. Treat old results as legacy content if affected. | Do not relocate Today unchanged or claim old sources are valid new scope. |
| Identity, RLS, audit, export/deletion, push | Keep and extend these foundations. New tables must join export/deletion/access tests; native push has a separate contract. | No need for Pip-side deletion to implement Captain lifecycle; no automatic cross-product deletion. |

## Runtime retirement coverage

| Path | Required retirement or revision |
|---|---|
| `inbox-triage` v7 | Retire scheduled, mail/note event and manual entry points; handle immutable pending runs |
| `discover-projects` v1 | Retire candidate/seeds/discovery scheduling and UI; not a source of future Work requirements |
| `calendar-prep` v1 | Retire preparation workflow and Google cache ingestion |
| `morning-brief` v2 and synchronous answers | Replace source selection only through a shared-business contract; remove Today/mail/outbox/personal-event assumptions |
| `chase-due` v3 | Separate task reminders/escalation from invoice-draft branch; remove Google/outbox dependency from retained business behaviour |
| `stocktake` v2 | Keep count requests and reorder tasks; remove supplier drafts and unnecessary Google/inference prerequisites |
| Series routine | Keep task materialisation; remove system-project requirement; no duplicate generator |

Repository startup paths to cover in a retirement PR:

| Routine | Existing switch / trigger |
|---|---|
| Workflow runner | `WORKFLOWS_DISABLED=1`; schedules, event enqueue, manual starts and continuation jobs |
| Mail sync | `MAIL_SYNC_DISABLED=1`; manual/API sync must also be accounted for |
| Gmail watch renewal/push | `GMAIL_PUBSUB_TOPIC`/`GMAIL_PUSH_AUDIENCE`, webhook receipts and watch renewal; no global off flag in original inventory |
| Calendar sync | `CALENDAR_SYNC_DISABLED=1`; manual/API sync too |
| Retrieval fill | `INDEX_DISABLED=1`; after-sync/note hooks too |
| Series | `SERIES_DISABLED=1`; retains business purpose |
| Xero / Shopify | Their own `*_SYNC_DISABLED` flags; retain business purpose independently of mail |
| Attachment expiry | Hourly cleanup, no original off flag; preserve expiry while cache exists |

These are code capabilities, not confirmation any particular job/account is enabled live. Review
current entry points in the implementation PR rather than assuming a flag stops every manual or
event path. An isolated fixture uses synthetic data, disabled outbound routines and no provider
credentials. It is not a second live scheduler.

## Next implementation sequence

1. Remove legacy navigation/onboarding and specify redirect/retired states. Keep valid Work,
   equipment, stock, people and account access; no “Open in Commitments” escape hatch.
2. Retire assistant definitions/routines and adapt mixed business definitions with explicit queued,
   waiting, retry and paused-run handling. Inspect affected operational state before the staging
   change; cancel/drain with an audit trail, no unintentional replay or automatic sending.
3. Remove Obligations storage dependence and allow genuine projectless tasks/series. Review one
   migration with every affected read/write, RLS/FK/checklist, tags, equipment and export contract.
   The plan does not preselect a destructive rewrite or assume any rows need migration.
4. Deliver bounded Work task/project/recurrence surfaces and access/revision tests, then continue
   saved views, chat and native work. Reuse authoritative records and services where they fit.

For an actual incompatible data/schema change, record the affected rows/references, backup/rollback
or forward-recovery method and any required irreversible-action approval. An application rollback
can leave additive tables intact; a destructive inverse migration is not a universal requirement.
Runtime retirement and data deletion are distinct operations. No step waits for Pip.
