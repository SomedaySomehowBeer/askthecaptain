import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import type { TransactionSql } from 'postgres';
import { withTenant } from '../src/context.ts';
import { databaseUrl, freshDatabase, runtimeRoleMigration, type Harness } from './harness.ts';

const platformTables = new Set(['schema_migrations', 'users', 'identities', 'sessions', 'auth_requests', 'auth_events', 'workflow_definitions', 'organisation_deletions', 'passkeys']);
const it = databaseUrl ? test : test.skip;
const runtime = 'captain_runtime';
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

it('the runtime roles cannot bypass RLS', async () => {
	const roles = await db.owner<{ name: string; bypass: boolean; superuser: boolean }[]>`
		select rolname as name, rolbypassrls as bypass, rolsuper as superuser from pg_roles where rolname in ('app', ${runtime}) order by rolname`;
	assert.deepEqual(roles, [{ name: 'app', bypass: false, superuser: false }, { name: runtime, bypass: false, superuser: false }]);
});

it('migrations are idempotent', async () => {
	const { applyMigrations } = await import('../src/migrate.ts');
	assert.deepEqual(await applyMigrations(db.owner), []);
});

// Migration 0041 (D6 repair): the runtime is captain_runtime, a SQL-created role with nothing but app's direct grants.

it('the suites connect as captain_runtime on the latest schema', async () => {
	const { listMigrations } = await import('../src/migrate.ts');
	const [who] = await db.app<{ current: string; session: string }[]>`select current_user as current, session_user as session`;
	assert.deepEqual(who, { current: runtime, session: runtime });
	assert.equal(db.runtimeRole, runtime);
	assert.equal(new URL(db.runtimeUrl).username, runtime);
	const [latest] = await db.owner<{ name: string }[]>`select max(name) as name from schema_migrations`;
	assert.equal(latest!.name, (await listMigrations()).at(-1)!.name);
	assert.ok(latest!.name >= runtimeRoleMigration);
});

it('captain_runtime has no attributes, no memberships (administrative or not) and owns nothing', async () => {
	const [role] = await db.owner`select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
		(select count(*) from pg_auth_members m where m.member = r.oid)::int as memberships,
		(select count(*) from pg_auth_members m where m.member = r.oid and m.admin_option)::int as administers,
		(select count(*) from pg_shdepend d where d.refclassid = 'pg_authid'::regclass and d.refobjid = r.oid and d.deptype = 'o')::int as owned,
		exists (select 1 from pg_roles o where o.oid <> r.oid and (o.rolsuper or o.rolbypassrls) and pg_has_role(r.oid, o.oid, 'SET')) as escalates
		from pg_roles r where r.rolname = ${runtime}`;
	assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false,
		memberships: 0, administers: 0, owned: 0, escalates: false });
});

// Every later migration must grant captain_runtime whatever it grants app, and name both in its policies: these two
// tests fail on the latest schema otherwise.
it('captain_runtime holds exactly app’s direct privileges on the application’s objects, nothing elsewhere, and only allowed kinds', async () => {
	const grants = await db.owner<{ role: string; grant: string; scoped: boolean; grantable: boolean }[]>`
		with schemas as (select oid from pg_namespace where nspname in ('public', 'workflow_queue')),
		members as (select classid, objid from pg_depend where deptype = 'e'),
		acl(grantee, object, privilege, grantable, scoped) as (
			select a.grantee, 'table ' || c.oid::regclass::text, a.privilege_type, a.is_grantable,
				c.relnamespace in (select oid from schemas) and not exists (select 1 from members e where e.classid = 'pg_class'::regclass and e.objid = c.oid)
				from pg_class c cross join lateral aclexplode(c.relacl) a
			union all select a.grantee, 'column ' || c.oid::regclass::text || '.' || t.attname, a.privilege_type, a.is_grantable,
				c.relnamespace in (select oid from schemas) and not exists (select 1 from members e where e.classid = 'pg_class'::regclass and e.objid = c.oid)
				from pg_attribute t join pg_class c on c.oid = t.attrelid cross join lateral aclexplode(t.attacl) a where t.attnum > 0
			union all select a.grantee, 'function ' || p.oid::regprocedure::text, a.privilege_type, a.is_grantable,
				p.pronamespace in (select oid from schemas) and not exists (select 1 from members e where e.classid = 'pg_proc'::regclass and e.objid = p.oid)
				from pg_proc p cross join lateral aclexplode(p.proacl) a
			union all select a.grantee, 'schema ' || n.nspname, a.privilege_type, a.is_grantable, n.oid in (select oid from schemas)
				from pg_namespace n cross join lateral aclexplode(n.nspacl) a
			union all select a.grantee, 'database ' || d.datname, a.privilege_type, a.is_grantable, d.datname = current_database()
				from pg_database d cross join lateral aclexplode(d.datacl) a
			union all select a.grantee, 'type ' || t.oid::regtype::text, a.privilege_type, a.is_grantable, false
				from pg_type t cross join lateral aclexplode(t.typacl) a)
		select pg_get_userbyid(grantee) as role, privilege || ' on ' || object as grant, scoped, grantable from acl
		where grantee in ('app'::regrole, ${runtime}::regrole) order by 2`;
	const of = (role: string) => grants.filter((g) => g.role === role && g.scoped).map((g) => g.grant);
	assert.ok(of('app').length > 40, 'app has its migrations’ grants');
	assert.deepEqual(of(runtime), of('app'), 'a migration granted app without captain_runtime, or the reverse');
	assert.deepEqual(grants.filter((g) => g.role === runtime && (!g.scoped || g.grantable)).map((g) => g.grant), [], 'nothing outside the application, nothing grantable');
	const kinds = new Set(grants.filter((g) => g.role === runtime).map((g) => g.grant.split(' ')[0]));
	assert.deepEqual([...kinds].filter((kind) => !['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'USAGE', 'EXECUTE', 'CONNECT', 'TEMPORARY'].includes(kind!)), []);
	assert.ok(of(runtime).includes('SELECT on table saved_views') && !of(runtime).includes('DELETE on table saved_views'));
	const policies = await db.owner<{ name: string; app: boolean; runtime: boolean }[]>`
		select p.polrelid::regclass::text || '.' || p.polname as name, 'app'::regrole = any(p.polroles) as app, ${runtime}::regrole = any(p.polroles) as runtime
		from pg_policy p order by 1`;
	assert.ok(policies.filter((p) => p.app).length > 20);
	for (const policy of policies) assert.equal(policy.runtime, policy.app, policy.name);
});

it('captain_runtime can execute exactly the security definer functions app can', async () => {
	const functions = await db.owner<{ name: string; app: boolean; runtime: boolean }[]>`
		select p.oid::regprocedure::text as name, has_function_privilege('app', p.oid, 'EXECUTE') as app, has_function_privilege(${runtime}, p.oid, 'EXECUTE') as runtime
		from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef order by 1`;
	assert.ok(functions.length > 0);
	for (const fn of functions) assert.equal(fn.runtime, fn.app, fn.name);
	for (const name of ['gmail_sync_organisations()', 'series_organisations()', 'shopify_sync_organisations()'])
		assert.ok(functions.find((fn) => fn.name === name)?.runtime, name);
	await db.app`select * from series_organisations()`;
});

it('captain_runtime is confined by row security: another tenant is invisible, and saved views cannot be deleted', async () => {
	const org = async (name: string) => (await db.owner<{ id: string }[]>`insert into organisations (name) values (${name}) returning id`)[0]!.id;
	const person = async (organisationId: string) => {
		const [user] = await db.owner<{ id: string }[]>`insert into users (email) values (${`${randomUUID()}@example.test`}) returning id`;
		await db.owner`insert into memberships (organisation_id, user_id, role) values (${organisationId}, ${user!.id}, 'owner')`;
		return user!.id;
	};
	const [a, b] = [await org('Runtime A'), await org('Runtime B')];
	const [alice, bob] = [await person(a), await person(b)];
	const view = async (organisationId: string, ownerId: string) => (await db.owner<{ id: string }[]>`insert into saved_views
		(id, organisation_id, owner_id, name, filter_version, filter) values (${randomUUID()}, ${organisationId}, ${ownerId}, 'Runtime view', 1,
		${db.owner.json({ owner: 'me', status: 'open', tagIds: [], projectId: null })}) returning id`)[0]!.id;
	const [mine, theirs] = [await view(a, alice), await view(b, bob)];
	const as = <T>(work: (tx: TransactionSql) => Promise<T>) => withTenant(db.app, { organisationId: a, userId: alice }, work);
	assert.deepEqual((await as((tx) => tx`select id from organisations where id in ${tx([a, b])}`)).map((r) => r.id), [a]);
	assert.deepEqual((await as((tx) => tx`select id from saved_views where id in ${tx([mine, theirs])}`)).map((r) => r.id), [mine]);
	await assert.rejects(as((tx) => tx`insert into saved_views (id, organisation_id, owner_id, name, filter_version, filter)
		values (${randomUUID()}, ${b}, ${alice}, 'Into B', 1, ${tx.json({ owner: 'me', status: 'open', tagIds: [], projectId: null })})`), /row-level security/);
	assert.equal((await db.app`select id from organisations`).length, 0, 'no tenant context sees no tenant rows');
	await assert.rejects(as((tx) => tx`delete from saved_views where id = ${mine}`), /permission denied/);
	await assert.rejects(as((tx) => tx`set local role app`), /permission denied/, 'no membership lets the runtime become app');
});

it('a database left before 0041 is still reached as app', async () => {
	const old = await freshDatabase({ through: '0040_saved_views.sql' });
	try {
		assert.equal(old.runtimeRole, 'app');
		assert.equal(new URL(old.runtimeUrl).username, 'app');
		assert.equal((await old.app<{ current: string }[]>`select current_user as current`)[0]!.current, 'app');
	} finally { await old.close(); }
});

it('0041 creates a clean runtime role, accepts a clean existing one, and refuses an unsafe one without changing it', async () => {
	// Roles are cluster-wide, so the shared captain_runtime is never touched: the migration's own text runs against a
	// throwaway role name inside a transaction that always rolls back.
	const migration = await readFile(new URL(`../migrations/${runtimeRoleMigration}`, import.meta.url), 'utf8');
	const binding = `runtime constant name := '${runtime}'`;
	assert.equal(migration.split(binding).length, 2, 'the migration names its role once, in its binding');
	const probe = `runtime_probe_${randomBytes(6).toString('hex')}`;
	class RolledBack extends Error {}
	const install = (setup: string, check?: (tx: TransactionSql) => Promise<void>) => db.owner.begin(async (tx) => {
		if (setup) await tx.unsafe(setup);
		await tx.unsafe(migration.replace(binding, `runtime constant name := '${probe}'`));
		await check?.(tx);
		throw new RolledBack();
	});
	const created = async (tx: TransactionSql) => {
		const [role] = await tx`select rolcanlogin, (select count(*) from pg_policy where ${probe}::regrole = any(polroles))::int as policies,
			has_table_privilege(${probe}, 'saved_views', 'SELECT') as reads, has_table_privilege(${probe}, 'saved_views', 'DELETE') as deletes
			from pg_roles where rolname = ${probe}`;
		assert.ok(role!.policies > 20); assert.equal(role!.reads, true); assert.equal(role!.deletes, false);
	};
	await assert.rejects(install('', async (tx) => { await created(tx); assert.equal((await tx`select rolcanlogin from pg_roles where rolname = ${probe}`)[0]!.rolcanlogin, false, 'created without login'); }), RolledBack);
	await assert.rejects(install(`create role ${probe} login`, created), RolledBack, 'an existing clean role is accepted, login and all');
	// Privileged catalog and extension functions are not the application's: app's direct grant on one is not copied.
	const [extension] = await db.owner<{ fn: string }[]>`select p.oid::regprocedure::text as fn from pg_proc p
		join pg_depend d on d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e' order by 1 limit 1`;
	await assert.rejects(install(`grant execute on function ${extension!.fn} to app`, async (tx) => {
		const [copied] = await tx`select count(*)::int as n from pg_proc p cross join lateral aclexplode(p.proacl) a
			where p.oid = ${extension!.fn}::regprocedure and a.grantee = ${probe}::regrole`;
		assert.equal(copied!.n, 0);
	}), RolledBack, 'extension function');
	// A direct grant to app outside the allowed kinds stops the migration before anything is copied.
	for (const [grant, shown] of [['truncate on saved_views', 'TRUNCATE on table saved_views'], ['references on saved_views', 'REFERENCES on table saved_views'],
		['trigger on saved_views', 'TRIGGER on table saved_views'], ['maintain on saved_views', 'MAINTAIN on table saved_views'],
		['create on schema public', 'CREATE on schema public']] as const)
		await assert.rejects(install(`grant ${grant} to app`), new RegExp(`app holds privileges a runtime must not have, so none are copied: ${shown}`), grant);
	for (const [setup, reason] of [
		[`create role ${probe} bypassrls`, /bypassrls/],
		[`create role ${probe} superuser`, /superuser/],
		[`create role ${probe} createrole`, /createrole/],
		[`create role ${probe} createdb`, /createdb/],
		[`create role ${probe} replication`, /replication/],
		[`create role ${probe}; grant pg_read_all_data to ${probe}`, /member of another role/],
		[`create role ${probe}; create role ${probe}_other; grant ${probe}_other to ${probe} with admin option, inherit false, set false`, /member of another role/],
		[`create role ${probe}; create table ${probe}_owned (); alter table ${probe}_owned owner to ${probe}`, /owns objects/],
		[`create role ${probe}; grant delete on saved_views to ${probe}`, /holds privileges app does not: DELETE on table saved_views/],
		[`create role ${probe}; grant select on saved_views to ${probe} with grant option`, /may grant its privileges on: table saved_views/],
		[`create role ${probe}; create policy ${probe}_open on saved_views for select to ${probe} using (true)`, /policies must name both app and/],
		[`create role ${probe}; grant execute on function ${extension!.fn} to ${probe}`, /already holds privileges outside the application's schemas/],
	] as const) await assert.rejects(install(setup), reason, setup);
	assert.equal((await db.owner`select 1 from pg_roles where rolname like ${`${probe}%`}`).length, 0, 'every attempt rolled back');
});
