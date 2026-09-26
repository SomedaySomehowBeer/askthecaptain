# Linked chat core validation — 27 September 2026

Outcome: discuss work (D25), under the repaired D6 runtime role. This is PR B: conversations,
participants, plain-text messages, task/project links and private audit. Pins, stars, read positions,
message edits, browser chat and inference remain later increments. This record does not claim a
usable Chat tab or a signed-in browser check.

## Local checks

All database-dependent checks used disposable databases on the local pgvector/PostgreSQL 18
container, with migrations run as owner and application operations through SQL-created
`captain_runtime`. Heavy commands ran serially under `/tmp/atc-build.lock`.

- DB chat and schema-policy checks: 30 passed, zero skipped. Includes actual-role identity,
  privilege parity, forced RLS, nonparticipant/foreign-tenant refusal, transitions, server
  timestamps, commit-time sequence integrity, leave rollback, concurrency and deletion cascades.
- Full workspace `pnpm test --log-order=stream`: 395 passed, zero failed/skipped, 8 packages,
  no cached test runs. The suite includes queue/workflow and existing Work/resource regressions.
- After the final chat database-error redaction: API chat, app and lifecycle suites rerun against
  Postgres, 27 passed, zero skipped. The forced unknown-constraint case remains a 500 while the
  captured console output contains the request ID/SQLSTATE and no private body or driver detail.
- `pnpm check --log-order=stream`: all 10 packages passed; API build passed.
- `git diff --check`: clean.

The two existing Claude Opus sessions in Herdr Monitor adapted the disjoint DB/API implementations
and independently reviewed each other's code. Codex reviewed integration, added the SQLSTATE log
privacy requirement, reconciled the contract/runtime role, and ran the checks. No new dependency,
background runtime service or browser route was introduced.

## Hosted preflight

A read-only check on the existing staging API machine passed before migration:

```
CHAT_PREFLIGHT_PASS {"runtimeRole":"captain_runtime","version":180006,"owner_bypasses":true,"latest":"0041_runtime_role.sql","chat_absent":true}
```

This confirms prerequisites, not deployment or chat operation. Only status/metadata was printed;
no credential, customer message or other record content was read into this record. Actual release
and post-migration checks will be recorded in the staging runbook after reviewed merge and green CI.

## Release boundary

Migration 0042 is additive and runs without HTTP on the same staging machine. Production stays
paused. Retain the migration and restricted runtime on rollback; a pre-chat API lacks membership
cleanup and chat-aware lifecycle handling, so it is not a general rollback once chat exists.
See the [contract](../../plans/linked-chat-2026-09.md) for the compatible-image/forward-fix boundary.
