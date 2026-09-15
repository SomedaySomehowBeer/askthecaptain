import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { withTenant } from '../src/context.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';
const it = databaseUrl ? test : test.skip;
let db: Harness;
let a: { org: string; user: string; connection: string; event: string };
let b: typeof a;
const tables = ['connections', 'sync_cursors', 'webhook_events', 'webhook_attempts'];
before(async () => {
	if (!databaseUrl) return; db = await freshDatabase();
	async function seed(name: string) {
		const [org] = await db.owner`insert into organisations (name) values (${name}) returning id`;
		const [user] = await db.owner`insert into users (email) values (${`${name}@example.com`}) returning id`;
		await db.owner`insert into memberships (organisation_id, user_id, role) values (${org!.id}, ${user!.id}, 'owner')`;
		const [connection] = await db.owner`insert into connections (organisation_id, provider, connected_by, account_email, scopes, status)
			values (${org!.id}, 'google', ${user!.id}, ${`${name}@example.com`}, '{}', 'connected') returning id`;
		await db.owner`insert into sync_cursors (organisation_id, connection_id, resource, cursor) values (${org!.id}, ${connection!.id}, 'gmail', '1')`;
		const [event] = await db.owner`insert into webhook_events (organisation_id, connection_id, provider, provider_event_id, payload)
			values (${org!.id}, ${connection!.id}, 'google', ${name}, '{}') returning id`;
		await db.owner`insert into webhook_attempts (organisation_id, connection_id, webhook_event_id) values (${org!.id}, ${connection!.id}, ${event!.id})`;
		return { org: org!.id as string, user: user!.id as string, connection: connection!.id as string, event: event!.id as string };
	}
	a = await seed('A'); b = await seed('B');
});
after(async () => { await db?.close(); });
it('all four tables hide other tenants, including reads without context and updates', async () => {
	for (const table of tables) {
		assert.equal((await db.app`select id from ${db.app(table)}`).length, 0);
		await withTenant(db.app, { organisationId: a.org, userId: a.user }, async (tx) => {
			const rows = await tx`select organisation_id from ${tx(table)}`;
			assert.deepEqual(rows.map((r) => r.organisationId), [a.org]);
			assert.equal((await tx`update ${tx(table)} set organisation_id = ${b.org} where organisation_id = ${b.org} returning id`).length, 0);
		});
		await assert.rejects(withTenant(db.app, { organisationId: a.org, userId: a.user }, (tx) =>
			tx`update ${tx(table)} set organisation_id = ${b.org} where organisation_id = ${a.org}`), { code: '42501' });
	}
});
it('a cursor in tenant A cannot reference tenant B connection: composite FK rejects it', async () => {
	await assert.rejects(withTenant(db.app, { organisationId: a.org, userId: a.user }, (tx) =>
		tx`insert into sync_cursors (organisation_id, connection_id, resource, cursor) values (${a.org}, ${b.connection}, 'calendar', '1')`), { code: '23503' });
});
it('webhook events and attempts cannot link across tenants or mismatched connections', async () => {
	await assert.rejects(withTenant(db.app, { organisationId: a.org, userId: a.user }, (tx) =>
		tx`insert into webhook_events (organisation_id, connection_id, provider, provider_event_id, payload) values (${a.org}, ${b.connection}, 'google', 'cross', '{}')`), { code: '23503' });
	for (const connection of [a.connection, b.connection]) {
		await assert.rejects(withTenant(db.app, { organisationId: a.org, userId: a.user }, (tx) =>
			tx`insert into webhook_attempts (organisation_id, connection_id, webhook_event_id) values (${a.org}, ${connection}, ${b.event})`), { code: '23503' });
	}
});
it('connection updates are role checked by RLS, including a member bypassing the service', async () => {
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${a.org}, ${b.user}, 'member')`;
	await assert.rejects(withTenant(db.app, { organisationId: a.org, userId: b.user }, (tx) =>
		tx`update connections set status = 'disconnected' where id = ${a.connection}`), { code: '42501' });
	await assert.rejects(withTenant(db.app, { organisationId: a.org, userId: a.user }, (tx) => tx`delete from connections`), { code: '42501' });
});
it('webhook provider event ids are deduplicated', async () => {
	await assert.rejects(withTenant(db.app, { organisationId: a.org, userId: a.user }, (tx) =>
		tx`insert into webhook_events (organisation_id, connection_id, provider, provider_event_id, payload) values (${a.org}, ${a.connection}, 'google', 'A', '{}')`), { code: '23505' });
});
