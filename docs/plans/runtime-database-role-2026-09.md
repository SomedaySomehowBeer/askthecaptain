# Runtime database role repair

Status: repair merged in [#162](https://github.com/SomedaySomehowBeer/askthecaptain/pull/162),
26 September 2026; restricted staging login activated; old administrative password reset and proven rejected;
infrastructure state reconciliation pending. Outcomes: protect shared work and private views (D6,
D26), and unblock linked chat (D25). Chat is held separately on `feat/linked-chat-core`.

## Observed problem and containment

Read-only queries through the staging API's actual `DATABASE_URL` found current/session role
`app`, `rolsuper=false`, `rolbypassrls=true`, `rolcreaterole=true`, `rolcreatedb=true`, and direct
`neon_superuser` membership with inheritance and role switching enabled. `row_security=on` does
not override BYPASSRLS. The migration owner is `neondb_owner`, which appropriately has bypass.
Postgres reports version `180006`; the 64 public tables are owned by `neondb_owner`.

The existing Neon API-created role matches [Neon's documented administrative role behavior](https://neon.com/docs/manage/roles).
Local tests created `app` through SQL without these privileges, so their passing RLS tests did
not establish hosted isolation. Prior release health checks also did not establish that isolation.
No assertion is made about historical exposure; customer records and access logs were not audited.

A transactional, intentionally rolled-back repair probe tried revoking `neon_superuser` from
`app`. Neon refused with SQLSTATE 42501. Nothing changed. Removing BYPASSRLS alone would leave
other administrative memberships, so it is not an adequate repair.

The existing staging API machine `80e39ea6416e18` was stopped with autostart disabled for
containment. Its guarded image and non-login role migration were subsequently prepared as
recorded in [the runbook](../runbooks/paused.md). After explicit owner authorisation, staging
activated the restricted login and resumed HTTP. Web remains on #159. No production or embedding machine was changed.

## Bounded implementation

Migration `0041_runtime_role.sql` creates SQL-owned `captain_runtime` as NOLOGIN, with no role
memberships, no superuser/bypass/role-creation/database-creation/replication privileges. It verifies
an already-existing role rather than silently weakening an unexpected role. It copies only direct
`app` ACLs for SELECT/INSERT/UPDATE/DELETE/USAGE/EXECUTE/CONNECT/TEMPORARY within the public and
workflow_queue schemas (excluding extension objects), those schemas and the current database.
It refuses unsafe grant kinds before copying and verifies parity both ways; later schema tests
enforce that parity. It never copies inherited privileges or grant options, and adds `captain_runtime` to existing
policies that name `app`. The old policy role remains for compatibility; it is not a runtime-login
recommendation. Future grants and policies name both roles. No password is in a migration.

The queue installer grants the same required queue privileges to both roles. Restore rehearsal
creates both roles before restoring policies. The test harness uses `captain_runtime` for current
schema tests, while historical `through` tests continue to use the role available at that point.
Tests cover private-view isolation, default-deny deletes, copied function grants, role membership
and all existing API/engine behavior with the actual new runtime role.

The API checks its effective and session roles before starting listeners, workers or schedules.
It refuses administrative flags, memberships, ownership of application database/schema/relations/
functions, or disabled row security. Readiness repeats the check and returns a generic 503 if
unsafe. This is not a promise to police changes made by an operator after startup; a failed role
check requires stopping the API and repairing configuration.

Chat's unmerged migration moves to 0042 after this repair and grants both roles. Its precondition
must inspect `captain_runtime`, not the retired administrative login. No chat code is included in
this repair. No customer content is reset, deleted, or converted.

## Release and owner credential step

1. Independently review this repair; pass typecheck, real-Postgres suites and applicable CI.
   Confirm automatic deploy and backup workflows remain disabled immediately before merging.
2. Build from the reviewed source. Use the same existing API machine for migration and queue
   installation, with no HTTP server, no restart loop and autostart disabled. Verify completion
   and leave it stopped. No second release machine and no infrastructure apply.
3. **Owner credential step:** enable LOGIN on `captain_runtime` with a new random secret, verify
   it by connecting directly, and update only staging API `DATABASE_URL`. Keep migration-owner
   credentials unchanged. AGENTS.md reserves secret changes to the owner; this step needs that
   action or explicit authorisation once the concrete repair is reviewed and verified. The owner
   explicitly authorised activation and old-credential retirement on 26 September.
   **Provider correction from execution:** this Neon deployment rejected a client-generated SCRAM
   verifier (SQLSTATE XX000, “Neon only supports being given plaintext passwords”); LOGIN remained
   off. Use a bound password parameter over verified TLS, through a temporary invoker function
   that constructs ALTER ROLE internally and catches failures, returning only SQLSTATE. In the
   same transaction, before sending the parameter, require statement/duration/transaction-sampled
   logging disabled, error parameter logging disabled, no pgAudit logging, pg_stat_statements
   limited to top-level queries, auto_explain disabled and SCRAM password storage. Drop the helper
   before commit. Fail closed if these checks fail. A fresh random credential is transferred by
   encrypted SFTP in a private 0600 file, imported through stdin with Fly's staging-only secret
   operation, and both temporary copies are deleted. Never print the password or put it in command
   arguments or machine configuration. Neon's internal provider logging cannot be established
   from PostgreSQL settings; this method controls the application and SQL logging paths.
   The role remains SQL-created; do not create or replace it through the Neon Console/API.
4. Preflight the new connection through the same endpoint the API uses (pooled or direct): effective/session roles and ownership checks pass; no privileged
   memberships; forced RLS on tenant tables; a rolled-back random-tenant probe finds no tasks,
   tags, memberships or saved views. `DELETE FROM saved_views WHERE false` must be denied. No
   real customer row is needed for these probes.
5. Start the same API with the reviewed guard image and its normal configuration. Verify readiness,
   sign-in and authorised existing Work/resources/private-view behavior. Preserve the one-machine
   limit and paused production/embedding. Do not restore bypass to repair an empty or failed view.
6. Immediately after successful activation, retire the old elevated runtime credential through
   an owner/provider operation; this is required, not optional cleanup. The old role may
   remain referenced by historical policies and infrastructure state; do not destroy it blindly.
   Resetting its password through the Neon control plane also requires reconciling the existing
   Terraform-managed credential state as an owner operation. The manual-only
   `.github/workflows/retire-elevated-runtime.yml` implements that authorised step for the fixed
   project and role: check identity/readiness, reset once, wait for Neon operations, prove the old
   password is rejected and refresh only the password in state. A rejected-password baseline
   skips the reset on resume. It rejects managed infrastructure
   changes or unrelated state drift. The scoped refresh uses a temporary override of the validated
   project/branch IDs to remove the project dependency during that operation; it never changes
   tracked Terraform configuration. Cleanup removes only the file created by that run. The stored
   role dependency may be absent until the next normal configuration apply. The `app` role remains administrative and unused; rotating its
   password does not disable the role. Neon retains the new, unused administrative password, and
   a successful refresh records it in state and the legacy URL output; neither is a runtime login.
   Retirement invalidates the distributed credential, not the role’s ability to sign in. Do not rerun a completed retirement just to repeat a check.
7. Resume the separately reviewed chat migration/API increment only after this gate passes.

The repository's existing Terraform `neon_role.app` resource is retained, to avoid a destructive
state change. Its generated URL is no longer a suitable runtime connection; future operators must
use the SQL-created role. No `tofu apply`, credential rotation or provider support request is
performed by implementation PR #162. The separately authorised activation and #164 retirement
workflow (with #165 rejection-classifier and #166 scoped-refresh fixes) do change credentials; the latter applies only a checked refresh-only state plan. If activation fails, keep the API stopped; reverting to the
administrative runtime connection is not an acceptable availability rollback.
