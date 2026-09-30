# Chat-first rebuild: audit and increments

Status: **proposed, 30 September 2026.** Companion to the
[chat-first proposal](../proposals/2026-09-29-chat-first-captain.md). The owner has decided to rebuild the client in
Expo (React Native, Expo Router) targeting web as well as iOS and Android, to retire the Next.js app, and to defer the
equipment timeline's touch gestures. This document records the audit of what exists, what carries over, what is
retired, and the order of work. Retirements listed here are recommendations until the owner confirms them.

The audit read `main` at `2d3f1ef`: every route group and service in `apps/api`, every table and migration in
`packages/db`, every package, workflow, infrastructure file, both clients, and every document. Nothing was run.

The owner's 30 September follow-up adds the
[private-call and selective-undo contract](private-threads-and-selective-undo-2026-09.md) and the
[checked-in prototype export](../proposals/assets/captain-chat-first-2026-09-30/README.md).

## 1. What carries over

| Area | Keep as is | Adapt |
|---|---|---|
| Auth | Google sign-in, passkey step-up, session revocation, the native PKCE handoff (dormant) | Add a browser session for the Expo web build (§3) |
| Organisations | Organisations, memberships, invitations, export, deletion | Agents become members (§3) |
| Work | Tasks, projects, series, evidence, the hourly series routine, revision preconditions (0039) | Rename from `commitments`; strip the legacy columns and statuses; tags on every record; projects as tags |
| Equipment | Equipment, reservations, database no-overlap rule, revisions, cancellation | Add `pending` to the status check and to the no-overlap predicate |
| Stock | Items, append-only counts, Shopify and Xero cached reads | Counts become versioned writes; stocktake becomes the Stock keeper's job |
| Inference | Sprite runtime, budgets, `infer()` with schema-checked output | Add the cheapest tier for the classifier and image input for worksheets |
| Workflows | pg-boss engine, transactional enqueue, journal, catalog DSL | Run model gains agent keys, chain origin, loop stop and chain budget; drop the six-job field and the retirement fence |
| Push | Web Push subscriptions and delivery journal | Re-prove on the Expo web export |
| Connectors | Xero and Shopify reads, envelope encryption | Google Drive connector is new; Xero writes are new when a Bookkeeper needs them |
| Mobile logic | Transport and byte budget, account reducer and read scope, stock parser, the equipment data layer (parsers, zone, range, geometry, cells, catalogue, coordinator), boundary guard, harness pattern | Account composition gains a web branch; equipment parsers gain `pending`; harness scenarios are rewritten |
| Infrastructure | OpenTofu (Neon, Cloudflare, monitor), Sprites bootstrap, API Fly and Docker, `mobile.yml`, `tofu.yml`, `backup.yml` | DNS for the web build; `ci.yml` and `deploy.yml` lose their Next.js jobs |

## 2. What is retired

Nothing below is needed by the chat-first product. Each item is a deletion in a reviewed pull request; data-bearing
items wait for a live count.

| Item | Why | Path |
|---|---|---|
| The Next.js app | Replaced by the Expo web export | `apps/web/`, `patches/next@15.5.25.patch`, `pnpm-workspace.yaml` patched dependency |
| Next.js Playwright suites | Test pages that will not exist: 10 specs and 16 scripts, about 3,100 lines | `apps/e2e/tests/*` except the API part of `smoke.spec.ts`; `apps/e2e/scripts/*` except `mobile-shell-*` |
| The `chat-browser` CI job and `react-retry` | Both build Next.js | `.github/workflows/ci.yml` |
| `packages/ui` | Only Next.js imports it; the Expo app may not (boundary guard). Logo, icon and splash assets move to `apps/mobile` | `packages/ui/` |
| `packages/retrieval` | Empty, untracked remnant on disk | `packages/retrieval/` (local `rm`) |
| The client-proof harness and its workflow | Superseded by `apps/mobile` | `docs/proposals/assets/captain-client-proof-2026-09-23/`, `.github/workflows/client-proof.yml` |
| One-off retirement workflows and scripts | Ran on 26 September; the runbook records them | `.github/workflows/reconcile-retired-output.yml`, `retire-elevated-runtime.yml`, `.github/scripts/` |
| Engine test fixture and retirement test | The fixture is the retired `inbox-triage` v7 with reply drafting; the runner is proven against it | `packages/engine/test/legacy-definition.ts`, `retirement.test.ts`, `retiredWorkflowVersions` |
| The six-job field and retired-workflow fence | Assistant vocabulary | `packages/steps/src/{definition,validate}.ts`, `workflow_definitions.job` |
| 410 stubs | Exist only to say the assistant is gone | `apps/api/src/retirement/`, `apps/api/src/connections/routes.ts`, `/webhooks/gmail`, the mail and calendar paths in the rate limiter |
| Legacy work fields | `projects.stage`, `brief*`, `proposed_*`, `accepted_*`, state `proposed`; `tasks.status 'suggested'`; `source_kind` `mail`/`note`; `evidence.kind` `mail`/`note`; `Brief`/`briefTasks`/`overview()` in the service | `apps/api/src/commitments/service.ts`, migrations 0002, 0029, 0032, 0033 (needs a live count) |
| 0037 leftovers | Enablement and run rows for `inbox-triage`, `discover-projects`, `calendar-prep`, `morning-brief` | `workflow_enablements`, `workflow_runs` (needs a live count) |
| Three-tab navigation | Replaced by one list of threads | `apps/mobile/src/navigation/`, `components/TabBar.tsx`, `ViewList.tsx`, `SectionStack.tsx`, `src/app/(tabs)/**`, `account/tab-entry.ts`, the navigation half of `copy.ts`, every harness scenario and browser check for tabs |
| Links to the website | The target is retired | `apps/mobile/src/config.ts` `webPaths`, `webLink`, every "on the website" notice |
| Saved views (D26) | The proposal has a fixed filter list | `apps/api/src/views/`, `saved_views` (needs a live count), web `saved-views.ts`, `DraftBar`, `SaveViewForm`, `ManageView` |
| Chat item panels | The latest-six panel is superseded by the record thread | web `components/chat/*` (dies with Next.js); the panel read API |
| Validation records for retired screens | Dated evidence; git keeps history | `docs/validation/{chat-web,work-design,project-overview,project-history,tag-views,equipment-scroll,session-revocation-web,sign-in-return,mobile-*}` |
| Local untracked state with a plaintext key | `infra/tofu/.terraform/terraform.tfstate` holds the Tigris access key | delete locally |

Kept as history, not authority: the 2026-09-22 mobile mockups (D14 moves to the chat-first prototype), the
delivery plan and batch plans, the linked-chat and work-record contracts, the files-in-place proposal.

## 3. Decisions

The owner decided items 1 to 4 on 30 September 2026 as recommended. Items 5 to 7 are recommendations still.

1. **Web session.** The API accepts only a bearer token and has no CORS; the cookie lived in Next.js. Options: (a) the
   API serves the Expo web export from its own origin and issues an HttpOnly cookie session, with a CSRF check; (b) a
   static host plus CORS and a token held by the page. **Decided: (a).** One origin, no token in page storage, one
   fewer service. The `app` CNAME then points at the API.
2. **Agents as principals.** Every RLS policy resolves `current_user_id()` through memberships. Options: a separate
   agents table touching every policy, or agents as users with `kind = 'agent'` and long-lived revocable keys in
   place of sessions. **Decided: agents are users.** The policies, memberships and audit paths carry over unchanged.
3. **Threads.** The 0042/0043 chat tables enforce participant-only privacy with about a thousand lines of triggers and
   definer functions. Record threads need audience-by-record. Options: bend the guards, or one new thread model
   (`threads` of kind record, topic or private; `thread_messages`) with private threads keeping the participant rules
   and `chat_audit_events`, and the small staging chat data migrated. **Decided: the new model.** Retire 0042/0043
   after migration; two message stores would be a carry-over. Shared pins and personal stars carry into the new
   model; the item panel read API does not. Existing participant-only chats remain private even
   when linked to shared records. A private thread bypasses classification except for explicit
   agent mentions, which expose only the calling message and never grant history access.
4. **Saved views.** Retire, per the proposal's fixed filters, or keep as private filters over the thread list.
   **Decided: retire.**
5. **Passkeys and Web Push.** Both continue on the Expo web build (WebAuthn and a service worker exist there); native
   push is a later increment. **Recommend keep both.**
6. **Stocktake and reminders workflows.** They are live definitions; the proposal makes them the Stock keeper's and
   Scheduler's jobs. **Recommend keep running until those agents land, then retire the definitions.**
7. **Live counts** before any data-bearing deletion: legacy work fields, 0037 leftovers, `saved_views`. A read-only
   staging audit, as in September.

## 4. Order of work

Each increment is small pull requests with the workspace outcome named. The first three retire the old surface
while the new one becomes usable; nothing deploys to production.

| # | Increment | Delivers | Retires |
|---|---|---|---|
| R0 | Adopt | Plan amendment (D27–D38 and edits), AGENTS.md, this document | The client-proof asset and workflow, one-off workflows, engine fixture, `packages/retrieval`, validation records for retired screens |
| R1 | Web session and shell | API serves the web export and cookie sessions; Expo web signs in; an empty thread list; passkey step-up and push re-proved | `apps/web` and its CI, `packages/ui` (assets moved), `webPaths` |
| R2 | Threads | [Contract](threads-2026-09.md). The thread model (decision 3); the thread list grouped by tag; a record thread with the small card, oldest-first, folded earlier messages, open at first unread; the composer | 0042/0043 after migration; item panels; three-tab navigation |
| R3 | Versions and selective undo | Snapshots plus typed before/after changes, change sets and causes; selection/preview, dependency and conflict checks, atomic retry-safe inverse operations; see the privacy/undo contract | The audit log as a state store (stocktake idempotency, Xero sync state move to their own tables) |
| R4 | Captain reads | Agents as users with keys; the Captain agent; the classifier as an `infer` step for shared messages; private mentions expose only the calling message; tags and kind applied as plain changes; mention routing | `commitments` naming, legacy work fields, the six-job field |
| R5 | Pending and approval | `pending` bookings holding the slot; approval cards; take-ownership privilege; the equipment schedule as a pinned view with buttons only | Saved views |
| R6 | First agents | Scheduler and Stock keeper doing internal work; hand-off chains with loop stop and budget; agent approval limits | `chase-due` and `stocktake` definitions |
| R7 | Files | Drive connector; marker files; change notices in the thread | — |
| R8 | Worksheets | Templates, print codes, scan pipeline, photo storage | — |
| R9 | Outside messages | Send as the owner; shared sending address; agent approvals within limits | — |

## 5. Gates that stay honest

- The Expo web export is browser evidence; iOS and Android remain bundle evidence until there is an Apple developer
  account and a device.
- The equipment timeline ships with scale buttons and native scrolling only. Pinch and custom pan are a later
  increment that names its dependency (D38).
- A screen touched by a change gets a Playwright check on the Expo web export. Business writes
  retain versions and typed changes; selective reversal preserves unrelated later edits and
  explains conflicts and irreversible effects. Private calls expose only the invoking message.
  No outside action bypasses approval.
