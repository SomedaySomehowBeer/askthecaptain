import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { withTenant } from '../src/context.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';

/** Cross-tenant tests for push_subscriptions and push_deliveries (D6). */
const it = databaseUrl ? test : test.skip;
let db: Harness;
const ids = { orgA: '', orgB: '', alice: '', bob: '', subA: '', subB: '' };

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	const [a] = await db.owner`insert into organisations (name) values ('A') returning id`;
	const [b] = await db.owner`insert into organisations (name) values ('B') returning id`;
	const [alice] = await db.owner`insert into users (email, name) values ('alice@example.com', 'Alice') returning id`;
	const [bob] = await db.owner`insert into users (email, name) values ('bob@example.com', 'Bob') returning id`;
	Object.assign(ids, { orgA: a!.id, orgB: b!.id, alice: alice!.id, bob: bob!.id });
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${ids.orgA}, ${ids.alice}, 'owner'), (${ids.orgB}, ${ids.bob}, 'owner')`;
	const [sa] = await db.owner`insert into push_subscriptions (organisation_id, user_id, endpoint, p256dh, auth) values (${ids.orgA}, ${ids.alice}, 'https://push.example/a', 'k', 'a') returning id`;
	const [sb] = await db.owner`insert into push_subscriptions (organisation_id, user_id, endpoint, p256dh, auth) values (${ids.orgB}, ${ids.bob}, 'https://push.example/b', 'k', 'a') returning id`;
	await db.owner`insert into push_deliveries (organisation_id, subscription_id, title, state) values (${ids.orgB}, ${sb!.id}, 'hello', 'sent')`;
	Object.assign(ids, { subA: sa!.id, subB: sb!.id });
});
after(async () => { await db?.close(); });

const asA = <T>(work: Parameters<typeof withTenant<T>>[2]) => withTenant<T>(db.app, { organisationId: ids.orgA, userId: ids.alice }, work);

it('a tenant sees only its own subscriptions and deliveries', async () => {
	assert.equal((await db.app`select id from push_subscriptions`).length, 0);
	const seen = await asA(async (tx) => ({ subs: (await tx`select id from push_subscriptions`).map((r) => r.id), deliveries: (await tx`select id from push_deliveries`).map((r) => r.id) }));
	assert.deepEqual(seen, { subs: [ids.subA], deliveries: [] });
});

it('a tenant cannot subscribe a stranger, reference another tenant\'s device, or touch its rows', async () => {
	await assert.rejects(asA((tx) => tx`insert into push_subscriptions (organisation_id, user_id, endpoint, p256dh, auth) values (${ids.orgA}, ${ids.bob}, 'https://push.example/x', 'k', 'a')`), /violates foreign key/);
	await assert.rejects(asA((tx) => tx`insert into push_deliveries (organisation_id, subscription_id, title, state) values (${ids.orgA}, ${ids.subB}, 'x', 'sent')`), /violates foreign key/);
	await assert.rejects(asA((tx) => tx`insert into push_deliveries (organisation_id, subscription_id, title, state) values (${ids.orgB}, ${ids.subB}, 'x', 'sent')`), /row-level security/);
	assert.equal((await asA((tx) => tx`update push_subscriptions set disabled_at = now() where id = ${ids.subB} returning id`)).length, 0);
	await assert.rejects(asA((tx) => tx`delete from push_deliveries`), /permission denied/);
});
