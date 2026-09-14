import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Migrations are numbered SQL files applied in order, each in its own transaction, recorded in
 *  `schema_migrations`. A file is never edited after it has been applied anywhere. */
export async function listMigrations(): Promise<{ name: string; sql: string }[]> {
	const names = (await readdir(migrationsDir)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
	return Promise.all(names.map(async (name) => ({ name, sql: await readFile(new URL(name, `file://${migrationsDir}`), 'utf8') })));
}

export async function applyMigrations(sql: Sql, log: (line: string) => void = () => undefined): Promise<string[]> {
	await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
	const applied = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((row) => row.name));
	const pending = (await listMigrations()).filter((migration) => !applied.has(migration.name));
	for (const migration of pending) {
		await sql.begin(async (tx) => {
			await tx.unsafe(migration.sql);
			await tx`insert into schema_migrations (name) values (${migration.name})`;
		});
		log(`applied ${migration.name}`);
	}
	if (pending.length === 0) log(`database is current (${applied.size} migrations)`);
	return pending.map((migration) => migration.name);
}

export function migrationDatabaseUrl(env: NodeJS.ProcessEnv): string {
	const url = env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;
	if (!url) throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
	return url;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	const sql = postgres(migrationDatabaseUrl(process.env), { max: 1 });
	try { await applyMigrations(sql, (line) => console.log(`[db:migrate] ${line}`)); } finally { await sql.end(); }
}
