import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { RateLimiter } from '../ratelimit.ts';
import type { IdentityProvider } from './google.ts';
import { PasskeyService, type WebAuthn } from './passkeys.ts';
import { AuthService } from './service.ts';

// Representative server-side evidence for the mobile app's bearer protection (docs/plans/expo-mobile-auth-core-2026-09.md):
// the native exchange, sign-out, /v1/me and sample organisation routes, called in process, answered no 3xx and no
// location header for valid, invalid and missing credentials. It is not a guarantee for every route, for a proxy or
// load balancer in front of the API, or for how native network stacks treat `redirect: 'error'`; that last one stays
// a named device check. Test-only: no API behaviour changes.
const it = databaseUrl ? test : test.skip;
let db: Harness; let on: ReturnType<typeof createApp>; let off: ReturnType<typeof createApp>; let onAuth: AuthService;
let clock = Date.parse('2030-01-01T00:00:00Z');
const limiter = new RateLimiter(() => (clock += 2_500));

const google: IdentityProvider & { next: { subject: string; email: string; name: string } } = {
	next: { subject: 'nr-0', email: 'no-redirect@example.com', name: 'No Redirect' },
	authorizationUrl: ({ state }) => `https://google.test/auth?state=${state}`,
	async exchange() { return google.next; }
};
const webauthn = {} as WebAuthn; // no passkeys are registered here, so it is never called

type App = ReturnType<typeof createApp>;
const value = () => randomBytes(32).toString('base64url');
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const call = (app: App, method: string, path: string, options: { body?: string; token?: string } = {}) => app.request(path, { method,
	headers: { 'content-type': 'application/json', ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }) }, body: options.body });

/** The whole native flow as far as the handoff the web would pass to the app. The start and the Google callback do
 *  redirect: they are browser legs, never called by the app's client. */
async function handoff(): Promise<{ code: string; verifier: string; attempt: string }> {
	const verifier = value(); const attempt = value();
	google.next = { subject: `nr-${value()}`, email: `nr-${randomBytes(4).toString('hex')}@example.com`, name: 'No Redirect' };
	const query = new URLSearchParams({ client: 'native', code_challenge: s256(verifier), code_challenge_method: 'S256', attempt, return_to: '/work' });
	const state = new URL((await on.request(`/auth/google/start?${query}`)).headers.get('location')!).searchParams.get('state')!;
	const code = new URL((await on.request(`/auth/google/callback?code=google-code&state=${state}`)).headers.get('location')!).searchParams.get('code')!;
	const exchanged = await call(on, 'POST', '/auth/session/exchange', { body: JSON.stringify({ code }) });
	assert.equal(exchanged.status, 200);
	return { code: ((await exchanged.json()) as { nativeHandoff: string }).nativeHandoff, verifier, attempt };
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

it('sampled routes the app calls answer no 3xx for valid, invalid and missing credentials', async () => {
	const results: { name: string; status: number; location: string | null }[] = [];
	const check = async (name: string, response: Response | Promise<Response>) => {
		const r = await response; results.push({ name, status: r.status, location: r.headers.get('location') });
		return r;
	};

	// POST /auth/native/exchange: valid, replayed, wrong binding, malformed, empty, off, and with a stray bearer.
	const good = await handoff();
	const signed = await check('exchange valid', call(on, 'POST', '/auth/native/exchange', { body: JSON.stringify(good) }));
	assert.equal(signed.status, 200, 'the valid exchange signs in');
	const token = ((await signed.json()) as { token: string }).token;
	await check('exchange replayed', call(on, 'POST', '/auth/native/exchange', { body: JSON.stringify(good) }));
	const other = await handoff();
	await check('exchange wrong verifier', call(on, 'POST', '/auth/native/exchange', { body: JSON.stringify({ ...other, verifier: value() }) }));
	await check('exchange malformed', call(on, 'POST', '/auth/native/exchange', { body: JSON.stringify({ code: 'nh_short', verifier: 'v', attempt: 'a' }) }));
	await check('exchange not json', call(on, 'POST', '/auth/native/exchange', { body: 'not json' }));
	await check('exchange empty', call(on, 'POST', '/auth/native/exchange'));
	await check('exchange with bearer', call(on, 'POST', '/auth/native/exchange', { body: JSON.stringify(other), token }));
	const offCode = await handoff();
	await check('exchange while off', call(off, 'POST', '/auth/native/exchange', { body: JSON.stringify(offCode) }));

	// An organisation for the signed-in routes.
	const created = await check('organisation create', call(on, 'POST', '/v1/organisations', { body: JSON.stringify({ name: 'No redirect' }), token }));
	assert.equal(created.status, 201);
	const organisationId = ((await created.json()) as { id: string }).id;
	const stranger = `00000000-0000-4000-8000-${randomBytes(6).toString('hex')}`;

	const credentials: [string, string | undefined][] = [['missing', undefined], ['malformed', 'not-a-session'], ['unknown', `sess_${value()}`], ['valid', token]];
	for (const [label, bearer] of credentials) {
		const options = bearer === undefined ? {} : { token: bearer };
		await check(`me ${label}`, call(on, 'GET', '/v1/me', options));
		await check(`organisation ${label}`, call(on, 'GET', `/v1/organisations/${organisationId}`, options));
		await check(`organisation members ${label}`, call(on, 'GET', `/v1/organisations/${organisationId}/members`, options));
		await check(`other organisation ${label}`, call(on, 'GET', `/v1/organisations/${stranger}`, options));
		await check(`organisation bad id ${label}`, call(on, 'GET', '/v1/organisations/not-a-uuid', options));
	}
	await check('sign-out missing', call(on, 'POST', '/auth/sign-out'));
	await check('sign-out unknown', call(on, 'POST', '/auth/sign-out', { token: `sess_${value()}` }));
	const signedOut = await check('sign-out valid', call(on, 'POST', '/auth/sign-out', { token }));
	assert.equal(signedOut.status, 200, 'the valid sign-out revokes');
	await check('sign-out revoked', call(on, 'POST', '/auth/sign-out', { token }));
	await check('me revoked', call(on, 'GET', '/v1/me', { token }));
	await check('organisation revoked', call(on, 'GET', `/v1/organisations/${organisationId}`, { token }));

	for (const r of results) {
		assert.ok(r.status < 300 || r.status >= 400, `${r.name} answered ${r.status}`);
		assert.equal(r.location, null, `${r.name} carried a location header`);
	}
	// The cases above covered success, refusal and missing credentials on every route.
	const statuses = new Set(results.map((r) => r.status));
	for (const status of [200, 400, 401]) assert.ok(statuses.has(status), `no ${status} case`);
});
