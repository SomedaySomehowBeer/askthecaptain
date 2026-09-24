# Staging resumed; production paused (2026-09-24)

Captain's staging workspace is available at **https://app.askthecaptain.app/work**. The API and
web run reviewed commit `2c63030efd832f3d2ab87ada2a96907fee65d875` (#123, including #122).
Production remains stopped. The original 23 September pause is recorded below as history.

## Staging authorisation (24 September 2026)

The owner authorised restarting infrastructure **when needed**, deploying **only to staging**,
and keeping **at most one machine per app**, plus merging PRs after review. This supersedes the
owner-only resume instruction below for those staging actions. Production remains stopped.
The authorised restart was performed on 24 September. Existing enabled in-app workflows and
provider syncs resume with the API; their settings and secrets were preserved. This is distinct
from GitHub's deploy and backup workflows, which remain disabled.

Before a staging resume, inspect live machine counts and deployment targets, constrain rollout
and standby behaviour to the one-machine limit, and record what changed here. Do not enable a
workflow that could promote production. Backups remain disabled pending their separate restore
checks and operational decision.

## Actual resumption (24 September 2026, UTC)

Job: **own commitments**. Make the reviewed Work, task creation, filters and shared tag controls
available to the first customer. Chat, equipment scheduling and the file library are not delivered.

| App | Existing machine | Result |
|---|---|---|
| `askthecaptain-api-staging` | `80e39ea6416e18` | new image, autostart on, stop when idle, minimum zero |
| `askthecaptain-web-staging` | `9185776e7cd3d8` | new image, autostart on, stop when idle, minimum zero |
| `askthecaptain-embed` | `82d1dd0b021908` | existing image unchanged, autostart restored, stop when idle |

Both new image tags are `git-2c63030efd832f3d2ab87ada2a96907fee65d875` in their respective
`registry.fly.io/<app>` repositories. Previous staging images, and the unchanged embedding image,
are tagged `git-ad43f401f97fd2f2327e327af2a6c0f2afdebab6`.

Images were built with Depot and pushed without deploying. To avoid a second temporary release
machine, the existing stopped API machine was updated to the new image with autostart off,
restart policy `no`, and a one-shot command running `packages/db/src/migrate.ts`, then
`packages/engine/src/install.ts`. It was explicitly started. Migration `0035_task_tags.sql`
applied at **10:51:53Z**, `CAPTAIN_MIGRATION_COMPLETE` appeared at **10:51:54Z**, and the process
exited **0**. Only this additive migration was pending. No new backup or Neon recovery branch
was created; existing backup recovery coverage remains unverified.

API and web deployments then used their staging configs and the built images with
`--ha=false --strategy immediate --update-only`; API also used `--skip-release-command`, because
the migration and queue installer had already succeeded. The API's command override was cleared
and restart policy restored to `on-failure`. No additional app machines were created.

The API started normally at **10:53:06Z**. `/readyz` returned HTTP 200 with `{"ok":true}`;
the embedding `/healthz` returned its healthy encoder/version/dimensions response.
Web Push is not configured in this environment, as reported by API startup; notifications that
require it remain unavailable. Existing schedules only run while the API is awake, including
catch-up after an idle period. A successful readiness check does not establish provider sync or
inference completion. Better Stack's live monitor state was not inspected or changed.

Live Chrome checks at 390×844 and 1280×900 confirmed `/work` redirects signed-out visitors to
the rendered sign-in page, with the Google action present, no failed notice, no horizontal
overflow and no browser errors. Sign-in initiation returned a redirect to `accounts.google.com`.
There was no existing hosted browser session, so authenticated hosted checks were not run and
no test records were added to the customer's database. The task/tag write flows were previously
checked against isolated real Postgres in #122/#123; that is not hosted-session evidence.

Production's two API and two web machines remain stopped with autostart off. Their counts and
images were not changed. No production deployment, DNS, secret or infrastructure apply occurred.
GitHub deploy and backup workflows remain disabled. Future code merges do not deploy themselves.

For rollback, redeploy the previous staging images with the same single-machine flags. Migration
0035 is additive and compatible with those images; do not drop the new tables to roll back code.
Future API releases must run migrations and the queue installer on the sole machine before
skipping the release command; never skip those operations merely to avoid the extra machine.

## Original pause: what was stopped (23 September)

| What | State | How it was stopped |
|---|---|---|
| `askthecaptain-api-staging` (1 machine) | stopped, autostart off | `flyctl machine update <id> --autostart=false --skip-start` then `flyctl machine stop` |
| `askthecaptain-web-staging` (1 machine) | stopped, autostart off | same |
| `askthecaptain-api` (production, 2 machines) | stopped, autostart off | same |
| `askthecaptain-web` (production, 2 machines) | stopped, autostart off | same |
| `askthecaptain-embed` (1 machine) | stopped, autostart off | same |
| `deploy` workflow | disabled | `gh workflow disable deploy.yml` |
| `backup` workflow (nightly 00:30 Perth) | disabled | `gh workflow disable backup.yml` |

**Why autostart had to go.** Every app scales to zero (`auto_stop_machines`, `min_machines_running
= 0`), so a stopped machine was never really off: Fly's proxy starts one for any incoming request
(the phone app, webhooks, crawlers). On the morning of 2026-09-23 the staging pair was being woken
every few minutes. With autostart off, requests to `app.askthecaptain.app` and
`api-staging.askthecaptain.app` time out instead of starting a machine.

**Why the deploy workflow had to go.** Any push to `main` touching `apps/`, `packages/` or `infra/`
deployed staging and started it again, and a deploy re-applies autostart from `fly.toml`.

**The backup workflow.** It never touched Fly, but it woke Neon every night. It had also been
failing since 2026-09-21 (`pg_dump: error: aborting because of server version mismatch`: the job's
`pg_dump` is older than the Neon server), so the newest good dump in `backups/` predates that. Fix
the client selection before re-enabling it. [#120](https://github.com/SomedaySomehowBeer/askthecaptain/pull/120)
prepares explicit PostgreSQL 18 executable paths and a pgvector-capable restore image; the changes
passed a disposable local restore. They do not resume backups or establish a fresh hosted backup.

## Original pause: what still ran or could be reached

- **CI and tofu workflows** stay enabled: they run on pull requests and pushes and deploy nothing
  to Fly (`tofu` applies only on changes under `infra/tofu/`).
- **Neon** scales to zero on its own; nothing on a schedule reaches it now.
- **The inference Sprite** (`captain-01a0a335-…`, org `somedaysomehowbeer`) was not touched. It
  sleeps when idle, and the only caller, the API, is stopped.
- **The Better Stack uptime monitor** is configured in `infra/tofu/uptime.tf` to request
  `https://api-staging.askthecaptain.app/readyz` every 30 minutes, with email and push alerts.
  Its live state was not checked in the 24 September documentation audit. If still enabled, it
  will see the stopped API as unavailable; with autostart disabled it cannot wake that machine.
  Check whether it also needs pausing as an owner operation; resume it with the apps.
- **Inbound deliveries** to the stopped API fail: configured Gmail push via Pub/Sub
  ([gmail-push.md](gmail-push.md)) retries according to its subscription policy. Nango is not a
  Captain connector under D8; investigate any old external sender separately. Mail catch-up uses
  the provider cursor, with full sync if history expired. Reconcile provider state on resume rather
  than assuming missed webhooks guarantee no data loss.
- **The in-app schedulers** (five-minute mail poll, morning brief, triage) live in the API process
  and do not run while it is stopped.

## Original resume procedure (superseded for staging)

Historical instructions follow. For the current staging scope, use the single-machine procedure
above and leave GitHub deployment/backup workflows disabled. Production resumption still belongs
to the owner.

1. Owner only: review the resume and backup repairs, then `gh workflow enable deploy.yml` and,
   once the backup tooling/restore checks pass, `gh workflow enable backup.yml`.
2. Turn autostart back on, either by deploying (Actions → deploy → Run workflow; a deploy applies
   `fly.toml` again) or per machine:
   ```bash
   for a in askthecaptain-api-staging askthecaptain-web-staging askthecaptain-embed; do
     for m in $(flyctl machines list -a $a --json | jq -r '.[].id'); do
       flyctl machine update $m -a $a --autostart=true --yes
     done
   done
   ```
   Production (`askthecaptain-api`, `askthecaptain-web`) has not been promoted since 2026-09-05;
   leave it off unless it is being promoted.
3. Unpause the Better Stack monitor if it was paused.
4. Check: `curl https://api-staging.askthecaptain.app/healthz`, then sign in on the phone and let the
   mail poll catch up.
