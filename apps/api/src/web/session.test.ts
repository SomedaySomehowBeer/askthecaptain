import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import type { IdentityProvider } from '../auth/google.ts';
import { PasskeyService, type WebAuthn } from '../auth/passkeys.ts';
import { AuthService } from '../auth/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { RateLimiter } from '../ratelimit.ts';
import { isApiPath, missingBuild } from './static.ts';

// The web session on the API's own origin (docs/plans/expo-web-session-2026-09.md §A.5): real Postgres, the runtime
// role, a temporary web export, and three apps over one database: the web app, one whose export is missing, and
// one with native sign-in on.
const it = databaseUrl ? test : test.skip;
type App = ReturnType<typeof createApp>;
let db: Harness; let app: App; let bare: App; let native: App; let auth: AuthService;
/** Production limits unchanged. The limiter's own clock moves 2.5 s per check, so at most 24 checks fall in any
 *  one-minute window: under the 30 sign-in attempts per address, however many requests a case makes. */
let clock = Date.parse('2030-01-01T00:00:00Z');
const limiter = new RateLimiter(() => (clock += 2_500));

const google: IdentityProvider & { next: { subject: string; email: string; name: string } } = {
	next: { subject: 'w-1', email: 'web@example.com', name: 'Wendy Web' },
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

/** A stand-in for `expo export --platform web`: the page, a hashed bundle and a plain file. */
const exportDir = mkdtempSync(join(tmpdir(), 'captain-web-export-'));
const page = '<!doctype html><html><body>captain shell</body></html>';
mkdirSync(join(exportDir, '_expo/static/js/web'), { recursive: true });
writeFileSync(join(exportDir, 'index.html'), page);
writeFileSync(join(exportDir, '_expo/static/js/web/entry-abc123.js'), 'console.log("shell")');
writeFileSync(join(exportDir, 'favicon.ico'), Buffer.from([0, 0, 1, 0]));

const web = 'x-captain-client';
type Options = { method?: string; body?: unknown; cookie?: string; bearer?: string; headers?: Record<string, string> };
const call = (target: App, path: string, options: Options = {}) => target.request(path, {
	method: options.method ?? 'GET',
	headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}), ...(options.headers ?? {}) },
	body: options.body === undefined ? undefined : JSON.stringify(options.body)
});
const read = async <T>(response: Response, status: number): Promise<T> => { assert.equal(response.status, status, await response.clone().text()); return (await response.json()) as T; };
async function redirectTo(response: Response, status = 303): Promise<string> {
	const location = response.headers.get('location');
	assert.equal(response.status, status, await response.clone().text()); assert.ok(location, 'a redirect names its location');
	return location;
}
/** The Set-Cookie header for one cookie, or null, and its attributes as a map. */
function setCookie(response: Response, name: string): { value: string; attributes: Record<string, string> } | null {
	const header = response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
	if (!header) return null;
	const [pair, ...rest] = header.split(';').map((part) => part.trim());
	const attributes: Record<string, string> = {};
	for (const part of rest) { const [key, ...value] = part.split('='); attributes[key!.toLowerCase()] = value.join('='); }
	return { value: pair!.slice(name.length + 1), attributes };
}
const value = () => randomBytes(32).toString('base64url');
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
let people = 0;
const person = () => { people += 1; return { subject: `w-${people}-${value()}`, email: `web-${people}-${randomBytes(3).toString('hex')}@example.com`, name: `Web ${people}` }; };

/** Google, as far as the exchange code the API's own callback carries. */
async function exchangeCode(target: App, identity: ReturnType<typeof person>, returnTo = '/settings', query?: URLSearchParams): Promise<string> {
	google.next = identity;
	const start = query ? `/auth/google/start?${query}` : `/auth/google/start?return_to=${encodeURIComponent(returnTo)}`;
	const state = new URL(await redirectTo(await target.request(start), 302)).searchParams.get('state')!;
	const back = new URL(await redirectTo(await target.request(`/auth/google/callback?code=google-code&state=${state}`), 302));
	assert.equal(back.pathname, '/auth/callback', 'Google returns to the API\'s own callback');
	const code = back.searchParams.get('code'); assert.ok(code, `expected an exchange code, got ${back}`);
	return code;
}
/** The whole web sign-in: the cookie the callback set and where it sent the person. */
async function signIn(identity = person(), returnTo = '/settings'): Promise<{ identity: ReturnType<typeof person>; cookie: string; location: string; response: Response }> {
	const response = await call(app, `/auth/callback?code=${await exchangeCode(app, identity, returnTo)}`);
	const location = await redirectTo(response);
	const session = setCookie(response, 'captain_session'); assert.ok(session, 'the callback sets the session cookie');
	return { identity, cookie: `captain_session=${session.value}`, location, response };
}
async function registerPasskey(cookie: string, credential: string) {
	const options = await read<{ token: string; options: { challenge: string } }>(await call(app, '/v1/me/passkeys/options', { method: 'POST', cookie, headers: { [web]: 'web' } }), 200);
	await read(await call(app, '/v1/me/passkeys', { method: 'POST', cookie, headers: { [web]: 'web' }, body: { token: options.token, name: 'Phone', response: { id: credential, challenge: options.options.challenge } } }), 201);
}

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	const passkeys = new PasskeyService(db.app, webauthn);
	const common = { db: db.app, passkeys, organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), rateLimiter: limiter };
	auth = new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30, passkeys });
	app = createApp({ ...common, auth, web: { exportDir, secureCookies: true } });
	bare = createApp({ ...common, auth, web: { exportDir: join(exportDir, 'absent'), secureCookies: false } });
	native = createApp({ ...common, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30, passkeys, nativeSignIn: true }), web: { exportDir, secureCookies: true } });
});
after(async () => { await db?.close(); });

it('the callback spends the code, sets the HttpOnly session cookie and returns to the checked path', async () => {
	const { cookie, location, response } = await signIn(person(), '/settings?tab=passkeys');
	assert.equal(location, '/settings?tab=passkeys');
	assert.equal(response.headers.get('cache-control'), 'no-store');
	const session = setCookie(response, 'captain_session')!;
	assert.match(session.value, /^sess_[A-Za-z0-9_-]+$/);
	assert.equal(session.attributes.path, '/'); assert.equal(session.attributes.samesite, 'Lax');
	assert.ok('httponly' in session.attributes && 'secure' in session.attributes, `HttpOnly and Secure: ${JSON.stringify(session.attributes)}`);
	const maxAge = Number(session.attributes['max-age']);
	assert.ok(maxAge > 30 * 86_400 - 120 && maxAge <= 30 * 86_400, `max-age is the session TTL, got ${maxAge}`);
	assert.equal(setCookie(response, 'captain_stepup'), null, 'no step-up cookie without a passkey');
	// The cookie is a session with the web header, and the token never appears in a page: only the cookie carries it.
	const me = await read<{ user: { email: string }; passkeyVerified: boolean }>(await call(app, '/v1/me', { cookie, headers: { [web]: 'web' } }), 200);
	assert.equal(me.passkeyVerified, false);
	const events = (await db.owner`select event, success from auth_events where event = 'auth.session.exchange' and user_id = (select id from users where email = ${me.user.email})`);
	assert.deepEqual(events.map((e) => `${e.event}:${e.success}`), ['auth.session.exchange:true']);
});

it('a spent, missing or refused code and a repeated Google error each go to the welcome page with its own code', async () => {
	const { identity, cookie } = await signIn();
	const code = await exchangeCode(app, identity);
	assert.equal(await redirectTo(await call(app, `/auth/callback?code=${code}`)), '/settings');
	const spent = await call(app, `/auth/callback?code=${code}`);
	assert.equal(await redirectTo(spent), '/welcome?error=request_invalid');
	assert.deepEqual(spent.headers.getSetCookie(), [], 'a failed exchange sets no cookie');
	assert.equal(await redirectTo(await call(app, '/auth/callback')), '/welcome?error=request_invalid');
	assert.equal(await redirectTo(await call(app, '/auth/callback?error=google_failed')), '/welcome?error=google_failed');
	assert.equal(await redirectTo(await call(app, '/auth/callback?error=Bad%20value')), '/welcome?error=request_invalid', 'an unusable error code is not repeated');
	assert.equal((await call(app, '/v1/me', { cookie, headers: { [web]: 'web' } })).status, 200, 'the earlier session is untouched');
});

it('the cookie is refused without the web client header, and bearer requests are unchanged', async () => {
	const { cookie, identity } = await signIn();
	const refused = await call(app, '/v1/me', { cookie });
	assert.equal(refused.status, 401);
	assert.deepEqual(await refused.json(), { ok: false, code: 'csrf_header_missing', error: 'a cookie session needs the x-captain-client header' });
	assert.equal((await call(app, '/v1/me', { cookie, headers: { [web]: 'native' } })).status, 401, 'only the web value counts');
	assert.equal((await call(app, '/v1/me', { cookie: 'captain_session=sess_made_up', headers: { [web]: 'web' } })).status, 401);
	const none = await call(app, '/v1/me');
	assert.deepEqual(await none.json(), { ok: false, code: 'unauthorised', error: 'sign in to continue' });
	// A bearer token needs no header and is not affected by a cookie beside it.
	const [user] = await db.owner`select id from users where email = ${identity.email}`;
	const bearer = (await auth.issueSessionFor(String(user!.id))).token;
	assert.equal((await call(app, '/v1/me', { bearer })).status, 200);
	assert.equal((await call(app, '/v1/me', { bearer, cookie: 'captain_session=sess_made_up' })).status, 200, 'the bearer wins over any cookie');
	const signedOut = await call(app, '/auth/sign-out', { method: 'POST', bearer });
	assert.deepEqual(await read(signedOut, 200), { ok: true });
	assert.deepEqual(signedOut.headers.getSetCookie(), [], 'a bearer sign-out sets no cookie');
	assert.equal((await call(app, '/v1/me', { bearer })).status, 401);
	assert.equal((await call(app, '/v1/me', { cookie, headers: { [web]: 'web' } })).status, 200, 'the cookie session is untouched');
});

it('a passkey steps up through the step-up cookie, and verify moves the session into the session cookie', async () => {
	const { identity, cookie } = await signIn();
	await registerPasskey(cookie, 'cred-web-1');
	const response = await call(app, `/auth/callback?code=${await exchangeCode(app, identity, '/organisation')}`);
	assert.equal(await redirectTo(response), '/auth/passkey');
	assert.equal(setCookie(response, 'captain_session'), null, 'no session before the passkey');
	const stepUp = setCookie(response, 'captain_stepup')!;
	assert.match(stepUp.value, /^pks_[A-Za-z0-9_-]+$/);
	assert.equal(stepUp.attributes.path, '/auth'); assert.equal(stepUp.attributes['max-age'], '600'); assert.equal(stepUp.attributes.samesite, 'Lax');
	assert.ok('httponly' in stepUp.attributes && 'secure' in stepUp.attributes);
	const jar = `captain_stepup=${stepUp.value}`;
	assert.equal((await call(app, '/auth/passkey/options', { method: 'POST', body: {} })).status, 400, 'neither body nor cookie');
	const options = await read<{ options: { challenge: string; allow: string[] } }>(await call(app, '/auth/passkey/options', { method: 'POST', body: {}, cookie: jar }), 200);
	assert.deepEqual(options.options.allow, ['cred-web-1']);
	const verified = await call(app, '/auth/passkey/verify', { method: 'POST', body: { response: { id: 'cred-web-1', challenge: options.options.challenge } }, cookie: jar });
	const answer = await read<Record<string, unknown>>(verified, 200);
	assert.equal(answer.token, undefined, 'the session token stays out of the page');
	assert.equal(answer.ok, true); assert.equal(answer.returnTo, '/organisation');
	const session = setCookie(verified, 'captain_session')!;
	assert.match(session.value, /^sess_/); assert.equal(session.attributes.path, '/');
	const cleared = setCookie(verified, 'captain_stepup')!;
	assert.equal(cleared.value, ''); assert.equal(cleared.attributes['max-age'], '0'); assert.equal(cleared.attributes.path, '/auth');
	const me = await read<{ passkeyVerified: boolean }>(await call(app, '/v1/me', { cookie: `captain_session=${session.value}`, headers: { [web]: 'web' } }), 200);
	assert.equal(me.passkeyVerified, true);
	assert.equal((await call(app, '/auth/passkey/options', { method: 'POST', body: {}, cookie: jar })).status, 401, 'the step-up token was single use');
	// The body still wins when present, exactly as before.
	const next = await call(app, `/auth/callback?code=${await exchangeCode(app, identity)}`);
	const token = setCookie(next, 'captain_stepup')!.value;
	const byBody = await read<{ options: { challenge: string } }>(await call(app, '/auth/passkey/options', { method: 'POST', body: { token }, cookie: 'captain_stepup=pks_ignored' }), 200);
	const bodyVerify = await read<{ token?: string }>(await call(app, '/auth/passkey/verify', { method: 'POST', body: { token, response: { id: 'cred-web-1', challenge: byBody.options.challenge } } }), 200);
	assert.match(bodyVerify.token!, /^sess_/, 'a body token gets the token in the answer, as before');
});

it('sign-out with the cookie ends the session and clears both cookies', async () => {
	const { cookie } = await signIn();
	assert.equal((await call(app, '/auth/sign-out', { method: 'POST', cookie })).status, 401, 'sign-out needs the header too');
	const out = await call(app, '/auth/sign-out', { method: 'POST', cookie, headers: { [web]: 'web' } });
	assert.deepEqual(await read(out, 200), { ok: true });
	for (const name of ['captain_session', 'captain_stepup']) {
		const cleared = setCookie(out, name); assert.ok(cleared, `${name} is cleared`);
		assert.equal(cleared.value, ''); assert.equal(cleared.attributes['max-age'], '0');
		assert.equal(cleared.attributes.path, name === 'captain_session' ? '/' : '/auth');
	}
	assert.equal((await call(app, '/v1/me', { cookie, headers: { [web]: 'web' } })).status, 401);
});

it('a native sign-in is handed to the app\'s fixed callback with no cookie', async () => {
	const attempt = value(); const verifier = value();
	const query = new URLSearchParams({ client: 'native', code_challenge: s256(verifier), code_challenge_method: 'S256', attempt, return_to: '/work' });
	const code = await exchangeCode(native, person(), '/work', query);
	const response = await call(native, `/auth/callback?code=${code}`);
	const location = await redirectTo(response);
	const target = new URL(location);
	assert.equal(`${target.protocol}${target.pathname}`, 'app.askthecaptain.dev:/auth/callback');
	assert.match(target.searchParams.get('code')!, /^nh_[A-Za-z0-9_-]{43}$/); assert.equal(target.searchParams.get('attempt'), attempt);
	assert.deepEqual(response.headers.getSetCookie(), []);
	assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
	assert.equal(response.headers.get('cache-control'), 'no-store');
	// The same native sign-in against an API whose native sign-in is off says so, as the web page did.
	const off = await call(app, `/auth/callback?code=${await exchangeCode(native, person(), '/work', new URLSearchParams({ client: 'native', code_challenge: s256(value()), code_challenge_method: 'S256', attempt: value() }))}`);
	assert.equal(await redirectTo(off), '/welcome?error=native_sign_in_disabled');
});

it('the export is served at the root with the page as the fallback, and the API\'s paths are never shadowed', async () => {
	for (const path of ['/', '/welcome', '/auth/passkey', '/auth/passkey?native=1', '/settings', '/equipment/anything', '/invitations/accept?token=x']) {
		const response = await app.request(path);
		assert.equal(response.status, 200, path);
		assert.match(response.headers.get('content-type')!, /^text\/html/);
		assert.equal(response.headers.get('cache-control'), 'no-store', path);
		assert.equal(await response.text(), page, path);
	}
	const bundle = await app.request('/_expo/static/js/web/entry-abc123.js');
	assert.equal(bundle.status, 200);
	assert.equal(bundle.headers.get('cache-control'), 'public, max-age=31536000, immutable');
	assert.match(bundle.headers.get('content-type')!, /javascript/);
	assert.equal(await bundle.text(), 'console.log("shell")');
	const icon = await app.request('/favicon.ico');
	assert.equal(icon.status, 200); assert.equal(icon.headers.get('cache-control'), 'no-store');
	const missing = await app.request('/_expo/static/js/web/entry-other.js');
	assert.equal(missing.status, 200); assert.equal(await missing.text(), page, 'an unknown asset path falls back to the page like any other');
	assert.equal((await app.request('/', { method: 'HEAD' })).status, 200);
	// API paths answer as the API, signed in or not.
	const [user] = await db.owner`select id from users limit 1`;
	const bearer = (await auth.issueSessionFor(String(user!.id))).token;
	const unknown = await call(app, '/v1/nothing-here', { bearer });
	assert.deepEqual(await read(unknown, 404), { ok: false, code: 'not_found', error: 'not found' });
	assert.deepEqual(await read(await app.request('/v1/nothing-here'), 401), { ok: false, code: 'unauthorised', error: 'sign in to continue' });
	assert.equal((await app.request('/auth/nothing-here')).status, 401);
	assert.equal((await app.request('/auth/passkey/')).status, 401, 'only the exact page path is the app\'s');
	assert.deepEqual(await read(await app.request('/healthz'), 200), { ok: true });
	assert.equal((await app.request('/welcome', { method: 'POST' })).status, 401, 'only GET reaches the page');
	assert.deepEqual([isApiPath('/auth/callback'), isApiPath('/auth/passkey'), isApiPath('/v1/me'), isApiPath('/readyz'), isApiPath('/welcome'), isApiPath('/webhooks/x'), isApiPath('/connections/x')], [true, false, true, true, false, true, true]);
});

it('without the export the API still answers and the page says the web build is missing', async () => {
	const root = await bare.request('/');
	assert.equal(root.status, 503); assert.equal(await root.text(), missingBuild);
	assert.match(root.headers.get('content-type')!, /^text\/plain/); assert.equal(root.headers.get('cache-control'), 'no-store');
	assert.equal((await bare.request('/welcome')).status, 503);
	assert.deepEqual(await read(await bare.request('/healthz'), 200), { ok: true });
	assert.equal((await bare.request('/v1/me')).status, 401);
	const { response } = await (async () => { const r = await call(bare, `/auth/callback?code=${await exchangeCode(bare, person())}`); return { response: r }; })();
	const session = setCookie(response, 'captain_session')!;
	assert.ok(!('secure' in session.attributes), 'an http app URL sets no Secure attribute');
});

it('cookie member controls retain CSRF, tenant, owner/admin and last-owner rules', async () => {
 const owner = await signIn(), admin = await signIn(), member = await signIn(), stranger = await signIn();
 const request = (cookie: string, path: string, method = 'GET', body?: unknown) => call(app, path, { cookie, method, body, headers: { [web]: 'web' } });
 const organisation = await read<{ id: string }>(await request(owner.cookie, '/v1/organisations', 'POST', { name: 'Cookie crew' }), 201);
 const base = `/v1/organisations/${organisation.id}`;
 const ownerMe = await read<{ user: { id: string } }>(await request(owner.cookie, '/v1/me'), 200);
 const adminMe = await read<{ user: { id: string } }>(await request(admin.cookie, '/v1/me'), 200);
 const memberMe = await read<{ user: { id: string } }>(await request(member.cookie, '/v1/me'), 200);
 const invite = async (email: string, role: 'admin' | 'member') => read<{ invitation: { id: string }; token: string }>(await request(owner.cookie, `${base}/invitations`, 'POST', { email, role }), 201);
 const adminInvite = await invite(admin.identity.email, 'admin');
 assert.match(adminInvite.token, /^inv_[A-Za-z0-9_-]{43}$/);
 await read(await request(admin.cookie, '/v1/invitations/accept', 'POST', { token: adminInvite.token }), 200);
 const memberInvite = await invite(member.identity.email, 'member');
 await read(await request(member.cookie, '/v1/invitations/accept', 'POST', { token: memberInvite.token }), 200);
 assert.equal((await request(stranger.cookie, `${base}/members`)).status, 404, 'another tenant cannot list the crew');
 assert.equal((await request(member.cookie, `${base}/invitations`)).status, 403);
 assert.equal((await request(member.cookie, `${base}/members/${adminMe.user.id}`, 'PATCH', { role: 'member' })).status, 403);
 assert.equal((await request(admin.cookie, `${base}/members/${adminMe.user.id}`, 'PATCH', { role: 'owner' })).status, 403);
 assert.equal((await request(admin.cookie, `${base}/members/${ownerMe.user.id}`, 'DELETE')).status, 403);
 const last = await read<{ code: string }>(await request(owner.cookie, `${base}/members/${ownerMe.user.id}`, 'DELETE'), 400);
 assert.equal(last.code, 'last_owner');
 assert.equal((await call(app, `${base}/members/${memberMe.user.id}`, { cookie: owner.cookie, method: 'PATCH', body: { role: 'admin' } })).status, 401, 'cookie PATCH requires the web header');
 await read(await request(admin.cookie, `${base}/members/${memberMe.user.id}`, 'PATCH', { role: 'admin' }), 200);
 const listed = await read<{ members: { userId: string; role: string }[] }>(await request(owner.cookie, `${base}/members`), 200);
 assert.equal(listed.members.find(row => row.userId === memberMe.user.id)?.role, 'admin');
 const pending = await invite(person().email, 'member');
 assert.equal((await call(app, `${base}/invitations/${pending.invitation.id}`, { cookie: owner.cookie, method: 'DELETE' })).status, 401, 'cookie DELETE requires the web header');
 await read(await request(admin.cookie, `${base}/invitations/${pending.invitation.id}`, 'DELETE'), 200);
 const invitations = await read<{ invitations: unknown[] }>(await request(owner.cookie, `${base}/invitations`), 200);
 assert.deepEqual(invitations.invitations, []);
 assert.equal((await request(stranger.cookie, `${base}/members/${memberMe.user.id}`, 'DELETE')).status, 404);
 await read(await request(owner.cookie, `${base}/members/${memberMe.user.id}`, 'DELETE'), 200);
 assert.equal((await request(member.cookie, `${base}/members`)).status, 404, 'the removed member loses access');
});
