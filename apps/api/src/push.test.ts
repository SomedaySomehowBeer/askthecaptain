import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from './app.ts';
import type { IdentityProvider } from './auth/google.ts';
import { AuthService } from './auth/service.ts';
import { CommitmentsService } from './commitments/service.ts';
import { OrganisationService } from './organisations/service.ts';
import { PushService, PushTransportError, type PushTransport } from './push/service.ts';
import { WorkflowService } from './workflows/service.ts';

const it = databaseUrl ? test : test.skip;
let db: Harness; let app: ReturnType<typeof createApp>; let push: PushService;
const google: IdentityProvider & { next: { subject: string; email: string; name: string } } = {
	next: { subject: 'g-1', email: 'owner@example.com', name: 'Olive Owner' },
	authorizationUrl: ({ state }) => `https://google.test/auth?state=${state}`,
	async exchange() { return google.next; }
};
const sent: { endpoint: string; payload: string }[] = []; const gone = new Set<string>();
const transport: PushTransport = { async send(subscription, payload) { if (gone.has(subscription.endpoint)) throw new PushTransportError(410, 'gone'); sent.push({ endpoint: subscription.endpoint, payload }); return { statusCode: 201 }; } };
const json = (method: string, path: string, token?: string, body?: unknown) => app.request(path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
async function signIn(identity: { subject: string; email: string; name: string }) {
	google.next = identity;
	const start = await app.request('/auth/google/start');
	const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
	const callback = await app.request(`/auth/google/callback?code=abc&state=${state}`);
	const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
	return (await (await json('POST', '/auth/session/exchange', undefined, { code })).json()) as { token: string; user: { id: string } };
}
const body = async <T>(response: Response, status: number): Promise<T> => { assert.equal(response.status, status, await response.clone().text()); return (await response.json()) as T; };
const device = (n: number) => ({ endpoint: `https://push.example/device-${n}`, keys: { p256dh: 'p256dh-key', auth: 'auth-key' }, userAgent: 'Mozilla/5.0 (iPhone) Safari/605' });

let owner: { token: string; user: { id: string } }; let orgId: string;
before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	push = new PushService(db.app, transport, 'public-key');
	app = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 }), organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), workflows: new WorkflowService(db.app, push), push });
	owner = await signIn({ subject: 'g-1', email: 'owner@example.com', name: 'Olive Owner' });
	orgId = (await body<{ id: string }>(await json('POST', '/v1/organisations', owner.token, { name: 'Harbour Brewing' }), 201)).id;
});
after(async () => { await db?.close(); });

it('a device subscribes, is listed for its person only, and satisfies the push requirement', async () => {
	assert.deepEqual(await body(await json('GET', '/v1/push/config', owner.token), 200), { configured: true, publicKey: 'public-key' });
	const created = await body<{ id: string; endpoint: string }>(await json('POST', `/v1/organisations/${orgId}/push/subscriptions`, owner.token, device(1)), 201);
	assert.equal(created.endpoint, device(1).endpoint);
	// Subscribing the same endpoint again updates it rather than duplicating it.
	await body(await json('POST', `/v1/organisations/${orgId}/push/subscriptions`, owner.token, device(1)), 201);
	const mine = await body<{ subscriptions: { endpoint: string }[] }>(await json('GET', `/v1/organisations/${orgId}/push/subscriptions`, owner.token), 200);
	assert.deepEqual(mine.subscriptions.map((s) => s.endpoint), [device(1).endpoint]);
	const offered = await body<{ workflows: { definition: { key: string }; unmet: { requirement: string }[] }[] }>(await json('GET', `/v1/organisations/${orgId}/workflows`, owner.token), 200);
	assert.ok(!offered.workflows.find((w) => w.definition.key === 'morning-brief')!.unmet.some((u) => u.requirement === 'push'), 'push is no longer unmet');
	assert.equal((await json('POST', `/v1/organisations/${orgId}/push/subscriptions`, owner.token, { ...device(2), endpoint: 'http://insecure.example/x' })).status, 400);
});

it('a test push is journaled per device, a gone device is disabled, and a stranger sees nothing', async () => {
	await body(await json('POST', `/v1/organisations/${orgId}/push/subscriptions`, owner.token, device(2)), 201);
	sent.length = 0;
	const first = await body<{ deliveries: { state: string }[] }>(await json('POST', `/v1/organisations/${orgId}/push/test`, owner.token), 200);
	assert.deepEqual(first.deliveries.map((d) => d.state), ['sent', 'sent']);
	assert.equal(sent.length, 2); assert.match(sent[0]!.payload, /Captain can reach this device/);
	gone.add(device(2).endpoint);
	const second = await body<{ deliveries: { state: string; statusCode: number | null }[] }>(await json('POST', `/v1/organisations/${orgId}/push/test`, owner.token), 200);
	assert.deepEqual(second.deliveries.map((d) => [d.state, d.statusCode]), [['sent', 201], ['gone', 410]]);
	const mine = await body<{ subscriptions: { endpoint: string }[] }>(await json('GET', `/v1/organisations/${orgId}/push/subscriptions`, owner.token), 200);
	assert.deepEqual(mine.subscriptions.map((s) => s.endpoint), [device(1).endpoint], 'the gone device is disabled');
	const deliveries = await db.owner`select state, status_code from push_deliveries where organisation_id = ${orgId} order by created_at`;
	assert.deepEqual(deliveries.map((d) => [d.state, d.statusCode]), [['sent', 201], ['sent', 201], ['sent', 201], ['gone', 410]]);
	await body(await json('DELETE', `/v1/organisations/${orgId}/push/subscriptions`, owner.token, { endpoint: device(1).endpoint }), 200);
	assert.equal((await json('POST', `/v1/organisations/${orgId}/push/test`, owner.token)).status, 400, 'no devices left');
	const stranger = await signIn({ subject: 'g-9', email: 'sam@example.com', name: 'Sam' });
	assert.equal((await json('GET', `/v1/organisations/${orgId}/push/subscriptions`, stranger.token)).status, 404);
});

it('without keys, push says it is not set up and subscribing is refused in words', async () => {
	const unconfigured = new PushService(db.app, null, null);
	assert.equal(unconfigured.configured, false);
	await assert.rejects(unconfigured.subscribe({ userId: owner.user.id, requestId: 'r' }, orgId, device(3)), /not set up/);
	assert.deepEqual(await unconfigured.send(orgId, owner.user.id, { title: 'x' }), []);
});
