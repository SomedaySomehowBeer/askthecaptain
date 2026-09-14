import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { withTenant, withUser } from '../src/context.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';

const it = databaseUrl ? test : test.skip;
let db: Harness;
const ids = { orgA: '', orgB: '', alice: '', bob: '' };

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	const [a] = await db.owner`insert into organisations (name) values ('A') returning id`;
	const [b] = await db.owner`insert into organisations (name) values ('B') returning id`;
	const [alice] = await db.owner`insert into users (email, name) values ('alice@example.com', 'Alice') returning id`;
	const [bob] = await db.owner`insert into users (email, name) values ('bob@example.com', 'Bob') returning id`;
	Object.assign(ids, { orgA: a!.id, orgB: b!.id, alice: alice!.id, bob: bob!.id });
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${ids.orgA}, ${ids.alice}, 'owner'), (${ids.orgB}, ${ids.bob}, 'owner')`;
	await db.owner`insert into audit_events (organisation_id, actor_kind, actor_id, action, subject_type) values
		(${ids.orgA}, 'person', ${ids.alice}, 'test', 'thing'), (${ids.orgB}, 'person', ${ids.bob}, 'test', 'thing')`;
});
after(async () => { await db?.close(); });

it('without a tenant context the runtime role sees no tenant rows', async () => {
	assert.equal((await db.app`select id from organisations`).length, 0);
	assert.equal((await db.app`select organisation_id from memberships`).length, 0);
	assert.equal((await db.app`select id from audit_events`).length, 0);
});

it('a tenant sees only its own rows', async () => {
	const seen = await withTenant(db.app, { organisationId: ids.orgA, userId: ids.alice }, async (tx) => ({
		organisations: (await tx`select id from organisations`).map((row) => row.id),
		memberships: (await tx`select organisation_id as id from memberships`).map((row) => row.id),
		audit: (await tx`select organisation_id as id from audit_events`).map((row) => row.id)
	}));
	assert.deepEqual(seen, { organisations: [ids.orgA], memberships: [ids.orgA], audit: [ids.orgA] });
});

it('a tenant cannot write into another tenant', async () => {
	await assert.rejects(withTenant(db.app, { organisationId: ids.orgA, userId: ids.alice }, (tx) =>
		tx`insert into audit_events (organisation_id, actor_kind, action, subject_type) values (${ids.orgB}, 'system', 'x', 'y')`), /row-level security/);
	await assert.rejects(withTenant(db.app, { organisationId: ids.orgA, userId: ids.alice }, (tx) =>
		tx`insert into memberships (organisation_id, user_id, role) values (${ids.orgB}, ${ids.alice}, 'owner')`), /row-level security/);
	const stolen = await withTenant(db.app, { organisationId: ids.orgA, userId: ids.alice }, (tx) => tx`update organisations set name = 'X' where id = ${ids.orgB} returning id`);
	assert.equal(stolen.length, 0);
});

it('a signed-in person sees their memberships and organisations before choosing one', async () => {
	const seen = await withUser(db.app, { userId: ids.alice }, async (tx) => ({
		memberships: (await tx`select organisation_id as id from memberships`).map((row) => row.id),
		organisations: (await tx`select id from organisations`).map((row) => row.id)
	}));
	assert.deepEqual(seen, { memberships: [ids.orgA], organisations: [ids.orgA] });
});

it('the audit log is append-only for the runtime role', async () => {
	await assert.rejects(withTenant(db.app, { organisationId: ids.orgA, userId: ids.alice }, (tx) => tx`delete from audit_events`), /permission denied/);
	await assert.rejects(withTenant(db.app, { organisationId: ids.orgA, userId: ids.alice }, (tx) => tx`update audit_events set action = 'z'`), /permission denied/);
});

it('the context helpers refuse anything that is not a UUID', async () => {
	assert.throws(() => withTenant(db.app, { organisationId: 'x' }, async () => undefined), TypeError);
	assert.throws(() => withUser(db.app, { userId: '' }, async () => undefined), TypeError);
});
