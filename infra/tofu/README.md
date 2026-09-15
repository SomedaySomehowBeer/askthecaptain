# infra/tofu

Everything outside Fly: Neon (one project, one branch, the `captain` database, the `app` runtime
role; D17), Cloudflare DNS for askthecaptain.app, and a Better Stack monitor. Fly apps are deployed from `apps/*/fly*.toml` by
GitHub Actions and are not managed here.

State lives in the Tigris bucket `askthecaptain-tofu-state`. The `tofu` workflow plans on pull
requests and applies on `main`; it needs these repository secrets: `NEON_API_KEY`,
`CLOUDFLARE_API_TOKEN`, `TF_VAR_cloudflare_zone_id`, `BETTERUPTIME_API_TOKEN`, `TIGRIS_ACCESS_KEY`,
`TIGRIS_SECRET_KEY`.

Sensitive outputs become Fly secrets by hand, by the repository owner: `neon_app_database_url` is
the API's `DATABASE_URL`; `neon_owner_database_url` is `MIGRATION_DATABASE_URL` (used only by the
release command that migrates). Encryption needs no cloud service: `MASTER_KEY` on the API is a
32-byte random key that wraps per-tenant data keys (plan §9, D16). Never put these values in source
or logs.
