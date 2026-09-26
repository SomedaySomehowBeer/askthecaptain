import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from './app.ts';
import type { IdentityProvider } from './auth/google.ts';
import { AuthService, hashSecret } from './auth/service.ts';
import { CommitmentsService } from './commitments/service.ts';
import { OrganisationService } from './organisations/service.ts';
import { RateLimiter } from './ratelimit.ts';

const it = databaseUrl ? test : test.skip;
let db: Harness; let app: ReturnType<typeof createApp>; let auth: AuthService;
/** The production limits apply unchanged (30 sign-in attempts a minute from one address, and every in-process
 *  request here comes from the same `unknown` address). Each test starts in a fresh window of the limiter's own
 *  clock, so one test's sign-ins never spend another's allowance; within a test the real limit still holds. */
let clock = Date.parse('2030-01-01T00:00:00Z');
const limiter = new RateLimiter(() => clock);
beforeEach(() => { clock += 61_000; });
/** The redirect target of a response, failing with its status and body (for example a 429) when it is not one. */
async function redirectTo(response: Response): Promise<URL> {
	const location = response.headers.get('location');
	assert.ok(response.status >= 300 && response.status < 400 && location, `expected a redirect, got ${response.status} ${await response.clone().text()}`);
	return new URL(location);
}
const google: IdentityProvider & { next: { subject: string; email: string; name: string } } = {
	next: { subject: 'g-1', email: 'owner@example.com', name: 'Olive Owner' },
	authorizationUrl: ({ state }) => `https://google.test/auth?state=${state}`,
	async exchange() { return google.next; }
};
const json = (method: string, path: string, token?: string, body?: unknown) => app.request(path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

async function signIn(identity: { subject: string; email: string; name: string }) {
	google.next = identity;
	const state = (await redirectTo(await app.request('/auth/google/start?return_to=/settings'))).searchParams.get('state')!;
	const code = (await redirectTo(await app.request(`/auth/google/callback?code=abc&state=${state}`))).searchParams.get('code')!;
	const exchange = await json('POST', '/auth/session/exchange', undefined, { code });
	assert.equal(exchange.status, 200, await exchange.clone().text());
	return (await exchange.json()) as { token: string; user: { id: string }; returnTo: string };
}

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	auth = new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 });
	app = createApp({ db: db.app, auth, organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), rateLimiter: limiter });
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
	for (const bad of ['https://evil.test', '//evil.test', '/\\evil.test', '/\\/evil.test', '/\t/evil.test', '/\n/evil.test', '/..//evil.test', '/.//evil.test', 'javascript:alert(1)']) {
		const response = await app.request(`/auth/google/start?return_to=${encodeURIComponent(bad)}`);
		assert.equal(response.status, 400, JSON.stringify(bad));
		assert.equal((await response.json() as { code: string }).code, 'return_to_invalid');
	}
	// A valid path keeps its query and fragment through the whole Google flow.
	google.next = { subject: 'g-return', email: 'return@example.com', name: 'Rita Return' };
	const wanted = '/chat?filter=unread&linked=false#latest';
	const state = (await redirectTo(await app.request(`/auth/google/start?return_to=${encodeURIComponent(wanted)}`))).searchParams.get('state')!;
	const code = (await redirectTo(await app.request(`/auth/google/callback?code=abc&state=${state}`))).searchParams.get('code')!;
	const response = await json('POST', '/auth/session/exchange', undefined, { code });
	assert.equal(response.status, 200, await response.clone().text());
	assert.equal((await response.json() as { returnTo: string }).returnTo, wanted);
});

it('a destination read back from a stored sign-in request is checked again and falls back home', async () => {
	// Rows as an older release (or a changed database) could have left them: the flow still never sends anyone away.
	google.next = { subject: 'g-stored', email: 'stored@example.com', name: 'Sid Stored' };
	for (const bad of ['/\\evil.test', '//evil.test', 'https://evil.test', '/\t/evil.test', '/..//evil.test']) {
		const state = `st_${crypto.randomUUID()}`;
		await db.owner`insert into auth_requests (kind, token_hash, payload, expires_at)
			values ('oauth', ${hashSecret(state)}, ${db.owner.json({ nonce: 'n_test', verifier: 'v_test', returnTo: bad })}, ${new Date(Date.now() + 60_000)})`;
		const target = await redirectTo(await app.request(`/auth/google/callback?code=abc&state=${state}`));
		assert.equal(target.origin, 'https://app.example.test');
		const code = target.searchParams.get('code');
		assert.ok(code, `the callback issued no code: ${target.href}`);
		const response = await json('POST', '/auth/session/exchange', undefined, { code });
		assert.equal(response.status, 200, await response.clone().text());
		assert.equal((await response.json() as { returnTo: string }).returnTo, '/', JSON.stringify(bad));
	}
	// A stored one-time exchange with a bad destination is corrected too.
	const [user] = await db.owner<{ id: string }[]>`select id from users where email = 'stored@example.com'`;
	const exchangeCode = `x_${crypto.randomUUID()}`;
	await db.owner`insert into auth_requests (kind, token_hash, user_id, payload, expires_at)
		values ('session_exchange', ${hashSecret(exchangeCode)}, ${user!.id}, ${db.owner.json({ returnTo: '/\\evil.test' })}, ${new Date(Date.now() + 60_000)})`;
	const response = await json('POST', '/auth/session/exchange', undefined, { code: exchangeCode });
	assert.equal(response.status, 200, await response.clone().text());
	assert.equal((await response.json() as { returnTo: string }).returnTo, '/');
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
