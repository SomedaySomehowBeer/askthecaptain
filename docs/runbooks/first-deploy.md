# First deploy

What the repository owner does once so the pipeline can run. Nothing here is automated on purpose:
infrastructure applies, secrets and DNS are the owner's.

1. **GitHub Actions billing.** Jobs do not start while the organisation's Actions billing is
   failing or its spending limit is reached. Fix that under the organisation's Billing & plans.
2. **Repository secrets.** `FLY_API_TOKEN`, plus the tofu set in `infra/tofu/README.md`.
3. **Infrastructure.** Merge a change under `infra/tofu/` (or dispatch the `tofu` workflow) so the
   `captain` databases exist on both Neon branches. Read the sensitive outputs locally with
   `tofu output -raw <name>`.
4. **Fly secrets** on `askthecaptain-api-staging` (and later `askthecaptain-api`):
   `DATABASE_URL` (the `app` role URL), `MIGRATION_DATABASE_URL` (the owner URL),
   `APP_URL=https://app.askthecaptain.app`, `API_URL=https://api-staging.askthecaptain.app`,
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. The web apps need no secrets; their environment is
   in `fly*.toml`.
5. **Google OAuth client.** A web client whose authorised redirect URIs are
   `https://api-staging.askthecaptain.app/auth/google/callback` and
   `https://api.askthecaptain.app/auth/google/callback`.
6. **Deploy.** Push to `main` deploys staging and runs the smoke gate. Production is promoted by
   running the `deploy` workflow from the Actions tab once staging is green.
7. **First sign-in.** Sign in with Google, name the organisation on the welcome page, invite the
   crew from Settings → Members.
