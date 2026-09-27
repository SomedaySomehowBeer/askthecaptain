# Assistant storage retirement — R5b

Status: implementation reviewed and local checks passed; migration 0045 has **not** been applied to staging.
Outcome: manage shared business work without retaining the old personal-assistant storage.

## Live gate

The [reader-free release](../assistant-retirement-release-2026-09-27/README.md) is deployed to the sole staging API and web machines. Its API image, `registry.fly.io/askthecaptain-api-staging:git-17089ce@sha256:9888f1a419eff548fd1569c30c373e4d14ec9c6ff6779fe0b70677f632e71e2f`, is the minimum rollback baseline after R5b. Production remains stopped.

A fresh verified-TLS owner audit at **2026-09-27 06:13:25.189251 UTC** ran in a read-only, repeatable-read transaction with `row_security=off`, then rolled back. The [count-only result](preflight-audit.json) confirms:

- All 21 listed legacy tables exist and contain zero rows; none has inheritance children.
- `contacts.last_thread_id` and both legacy workflow cursors have zero non-null values.
- All seven legacy functions exist. The only retained foreign key into legacy storage is the known contacts reference.
- No external views/rules, policies, row-type columns, triggers, tracked function dependencies or other function-source references were found.
- Informational old-evidence/task/proposal/Google-connection/auth-request counts and provider sync-cursor counts are empty. These retained structures are not removed.

The legacy tables have 332 catalogue grant entries; these disappear with the tables, while parity checks on retained grants and policies continue to pass.

No reset, provider action or business record write occurred. The audit is a prerequisite, not a substitute for the in-migration guards.

## Implementation and checks

0045 locks every affected table before rechecking emptiness; non-zero counts or an unknown dependency abort the transaction. No `CASCADE`, row deletion or historical migration edit is used. It removes the legacy tables/functions and three obsolete columns, their unused Drizzle descriptions and tests, and the already-used reset script. Current projects, tasks, equipment, inventory, contacts, business integrations, provenance and Chat remain.

New database regressions cover refusal for a legacy row, each obsolete cursor and the contacts reference, complete rollback for an unexpected dependency, repeat migration execution, and unchanged Work/Chat rows with cross-tenant isolation. Lifecycle regressions ensure removed tables disappear from export/deletion inventories while retained records remain covered.

Validation on the #192 base: all ten forced workspace typechecks passed. Across the successful package runs, **554 tests passed**, none skipped: model 11, web 135, connectors 5, database 93, steps 8, engine 20, API 208, mobile 63 plus 11 boundary checks. Database/integration suites used fresh throwaway PostgreSQL databases. The first run exposed a test-only Result-array prototype mismatch; the corrected database suite and all downstream suites were rerun uncached. No migration assertion was weakened. Both Claude agents reviewed implementation/evidence; root reviewed and ran checks.

The branch will be rebased onto merged #193 before CI, so its newer mobile tests are covered by the combined-tree checks rather than this earlier local count. No web route changed in this PR; the existing Chat/native browser CI still exercises the combined schema. No hosted migration or release acceptance is claimed here.

## Release and rollback

Use the sole existing staging API with HTTP stopped, no public services and restart policy `no` for the one-shot migration. Verify the reviewed image, fresh migration/queue marker and exit 0; restore and compare normal configuration before serving. Remove the earlier postflight query of `attachment_text`; it no longer exists after 0045. Postflight must confirm all 21 tables, seven functions and three columns are absent, full migration history through 0045, safe runtime role, readiness and native sign-in still disabled.

After 0045, forward-fix or use the recorded reader-free API image. Never restore an image containing retired readers, recreate the dropped tables, or repeat the old data-reset procedure. Production cannot resume on its paused old image.
