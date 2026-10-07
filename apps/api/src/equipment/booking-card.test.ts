import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import type { IdentityProvider } from '../auth/google.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { RateLimiter } from '../ratelimit.ts';
import type { ApiClient, ApiOutcome } from '../../../mobile/src/auth/contracts.ts';

// The booking card's decisions (owner's hosted findings, 7 October) fed by the real API: real Postgres as the runtime
// role, the Expo client's own calls, parsers, thread controls, occupancy read, form and control rules. The synthetic
// browser check answers with contract-shaped values; this one answers with whatever the API writes and reads.
const it = databaseUrl ? test : test.skip;
let db: Harness, app: ReturnType<typeof createApp>;
type Person = { token: string; user: { id: string } };
const google: IdentityProvider & { next: { subject: string; email: string; name: string } } = {
	next: { subject: 'owner', email: 'owner@example.test', name: 'Owner' },
	authorizationUrl: ({ state }) => `https://google.test/auth?state=${state}`, async exchange() { return google.next; },
};
const request = (method: string, path: string, person?: Person, data?: unknown) => app.request(path, { method,
	headers: { 'content-type': 'application/json', ...(person ? { authorization: `Bearer ${person.token}` } : {}) },
	body: data === undefined ? undefined : JSON.stringify(data) });
async function json<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
	const value = await response; assert.equal(value.status, status, await value.clone().text()); return value.json() as Promise<T>;
}
async function signIn(subject: string, name: string): Promise<Person> {
	google.next = { subject, email: `${subject}@example.test`, name };
	const start = await app.request('/auth/google/start');
	const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
	const callback = await app.request(`/auth/google/callback?code=abc&state=${state}`);
	const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
	return json(request('POST', '/auth/session/exchange', undefined, { code }));
}
/** The Expo `ApiClient` over this app: the outcome kinds the real fetch client gives each status. */
function clientFor(person: Person): ApiClient {
	const outcome = async <T>(response: Response, parse: (v: unknown) => T): Promise<ApiOutcome<T>> => {
		const body = await response.json().catch(() => null) as { code?: string } | null;
		if (response.ok) { try { return { ok: true, value: parse(body) }; } catch { return { ok: false, kind: 'unavailable', status: response.status }; } }
		if (response.status === 401) return { ok: false, kind: 'unauthorised' };
		if (response.status === 429 || response.status >= 500) return { ok: false, kind: 'unavailable', status: response.status };
		return { ok: false, kind: 'refused', status: response.status, code: body?.code ?? 'unknown' };
	};
	return {
		async get(path, _token, parse) { return outcome(await request('GET', path, person), parse); },
		async post(path, _token, body, parse) { return outcome(await request('POST', path, person, body), parse); },
		async patch(path, _token, body, parse) { return outcome(await request('PATCH', path, person, body), parse); },
		async delete(path, _token, parse) { return outcome(await request('DELETE', path, person), parse); },
	};
}

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	let now = 0;
	app = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 }),
		organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), rateLimiter: new RateLimiter(() => (now += 120_000)) });
});
after(async () => { await db?.close(); });

it('the booking card on real data: cancel is offered on an untouched card and works; an overlap or invalid warning turns Save off and the API agrees; a booking that spans days opens whole; the thread stays ready through card writes', async () => {
	const { createThreadCalls } = await import('../../../mobile/src/threads/api.ts');
	const { createThreadControls } = await import('../../../mobile/src/threads/thread-controls.ts');
	const { reads, send, writes } = await import('../../../mobile/src/threads/cards/records.ts');
	const { bookingChanged, bookingControls, bookingPlan, bookingStart } = await import('../../../mobile/src/threads/cards/forms.ts');
	const owner = await signIn('card-owner', 'Olive Owner');
	const org = (await json<{ id: string }>(request('POST', '/v1/organisations', owner, { name: 'Harbour Brewing' }), 201)).id;
	await json(request('PATCH', `/v1/organisations/${org}`, owner, { timezone: 'Australia/Sydney' }));
	const base = `/v1/organisations/${org}`;
	const line = (await json<{ id: string }>(request('POST', `${base}/equipment`, owner, { name: 'Canning line' }), 201)).id;
	const book = async (title: string, startsAt: string, endsAt: string, setupMinutes = 0, cleanupMinutes = 0) =>
		(await json<{ id: string }>(request('POST', `${base}/equipment/${line}/reservations`, owner, { id: randomUUID(), title, startsAt, endsAt, setupMinutes, cleanupMinutes }), 201)).id;
	// Sydney is UTC+11 in March 2031: 8:00 am–12:00 pm with 30 minutes either side, then a clean at 1:00–3:00 pm.
	const runId = await book('Summer lager canning run', '2031-03-03T21:00:00.000Z', '2031-03-04T01:00:00.000Z', 30, 30);
	await book('Bright tank clean', '2031-03-04T02:00:00.000Z', '2031-03-04T04:00:00.000Z');
	const longId = await book('Fermenter hire', '2031-03-10T05:00:00.000Z', '2031-03-11T23:00:00.000Z');

	const scope = { userId: owner.user.id, organisationId: org, epoch: 'test' };
	const calls = createThreadCalls(clientFor(owner), { scope: () => scope, sessionEnded() { throw new Error('session ended'); }, reconcile() { throw new Error('unexpected 403'); } });
	const zone = await reads.zone(calls, scope); assert.ok(zone.kind === 'ok'); assert.equal(zone.value, 'Australia/Sydney');
	const read = async (id: string) => { const r = await reads.booking(calls, scope, line, id); assert.ok(r.kind === 'ok', JSON.stringify(r)); return r.value; };
	const idle = { busy: false, uncertain: false, refusal: null };

	// The booking's own thread through the client's thread controls: ready, so the card is not locked.
	const threadId = (await db.owner`select id from threads where reservation_id = ${runId}`)[0]!.id as string;
	const controls = createThreadControls(calls, scope, threadId, Date.now, () => {}, () => { throw new Error('lost'); });
	await controls.load(); assert.equal(controls.snapshot().phase, 'ready'); assert.equal(controls.snapshot().detail?.card.record?.kind, 'booking');

	// Untouched: nothing to save or discard, the time is free, and "Cancel this booking" is offered.
	const run = await read(runId), start = bookingStart(run, zone.value);
	assert.equal(start.multiDay, false);
	const same = bookingPlan(run, start.form, zone.value, start.multiDay); assert.ok('time' in same); assert.equal(bookingChanged(run, same.time), false);
	const free = await reads.occupancy(calls, scope, run, zone.value, same.occupiedFrom, same.occupiedTo, 2031);
	assert.deepEqual(free, { kind: 'free' });
	assert.deepEqual(bookingControls({ locked: controls.snapshot().phase !== 'ready', cancelled: false, waiting: false, changed: false, plan: same, free: free!, save: idle, cancel: idle }),
		{ editable: true, warning: null, save: false, discard: false, cancel: true, confirmCancel: true });

	// Ending at 1:00 pm runs the cleanup into the clean: the note names it, Save is off, and the API refuses that very write.
	const moved = bookingPlan(run, { ...start.form, end: '13:00' }, zone.value, false); assert.ok('time' in moved);
	const taken = await reads.occupancy(calls, scope, run, zone.value, moved.occupiedFrom, moved.occupiedTo, 2031);
	assert.deepEqual(taken, { kind: 'taken', holders: ['Bright tank clean (1:00 pm to 3:00 pm)'] });
	const underWarning = bookingControls({ locked: false, cancelled: false, waiting: false, changed: true, plan: moved, free: taken!, save: idle, cancel: idle });
	assert.deepEqual([underWarning.warning, underWarning.save, underWarning.discard, underWarning.cancel], ['taken', false, true, true]);
	const refused = await send(calls, scope, writes.booking(scope, line, runId, randomUUID(), run.revision, moved.time));
	assert.ok(refused.kind === 'error' && refused.code === 'reservation_conflict', JSON.stringify(refused));
	// An end before the start: the invalid note, Save off.
	const invalid = bookingPlan(run, { ...start.form, end: '07:00' }, zone.value, false);
	assert.equal(bookingControls({ locked: false, cancelled: false, waiting: false, changed: true, plan: invalid, free: { kind: 'idle' }, save: idle, cancel: idle }).warning, 'invalid');
	// Ending at 12:30 pm is free: Save is on and the API takes it; the thread reconciles and stays ready.
	const fine = bookingPlan(run, { ...start.form, end: '12:30', cleanup: 0 }, zone.value, false); assert.ok('time' in fine);
	const open = await reads.occupancy(calls, scope, run, zone.value, fine.occupiedFrom, fine.occupiedTo, 2031); assert.deepEqual(open, { kind: 'free' });
	assert.equal(bookingControls({ locked: false, cancelled: false, waiting: false, changed: true, plan: fine, free: open!, save: idle, cancel: idle }).save, true);
	const saved = await send(calls, scope, writes.booking(scope, line, runId, randomUUID(), run.revision, fine.time));
	assert.ok(saved.kind === 'ok', JSON.stringify(saved)); assert.equal(saved.value.revision, run.revision + 1);
	await controls.refresh(); assert.equal(controls.snapshot().phase, 'ready'); assert.equal(controls.snapshot().busy, false);

	// A booking that spans days opens with its end date: no warning and nothing to save on an untouched card.
	const long = await read(longId), opened = bookingStart(long, zone.value);
	assert.equal(opened.multiDay, true); assert.deepEqual([opened.form.date, opened.form.start, opened.form.endDate, opened.form.end], ['2031-03-10', '16:00', '2031-03-12', '10:00']);
	const whole = bookingPlan(long, opened.form, zone.value, opened.multiDay); assert.ok('time' in whole); assert.equal(bookingChanged(long, whole.time), false);
	const longFree = await reads.occupancy(calls, scope, long, zone.value, whole.occupiedFrom, whole.occupiedTo, 2031); assert.deepEqual(longFree, { kind: 'free' });
	assert.deepEqual(bookingControls({ locked: false, cancelled: false, waiting: false, changed: false, plan: whole, free: longFree!, save: idle, cancel: idle }),
		{ editable: true, warning: null, save: false, discard: false, cancel: true, confirmCancel: true });

	// "Cancel this booking", confirmed: the card's own write; the thread stays ready and its card says cancelled.
	const current = await read(runId);
	const cancelled = await send(calls, scope, writes.cancelBooking(scope, line, runId, randomUUID(), current.revision));
	assert.ok(cancelled.kind === 'ok', JSON.stringify(cancelled)); assert.equal(cancelled.value.status, 'cancelled');
	await controls.refresh(); assert.equal(controls.snapshot().phase, 'ready'); assert.equal(controls.snapshot().detail?.card.status, 'cancelled');
	assert.deepEqual(bookingControls({ locked: false, cancelled: true, waiting: false, changed: false, plan: same, free: { kind: 'idle' }, save: idle, cancel: idle }),
		{ editable: false, warning: null, save: false, discard: false, cancel: false, confirmCancel: false });
	assert.equal((await db.owner`select status from equipment_reservations where id = ${runId}`)[0]!.status, 'cancelled');
	controls.dispose();
});
