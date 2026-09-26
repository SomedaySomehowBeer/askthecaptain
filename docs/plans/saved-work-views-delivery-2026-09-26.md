# Saved Work views: implementation assignments

Status: assigned on 26 September 2026; implementation and validation pending.
Workspace outcome: **manage shared work**. Tracking: #141, under D26 and the
[contract adopted in #140](saved-work-views-2026-09.md). This is the next feature
increment after the #149/#150 calendar and task-history corrections.

A person can save a useful combination of Work filters, return to it from the Work view list,
and change or delete it without losing task context or overwriting another edit.
Work still defaults to open tasks assigned to the person. Views are private within an organisation.
Shared views, new filter vocabulary, search, Chat, Files/DAM and Expo are separate increments.
There are no new dependencies, model calls or background processes in this slice.

## Two parallel assignments

Both implementers use **Claude Opus**, in separate worktrees based on `55122b9`.
Codex owns this delivery document, coordination, commits, PRs, integration and release.

| Assignment | Owned files | Required deliverable |
|---|---|---|
| Opus A — storage/API | `packages/db/**`, `apps/api/src/**`; API test helpers only when required, excluding `apps/api/test/workspace-fixture.ts` | One new migration, Drizzle schema/exports, service/routes, privacy-safe audit/export and real-Postgres regression tests |
| Opus B — Work web | `apps/web/**`, new `apps/e2e/scripts/saved-views-check.cjs` | Saved views list, save/rename/delete, saved-versus-draft navigation, conflict/uncertain-save states, pure URL/filter tests and browser scenarios |
| Codex — integration/proof | This document, shared local browser fixture, validation/release records | Contract integration, full review, serial test/build execution, populated screenshots, CI and staging rollout |

Agents do not edit each other's worktrees or shared integration files. They may read each other's
handoff. They leave changes uncommitted for Codex to review and split into the two planned PRs.
Each first reviews the assignment against the adopted contract and reports ambiguities before
inventing a different interface. No schema or UI shortcuts to make one side appear complete.

### A. Storage/API

Implement contract §§2–6, 8 and 11. Reserve the next migration number only after checking the
current migration list; never edit a merged migration. Register the service in the real app.

- Forced RLS requires the owning user and active membership. Other members, including admins,
  cannot see private views. Runtime gets no physical DELETE privilege.
- Immutable identity, revisions and content-clearing tombstones protect retries from resurrection.
  Enforce normalised names, the 50-live-view cap under a membership-row lock, and concurrent edits.
- Strictly validate the existing four-key filter; normalise UUIDs/tags and reject unsupported keys.
  Validate referenced tags/projects at save time, including archived projects where allowed.
- Implement bounded list/detail/create/patch/tombstone endpoints and exact contract error codes.
  Preserve same-ID create retries; hidden ID conflicts never reveal someone else's data.
- Resolve reference names in bounded batches, separately from reading the saved record. Missing
  or unavailable references never remove a filter term. Newer versions remain inapplicable.
- Audit only view identity/version/revision. Owner/admin exports contain only the exporting person's live views.
  Prove removal/reactivation, account/organisation cascades and content-free tombstones with SQL
  using the real non-bypassing runtime role.

### B. Work web

Implement contract §7 and its browser acceptance cases against the agreed API, using the reviewed
workspace mockups and existing components. It can be authored before the API is ready; integration
and release wait for the real backend. Do not ship a mock store or fabricated saved records.

- Replace the Saved filters placeholder with a paged Saved views group. Add Save this view and
  open/rename/delete controls with useful empty, loading, failed, disabled and saving states.
- `/work?view=<id>` applies exactly the stored filter. Mixed saved/filter URLs are explicitly
  inconsistent. Unknown, deleted, inaccessible or newer-version views never fall back silently.
- A draft retains its original `base` revision and explicitly carries every filter value, including
  cleared tags/project, through filter changes, paging and browser history. Provide Save changes,
  Save as new view and Discard. Compare the draft with the latest saved filter after a conflict.
- Keep a create ID and normalised payload through uncertain outcomes. Lock ambiguous inputs;
  reconcile or explicitly retry that identity. Generate a fresh ID only for an explicit new save.
- Preserve existing task completion, keyboard confirmation, parent navigation, tags and the
  three-tab shell. Keep unavailable reference labels distinct from missing references.
- Add pure draft/URL tests and a browser script covering two-tab edits, explicit clears, uncertain
  saves, create/open/rename/delete, retained filters after name lookup failures, revoked access
  and phone/desktop layout. Codex supplies fixture fault injection and runs the real checks.

## Interface coordination

The adopted contract defines endpoint paths, payloads, limits and errors. Neither agent changes
those independently. List rows omit references. Successful create/update responses use the saved
record shape, not a new wrapper; create returns 201 or 200 for an identical retry.

For the reference-failure case left structurally open by §6, preserve its normal array/object shape:

- `references.tags` is an array of `{ id, state: 'available', name }`, `{ id, state: 'missing' }`
  or `{ id, state: 'unavailable' }`. A failed batch marks each selected ID unavailable.
- `references.project` is `null` for no project, otherwise `{ id, state: 'available', name,
  projectState }`, `{ id, state: 'missing' }` or `{ id, state: 'unavailable' }`.
- Inapplicable/newer-version detail returns `references: null`; the client checks applicability
  before reading references or parsing the filter.
- `reason` is `null` when applicable, otherwise an explanatory string. A newer-version filter is
  untrusted/unknown to the old client and must not be cast into the version-1 shape.

This specifies failure representation without changing the contract's permissions or filtering.
Organisation-deletion counts omit private saved views rather than report the deleting owner's
RLS-limited count as an organisation total; the cascade still deletes all rows. The existing
owner/admin export permission stays intact, with each exporter seeing only their own live views.

Agents report any mismatch in their handoff; Codex resolves it in the reviewed contract before
merging dependent code. No new shared package is needed.

## Review and acceptance gates

1. **Parallel implementation:** each agent reports changed files, contract choices, tests written,
   outstanding concerns and a handoff. Writing tests does not claim they have run.
2. **Backend PR:** Codex reviews A's schema/service; B independently reviews its interface/privacy.
   Run typecheck and real-Postgres tests for RLS, exports, retries, deletion, references and races.
   Merge the reviewed backend with green CI before merging the web PR.
3. **Web PR:** rebase B onto the merged backend. Codex reviews the UI; A independently reviews
   API use, draft revisions, missing references and uncertain writes. Run production build and
   real API/Postgres browser checks, preserving the existing Work regressions. Capture populated
   360/390/430/1440-pixel screens against the approved designs.
4. **Release:** after both PRs are reviewed and green, deploy only to staging, using the existing
   single API and web machines. Apply the one migration under the existing staging procedure;
   no extra release machine or legacy reset. Preserve the demo and production pause. Record exact
   source/images, migration result, health checks and hosted-auth limits in the release record.

Codex runs one heavy test/build at a time under `flock /tmp/atc-build.lock`; the two implementers
must not start builds, package installs or database tests concurrently. No agent deploys, migrates
hosted data, changes secrets or sends external messages. Native-device acceptance remains separate.

## Completion ledger

- [x] Both Opus agents started and model selection verified (`claude-opus-5-5`).
- [ ] Backend implementation and reciprocal review complete; real-Postgres checks green.
- [ ] Web implementation and reciprocal review complete; integrated browser checks green.
- [ ] Two implementation PRs merged with green CI.
- [ ] Staging migration/deployment verified and recorded; #141 updated with actual results.

## Running assignments

- **Opus A:** `Captain saved views API`, background session `5b494281`, worktree
  `/tmp/captain-saved-views-api`, branch `feat/saved-views-api`.
- **Opus B:** `Captain saved views WEB`, background session `fc139db6`, worktree
  `/tmp/captain-saved-views-web`, branch `feat/saved-views-web`.

Both were observed working, and their actual assistant-message model was verified as
`claude-opus-5-5`. Supervision uses `claude agents`, `claude logs <id>` and `claude attach <id>`.
Initial plan-review checkpoints and final handoffs are in `/tmp/captain-saved-views/` as
`api-status.md`, `web-status.md`, `api-handoff.md` and `web-handoff.md` when written.
These local session details are execution evidence, not shipped functionality.

Both agents completed their initial plan reviews with no blocking findings. The review corrected
the contract's outdated export-role description and clarified unsupported-version references and
private deletion-count handling before implementation review.
