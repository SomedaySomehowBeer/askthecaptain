# Web cutover: the API serves the Expo web export (R1c)

Status: prepared 30 September 2026 for the owner to run. Decision D37; contract
`docs/plans/expo-web-session-2026-09.md` §C. Staging only, one machine per app. Production stays paused.

After this, `https://app.askthecaptain.app` is answered by the staging API app, which serves the Expo web export at `/`
and its own routes under `/auth`, `/v1`, `/connections`, `/webhooks`, `/healthz` and `/readyz`. The Next.js machine
stops. `APP_URL` stays `https://app.askthecaptain.app`, so the session cookie, the Google return and the passkey
relying-party host do not change.

## Before

1. `main` at or after `519b1ad` (#218). The API image built from it carries the web export (`apps/api/Dockerfile`, stage
   `web`); confirm with `docker image inspect` or by the deploy's build log line `test -f /repo/apps/mobile/dist/web/index.html`.
2. Secrets on `askthecaptain-api-staging`: `APP_URL=https://app.askthecaptain.app` (unchanged), `API_URL=https://api-staging.askthecaptain.app`
   (unchanged). `fly secrets list -a askthecaptain-api-staging` shows names only; the values were set at first deploy.
3. Google OAuth client: the redirect URI is `${API_URL}/auth/google/callback`, unchanged. Nothing to do.

## Steps

1. **Deploy the API image** from `main` to staging, image-only as usual (`docs/runbooks/paused.md` records the pattern):
   `flyctl deploy -a askthecaptain-api-staging -c apps/api/fly.staging.toml` from the repository root on the Mac.
   Check `https://api-staging.askthecaptain.app/readyz` is `{"ok":true}` and that `GET https://api-staging.askthecaptain.app/`
   returns the Expo shell (HTML, `cache-control: no-store`), not the old JSON 404.
2. **Move the certificates.** Fly allows a hostname on one app at a time, so remove before adding:
   ```
   flyctl certs remove app.askthecaptain.app -a askthecaptain-web-staging
   flyctl certs remove askthecaptain.app      -a askthecaptain-web-staging
   flyctl certs remove www.askthecaptain.app  -a askthecaptain-web-staging
   flyctl certs add app.askthecaptain.app     -a askthecaptain-api-staging
   flyctl certs add askthecaptain.app         -a askthecaptain-api-staging
   flyctl certs add www.askthecaptain.app     -a askthecaptain-api-staging
   ```
   `flyctl certs show <host> -a askthecaptain-api-staging` lists any `_acme-challenge` record it wants; add it in
   `infra/tofu/dns.tf` if one is required (the existing hosts validated without one).
3. **Point DNS at the API app.** Merge the pull request that changes `app`, `@` and `www` in `infra/tofu/dns.tf` to
   `askthecaptain-api-staging.fly.dev`; `tofu.yml` applies on `main`. TTL is 300 s.
4. **Hosted checks** (all against `https://app.askthecaptain.app`):
   - `/healthz` and `/readyz` answer from the API; `/` returns the shell; `/_expo/...` assets carry `immutable`.
   - Sign in with a real Google account: welcome → Google → `/auth/callback` sets `captain_session` (HttpOnly) → the
     thread list shell with the organisation name in the header. `/v1/me` from the page carries the cookie and
     `x-captain-client: web`.
   - An account with a passkey: the step-up page at `/auth/passkey` completes and lands on `/`.
   - Settings: sign out clears the cookie; "Sign out everywhere else" still works.
   - `/invitations/accept?token=...` with a fresh invitation.
   - Web Push: register a device from Settings on the export and send the test notification (`docs/runbooks/web-push.md`).
   Record the results in `docs/runbooks/paused.md` under a dated heading, as for earlier releases.
5. **Stop the Next.js machine**: `flyctl scale count 0 -a askthecaptain-web-staging` (keep the app until the removal PR merges;
   its last image is the rollback).
6. **Merge the removal PR** (`chore/retire-nextjs`): the Next.js source, `packages/ui`, its Playwright suites and CI jobs go.

## Rollback

**Superseded on 1 October 2026:** `askthecaptain-web-staging` was destroyed at the owner's instruction after the
cutover held, so there is no Next.js app to return to. A web regression is fixed forward, or rolled back by redeploying
an earlier `askthecaptain-api-staging` image (`flyctl releases -a askthecaptain-api-staging`, then
`flyctl deploy --image <earlier image>`). The original rollback, kept for the record, was: revert the DNS pull request,
move the three certificates back to the web app and scale it to one machine. Nothing in the database changed in this
cutover.

## Not covered

No native sign-in (still off), no device evidence, no production change, no backup change.
