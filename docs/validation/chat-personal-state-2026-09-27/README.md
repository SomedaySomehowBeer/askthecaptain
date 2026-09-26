# Chat pins and personal state validation — 27 September 2026

Outcome: discuss work (D25), with D6 runtime isolation. PR C implements author edits, shared pins,
personal conversation stars, read positions and capped unread counts. The contract was adopted
in #160 and its execution clarifications in #170. Migration 0043 is additive; no merged migration
was changed. This record does not claim a usable Chat screen or hosted browser acceptance.

## Checks

All database checks use disposable pgvector/PostgreSQL 18 databases. Application calls connect
as the actual `captain_runtime` role. Heavy checks run serially under `/tmp/atc-build.lock`.

- DB chat-personal, existing chat and schema-policy suites: 40 passed, zero failed/skipped.
  Includes backfill from schema 0042, private-state isolation, forced RLS, both-role grant parity,
  no new elevated function, author-only transitions, cross-table change-number collisions,
  concurrency and account/organisation deletion.
- Initial API chat, app and lifecycle suites: 36 passed, zero failed/skipped.
- Workspace typecheck: all 10 packages passed (2 rebuilt, 8 unchanged cached results).
  Final API typecheck and build passed after the rollback-test amendment.
- Full workspace regression suite, including the strengthened endpoint rollback test: **414 passed**,
  zero failed/skipped, 8 packages, no cached test runs (3m27s).

Two existing Claude Opus agents in Herdr implemented disjoint database and API files and reviewed
one another's work. Codex integrated and ran checks. Root identified that the initial rollback
test repeated a transaction by hand; its replacement exercises the actual DELETE endpoint with
an injected unpin failure, so committing the message tombstone separately would be caught.

## Boundaries

No browser route, new dependency, new service, inference or rate-limit relaxation is included.
Stars use POST/DELETE under the existing chat-write policy. Pin records reference original message
IDs; stars/read positions and their audit rows remain personal. Author edits retain the original
send hash for retry matching; a tombstone clears it. Deleting a pinned message atomically unpins
it with the next change number and one participant-scoped chat audit event naming the unpinned pin.

## Hosted verification

Reviewed #171 merged and CI 36266589165 passed. Migration 0043 and the queue installer completed
on the existing staging API machine (exit 0); normal configuration was restored and readiness
returned 200. The rollback-only runtime check returned:

```
CHAT_PERSONAL_POSTDEPLOY_PASS {"role":"captain_runtime","latest":"0043_chat_personal_pins.sql","forced_tables":8,"policy_mismatches":0,"checks":["bootstrap retry","send","baseline","author edit keeps send hash","pin","personal star/read","nonparticipant hidden","foreign tenant hidden","tombstone and ordered unpin","leave hides all eight tables","deferred integrity","all probes rolled back"]}
```

All synthetic probe writes rolled back, with owner-side absence checks. Existing owner's IDs
were used for context only; no existing work/message contents were read or changed. Fleet comparison
verified one machine per staging app and unchanged web/production/embedding configuration, with
production/embedding stopped. The [runbook](../../runbooks/paused.md) records exact source, image
and timing. This is hosted runtime/database verification, not signed-in browser chat acceptance.

Keep migration 0043 and captain_runtime
on rollback. A pre-PR-C API does not atomically unpin when deleting a message and counts the new chat tables
in deletion totals; use a compatible
forward fix or stop HTTP for repair once pins exist. Never discard conversation data.
