import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { GoogleConnector, googleScopes } from '@captain/connectors';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { ConnectionService } from './service.ts';
import { open } from './encryption.ts';

const it = databaseUrl ? test : test.skip;
let db: Harness; let app: ReturnType<typeof createApp>; let auth: AuthService; let service: ConnectionService;
let owner: string; let member: string; let stranger: string; let org: string; let user: string;
const master = randomBytes(32);
let refreshCalls = 0; let exchangeCalls = 0; let failure = ''; let scopes = googleScopes; let refreshToken: string | undefined = 'refresh';
const fetcher: typeof fetch = async (url, init) => {
	if (String(url).endsWith('/profile')) return Response.json({ emailAddress: 'mail@example.com' });
	if (String(url).endsWith('/revoke')) throw new Error('test revocation failure');
	const params = new URLSearchParams(init!.body as URLSearchParams);
	if (params.get('grant_type') === 'refresh_token') {
		refreshCalls++;
		if (failure) return Response.json({ error: failure, error_description: 'must not be exposed' }, { status: 400 });
		await new Promise((resolve) => setTimeout(resolve, 30));
		return Response.json({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600, token_type: 'Bearer' });
	}
	exchangeCalls++;
	return Response.json({ access_token: 'access', refresh_token: refreshToken, expires_in: 3600, token_type: 'Bearer', scope: scopes.join(' ') });
};
const request = (method: string, path: string, token?: string) => app.request(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
const root = () => `/v1/organisations/${org}/connections`;
async function start() {
	const response = await request('POST', `${root()}/google/start`, owner); assert.equal(response.status, 200);
	return new URL((await response.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get('state')!;
}
async function finish(state: string, suffix = '&code=code') {
	const response = await app.request(`/connections/google/callback?state=${state}${suffix}`);
	assert.equal(response.status, 302); return new URL(response.headers.get('location')!);
}
const actor = () => ({ userId: user, requestId: 'test' });
async function connection() { const [row] = await db.owner`select * from connections where organisation_id = ${org}`; return row!; }
before(async () => {
	if (!databaseUrl) return; db = await freshDatabase();
	auth = new AuthService(db.app, null, { appUrl: 'https://app.test', sessionTtlDays: 1 });
	const organisations = new OrganisationService(db.app);
	service = new ConnectionService(db.app, new GoogleConnector('client', 'secret', 'https://api.test/connections/google/callback', fetcher), master, 'https://app.test');
	app = createApp({ db: db.app, auth, organisations, connections: service, commitments: new CommitmentsService(db.app) });
	const users = await db.owner`insert into users (email) values ('owner@test.com'), ('member@test.com'), ('stranger@test.com') returning id`;
	user = users[0]!.id; owner = (await auth.issueSessionFor(user)).token;
	member = (await auth.issueSessionFor(users[1]!.id)).token; stranger = (await auth.issueSessionFor(users[2]!.id)).token;
	org = (await organisations.create(actor(), { name: 'Connection test' })).id;
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${users[1]!.id}, 'member')`;
});
after(async () => { await db?.close(); });
it('routes require a session; members read only; outsiders cannot choose a tenant', async () => {
	assert.equal((await request('GET', root())).status, 401);
	assert.equal((await request('GET', root(), member)).status, 200);
	assert.equal((await request('POST', `${root()}/google/start`, member)).status, 403);
	assert.equal((await request('GET', root(), stranger)).status, 404);
	assert.equal((await request('POST', `${root()}/google/start`, stranger)).status, 404);
});
it('callback verifies profile, encrypts both tokens, and exposes only metadata; reconnect upserts', async () => {
	const state = await start(); assert.equal((await finish(state)).searchParams.get('connected'), 'google');
	const row = await connection(); const [organisation] = await db.owner`select data_key_wrapped from organisations where id = ${org}`;
	const key = open(master, organisation!.dataKeyWrapped, org, 'data_key');
	assert.equal(open(key, row.accessTokenEncrypted, org, 'access_token').toString(), 'access');
	assert.equal(open(key, row.refreshTokenEncrypted, org, 'refresh_token').toString(), 'refresh');
	const response = await request('GET', root(), member); const body = await response.text();
	assert.ok(body.includes('mail@example.com')); assert.ok(!body.includes('Encrypted')); assert.ok(!body.includes('Wrapped'));
	assert.equal((await finish(state)).searchParams.get('error'), 'request_invalid');
	assert.equal((await finish(await start())).searchParams.get('connected'), 'google');
	assert.equal((await connection()).id, row.id);
	const audit = await db.owner`select action, detail from audit_events where organisation_id = ${org}`;
	for (const action of ['connection.started', 'connection.callback_consumed', 'organisation.data_key_created', 'connection.connected']) assert.ok(audit.some((r) => r.action === action));
	assert.ok(!JSON.stringify(audit).includes('refresh_token'));
});
it('OAuth state expires, is single-use on denial, and cannot be confused with sign-in', async () => {
	const state = await start(); assert.equal((await finish(state, '&error=access_denied')).searchParams.get('error'), 'access_denied');
	assert.equal((await finish(state)).searchParams.get('error'), 'request_invalid');
	const expired = await start(); await db.owner`update auth_requests set expires_at = now() - interval '1 minute' where consumed_at is null`;
	assert.equal((await finish(expired)).searchParams.get('error'), 'request_invalid');
	const wrongKind = await start(); await db.owner`update auth_requests set kind = 'oauth' where consumed_at is null`;
	const calls = exchangeCalls; assert.equal((await finish(wrongKind)).searchParams.get('error'), 'request_invalid'); assert.equal(exchangeCalls, calls);
});
it('callback rechecks roles and refuses partial scopes and missing offline access without damaging the connection', async () => {
	const state = await start(); const calls = exchangeCalls;
	await db.owner`update memberships set role = 'member' where organisation_id = ${org} and user_id = ${user}`;
	assert.equal((await finish(state)).searchParams.get('error'), 'forbidden'); assert.equal(exchangeCalls, calls);
	await db.owner`update memberships set role = 'owner' where organisation_id = ${org} and user_id = ${user}`;
	scopes = [googleScopes[2]!]; assert.equal((await finish(await start())).searchParams.get('error'), 'scopes_missing'); scopes = googleScopes;
	refreshToken = undefined; assert.equal((await finish(await start())).searchParams.get('error'), 'refresh_missing'); refreshToken = 'refresh';
	assert.equal((await connection()).status, 'connected');
});
it('concurrent system refreshes rotate once under a row lock and are audited as system', async () => {
	const row = await connection(); await db.owner`update connections set access_token_expires_at = now() where id = ${row.id}`;
	const tokens = await Promise.all([service.accessToken(undefined, org, row.id), service.accessToken(undefined, org, row.id)]);
	assert.deepEqual(tokens, ['new-access', 'new-access']); assert.equal(refreshCalls, 1);
	const [organisation] = await db.owner`select data_key_wrapped from organisations where id = ${org}`;
	const key = open(master, organisation!.dataKeyWrapped, org, 'data_key');
	assert.equal(open(key, (await connection()).refreshTokenEncrypted, org, 'refresh_token').toString(), 'rotated-refresh');
	const events = await db.owner`select actor_kind, actor_id from audit_events where action = 'connection.refreshed' and subject_id = ${row.id}`;
	assert.deepEqual([...events], [{ actorKind: 'system', actorId: null }]);
});
it('members cannot connect or disconnect through the API but can refresh for workflows; outsiders cannot', async () => {
	const row = await connection();
	assert.equal((await request('POST', `${root()}/google/start`, member)).status, 403);
	assert.equal((await request('DELETE', `${root()}/${row.id}`, member)).status, 403);
	await db.owner`update connections set access_token_expires_at = now() where id = ${row.id}`;
	const memberActor = { userId: (await auth.requireSession(member)).userId, requestId: 'member-refresh' };
	const strangerActor = { userId: (await auth.requireSession(stranger)).userId, requestId: 'stranger-refresh' };
	await assert.rejects(service.accessToken(strangerActor, org, row.id), { code: 'not_found' });
	assert.equal(await service.accessToken(memberActor, org, row.id), 'new-access');
	const events = await db.owner`select actor_kind, actor_id from audit_events where request_id = 'member-refresh'`;
	assert.deepEqual([...events], [{ actorKind: 'person', actorId: memberActor.userId }]);
	await db.owner`update memberships set status = 'removed' where organisation_id = ${org} and user_id = ${memberActor.userId}`;
	await assert.rejects(service.accessToken(memberActor, org, row.id), { code: 'not_found' });
	await db.owner`update memberships set status = 'active' where organisation_id = ${org} and user_id = ${memberActor.userId}`;
});
it('refresh failures commit an honest state and invalid_grant requires reconnecting', async () => {
	const row = await connection();
	for (const [error, status] of [['temporarily_unavailable', 'refresh_failed'], ['invalid_grant', 'revoked']]) {
		failure = error!; await db.owner`update connections set access_token_expires_at = now() where id = ${row.id}`;
		await assert.rejects(service.accessToken(undefined, org, row.id), { code: 'reconnect_required' });
		const stored = await connection(); assert.equal(stored.status, status); assert.ok(!stored.error.includes('must not be exposed'));
		const [event] = await db.owner`select actor_kind, actor_id from audit_events where action = 'connection.refresh_failed' order by created_at desc limit 1`;
		assert.deepEqual(event, { actorKind: 'system', actorId: null });
	}
	failure = '';
});
it('disconnect is role checked, best effort at Google, clears tokens and is audited', async () => {
	const row = await connection();
	assert.equal((await request('DELETE', `${root()}/${row.id}`, member)).status, 403);
	assert.equal((await request('DELETE', `${root()}/${row.id}`, stranger)).status, 404);
	assert.equal((await request('DELETE', `${root()}/${row.id}`, owner)).status, 200);
	const stored = await connection(); assert.equal(stored.status, 'disconnected'); assert.equal(stored.accessTokenEncrypted, null); assert.equal(stored.refreshTokenEncrypted, null);
	assert.match(stored.error, /Remove Captain/);
	assert.equal((await db.owner`select id from audit_events where action = 'connection.disconnected'`).length, 1);
	assert.equal((await request('DELETE', `${root()}/${row.id}`, owner)).status, 200);
});
