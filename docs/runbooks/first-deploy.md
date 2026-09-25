# First deploy

> **Current operations:** use [paused.md](paused.md) for the authorised staging procedure,
> one machine per app. Automatic deploy/backup workflows remain disabled and production remains
> paused; the historical pipeline setup below is not permission to apply infrastructure or promote.

What the repository owner does once so the pipeline can run. Nothing here is automated on purpose:
infrastructure applies, secrets and DNS are the owner's.

1. **GitHub Actions billing.** Jobs do not start while the organisation's Actions billing is
   failing or its spending limit is reached. Fix that under the organisation's Billing & plans.
2. **Repository secrets.** `FLY_API_TOKEN`, plus the tofu set in `infra/tofu/README.md`.
3. **Infrastructure.** Merge a change under `infra/tofu/` so the `captain` database exists on the
   one Neon branch. Read the sensitive outputs locally with `tofu output -raw <name>`.
4. **Fly secrets** on `askthecaptain-api-staging`, the live API (D17):
   `DATABASE_URL` (`neon_app_database_url`), `MIGRATION_DATABASE_URL` (`neon_owner_database_url`),
   `APP_URL=https://app.askthecaptain.app`, `API_URL=https://api-staging.askthecaptain.app`,
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `MASTER_KEY` (32 random bytes, base64:
   `openssl rand -base64 32`), one per environment, never reused. The web apps need no secrets; their environment is
   in `fly*.toml`.
5. **Google OAuth client.** A web client whose authorised redirect URIs are
   `https://api-staging.askthecaptain.app/auth/google/callback` and
   `https://api.askthecaptain.app/auth/google/callback`, for sign-in. Gmail/Calendar connection callbacks and scopes belong to the legacy assistant,
   not new Captain onboarding. Do not request mailbox/calendar consent to enable shared work.
   Existing adapter diagnostics remain in the legacy sync runbooks while that code is retired.
6. **Deploy.** Push to `main` deploys the live apps and runs the smoke gate. (Paused since
   2026-09-23: the `deploy` workflow is disabled; see [paused.md](paused.md).) The dormant production
   pair is promoted only by running the `deploy` workflow with `promote` ticked. While we develop,
   every Fly app runs one machine that scales to zero: `min_machines_running = 0` in `fly*.toml`,
   and the workflow scales each app to one machine and deploys with `--ha=false`.
7. **First sign-in.** Sign in with Google, name the organisation on the welcome page, invite the
   crew from Settings → Members.
