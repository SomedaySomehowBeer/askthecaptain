> Runtime security correction (26 September 2026): the API-created `app` role is administrative
> on Neon and must not be used for `DATABASE_URL`. The SQL-created `captain_runtime` role is
> introduced by migration 0041; its credential is a separate owner operation. The existing
> `neon_role.app` resource is retained to avoid destructive state changes. Do not apply Terraform
> or reuse `neon_app_database_url` to activate runtime access. See
> [the reviewed repair plan](../../docs/plans/runtime-database-role-2026-09.md).

# infra/tofu

Everything outside Fly: Neon (one project, one branch, the `captain` database, the `app` runtime
role; D17), Cloudflare DNS for askthecaptain.app, and a Better Stack monitor. Fly apps are deployed from `apps/*/fly*.toml` by
GitHub Actions and are not managed here.

State lives in the Tigris bucket `askthecaptain-tofu-state`. The `tofu` workflow plans on pull
requests and applies on `main`; it needs these repository secrets: `NEON_API_KEY`,
`CLOUDFLARE_API_TOKEN`, `TF_VAR_cloudflare_zone_id`, `BETTERUPTIME_API_TOKEN`, `TIGRIS_ACCESS_KEY`,
`TIGRIS_SECRET_KEY`.

The repository owner supplies Fly secrets separately. `DATABASE_URL` must use SQL-created
`captain_runtime`, after its least-privilege checks pass. `neon_app_database_url` is retained as
legacy infrastructure output and must not be used by the API. `neon_owner_database_url` supplies
`MIGRATION_DATABASE_URL` (used only by the release command that migrates). Encryption needs no cloud service: `MASTER_KEY` on the API is a
32-byte random key that wraps per-tenant data keys (plan §9, D16). Never put these values in source
or logs.
