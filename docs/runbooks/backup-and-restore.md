# Backup and restore

Plan §9: backups with a rehearsed restore before the second tenant. There is one Neon database
(D17); it is backed up two ways, and each scheduled backup run rehearses the restore.

> **Paused 2026-09-23:** the `backup` workflow is disabled and was failing on a `pg_dump` version
> mismatch; see [paused.md](paused.md).

The repair in [#120](https://github.com/SomedaySomehowBeer/askthecaptain/pull/120) pins PostgreSQL
18 client executables and uses a pgvector-capable restore image. It passed a disposable local
rehearsal; the hosted workflow remains disabled until the owner resumes it.

## What runs on its own

The `backup` GitHub Actions workflow (`.github/workflows/backup.yml`) runs at 00:30 Perth time and
on demand (*Actions → backup → Run workflow*):

1. reads the owner connection string from the infrastructure state, exactly as the deploy does;
2. takes a logical dump of the whole database (`pg_dump`, custom format, zstd), stripping owner
   assignments and ACLs; policy definitions still reference roles such as `app` and `captain_runtime`;
3. **rehearses the restore** into a fresh Postgres 18 inside the job, checks the archive lists its
   tables, restores with `--exit-on-error`, and compares the organisation count with the source;
   a difference fails the run. For dumps recording migration 0041, it also verifies each restored
   policy names both runtime roles or neither. Matching policy role lists do not prove application
   access because the archive omits grants;
4. keeps the dump in the Tigris bucket `askthecaptain-tofu-state` under `backups/` and prunes
   dumps older than 30 days;
5. deletes the local copy whether or not the run succeeded.

A red run is the alarm. Nobody is paged by it yet; the operator must check the Actions tab
after a scheduled backup or configure monitoring before relying on unattended backups.

What the dump holds: every table, including encrypted provider tokens (still encrypted with each
organisation's data key, which is itself wrapped by `MASTER_KEY`). A dump without `MASTER_KEY` cannot
reveal a token; keep the key in Fly's secrets and nowhere else, and treat the bucket as sensitive.

## Neon's own restore

An owner/admin tenant export is different from an operator database backup. Exports include only
the exporting person's live saved Work views; other members' private views and content-free
deletion tombstones are omitted. They cannot restore every member's personal views. A database
backup includes those rows and needs the operator access controls described above. Organisation
deletion cascades through all saved views, but its recorded row counts omit this private table
rather than presenting the deleting owner's visible count as a total.

Neon keeps point-in-time history for the branch. For a mistake in the last hours (a bad migration,
a wrong delete) this is the first choice: in the Neon console, restore the branch to a timestamp,
or create a branch from that timestamp and read from it. No dump is needed.

## Restoring a dump

When Neon's history does not reach far enough, or the project itself is gone:

1. Fetch the dump: `aws s3 cp s3://askthecaptain-tofu-state/backups/captain-<stamp>.dump .` with
   the Tigris keys and `AWS_ENDPOINT_URL=https://fly.storage.tigris.dev`.
2. Create the target: a new Neon project or branch (`infra/tofu` recreates the project, database and
   legacy `app` role from nothing; applying infrastructure remains an owner operation).
3. Restore as the owner: `pg_restore --dbname="$MIGRATION_DATABASE_URL" --no-owner --no-privileges
   --exit-on-error captain-<stamp>.dump`. Both `app` and SQL-created `captain_runtime` must exist
   before restoring policies. Create the latter with NOLOGIN, NOSUPERUSER, NOBYPASSRLS,
   NOCREATEROLE, NOCREATEDB, NOREPLICATION and no role memberships; never through the Neon API.
4. Confirm: `psql "$MIGRATION_DATABASE_URL" -c "select count(*) from organisations"` and
   `select name from schema_migrations order by 1` end with the latest migration.
5. Before pointing an API at the restored data, restore and verify the required runtime-role
   grants against the migration definitions. The archive omits ACLs; migrations already recorded
   in `schema_migrations` will not run again to recreate grants. Test an authorised application
   read/write and cross-tenant denial on the scratch restore. The automated count check alone
   does not prove application access. Prepare/review the grant restoration as part of the drill;
   a reusable complete grant-replay script remains a tracked prerequisite before hosted backups
   resume. Migration 0041 alone cannot repair an ACL-free restore, because it copies grants
   already present on the legacy role.
6. Point the API at it: set `DATABASE_URL` and `MIGRATION_DATABASE_URL` on the Fly app to the new
   connection strings: runtime uses SQL-created `captain_runtime`, migrations use the owner.
   Do not use the administrative `neon_app_database_url` output. Verify runtime flags, membership,
   object ownership and RLS before activation. Enable LOGIN and set the credential through the
   [repair plan’s owner step](../plans/runtime-database-role-2026-09.md), never with plaintext
   passwords in command or SQL logs. The release step applies only unrecorded migrations and
   repeats queue installation. Queue installation restores queue grants only; it does not replay
   application grants from migrations already recorded in the dump.
7. Tell people that writes after the dump's timestamp are missing. Reconcile affected shared work
   and enabled business integrations before resuming workflows. Captain does not ingest mail or
   personal calendars, and provider synchronisation cannot reconstruct every lost workspace write.

## The drill

Once a quarter, do the restore above by hand into a scratch Neon branch and sign in against it
with a scratch web app, or at least run step 3 and 4. Record the date and outcome in this file:

| Date | Who | Outcome |
|---|---|---|
| (none yet) | | |
