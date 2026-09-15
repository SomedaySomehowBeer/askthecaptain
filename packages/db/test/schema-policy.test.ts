import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';

const platformTables = new Set(['schema_migrations', 'users', 'identities', 'sessions', 'auth_requests', 'auth_events', 'workflow_definitions']);
const it = databaseUrl ? test : test.skip;
let db: Harness;
before(async () => { if (databaseUrl) db = await freshDatabase(); });
after(async () => { await db?.close(); });

it('every tenant table has organisation_id, forced RLS and a policy for app', async () => {
	const tables = await db.owner<{ name: string; hasOrg: boolean; rls: boolean; forced: boolean; policies: number }[]>`
		select c.relname as name,
			exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organisation_id' and not a.attisdropped) as "hasOrg",
			c.relrowsecurity as rls, c.relforcerowsecurity as forced,
			(select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
		from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where n.nspname = 'public' and c.relkind = 'r'`;
	assert.ok(tables.length >= 8);
	for (const table of tables) {
		if (platformTables.has(table.name)) { assert.equal(table.hasOrg, false, `${table.name} is platform-level and must not carry organisation_id`); continue; }
		assert.ok(table.hasOrg || table.name === 'organisations', `${table.name} must carry organisation_id or be in the platform list`);
		assert.ok(table.rls && table.forced, `${table.name} must have forced RLS`);
		assert.ok(table.policies >= 1, `${table.name} must have a policy`);
	}
});

it('the runtime role cannot bypass RLS', async () => {
	const [role] = await db.owner<{ bypass: boolean; superuser: boolean }[]>`select rolbypassrls as bypass, rolsuper as superuser from pg_roles where rolname = 'app'`;
	assert.deepEqual(role, { bypass: false, superuser: false });
});

it('migrations are idempotent', async () => {
	const { applyMigrations } = await import('../src/migrate.ts');
	assert.deepEqual(await applyMigrations(db.owner), []);
});
