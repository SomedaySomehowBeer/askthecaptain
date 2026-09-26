import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from './app.ts';
import type { IdentityProvider } from './auth/google.ts';
import { AuthService } from './auth/service.ts';
import { CommitmentsService } from './commitments/service.ts';
import { OrganisationService } from './organisations/service.ts';

const it = databaseUrl ? test : test.skip;
let db: Harness; let app: ReturnType<typeof createApp>; let auth: AuthService;
const google: IdentityProvider & { next: { subject: string; email: string; name: string } } = {
	next: { subject: 'g-1', email: 'owner@example.com', name: 'Olive Owner' },
	authorizationUrl: ({ state }) => `https://google.test/auth?state=${state}`,
	async exchange() { return google.next; }
};
const json = (method: string, path: string, token?: string, body?: unknown) => app.request(path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

async function signIn(identity: { subject: string; email: string; name: string }) {
	google.next = identity;
	const start = await app.request('/auth/google/start?return_to=/settings');
	const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
	const callback = await app.request(`/auth/google/callback?code=abc&state=${state}`);
	const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
	const exchange = await json('POST', '/auth/session/exchange', undefined, { code });
	return (await exchange.json()) as { token: string; user: { id: string }; returnTo: string };
}

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	auth = new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 });
	app = createApp({ db: db.app, auth, organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app) });
});
after(async () => { await db?.close(); });

it('health answers without a session', async () => {
	assert.equal((await app.request('/healthz')).status, 200);
	assert.equal((await app.request('/readyz')).status, 200);
	assert.equal((await app.request('/v1/me')).status, 401);
});

it('readiness rejects an administrative database connection without exposing role details', async () => {
	const unsafe = createApp({ db: db.owner, auth, organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app) });
	const response = await unsafe.request('/readyz');
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { ok: false, reason: 'database role is unsafe' });
});

it('Google sign-in hands the web a one-time code that becomes a session', async () => {
	const signed = await signIn({ subject: 'g-1', email: 'owner@example.com', name: 'Olive Owner' });
	assert.match(signed.token, /^sess_/); assert.equal(signed.returnTo, '/settings');
	const me = await json('GET', '/v1/me', signed.token);
	assert.equal(me.status, 200);
	assert.deepEqual((await me.json() as { memberships: unknown[] }).memberships, []);
	// The exchange code is single use and the OAuth state cannot be replayed.
	const replay = await json('POST', '/auth/session/exchange', undefined, { code: 'x_nope' });
	assert.equal(replay.status, 401);
	const again = await signIn({ subject: 'g-1', email: 'owner@example.com', name: 'Olive Owner' });
	assert.equal(again.user.id, signed.user.id, 'the same Google subject is the same person');
});

it('return_to must be a path on the app', async () => {
	assert.equal((await app.request('/auth/google/start?return_to=https://evil.test')).status, 400);
	assert.equal((await app.request('/auth/google/start?return_to=//evil.test')).status, 400);
});

it('a person creates an organisation and becomes its owner; others cannot see it', async () => {
	const owner = await signIn({ subject: 'g-1', email: 'owner@example.com', name: 'Olive Owner' });
	const created = await json('POST', '/v1/organisations', owner.token, { name: 'Harbour Bakery' });
	assert.equal(created.status, 201);
	const org = (await created.json()) as { id: string; name: string };
	const me = (await (await json('GET', '/v1/me', owner.token)).json()) as { memberships: { organisationId: string; role: string }[] };
	assert.deepEqual(me.memberships.map((m) => [m.organisationId, m.role]), [[org.id, 'owner']]);
	const stranger = await signIn({ subject: 'g-2', email: 'stranger@example.com', name: 'Sam' });
	assert.equal((await json('GET', `/v1/organisations/${org.id}`, stranger.token)).status, 404);
	assert.equal((await json('GET', `/v1/organisations/${org.id}/members`, stranger.token)).status, 404);
	const audit = await db.owner`select action from audit_events where organisation_id = ${org.id}`;
	assert.deepEqual(audit.map((row) => row.action), ['organisation.created']);
});

it('invitations are verified by the signed-in email and roles are guarded', async () => {
	const owner = await signIn({ subject: 'g-1', email: 'owner@example.com', name: 'Olive Owner' });
	const org = (await (await json('POST', '/v1/organisations', owner.token, { name: 'Second Org' })).json()) as { id: string };
	const invited = await json('POST', `/v1/organisations/${org.id}/invitations`, owner.token, { email: 'Pat@Example.com', role: 'member' });
	assert.equal(invited.status, 201);
	const { token: inviteToken } = (await invited.json()) as { token: string };
	const wrongPerson = await signIn({ subject: 'g-3', email: 'notpat@example.com', name: 'Not Pat' });
	assert.equal((await json('POST', '/v1/invitations/accept', wrongPerson.token, { token: inviteToken })).status, 403);
	const pat = await signIn({ subject: 'g-4', email: 'pat@example.com', name: 'Pat' });
	const accepted = await json('POST', '/v1/invitations/accept', pat.token, { token: inviteToken });
	assert.equal(accepted.status, 200);
	assert.equal((await json('POST', '/v1/invitations/accept', pat.token, { token: inviteToken })).status, 400, 'single use');
	// A member cannot manage members; an owner cannot demote the last owner.
	assert.equal((await json('POST', `/v1/organisations/${org.id}/invitations`, pat.token, { email: 'x@example.com', role: 'member' })).status, 403);
	assert.equal((await json('PATCH', `/v1/organisations/${org.id}/members/${owner.user.id}`, owner.token, { role: 'member' })).status, 400);
	assert.equal((await json('PATCH', `/v1/organisations/${org.id}/members/${pat.user.id}`, owner.token, { role: 'admin' })).status, 200);
	const members = (await (await json('GET', `/v1/organisations/${org.id}/members`, pat.token)).json()) as { members: { email: string; role: string }[] };
	assert.deepEqual(members.members.map((m) => [m.email, m.role]), [['owner@example.com', 'owner'], ['pat@example.com', 'admin']]);
	assert.equal((await json('DELETE', `/v1/organisations/${org.id}/members/${pat.user.id}`, owner.token)).status, 200);
	assert.equal((await json('GET', `/v1/organisations/${org.id}`, pat.token)).status, 404, 'a removed member is out');
});

it('signing out revokes the session', async () => {
	const person = await signIn({ subject: 'g-9', email: 'nine@example.com', name: 'Nine' });
	assert.equal((await json('POST', '/auth/sign-out', person.token)).status, 200);
	assert.equal((await json('GET', '/v1/me', person.token)).status, 401);
});
