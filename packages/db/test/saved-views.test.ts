import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { TransactionSql } from 'postgres';
import { withTenant } from '../src/context.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';

// Migration 0040 (D26): private saved Work views. The table's own rules, proven as the migration owner and as the
// non-bypassing runtime role `app`, independently of the API.
const it = databaseUrl ? test : test.skip;
let db: Harness;
let orgA: string, orgB: string, ownerA: string, memberA: string, ownerB: string;
const filter = { owner: 'me', status: 'open', tagIds: [], projectId: null };
const insertView = async (organisationId: string, ownerId: string, name = `View ${randomUUID().slice(0, 8)}`) => {
	const [row] = await db.owner<{ id: string }[]>`insert into saved_views (id, organisation_id, owner_id, name, filter_version, filter)
		values (${randomUUID()}, ${organisationId}, ${ownerId}, ${name}, 1, ${db.owner.json(filter)}) returning id`;
	return row!.id;
};
const as = <T>(organisationId: string, userId: string, work: (tx: TransactionSql) => Promise<T>) => withTenant(db.app, { organisationId, userId }, work);

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	const user = async (email: string) => (await db.owner<{ id: string }[]>`insert into users (email) values (${email}) returning id`)[0]!.id;
	[ownerA, memberA, ownerB] = [await user('owner-a@example.test'), await user('member-a@example.test'), await user('owner-b@example.test')];
	orgA = (await db.owner<{ id: string }[]>`insert into organisations (name) values ('A') returning id`)[0]!.id;
	orgB = (await db.owner<{ id: string }[]>`insert into organisations (name) values ('B') returning id`)[0]!.id;
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${orgA}, ${ownerA}, 'owner'), (${orgA}, ${memberA}, 'member'), (${orgB}, ${ownerB}, 'owner')`;
});
after(async () => { await db?.close(); });

it('a live row has all of its content, a tombstone none, and every column keeps its bounds', async () => {
	const insert = (values: { name?: string | null; filterVersion?: number | null; filter?: unknown; deletedAt?: Date | null; section?: string; revision?: number; ownerId?: string }) =>
		db.owner`insert into saved_views (id, organisation_id, owner_id, section, name, filter_version, filter, deleted_at, revision)
			values (${randomUUID()}, ${orgA}, ${values.ownerId ?? memberA}, ${values.section ?? 'work'}, ${values.name === undefined ? 'Bounds' : values.name},
				${values.filterVersion === undefined ? 1 : values.filterVersion}, ${values.filter === undefined ? db.owner.json(filter) : values.filter === null ? null : db.owner.json(values.filter as never)},
				${values.deletedAt ?? null}, ${values.revision ?? 1})`;
	const now = new Date();
	for (const [label, values] of [
		['live without a name', { name: null }], ['live without a filter', { filter: null }], ['live without a version', { filterVersion: null }],
		['tombstone keeping its name', { deletedAt: now, filter: null, filterVersion: null }],
		['tombstone keeping its filter', { deletedAt: now, name: null, filterVersion: null }],
		['tombstone keeping its version', { deletedAt: now, name: null, filter: null }],
		['another section', { section: 'chat' }], ['untrimmed name', { name: ' Padded' }], ['empty name', { name: '' }], ['61-character name', { name: 'x'.repeat(61) }],
		['array filter', { filter: [] }], ['string filter', { filter: 'open' }], ['filter over 4 KB', { filter: { ...filter, padding: 'x'.repeat(4100) } }],
		['version 0', { filterVersion: 0 }], ['revision 0', { revision: 0 }],
	] as const) await assert.rejects(insert(values as Parameters<typeof insert>[0]), /check constraint/, label);
	await assert.rejects(insert({ ownerId: ownerB }), /foreign key/, 'the owner must be a member of the organisation');
	await insert({ name: '60'.repeat(30) });
	await insert({ deletedAt: now, name: null, filter: null, filterVersion: null });
	await insert({ name: 'A newer version', filterVersion: 7, filter: { anything: 'the old server does not understand' } });
});

it('every update moves the revision, identity is fixed and a tombstone is final, whoever writes', async () => {
	const id = await insertView(orgA, memberA, 'Identity');
	await db.owner`update saved_views set name = 'Renamed', revision = 99, updated_at = now() where id = ${id}`;
	await db.owner`update saved_views set updated_at = now() where id = ${id}`;
	assert.equal((await db.owner`select revision from saved_views where id = ${id}`)[0]!.revision, 3, 'a supplied revision is ignored');
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${orgB}, ${memberA}, 'member')`;
	try {
		for (const [column, change] of [
			['id', db.owner`update saved_views set id = ${randomUUID()} where id = ${id}`],
			['organisation_id', db.owner`update saved_views set organisation_id = ${orgB} where id = ${id}`],
			['owner_id', db.owner`update saved_views set owner_id = ${ownerA} where id = ${id}`],
			['section', db.owner`update saved_views set section = 'work ' where id = ${id}`],
			['created_at', db.owner`update saved_views set created_at = now() - interval '1 day' where id = ${id}`],
		] as const) await assert.rejects(change, /keeps its id, organisation, owner, section and creation time/, column);
	} finally { await db.owner`delete from memberships where organisation_id = ${orgB} and user_id = ${memberA}`; }
	await db.owner`update saved_views set deleted_at = now(), name = null, filter = null, filter_version = null, updated_at = now() where id = ${id}`;
	assert.equal((await db.owner`select revision from saved_views where id = ${id}`)[0]!.revision, 4);
	for (const change of [
		db.owner`update saved_views set updated_at = now() where id = ${id}`,
		db.owner`update saved_views set deleted_at = null, name = 'Back', filter = ${db.owner.json(filter)}, filter_version = 1 where id = ${id}`,
	]) await assert.rejects(change, /deleted saved view cannot be changed/);
	await assert.rejects(as(orgA, memberA, tx => tx`update saved_views set deleted_at = null, name = 'Back', filter = ${tx.json(filter)}, filter_version = 1 where id = ${id}`),
		/deleted saved view cannot be changed/, 'nor can the owner through app');
	const [tombstone] = await db.owner`select name, filter, filter_version, deleted_at, revision from saved_views where id = ${id}`;
	assert.equal(tombstone!.name, null); assert.ok(tombstone!.deletedAt); assert.equal(tombstone!.revision, 4);
});

it('app reads and writes only the owner’s rows in the current tenant, while active, and can never delete', async () => {
	const [grant] = await db.owner<{ del: boolean; sel: boolean; ins: boolean; upd: boolean; truncate: boolean }[]>`select
		has_table_privilege('app', 'saved_views', 'DELETE') as del, has_table_privilege('app', 'saved_views', 'SELECT') as sel,
		has_table_privilege('app', 'saved_views', 'INSERT') as ins, has_table_privilege('app', 'saved_views', 'UPDATE') as upd,
		has_table_privilege('app', 'saved_views', 'TRUNCATE') as truncate`;
	assert.deepEqual(grant, { del: false, sel: true, ins: true, upd: true, truncate: false });
	const [policies] = await db.owner<{ commands: string[]; forced: boolean }[]>`select array_agg(p.polcmd::text order by p.polcmd) as commands, c.relforcerowsecurity as forced
		from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname = 'saved_views' group by c.relforcerowsecurity`;
	assert.deepEqual(policies, { commands: ['a', 'r', 'w'], forced: true }, 'insert, select and update policies only; no delete or all policy');

	const mine = await insertView(orgA, memberA, 'Member row');
	const theirs = await insertView(orgA, ownerA, 'Owner row');
	const elsewhere = await insertView(orgB, ownerB, 'Other tenant row');
	assert.deepEqual((await as(orgA, memberA, tx => tx`select id from saved_views where id in ${tx([mine, theirs, elsewhere])}`)).map(r => r.id), [mine]);
	assert.deepEqual((await as(orgA, ownerA, tx => tx`select id from saved_views where id in ${tx([mine, theirs, elsewhere])}`)).map(r => r.id), [theirs], 'an organisation owner does not see a member’s view');
	assert.equal((await as(orgB, memberA, tx => tx`select id from saved_views`)).length, 0, 'the wrong tenant context sees nothing');
	assert.equal((await as(orgA, ownerA, tx => tx`update saved_views set name = 'Taken' where id = ${mine} returning id`)).length, 0);
	assert.equal((await as(orgA, ownerA, tx => tx`update saved_views set name = 'Taken' where id = ${elsewhere} returning id`)).length, 0);
	assert.equal((await withTenant(db.app, { organisationId: orgA }, tx => tx`select id from saved_views`)).length, 0, 'no user context sees nothing');
	for (const [org, user] of [[orgA, memberA], [orgA, ownerA], [orgB, ownerB]] as const)
		await assert.rejects(as(org, user, tx => tx`delete from saved_views`), /permission denied/);
	await assert.rejects(as(orgA, memberA, tx => tx`truncate saved_views`), /permission denied/);
	await assert.rejects(as(orgA, memberA, tx => tx`insert into saved_views (id, organisation_id, owner_id, name, filter_version, filter)
		values (${randomUUID()}, ${orgA}, ${ownerA}, 'For someone else', 1, ${tx.json(filter)})`), /row-level security/);
	await assert.rejects(as(orgA, memberA, tx => tx`insert into saved_views (id, organisation_id, owner_id, name, filter_version, filter)
		values (${randomUUID()}, ${orgB}, ${memberA}, 'Elsewhere', 1, ${tx.json(filter)})`), /row-level security/);
	await assert.rejects(as(orgA, memberA, tx => tx`update saved_views set owner_id = ${ownerA} where id = ${mine}`), /keeps its id/);
	// The second, independent layer: with the identity trigger out of the way, row security's `with check` still refuses.
	await db.owner`alter table saved_views disable trigger saved_views_identity`;
	try {
		await assert.rejects(as(orgA, memberA, tx => tx`update saved_views set owner_id = ${ownerA} where id = ${mine}`), /row-level security/);
		await assert.rejects(as(orgA, memberA, tx => tx`update saved_views set organisation_id = ${orgB} where id = ${mine}`), /row-level security/);
	} finally { await db.owner`alter table saved_views enable trigger saved_views_identity`; }
	await as(orgA, memberA, tx => tx`update saved_views set name = 'Member renamed' where id = ${mine}`);
	// A hidden row's id is still taken: the insert fails on the key, not by overwriting or revealing it.
	await assert.rejects(as(orgA, memberA, tx => tx`insert into saved_views (id, organisation_id, owner_id, name, filter_version, filter)
		values (${theirs}, ${orgA}, ${memberA}, 'Same id', 1, ${tx.json(filter)})`), /duplicate key/);
	assert.equal((await as(orgA, memberA, tx => tx`insert into saved_views (id, organisation_id, owner_id, name, filter_version, filter)
		values (${theirs}, ${orgA}, ${memberA}, 'Same id', 1, ${tx.json(filter)}) on conflict (id) do nothing returning id`)).length, 0);
	assert.equal((await db.owner`select owner_id from saved_views where id = ${theirs}`)[0]!.ownerId, ownerA);

	await db.owner`update memberships set status = 'removed' where organisation_id = ${orgA} and user_id = ${memberA}`;
	try {
		assert.equal((await as(orgA, memberA, tx => tx`select id from saved_views`)).length, 0, 'a removed member sees none of their views');
		assert.equal((await as(orgA, memberA, tx => tx`update saved_views set name = 'While removed' where id = ${mine} returning id`)).length, 0);
		await assert.rejects(as(orgA, memberA, tx => tx`insert into saved_views (id, organisation_id, owner_id, name, filter_version, filter)
			values (${randomUUID()}, ${orgA}, ${memberA}, 'While removed', 1, ${tx.json(filter)})`), /row-level security/);
		assert.equal((await db.owner`select name from saved_views where id = ${mine}`)[0]!.name, 'Member renamed', 'kept while removed');
	} finally { await db.owner`update memberships set status = 'active' where organisation_id = ${orgA} and user_id = ${memberA}`; }
	assert.deepEqual((await as(orgA, memberA, tx => tx`select name from saved_views where id = ${mine}`)).map(r => r.name), ['Member renamed'], 'reactivation shows them again');
});

it('membership and organisation deletion as app cascade live views and tombstones, with no delete grant', async () => {
	const leaver = (await db.owner<{ id: string }[]>`insert into users (email) values ('leaver@example.test') returning id`)[0]!.id;
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${orgA}, ${leaver}, 'member')`;
	const live = await insertView(orgA, leaver, 'Leaver live');
	const dead = await insertView(orgA, leaver, 'Leaver dead');
	await as(orgA, leaver, tx => tx`update saved_views set deleted_at = now(), name = null, filter = null, filter_version = null where id = ${dead}`);
	await as(orgA, ownerA, tx => tx`delete from memberships where organisation_id = ${orgA} and user_id = ${leaver}`);
	assert.equal((await db.owner`select id from saved_views where id in ${db.owner([live, dead])}`).length, 0);

	const accountLeaver = (await db.owner<{ id: string }[]>`insert into users (email) values ('account-leaver@example.test') returning id`)[0]!.id;
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${orgA}, ${accountLeaver}, 'member'), (${orgB}, ${accountLeaver}, 'member')`;
	const inA = await insertView(orgA, accountLeaver), inB = await insertView(orgB, accountLeaver);
	await db.app`delete from users where id = ${accountLeaver}`;
	assert.equal((await db.owner`select id from saved_views where id in ${db.owner([inA, inB])}`).length, 0, 'account deletion cascades through every membership');

	const bView = await insertView(orgB, ownerB, 'B live');
	const bDead = await insertView(orgB, ownerB, 'B dead');
	await as(orgB, ownerB, tx => tx`update saved_views set deleted_at = now(), name = null, filter = null, filter_version = null where id = ${bDead}`);
	await as(orgB, ownerB, tx => tx`delete from organisations where id = ${orgB}`);
	assert.equal((await db.owner`select id from saved_views where organisation_id = ${orgB}`).length, 0);
	assert.equal((await db.owner`select id from saved_views where id in ${db.owner([bView, bDead])}`).length, 0);
	assert.ok((await db.owner`select id from saved_views where organisation_id = ${orgA}`).length > 0, 'another tenant is untouched');
	assert.equal((await db.owner<{ del: boolean }[]>`select has_table_privilege('app', 'saved_views', 'DELETE') as del`)[0]!.del, false);
});
