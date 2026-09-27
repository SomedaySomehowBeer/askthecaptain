import { writeFile, unlink } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { freshDatabase } from '../../../packages/db/test/harness.ts';
import { createApp } from '../src/app.ts';
import type { IdentityProvider } from '../src/auth/google.ts';
import { PasskeyService } from '../src/auth/passkeys.ts';
import { AuthService } from '../src/auth/service.ts';
import { simpleWebAuthn } from '../src/auth/webauthn.ts';
import { CommitmentsService } from '../src/commitments/service.ts';
import { OrganisationService } from '../src/organisations/service.ts';
import { RateLimiter } from '../src/ratelimit.ts';

/** Native sign-in browser fixture (mobile foundation contract §3.5, A2). Test-only: never imported by the
 *  application and never started against hosted data. It serves the real API over its own disposable database on
 *  loopback, with a fake Google that signs in one of three synthetic people and the real WebAuthn verifier for the
 *  web origin, so the browser's virtual authenticator exercises the actual passkey step-up. Native sign-in can be
 *  switched on and off between requests to prove the gate fails closed; the switch exists only here. */
const directory = process.env.NATIVE_PROBE_DIR;
if (!directory) throw new Error('Set NATIVE_PROBE_DIR to a private temporary directory.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const loopback = ['127.0.0.1', 'localhost', '[::1]'];
if (!loopback.includes(new URL(process.env.DATABASE_URL).hostname)) throw new Error('The native fixture requires a loopback Postgres server.');
const api = new URL(process.env.NATIVE_API_URL ?? 'http://127.0.0.1:8086');
// WebAuthn refuses an IP address as a relying party, so the web origin is `localhost` (a secure context).
const web = new URL(process.env.NATIVE_WEB_URL ?? 'http://localhost:3036');
if (api.hostname !== '127.0.0.1' || web.hostname !== 'localhost' || api.protocol !== 'http:' || web.protocol !== 'http:')
	throw new Error('The native fixture runs only on loopback: API on 127.0.0.1, web on localhost.');

type Who = 'nora' | 'pat' | 'olive';
type Identity = { subject: string; email: string; name: string };
/** Nora never has a passkey; Pat registers one during the browser proof; Olive holds an unrelated web session. */
const people: Record<Who, Identity> = {
	nora: { subject: 'native-nora', email: 'nora@example.test', name: 'Nora No-passkey' },
	pat: { subject: 'native-pat', email: 'pat@example.test', name: 'Pat Passkey' },
	olive: { subject: 'native-olive', email: 'olive@example.test', name: 'Olive Other' }
};

const db = await freshDatabase();
try {
	let who: Who = 'nora';
	const google: IdentityProvider = {
		// The browser really leaves the web for this "Google" page, which returns straight to the API callback.
		authorizationUrl: ({ state }) => new URL(`/__fixture/google?state=${encodeURIComponent(state)}`, api).toString(),
		async exchange() { return people[who]; }
	};
	const passkeys = new PasskeyService(db.app, simpleWebAuthn(web.origin));
	// Disposable loopback data only: the browser proof makes many sign-ins, so each rate-limit check starts a new window.
	let clock = 0; const rateLimiter = new RateLimiter(() => (clock += 61_000));
	const common = { db: db.app, passkeys, rateLimiter, organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app) };
	const auth = (nativeSignIn: boolean) => new AuthService(db.app, google, { appUrl: web.origin, sessionTtlDays: 1, passkeys, nativeSignIn });
	const on = createApp({ ...common, auth: auth(true) });
	const off = createApp({ ...common, auth: auth(false) });
	let nativeEnabled = true;

	/** Signs a person in through the real web exchange, without a browser, and gives them an organisation. */
	async function seed(person: Who): Promise<{ token: string; email: string }> {
		who = person;
		const start = await on.request('/auth/google/start?return_to=%2Fwork');
		const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
		const callback = await on.request(`/auth/google/callback?code=fixture&state=${encodeURIComponent(state)}`);
		const code = new URL(callback.headers.get('location')!).searchParams.get('code');
		if (!code) throw new Error(`seed ${person}: no exchange code`);
		const exchanged = await on.request('/auth/session/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
		const signed = await exchanged.json() as { token?: string };
		if (!exchanged.ok || !signed.token) throw new Error(`seed ${person}: exchange ${exchanged.status}`);
		const org = await on.request('/v1/organisations', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${signed.token}` }, body: JSON.stringify({ name: `${people[person].name}'s bakery` }) });
		if (!org.ok) throw new Error(`seed ${person}: organisation ${org.status}`);
		return { token: signed.token, email: people[person].email };
	}
	const users = { nora: await seed('nora'), pat: await seed('pat'), olive: await seed('olive') };
	who = 'nora';

	const server = serve({ hostname: api.hostname, port: Number(api.port), fetch: async (req) => {
		const url = new URL(req.url);
		if (url.pathname === '/__fixture/ready') return Response.json({ ok: true });
		if (url.pathname === '/__fixture/google' && req.method === 'GET') {
			const state = url.searchParams.get('state');
			if (!state) return Response.json({ error: 'missing state' }, { status: 400 });
			return new Response(null, { status: 302, headers: { location: `/auth/google/callback?code=fixture&state=${encodeURIComponent(state)}` } });
		}
		if (url.pathname === '/__fixture/identity' && req.method === 'POST') {
			const body = await req.json().catch(() => null) as { who?: string } | null;
			if (!body?.who || !(body.who in people)) return Response.json({ error: 'unknown person' }, { status: 400 });
			who = body.who as Who; return Response.json({ ok: true });
		}
		if (url.pathname === '/__fixture/native' && req.method === 'POST') {
			const body = await req.json().catch(() => null) as { enabled?: unknown } | null;
			if (typeof body?.enabled !== 'boolean') return Response.json({ error: 'enabled must be true or false' }, { status: 400 });
			nativeEnabled = body.enabled; return Response.json({ ok: true });
		}
		return (nativeEnabled ? on : off).fetch(req);
	} });
	await writeFile(`${directory}/data.json`, JSON.stringify({ fixture: 'captain-native-local', api: api.origin, web: web.origin, users }), { mode: 0o600, flag: 'wx' });
	console.log(`Native fixture ready on ${api.origin} for ${web.origin}`);
	let closing = false;
	async function close() {
		if (closing) return; closing = true;
		server.close(); await db.close(); await unlink(`${directory}/data.json`).catch(() => undefined); process.exit(0);
	}
	process.on('SIGTERM', close);
	process.on('SIGINT', close);
} catch (error) {
	await db.close();
	throw error;
}
