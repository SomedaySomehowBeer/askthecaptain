# Assistant storage retirement — R5b

Status: reviewed #194 merged and released to staging; migration 0045 applied at **2026-09-27 06:42:39 UTC**.
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

The branch was rebased onto merged #193. [Final CI](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36300326550) passed on `02733f2accdbbb87b299ac629e8c5f1d304beac8`, including the newer mobile tests, Chat browser suites and native sign-in browser proof. Its tree equals squash merge `b7b9bb80fe26e6e805546b3d9f1a4ecc7af0dadd`. No web route changed.

## Release and rollback

Use the sole existing staging API with HTTP stopped, no public services and restart policy `no` for the one-shot migration. Verify the reviewed image, fresh migration/queue marker and exit 0; restore and compare normal configuration before serving. The postflight no longer queries `attachment_text`, which 0045 removed. Postflight must confirm all 21 tables, seven functions and three columns are absent, full migration history through 0045, safe runtime role, readiness and native sign-in still disabled.

After 0045, forward-fix or use the recorded reader-free API image. Never restore an image containing retired readers, recreate the dropped tables, or repeat the old data-reset procedure. Production cannot resume on its paused old image.

## Actual staging release

The [second count-only preflight](release-preflight.json) at 06:40:09 UTC was clear, after the
reader-free release and immediately before the one-shot. Exactly the existing API machine
`80e39ea6416e18` ran the migration with no public services and restart policy `no`. The
[timestamped log](migration-hosted.log) and [exit evidence](migration-verified.json) confirm only
0045 applied, queue setup completed and the process exited normally with code 0. Normal
configuration was restored and compared before starting the API. Claude A reviewed the migration/tests and this evidence; Claude B reviewed the migration and
release scripts, including the removed bypass path. Codex executed and verified the release.

API image: `registry.fly.io/askthecaptain-api-staging:git-02733f2@sha256:1e2cdf9407cda83b3363d5fa763812cedc72114955b255c8a5b15d55057be3aa`.
Its pushed index is `sha256:4e4d3db1e3d9f3c118b1304f0a3319d3a59b55b3cae69ea004c3155b07288d04`;
Fly resolves that index to the recorded platform manifest. The web machine `9185776e7cd3d8`
and image `git-17089ce` were unchanged. [All five applications' machine IDs/configurations](fleet-proof.json) were
compared; only the staging API image changed. Production and embedding stayed stopped, automatic
deployment and backups disabled. No DNS, secret, provider, native enablement or reset operation ran.

[Read-only postflight](release-postflight.json) verified the complete 42-file migration history (0014, 0017 and 0022 were never repository migrations),
absence of all 21 tables, seven functions and three columns, retained vector extension,
project/provenance columns and checks, eight auth kinds and three queues. The deployed runtime-role
safety guard passed; `app` and `captain_runtime` have equal sets of 228 direct scoped grants and
66 policies. All 27 retained table counts exactly match preflight, including one project, 26 tasks,
one conversation/message, five equipment records, seven reservations and seven stock items.
This is count preservation evidence, alongside the transactional migration tests; it is not
hosted signed-in acceptance.

[HTTP checks](http-proof.json) returned readiness 200, Google identity available, and native sign-in
400 `native_sign_in_unavailable`. The [anonymous 390-pixel browser check](browser-proof.json) and [screenshot](login-390.png) passed;
no real account or device sign-in was attempted. The rollback set is this API image or the earlier
recorded reader-free `git-17089ce` API image. Never deploy the paused production image against this
schema or recreate the removed storage.
