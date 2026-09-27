import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { RateLimiter } from '../ratelimit.ts';
import type { IdentityProvider } from './google.ts';
import { lockPasskeys, parseStart, passkeyLockName } from './native.ts';
import { PasskeyService, type WebAuthn } from './passkeys.ts';
import { AuthService, hashSecret } from './service.ts';

// Native sign-in handoff, A1 of docs/plans/expo-mobile-foundation-2026-09.md §3: real Postgres, the runtime role,
// and two apps over one database: native sign-in on and native sign-in off.
const it = databaseUrl ? test : test.skip;
let db: Harness; let on: ReturnType<typeof createApp>; let off: ReturnType<typeof createApp>; let onAuth: AuthService;
/** Production limits unchanged. The limiter's own clock moves 2.5 s per check, so at most 24 checks fall in any
 *  one-minute window: under the 30 sign-in attempts per address, however many requests a case makes. */
let clock = Date.parse('2030-01-01T00:00:00Z');
const limiter = new RateLimiter(() => (clock += 2_500));

const google: IdentityProvider & { next: { subject: string; email: string; name: string } } = {
	next: { subject: 'n-1', email: 'native@example.com', name: 'Nat Native' },
	authorizationUrl: ({ state }) => `https://google.test/auth?state=${state}`,
	async exchange() { return google.next; }
};
/** A stand-in authenticator: a response is valid when it names a known credential and echoes the challenge. */
const webauthn: WebAuthn = {
	async registrationOptions(input) { const challenge = `reg-${input.userId}-${randomBytes(4).toString('hex')}`; return { challenge, options: { challenge } }; },
	async verifyRegistration(input) { const r = input.response as { id: string; challenge: string }; if (r.challenge !== input.challenge) throw new Error('bad challenge'); return { credentialId: r.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'], deviceType: 'multiDevice', backedUp: true }; },
	async authenticationOptions(input) { const challenge = `auth-${randomBytes(4).toString('hex')}`; return { challenge, options: { challenge, allow: input.allowCredentialIds } }; },
	async verifyAuthentication(input) { const r = input.response as { id: string; challenge: string }; if (r.challenge !== input.challenge || r.id !== input.credential.id) throw new Error('bad assertion'); return { newCounter: input.credential.counter + 1 }; }
};

type App = ReturnType<typeof createApp>;
const value = () => randomBytes(32).toString('base64url');
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const call = (app: App, method: string, path: string, body?: unknown, token?: string) => app.request(path, { method,
	headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const read = async <T>(response: Response, status: number): Promise<T> => { assert.equal(response.status, status, await response.clone().text()); return (await response.json()) as T; };
async function redirectTo(response: Response): Promise<URL> {
	const location = response.headers.get('location');
	assert.ok(response.status >= 300 && response.status < 400 && location, `expected a redirect, got ${response.status} ${await response.clone().text()}`);
	return new URL(location);
}
let people = 0;
const person = () => { people += 1; return { subject: `n-${people}-${value()}`, email: `native-${people}-${randomBytes(3).toString('hex')}@example.com`, name: `Native ${people}` }; };
type Attempt = { verifier: string; attempt: string };
const attemptOf = (): Attempt => ({ verifier: value(), attempt: value() });
const startQuery = (a: Attempt, returnTo?: string) => new URLSearchParams({ client: 'native', code_challenge: s256(a.verifier), code_challenge_method: 'S256', attempt: a.attempt, ...(returnTo ? { return_to: returnTo } : {}) });
const oauthRows = async () => Number((await db.owner`select count(*)::int as n from auth_requests where kind = 'oauth'`)[0]!.n);
const sessionsOf = async (email: string) => Number((await db.owner`select count(*)::int as n from sessions s join users u on u.id = s.user_id where u.email = ${email}`)[0]!.n);

/** Google, as far as the web callback's exchange code. */
async function exchangeCode(app: App, identity: ReturnType<typeof person>, a?: Attempt, returnTo = '/work'): Promise<string> {
	google.next = identity;
	const start = a ? `/auth/google/start?${startQuery(a, returnTo)}` : `/auth/google/start?return_to=${encodeURIComponent(returnTo)}`;
	const state = (await redirectTo(await app.request(start))).searchParams.get('state')!;
	const back = await redirectTo(await app.request(`/auth/google/callback?code=google-code&state=${state}`));
	const code = back.searchParams.get('code'); assert.ok(code, `expected an exchange code, got ${back}`);
	return code;
}
/** The whole native flow without a passkey, up to the handoff the web would pass to the app. */
async function handoff(identity = person(), a = attemptOf(), returnTo = '/work'): Promise<{ identity: ReturnType<typeof person>; a: Attempt; code: string }> {
	const result = await read<{ nativeHandoff: string; attempt: string; token?: string }>(await call(on, 'POST', '/auth/session/exchange', { code: await exchangeCode(on, identity, a, returnTo) }), 200);
	assert.match(result.nativeHandoff, /^nh_[A-Za-z0-9_-]{43}$/); assert.equal(result.attempt, a.attempt);
	assert.equal(result.token, undefined, 'a native exchange never returns a session token to the web');
	return { identity, a, code: result.nativeHandoff };
}
const spend = (app: App, code: string, a: Attempt) => call(app, 'POST', '/auth/native/exchange', { code, verifier: a.verifier, attempt: a.attempt });
async function registerPasskey(email: string, credential: string) {
	const [user] = await db.owner`select id from users where email = ${email}`;
	const session = (await onAuth.issueSessionFor(user!.id)).token;
	const options = await read<{ token: string; options: { challenge: string } }>(await call(on, 'POST', '/v1/me/passkeys/options', undefined, session), 200);
	await read(await call(on, 'POST', '/v1/me/passkeys', { token: options.token, name: 'Phone', response: { id: credential, challenge: options.options.challenge } }, session), 201);
}

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	const passkeys = new PasskeyService(db.app, webauthn);
	const common = { db: db.app, passkeys, organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), rateLimiter: limiter };
	onAuth = new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30, passkeys, nativeSignIn: true });
	on = createApp({ ...common, auth: onAuth });
	off = createApp({ ...common, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30, passkeys }) });
});
after(async () => { await db?.close(); });

test('start parameters: the web flow is untouched, native parameters are strict, and nothing native passes while off', () => {
	const a = attemptOf(); const good = { client: ['native'], code_challenge: [s256(a.verifier)], code_challenge_method: ['S256'], attempt: [a.attempt] };
	assert.deepEqual(parseStart({ return_to: ['/work', '/other'], utm: ['x'] }, false), { returnTo: '/work' }, 'web: first return_to, other keys ignored as before');
	assert.deepEqual(parseStart({}, true), { returnTo: undefined });
	assert.deepEqual(parseStart({ ...good, return_to: ['/work'] }, true), { returnTo: '/work', native: { challenge: s256(a.verifier), attempt: a.attempt } });
	assert.throws(() => parseStart(good, false), { code: 'native_sign_in_unavailable' });
	assert.throws(() => parseStart({ attempt: [a.attempt] }, false), { code: 'native_sign_in_unavailable' }, 'any native key counts');
	const invalid: Record<string, string[]>[] = [
		{ ...good, client: ['web'] }, { ...good, client: ['native', 'native'] }, { ...good, code_challenge_method: ['plain'] },
		{ ...good, code_challenge: ['short'] }, { ...good, code_challenge: [`${s256(a.verifier)}=`] }, { ...good, attempt: ['a'.repeat(44)] },
		{ ...good, attempt: [a.attempt, a.attempt] }, { ...good, return_to: ['/a', '/b'] }, { ...good, extra: ['1'] },
		{ code_challenge: good.code_challenge, code_challenge_method: ['S256'], attempt: good.attempt }, { client: ['native'] }
	];
	for (const query of invalid) assert.throws(() => parseStart(query, true), { code: 'native_request_invalid' }, JSON.stringify(query));
});

it('while off, a native start is refused before anything is stored; the web flow and the web exchange are unchanged', async () => {
	const before = await oauthRows();
	const refused = await read<{ code: string }>(await off.request(`/auth/google/start?${startQuery(attemptOf())}`), 400);
	assert.equal(refused.code, 'native_sign_in_unavailable');
	assert.equal(await oauthRows(), before, 'no auth request stored');
	for (const app of [off, on]) {
		const identity = person();
		const signed = await read<{ token: string; returnTo: string; nativeHandoff?: string }>(await call(app, 'POST', '/auth/session/exchange', { code: await exchangeCode(app, identity) }), 200);
		assert.match(signed.token, /^sess_/); assert.equal(signed.returnTo, '/work'); assert.equal(signed.nativeHandoff, undefined);
		const [oauth] = await db.owner`select payload from auth_requests where kind = 'oauth' order by created_at desc limit 1`;
		assert.equal((oauth!.payload as { native?: unknown }).native, undefined, 'a web start stores no native context');
	}
});

it('invalid native starts are refused before anything is stored, including every unsafe return path', async () => {
	const before = await oauthRows(); const a = attemptOf();
	const queries = [
		new URLSearchParams({ client: 'native', code_challenge: s256(a.verifier), code_challenge_method: 'plain', attempt: a.attempt }),
		new URLSearchParams({ client: 'native', code_challenge: 'x', code_challenge_method: 'S256', attempt: a.attempt }),
		new URLSearchParams([...startQuery(a), ['attempt', a.attempt]]),
		new URLSearchParams([...startQuery(a), ['redirect_uri', 'https://evil.test']])
	];
	for (const query of queries) assert.equal((await read<{ code: string }>(await on.request(`/auth/google/start?${query}`), 400)).code, 'native_request_invalid', String(query));
	for (const unsafe of ['//evil.test', '/\\evil.test', 'https://evil.test/', '/\t/evil.test', '/..//evil.test', 'work'])
		assert.equal((await read<{ code: string }>(await on.request(`/auth/google/start?${startQuery(a, unsafe)}`), 400)).code, 'return_to_invalid', unsafe);
	assert.equal(await oauthRows(), before);
});

it('without a passkey: the web gets only a handoff, the app spends it once with its verifier and attempt, and audit holds no secret', async () => {
	const { identity, a, code } = await handoff(undefined, undefined, '/work/tasks');
	const [stored] = await db.owner`select payload, expires_at, created_at from auth_requests where kind = 'native_handoff' and token_hash = ${hashSecret(code)}`;
	assert.deepEqual(stored!.payload, { challenge: s256(a.verifier), attempt: a.attempt, returnTo: '/work/tasks', passkeyVerified: false });
	assert.ok((stored!.expiresAt as Date).getTime() - (stored!.createdAt as Date).getTime() <= 2 * 60_000 + 5_000, 'two-minute handoff');
	assert.equal(await sessionsOf(identity.email), 0, 'nothing issued before the app spends the handoff');
	const signed = await read<{ token: string; expiresAt: string; returnTo: string; user: { email: string } }>(await spend(on, code, a), 200);
	assert.match(signed.token, /^sess_/); assert.equal(signed.returnTo, '/work/tasks'); assert.equal(signed.user.email, identity.email);
	assert.equal((await read<{ passkeyVerified: boolean }>(await call(on, 'GET', '/v1/me', undefined, signed.token), 200)).passkeyVerified, false);
	assert.equal((await spend(on, code, a)).status, 401, 'single use');
	assert.equal(await sessionsOf(identity.email), 1);
	const audit = JSON.stringify(await db.owner`select event, success, detail from auth_events`);
	for (const secret of [code, a.verifier, signed.token]) assert.ok(!audit.includes(secret), 'no code, verifier or token in audit');
	const events = (await db.owner`select event, success from auth_events e join users u on u.id = e.user_id where u.email = ${identity.email} and event like 'auth.native.%' order by e.created_at`).map((e) => `${e.event}:${e.success}`);
	assert.deepEqual(events, ['auth.native.handoff:true', 'auth.native.exchange:true'], 'the replay found no request, so it names no person');
	const [replay] = await db.owner`select detail->>'reason' as reason, user_id from auth_events where event = 'auth.native.exchange' and not success order by created_at desc limit 1`;
	assert.equal(replay!.reason, 'request_invalid'); assert.equal(replay!.userId, null);
});

it('kinds are separate: a handoff is not a web exchange code, and a web exchange code is not a handoff', async () => {
	const { a, code } = await handoff();
	assert.equal((await call(on, 'POST', '/auth/session/exchange', { code })).status, 401);
	const webCode = await exchangeCode(on, person());
	assert.equal((await read<{ code: string }>(await call(on, 'POST', '/auth/native/exchange', { code: webCode, verifier: a.verifier, attempt: a.attempt }), 400)).code, 'native_request_invalid');
	assert.match((await read<{ token: string }>(await call(on, 'POST', '/auth/session/exchange', { code: webCode }), 200)).token, /^sess_/, 'the web code was untouched');
	assert.match((await read<{ token: string }>(await spend(on, code, a), 200)).token, /^sess_/, 'the handoff was untouched by the web exchange attempt');
	// The database kind is what separates them, not only the code's prefix: a handoff-shaped secret stored as
	// another kind, with a matching binding, is not a handoff.
	const other = attemptOf(); const [user] = await db.owner`select id from users limit 1`;
	for (const kind of ['session_exchange', 'passkey_challenge', 'oauth']) {
		const disguised = `nh_${value()}`;
		await db.owner`insert into auth_requests (kind, token_hash, user_id, payload, expires_at) values (${kind}, ${hashSecret(disguised)}, ${user!.id},
			${db.owner.json({ challenge: s256(other.verifier), attempt: other.attempt, returnTo: '/', passkeyVerified: true })}, now() + interval '1 minute')`;
		assert.equal((await spend(on, disguised, other)).status, 401, kind);
		const [row] = await db.owner`select consumed_at from auth_requests where token_hash = ${hashSecret(disguised)}`;
		assert.equal(row!.consumedAt, null, `${kind} left alone`);
	}
});

it('a wrong verifier, a wrong attempt or an expired handoff fails and burns the code; malformed bodies are refused', async () => {
	for (const wrong of [(a: Attempt) => ({ ...a, verifier: value() }), (a: Attempt) => ({ ...a, attempt: value() }), (a: Attempt) => ({ ...a, verifier: s256(a.verifier) })]) {
		const { identity, a, code } = await handoff();
		assert.equal((await spend(on, code, wrong(a))).status, 401);
		assert.equal((await spend(on, code, a)).status, 401, 'burned by the mismatch');
		assert.equal(await sessionsOf(identity.email), 0);
	}
	const expired = await handoff();
	await db.owner`update auth_requests set expires_at = now() - interval '1 second' where token_hash = ${hashSecret(expired.code)}`;
	assert.equal((await spend(on, expired.code, expired.a)).status, 401);
	const { a, code } = await handoff();
	for (const body of [{ code, verifier: a.verifier }, { code: 'nh_short', verifier: a.verifier, attempt: a.attempt }, { code, verifier: a.verifier, attempt: a.attempt, extra: 1 }, { code, verifier: 'v'.repeat(129), attempt: a.attempt }])
		assert.equal((await call(on, 'POST', '/auth/native/exchange', body)).status, 400, JSON.stringify(Object.keys(body)));
	assert.equal((await on.request('/auth/native/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' })).status, 400);
	assert.match((await read<{ token: string }>(await spend(on, code, a), 200)).token, /^sess_/, 'malformed requests did not spend it');
	const reasons = (await db.owner`select detail->>'reason' as reason from auth_events where event = 'auth.native.exchange' and not success`).map((r) => r.reason);
	for (const reason of ['binding_mismatch', 'request_invalid']) assert.ok(reasons.includes(reason), reason);
});

it('two concurrent exchanges of one handoff: exactly one session', async () => {
	const { identity, a, code } = await handoff();
	const statuses = (await Promise.all([spend(on, code, a), spend(on, code, a), spend(on, code, a)])).map((r) => r.status).sort();
	assert.deepEqual(statuses, [200, 401, 401]);
	assert.equal(await sessionsOf(identity.email), 1);
});

it('with a passkey: the native sign-in steps up, the step-up yields a handoff rather than a session, and the session is passkey-verified', async () => {
	const identity = person(); await exchangeCode(on, identity); // creates the person
	await registerPasskey(identity.email, `cred-${value()}`);
	const [credential] = await db.owner`select credential_id from passkeys p join users u on u.id = p.user_id where u.email = ${identity.email}`;
	const a = attemptOf();
	const stepped = await read<{ stepUp: true; native: true; token: string; returnTo: string; nativeHandoff?: string }>(await call(on, 'POST', '/auth/session/exchange', { code: await exchangeCode(on, identity, a, '/chat') }), 200);
	assert.equal(stepped.stepUp, true); assert.equal(stepped.native, true); assert.match(stepped.token, /^pks_/); assert.equal(stepped.nativeHandoff, undefined);
	const [stepRow] = await db.owner`select payload from auth_requests where token_hash = ${hashSecret(stepped.token)}`;
	assert.deepEqual((stepRow!.payload as { native: unknown }).native, { challenge: s256(a.verifier), attempt: a.attempt }, 'native context kept in the step-up');
	const options = await read<{ options: { challenge: string } }>(await call(on, 'POST', '/auth/passkey/options', { token: stepped.token }), 200);
	const verified = await read<{ nativeHandoff: string; attempt: string; token?: string }>(await call(on, 'POST', '/auth/passkey/verify', { token: stepped.token, response: { id: credential!.credentialId, challenge: options.options.challenge } }), 200);
	assert.equal(verified.token, undefined, 'a native step-up never issues a web session'); assert.equal(verified.attempt, a.attempt);
	const [handoffRow] = await db.owner`select payload from auth_requests where kind = 'native_handoff' and token_hash = ${hashSecret(verified.nativeHandoff)}`;
	assert.deepEqual(handoffRow!.payload, { challenge: s256(a.verifier), attempt: a.attempt, returnTo: '/chat', passkeyVerified: true });
	assert.equal(await sessionsOf(identity.email), 1, 'only the session the passkey was registered with');
	const signed = await read<{ token: string; returnTo: string }>(await spend(on, verified.nativeHandoff, a), 200);
	assert.equal(signed.returnTo, '/chat');
	assert.equal((await read<{ passkeyVerified: boolean }>(await call(on, 'GET', '/v1/me', undefined, signed.token), 200)).passkeyVerified, true);
	// A web sign-in by the same person still steps up and ends in an ordinary session.
	const web = await read<{ stepUp: true; native?: true; token: string }>(await call(on, 'POST', '/auth/session/exchange', { code: await exchangeCode(on, identity) }), 200);
	assert.equal(web.native, undefined);
	const webOptions = await read<{ options: { challenge: string } }>(await call(on, 'POST', '/auth/passkey/options', { token: web.token }), 200);
	assert.match((await read<{ token: string }>(await call(on, 'POST', '/auth/passkey/verify', { token: web.token, response: { id: credential!.credentialId, challenge: webOptions.options.challenge } }), 200)).token, /^sess_/);
});

it('a passkey registered after a handoff was issued without one refuses that handoff and burns it', async () => {
	const { identity, a, code } = await handoff();
	await registerPasskey(identity.email, `cred-${value()}`);
	const sessions = await sessionsOf(identity.email);
	const refused = await read<{ error: string }>(await spend(on, code, a), 401);
	assert.match(refused.error, /passkey/);
	assert.equal(await sessionsOf(identity.email), sessions, 'no session issued');
	assert.equal((await spend(on, code, a)).status, 401, 'burned');
	const [event] = await db.owner`select detail->>'reason' as reason from auth_events e join users u on u.id = e.user_id where u.email = ${identity.email} and event = 'auth.native.exchange' order by e.created_at limit 1`;
	assert.equal(event!.reason, 'passkey_required');
});

it('a registration in progress holds the exchange back until it commits, and the exchange is then refused and burned', async () => {
	const { identity, a, code } = await handoff();
	const [user] = await db.owner`select id from users where email = ${identity.email}`;
	const userId = String(user!.id);
	// A registration transaction as `register` runs it: the same lock, then the passkey insert, held open.
	let release!: () => void; const released = new Promise<void>((resolve) => { release = resolve; });
	let holding!: () => void; const held = new Promise<void>((resolve) => { holding = resolve; });
	const registration = db.owner.begin(async (tx) => {
		await lockPasskeys(tx, userId);
		await tx`insert into passkeys (user_id, credential_id, public_key) values (${userId}, ${`cred-${value()}`}, ${Buffer.from([1, 2, 3])})`;
		holding();
		await released;
	});
	let settled = false;
	try {
		await held;
		const exchange = Promise.resolve(spend(on, code, a)).then((response) => { settled = true; return response; });
		// Wait, boundedly, until Postgres itself shows the exchange queued behind this person's passkey lock.
		const waiting = async () => Number((await db.owner`select count(*)::int as n from pg_locks l, (select hashtextextended(${passkeyLockName(userId)}, 0) as k) h
			where l.locktype = 'advisory' and not l.granted and l.objsubid = 1 and l.database = (select oid from pg_database where datname = current_database())
			and l.classid::bigint = ((h.k >> 32) & 4294967295) and l.objid::bigint = (h.k & 4294967295)`)[0]!.n);
		for (let i = 0; (await waiting()) === 0; i++) {
			assert.ok(i < 200 && !settled, 'the exchange never queued behind the registration lock');
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.equal(settled, false, 'nothing answered while the registration was pending');
		assert.equal(await sessionsOf(identity.email), 0, 'no session issued while the registration was pending');
		release(); await registration;
		const refused = await read<{ error: string }>(await exchange, 401);
		assert.match(refused.error, /passkey/);
	} finally { release(); await registration.catch(() => undefined); }
	assert.equal(await sessionsOf(identity.email), 0);
	assert.equal((await spend(on, code, a)).status, 401, 'burned');
	const [event] = await db.owner`select detail->>'reason' as reason from auth_events where event = 'auth.native.exchange' and user_id = ${userId} order by created_at limit 1`;
	assert.equal(event!.reason, 'passkey_required');
});

it('turned off after minting: every native leg fails closed, burns what it spends and never falls back to a web session', async () => {
	// An OAuth state started while on and finished while off: stopped before Google is asked, no exchange code.
	const a = attemptOf(); google.next = person();
	const state = (await redirectTo(await on.request(`/auth/google/start?${startQuery(a)}`))).searchParams.get('state')!;
	const back = await redirectTo(await off.request(`/auth/google/callback?code=google-code&state=${state}`));
	assert.equal(back.searchParams.get('error'), 'native_sign_in_disabled'); assert.equal(back.searchParams.get('code'), null);
	// A native exchange code spent while off: refused and burned.
	const identity = person(); const code = await exchangeCode(on, identity, attemptOf());
	assert.equal((await read<{ code: string }>(await call(off, 'POST', '/auth/session/exchange', { code }), 401)).code, 'native_sign_in_disabled');
	assert.equal((await call(on, 'POST', '/auth/session/exchange', { code })).status, 401, 'burned');
	assert.equal(await sessionsOf(identity.email), 0);
	// A handoff spent while off: refused and burned.
	const minted = await handoff();
	assert.equal((await read<{ code: string }>(await spend(off, minted.code, minted.a), 401)).code, 'native_sign_in_disabled');
	assert.equal((await spend(on, minted.code, minted.a)).status, 401, 'burned');
	assert.equal(await sessionsOf(minted.identity.email), 0);
	// A native step-up verified while off: refused, burned, no session and no handoff.
	const stepper = person(); await exchangeCode(on, stepper);
	await registerPasskey(stepper.email, `cred-${value()}`);
	const [credential] = await db.owner`select credential_id from passkeys p join users u on u.id = p.user_id where u.email = ${stepper.email}`;
	const stepped = await read<{ token: string }>(await call(on, 'POST', '/auth/session/exchange', { code: await exchangeCode(on, stepper, attemptOf()) }), 200);
	const options = await read<{ options: { challenge: string } }>(await call(on, 'POST', '/auth/passkey/options', { token: stepped.token }), 200);
	const response = { id: credential!.credentialId, challenge: options.options.challenge };
	const handoffs = Number((await db.owner`select count(*)::int as n from auth_requests where kind = 'native_handoff'`)[0]!.n);
	// Assertion options are a native leg too: refused while off, without spending the token.
	assert.equal((await read<{ code: string }>(await call(off, 'POST', '/auth/passkey/options', { token: stepped.token }), 401)).code, 'native_sign_in_disabled');
	const [unspent] = await db.owner`select consumed_at, payload from auth_requests where token_hash = ${hashSecret(stepped.token)}`;
	assert.equal(unspent!.consumedAt, null);
	assert.equal((unspent!.payload as { challenge?: string }).challenge, options.options.challenge, 'the refused request did not replace the challenge');
	assert.equal((await read<{ code: string }>(await call(off, 'POST', '/auth/passkey/verify', { token: stepped.token, response }), 401)).code, 'native_sign_in_disabled');
	assert.equal((await call(on, 'POST', '/auth/passkey/verify', { token: stepped.token, response })).status, 401, 'burned');
	assert.equal(Number((await db.owner`select count(*)::int as n from auth_requests where kind = 'native_handoff'`)[0]!.n), handoffs);
	assert.equal(await sessionsOf(stepper.email), 1, 'only the session the passkey was registered with');
});

it('a failure after the session insert rolls everything back: no session, the handoff unspent, then it succeeds', async () => {
	const { identity, a, code } = await handoff();
	await db.owner.unsafe(`create function native_test_fail() returns trigger language plpgsql as $$
		begin if new.event = 'auth.native.exchange' and new.success then raise exception 'injected audit failure'; end if; return new; end $$`);
	await db.owner.unsafe('create trigger native_test_fail before insert on auth_events for each row execute function native_test_fail()');
	try {
		assert.equal((await spend(on, code, a)).status, 500);
		assert.equal(await sessionsOf(identity.email), 0, 'the session insert was rolled back');
		const [row] = await db.owner`select consumed_at from auth_requests where token_hash = ${hashSecret(code)}`;
		assert.equal(row!.consumedAt, null, 'the handoff was not spent');
	} finally {
		await db.owner.unsafe('drop trigger native_test_fail on auth_events; drop function native_test_fail()');
	}
	assert.match((await read<{ token: string }>(await spend(on, code, a), 200)).token, /^sess_/);
	assert.equal(await sessionsOf(identity.email), 1);
});

it('a stored destination that is not a path on the app finishes at home', async () => {
	const { a, code } = await handoff();
	await db.owner`update auth_requests set payload = payload || ${db.owner.json({ returnTo: '/\\evil.test' })} where token_hash = ${hashSecret(code)}`;
	assert.equal((await read<{ returnTo: string }>(await spend(on, code, a), 200)).returnTo, '/');
});
