# Backup and restore

Plan §9: backups with a rehearsed restore before the second tenant. There is one Neon database
(D17); it is backed up two ways, and the restore is rehearsed every night.

> **Paused 2026-09-23:** the `backup` workflow is disabled and was failing on a `pg_dump` version
> mismatch; see [paused.md](paused.md).

## What runs on its own

The `backup` GitHub Actions workflow (`.github/workflows/backup.yml`) runs at 00:30 Perth time and
on demand (*Actions → backup → Run workflow*):

1. reads the owner connection string from the infrastructure state, exactly as the deploy does;
2. takes a logical dump of the whole database (`pg_dump`, custom format, zstd), roles and grants
   included by reference, owners stripped so it restores anywhere;
3. **rehearses the restore** into a fresh Postgres 18 inside the job, checks the archive lists its
   tables, restores with `--exit-on-error`, and compares the organisation count with the source;
   a difference fails the run;
4. keeps the dump in the Tigris bucket `askthecaptain-tofu-state` under `backups/` and prunes
   dumps older than 30 days;
5. deletes the local copy whether or not the run succeeded.

A red run is the alarm. Nobody is paged by it yet; check the Actions tab when the morning brief
mentions nothing, or add a Better Stack monitor on the workflow's badge URL.

What the dump holds: every table, including encrypted provider tokens (still encrypted with each
organisation's data key, which is itself wrapped by `MASTER_KEY`). A dump without `MASTER_KEY` cannot
reveal a token; keep the key in Fly's secrets and nowhere else, and treat the bucket as sensitive.

## Neon's own restore

Neon keeps point-in-time history for the branch. For a mistake in the last hours (a bad migration,
a wrong delete) this is the first choice: in the Neon console, restore the branch to a timestamp,
or create a branch from that timestamp and read from it. No dump is needed.

## Restoring a dump

When Neon's history does not reach far enough, or the project itself is gone:

1. Fetch the dump: `aws s3 cp s3://askthecaptain-tofu-state/backups/captain-<stamp>.dump .` with
   the Tigris keys and `AWS_ENDPOINT_URL=https://fly.storage.tigris.dev`.
2. Create the target: a new Neon project or branch (`infra/tofu` recreates the project, database and
   `app` role from nothing; apply it first if the project is gone).
3. Restore as the owner: `pg_restore --dbname="$MIGRATION_DATABASE_URL" --no-owner --no-privileges
   --exit-on-error captain-<stamp>.dump`. The `app` role must exist before restoring (the migration
   creates it; so does `infra/tofu`).
4. Confirm: `psql "$MIGRATION_DATABASE_URL" -c "select count(*) from organisations"` and
   `select name from schema_migrations order by 1` end with the latest migration.
5. Point the API at it: set `DATABASE_URL` and `MIGRATION_DATABASE_URL` on the Fly app to the new
   connection strings (`tofu output -raw …`), then redeploy or restart. The release step re-runs
   migrations and the queue installation; both are idempotent.
6. Tell people: anything written after the dump's timestamp is gone; mail and calendar re-sync from
   the providers on the next run (their cursors are in the dump and re-sync from that point).

## The drill

Once a quarter, do the restore above by hand into a scratch Neon branch and sign in against it
with a scratch web app, or at least run step 3 and 4. Record the date and outcome in this file:

| Date | Who | Outcome |
|---|---|---|
| (none yet) | | |
