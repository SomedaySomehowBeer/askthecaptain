import { randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { applyMigrations } from '../src/migrate.ts';

/** A fresh database per test file, migrated as the owner, reachable as the runtime role: `captain_runtime` once
 *  migration 0041 has created it, `app` for a database left before it. `app` is the connection's name either way.
 *  Tests that need Postgres skip when DATABASE_URL is unset; they are not "passed". */
export type Harness = { owner: Sql; app: Sql; runtimeRole: RuntimeRole; databaseUrl: string; runtimeUrl: string; close(): Promise<void> };
export type RuntimeRole = 'app' | 'captain_runtime';

export const databaseUrl = process.env.DATABASE_URL;
export const runtimeRoleMigration = '0041_runtime_role.sql';

/** Test files run in parallel and roles are cluster-wide: serialise role changes with an advisory lock so two
 *  files cannot both find a role missing, or update the same role at once. Local test passwords only. */
async function withRoleLock(admin: Sql, work: () => Promise<unknown>) {
	await admin`select pg_advisory_lock(7201)`;
	try { await work(); } finally { await admin`select pg_advisory_unlock(7201)`; }
}

/** `through` leaves the database at that migration; call `applyMigrations(owner)` to apply the rest. */
export async function freshDatabase(options: { through?: string } = {}): Promise<Harness> {
	if (!databaseUrl) throw new Error('DATABASE_URL is required');
	const runtimeRole: RuntimeRole = options.through !== undefined && options.through < runtimeRoleMigration ? 'app' : 'captain_runtime';
	const admin = postgres(databaseUrl, { max: 1 });
	const name = `captain_test_${randomBytes(6).toString('hex')}`;
	const base = new URL(databaseUrl);
	const ownerUrl = new URL(base); ownerUrl.pathname = `/${name}`;
	const owner = postgres(ownerUrl.toString(), { max: 2, transform: postgres.camel });
	let created = false;
	try {
		await admin.unsafe(`create database ${name}`);
		created = true;
		await withRoleLock(admin, async () => {
			const roles = await admin<{ rolname: string }[]>`select rolname from pg_roles where rolname = 'app'`;
			if (roles.length === 0) await admin.unsafe(`create role app login password 'app'`);
			else await admin.unsafe(`alter role app with login password 'app'`);
		});
		await applyMigrations(owner, undefined, options.through);
		// The migration creates captain_runtime NOLOGIN; only this test cluster lets it sign in.
		if (runtimeRole === 'captain_runtime') await withRoleLock(admin, () => admin.unsafe(`alter role captain_runtime with login password 'captain_runtime'`));
	} catch (error) {
		// A failed setup leaves nothing behind: close this database's connections, then drop only the database made here.
		await owner.end();
		if (created) await admin.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
		throw error;
	} finally { await admin.end(); }
	const runtimeUrl = new URL(ownerUrl); runtimeUrl.username = runtimeRole; runtimeUrl.password = runtimeRole;
	const app = postgres(runtimeUrl.toString(), { max: 4, transform: postgres.camel });
	return {
		owner, app, runtimeRole, databaseUrl: ownerUrl.toString(), runtimeUrl: runtimeUrl.toString(),
		async close() {
			await app.end(); await owner.end();
			const drop = postgres(databaseUrl!, { max: 1 });
			await drop.unsafe(`drop database if exists ${name} with (force)`);
			await drop.end();
		}
	};
}
