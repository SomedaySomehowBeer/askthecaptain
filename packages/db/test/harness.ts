import { randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { applyMigrations } from '../src/migrate.ts';

/** A fresh database per test file, migrated as the owner, reachable as the runtime role `app`.
 *  Tests that need Postgres skip when DATABASE_URL is unset; they are not "passed". */
export type Harness = { owner: Sql; app: Sql; databaseUrl: string; close(): Promise<void> };

export const databaseUrl = process.env.DATABASE_URL;

export async function freshDatabase(): Promise<Harness> {
	if (!databaseUrl) throw new Error('DATABASE_URL is required');
	const admin = postgres(databaseUrl, { max: 1 });
	const name = `captain_test_${randomBytes(6).toString('hex')}`;
	await admin.unsafe(`create database ${name}`);
	const roles = await admin<{ rolname: string }[]>`select rolname from pg_roles where rolname = 'app'`;
	if (roles.length === 0) await admin.unsafe(`create role app login password 'app'`);
	else await admin.unsafe(`alter role app with login password 'app'`);
	await admin.end();
	const base = new URL(databaseUrl);
	const ownerUrl = new URL(base); ownerUrl.pathname = `/${name}`;
	const appUrl = new URL(ownerUrl); appUrl.username = 'app'; appUrl.password = 'app';
	const owner = postgres(ownerUrl.toString(), { max: 2, transform: postgres.camel });
	await applyMigrations(owner);
	const app = postgres(appUrl.toString(), { max: 4, transform: postgres.camel });
	return {
		owner, app, databaseUrl: ownerUrl.toString(),
		async close() {
			await app.end(); await owner.end();
			const drop = postgres(databaseUrl!, { max: 1 });
			await drop.unsafe(`drop database if exists ${name} with (force)`);
			await drop.end();
		}
	};
}
