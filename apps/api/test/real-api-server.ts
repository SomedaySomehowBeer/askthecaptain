/** A throwaway real API for browser checks against real data (apps/e2e/scripts/real-api-cards-check.mjs): a fresh
 *  Postgres database through the runtime role, the API as `createApp` builds it, serving the Expo web export, seeded
 *  through its own routes with a signed-in owner, an organisation in Australia/Sydney, equipment, three bookings and a
 *  task. Prints one JSON line when ready (the session token goes into the `captain_session` cookie); SIGTERM stops the
 *  server and drops the database. Not for any shared or hosted database. */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { freshDatabase } from '@captain/db/test';
import { createApp } from '../src/app.ts';
import type { IdentityProvider } from '../src/auth/google.ts';
import { AuthService } from '../src/auth/service.ts';
import { CommitmentsService } from '../src/commitments/service.ts';
import { OrganisationService } from '../src/organisations/service.ts';

const db = await freshDatabase();
const port = Number(process.env.PORT ?? 8091);
let next = { subject: 'real-owner', email: 'owner@example.test', name: 'Olive Owner' };
const google: IdentityProvider = { authorizationUrl: ({ state }) => `https://google.test/auth?state=${state}`, async exchange() { return next; } };
const app = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: `http://127.0.0.1:${port}`, sessionTtlDays: 1 }),
	organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app),
	web: { exportDir: process.env.WEB_EXPORT_DIR ?? fileURLToPath(new URL('../../mobile/dist/web', import.meta.url)), secureCookies: false } });
async function call<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
	const r = await app.request(path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
	if (r.status >= 400) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
	return r.json() as Promise<T>;
}
async function signIn(subject: string, name: string): Promise<{ token: string; user: { id: string } }> {
	next = { subject, email: `${subject}@example.test`, name };
	const start = await app.request('/auth/google/start');
	const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
	const callback = await app.request(`/auth/google/callback?code=abc&state=${state}`);
	return call('POST', '/auth/session/exchange', undefined, { code: new URL(callback.headers.get('location')!).searchParams.get('code')! });
}
const owner = await signIn('real-owner', 'Olive Owner'), maya = await signIn('real-maya', 'Maya Chen');
const org = (await call<{ id: string }>('POST', '/v1/organisations', owner.token, { name: 'Harbour Brewing' })).id;
await call('PATCH', `/v1/organisations/${org}`, owner.token, { timezone: 'Australia/Sydney' });
await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${maya.user.id}, 'member')`;
const base = `/v1/organisations/${org}`;
const equipment = (await call<{ id: string }>('POST', `${base}/equipment`, owner.token, { name: 'Canning line' })).id;
const book = async (title: string, startsAt: string, endsAt: string, setupMinutes = 0, cleanupMinutes = 0) =>
	(await call<{ id: string }>('POST', `${base}/equipment/${equipment}/reservations`, owner.token, { id: randomUUID(), title, startsAt, endsAt, setupMinutes, cleanupMinutes })).id;
// Sydney is UTC+11 in March 2031: the run is 8:00 am–12:00 pm with 30 minutes either side; the clean follows at 1:00 pm.
const run = await book('Summer lager canning run', '2031-03-03T21:00:00.000Z', '2031-03-04T01:00:00.000Z', 30, 30);
await book('Bright tank clean', '2031-03-04T02:00:00.000Z', '2031-03-04T04:00:00.000Z');
const hire = await book('Fermenter hire', '2031-03-10T05:00:00.000Z', '2031-03-11T23:00:00.000Z');
const task = (await call<{ id: string }>('POST', `${base}/tasks`, owner.token, { title: 'Package summer lager', due: '2031-03-05' })).id;
const thread = async (column: 'reservation_id' | 'task_id', id: string) => (await db.owner.unsafe(`select id from threads where ${column} = $1`, [id]))[0]!.id as string;
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}`, token: owner.token, maya: maya.token, org, equipment,
	run, runThread: await thread('reservation_id', run), hire, hireThread: await thread('reservation_id', hire), task, taskThread: await thread('task_id', task) }));
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; server.close(); await db.close(); process.exit(0); };
process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
