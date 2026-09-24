# Paused (2026-09-23)

Ask The Captain is paused while the product is re-thought. Nothing runs and nothing is billed for
compute on Fly. Nothing was deleted: apps, images, secrets, the Neon database, DNS and the Tigris
bucket are all as they were, so the steps below bring everything back as it was.

## What was stopped

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

## What still runs or can still be reached

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

## Resume

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
