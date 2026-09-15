import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import type { IdentityProvider } from './google.ts';
import { PasskeyService, type WebAuthn } from './passkeys.ts';
import { AuthService } from './service.ts';

const it = databaseUrl ? test : test.skip;
let db: Harness; let app: ReturnType<typeof createApp>;
const google: IdentityProvider & { next: { subject: string; email: string; name: string } } = {
	next: { subject: 'g-1', email: 'owner@example.com', name: 'Olive Owner' },
	authorizationUrl: ({ state }) => `https://google.test/auth?state=${state}`,
	async exchange() { return google.next; }
};
/** A stand-in authenticator: a response is valid when it names a known credential and echoes the challenge. */
const webauthn: WebAuthn = {
	async registrationOptions(input) { const challenge = `reg-${input.userId}-${Date.now()}`; return { challenge, options: { challenge, exclude: input.excludeCredentialIds } }; },
	async verifyRegistration(input) { const r = input.response as { id: string; challenge: string }; if (r.challenge !== input.challenge) throw new Error('bad challenge'); return { credentialId: r.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'], deviceType: 'multiDevice', backedUp: true }; },
	async authenticationOptions(input) { const challenge = `auth-${Date.now()}`; return { challenge, options: { challenge, allow: input.allowCredentialIds } }; },
	async verifyAuthentication(input) { const r = input.response as { id: string; challenge: string }; if (r.challenge !== input.challenge || r.id !== input.credential.id) throw new Error('bad assertion'); return { newCounter: input.credential.counter + 1 }; }
};
const json = (method: string, path: string, token?: string, body?: unknown) => app.request(path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const body = async <T>(response: Response, status: number): Promise<T> => { assert.equal(response.status, status, await response.clone().text()); return (await response.json()) as T; };
async function exchange(identity: { subject: string; email: string; name: string }) {
	google.next = identity;
	const start = await app.request('/auth/google/start?return_to=/settings');
	const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
	const callback = await app.request(`/auth/google/callback?code=abc&state=${state}`);
	const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
	return body<{ token: string; stepUp?: true; returnTo: string; user?: { id: string } }>(await json('POST', '/auth/session/exchange', undefined, { code }), 200);
}
const olive = { subject: 'g-1', email: 'owner@example.com', name: 'Olive Owner' };

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	const passkeys = new PasskeyService(db.app, webauthn);
	app = createApp({ db: db.app, passkeys, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30, passkeys }), organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app) });
});
after(async () => { await db?.close(); });

it('without a passkey, sign-in issues a session as before, and the person is told they have none', async () => {
	const signed = await exchange(olive);
	assert.match(signed.token, /^sess_/); assert.equal(signed.stepUp, undefined);
	const me = await body<{ passkeyVerified: boolean }>(await json('GET', '/v1/me', signed.token), 200);
	assert.equal(me.passkeyVerified, false);
	assert.deepEqual(await body(await json('GET', '/v1/me/passkeys', signed.token), 200), { available: true, passkeys: [] });
});

it('registering a passkey needs a fresh challenge, then every sign-in steps up and the token is single use', async () => {
	const signed = await exchange(olive);
	const opts = await body<{ token: string; options: { challenge: string } }>(await json('POST', '/v1/me/passkeys/options', signed.token), 200);
	assert.equal((await json('POST', '/v1/me/passkeys', signed.token, { token: opts.token, name: 'Phone', response: { id: 'cred-1', challenge: 'wrong' } })).status, 400);
	// The challenge was spent by the failed attempt; a new one is needed.
	const again = await body<{ token: string; options: { challenge: string } }>(await json('POST', '/v1/me/passkeys/options', signed.token), 200);
	const created = await body<{ id: string; name: string; backedUp: boolean }>(await json('POST', '/v1/me/passkeys', signed.token, { token: again.token, name: '  Phone ', response: { id: 'cred-1', challenge: again.options.challenge } }), 201);
	assert.equal(created.name, 'Phone'); assert.equal(created.backedUp, true);
	// Now sign-in stops before the session.
	const stepped = await exchange(olive);
	assert.equal(stepped.stepUp, true); assert.match(stepped.token, /^pks_/); assert.equal(stepped.returnTo, '/settings');
	assert.equal((await json('GET', '/v1/me', stepped.token)).status, 401, 'a step-up token is not a session');
	const options = await body<{ options: { challenge: string; allow: string[] } }>(await json('POST', '/auth/passkey/options', undefined, { token: stepped.token }), 200);
	assert.deepEqual(options.options.allow, ['cred-1']);
	assert.equal((await json('POST', '/auth/passkey/verify', undefined, { token: stepped.token, response: { id: 'cred-1', challenge: 'nope' } })).status, 401);
	assert.equal((await json('POST', '/auth/passkey/verify', undefined, { token: stepped.token, response: { id: 'cred-1', challenge: options.options.challenge } })).status, 401, 'the failed attempt spent the token');
	const second = await exchange(olive);
	const secondOptions = await body<{ options: { challenge: string } }>(await json('POST', '/auth/passkey/options', undefined, { token: second.token }), 200);
	const session = await body<{ token: string; returnTo: string }>(await json('POST', '/auth/passkey/verify', undefined, { token: second.token, response: { id: 'cred-1', challenge: secondOptions.options.challenge } }), 200);
	assert.match(session.token, /^sess_/); assert.equal(session.returnTo, '/settings');
	const me = await body<{ passkeyVerified: boolean }>(await json('GET', '/v1/me', session.token), 200);
	assert.equal(me.passkeyVerified, true);
	const [stored] = await db.owner`select counter, last_used_at from passkeys where credential_id = 'cred-1'`;
	assert.equal(Number(stored!.counter), 1); assert.ok(stored!.lastUsedAt);
	const events = (await db.owner`select event, success from auth_events where event like 'auth.passkey.%' order by created_at`).map((e) => `${e.event}:${e.success}`);
	assert.deepEqual(events, ['auth.passkey.register:false', 'auth.passkey.register:true', 'auth.passkey.step_up:false', 'auth.passkey.step_up:true']);
	// Removing the passkey returns sign-in to Google alone.
	const list = await body<{ passkeys: { id: string }[] }>(await json('GET', '/v1/me/passkeys', session.token), 200);
	await body(await json('DELETE', `/v1/me/passkeys/${list.passkeys[0]!.id}`, session.token), 200);
	assert.equal((await exchange(olive)).stepUp, undefined);
});

it('a step-up token cannot be used for another person\'s credential', async () => {
	const signed = await exchange(olive);
	const opts = await body<{ token: string; options: { challenge: string } }>(await json('POST', '/v1/me/passkeys/options', signed.token), 200);
	await body(await json('POST', '/v1/me/passkeys', signed.token, { token: opts.token, name: 'Laptop', response: { id: 'cred-2', challenge: opts.options.challenge } }), 201);
	const stepped = await exchange(olive);
	const options = await body<{ options: { challenge: string } }>(await json('POST', '/auth/passkey/options', undefined, { token: stepped.token }), 200);
	assert.equal((await json('POST', '/auth/passkey/verify', undefined, { token: stepped.token, response: { id: 'someone-elses', challenge: options.options.challenge } })).status, 401);
	assert.equal((await json('POST', '/auth/passkey/options', undefined, { token: 'pks_made_up' })).status, 401);
});
