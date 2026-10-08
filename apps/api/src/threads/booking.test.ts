import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import type { IdentityProvider } from '../auth/google.ts';
import { changeSetHeader } from '../changes.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { RateLimiter } from '../ratelimit.ts';

// H2 B-A (docs/plans/bookings-and-equipment-2026-10.md §2, §4; versions contract §5, §6; D29): a topic becomes a booking
// through the API, and the equipment writes a person makes from the Equipment screen. Real Postgres, migration 0049.
const it = databaseUrl ? test : test.skip;
let db: Harness, app: ReturnType<typeof createApp>;
type Person = { token: string; user: { id: string } };
type Detail = { thread: { id: string; kind: string; title: string; revision: number }; card: { record: { kind: string; id: string } | null; title: string; fold: Record<string, unknown> };
	tags: { id: string }[] };
type Message = { kind: string; changeSetId?: string; body: string | null; change?: { causeKind: string; changes: { recordKind: string; operation: string; field: string | null }[] } };
type Equipment = { id: string; name: string; archivedAt: string | null; revision: number; changeSetId: string };
type History = { changeSets: { id: string; changes: { operation: string; field: string | null; state: string; reason?: string }[] }[]; start: { kind: string; changeSetId: string } | null };
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
const code = async (response: Response | Promise<Response>, status: number) => (await json<{ code: string }>(response, status)).code;
async function signIn(subject: string, name: string): Promise<Person> {
	google.next = { subject, email: `${subject}@example.test`, name };
	const start = await app.request('/auth/google/start');
	const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
	const callback = await app.request(`/auth/google/callback?code=abc&state=${state}`);
	const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
	return json(request('POST', '/auth/session/exchange', undefined, { code }));
}
const count = async (sql: string, ...params: unknown[]) => Number((await db.owner.unsafe(sql, params as never[]))[0]!.n);
let people = 0;
async function business(name: string) {
	const n = ++people;
	const owner = await signIn(`book-owner-${n}`, `Maya ${n}`), member = await signIn(`book-member-${n}`, `Tom ${n}`);
	const org = (await json<{ id: string }>(request('POST', '/v1/organisations', owner, { name }), 201)).id;
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${member.user.id}, 'member')`;
	const base = `/v1/organisations/${org}`;
	return {
		org, owner, member, base,
		equipment: (person: Person, body: Record<string, unknown>) => json<Equipment>(request('POST', `${base}/equipment`, person, body), 201),
		topic: async (person: Person, body: string) => (await json<{ thread: { id: string; revision: number } }>(request('POST', `${base}/threads`, person,
			{ id: randomUUID(), kind: 'topic', message: { id: randomUUID(), body } }), 201)).thread,
		makeBooking: (person: Person, threadId: string, body: Record<string, unknown>) => request('POST', `${base}/threads/${threadId}/booking`, person, body),
		messages: (person: Person, thread: string) => json<{ messages: Message[] }>(request('GET', `${base}/threads/${thread}/messages?latest=100`, person)).then(r => r.messages),
		history: (person: Person, kind: string, id: string) => json<History>(request('GET', `${base}/history/${kind}/${id}`, person)),
		threadRow: async (id: string) => (await db.owner<{ kind: string; reservationId: string | null; revision: number; title: string | null }[]>`select kind, reservation_id, revision, title
			from threads where id = ${id}`)[0]!,
	};
}

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	let clock = Date.now();
	app = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 }),
		organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), rateLimiter: new RateLimiter(() => (clock += 61_000)) });
});
after(async () => { await db?.close(); });

const slot = { startsAt: '2031-10-14T09:00:00+11:00', endsAt: '2031-10-14T13:00:00+11:00', setupMinutes: 30, cleanupMinutes: 45 };

it('topic to booking: the topic’s thread becomes the booking’s, keeping its messages and tags, journalled as its creation, once', async () => {
	const b = await business('Topic to booking');
	const kettle = await b.equipment(b.owner, { name: 'Brew kettle' });
	const tag = await json<{ id: string }>(request('POST', `${b.base}/tags`, b.owner, { name: 'Autumn lager' }), 201);
	const topic = await b.topic(b.member, 'Brew the autumn lager on the kettle\nTuesday morning suits the crew.');
	await json(request('POST', `${b.base}/threads/${topic.id}/tags/${tag.id}`, b.member, { expectedRevision: topic.revision }));
	await json(request('POST', `${b.base}/threads/${topic.id}/messages`, b.owner, { id: randomUUID(), body: 'I can start the mash at 9.' }), 201);
	const threadsBefore = await count('select count(*) as n from threads where organisation_id = $1', b.org);
	const before = await b.messages(b.owner, topic.id);
	const changeSetId = randomUUID();
	const body = { expectedRevision: 2, changeSetId, equipmentId: kettle.id, ...slot, ownerId: b.member.user.id };
	const made = await b.makeBooking(b.owner, topic.id, body);
	const detail = await json<Detail>(made);
	assert.equal(made.headers.get(changeSetHeader), changeSetId);
	assert.deepEqual([detail.thread.id, detail.thread.kind, detail.thread.title, detail.thread.revision, detail.card.record?.kind, detail.tags.map(t => t.id)],
		[topic.id, 'record', 'Brew the autumn lager on the kettle', 3, 'booking', [tag.id]]);
	const bookingId = detail.card.record!.id;
	const [booking] = await db.owner<{ title: string; kind: string; status: string; equipmentId: string; startsAt: Date; endsAt: Date; setupMinutes: number; cleanupMinutes: number;
		occupiedStartsAt: Date; occupiedEndsAt: Date; ownerId: string; taskId: string | null; createdBy: string; revision: number }[]>`select title, kind, status, equipment_id, starts_at,
		ends_at, setup_minutes, cleanup_minutes, occupied_starts_at, occupied_ends_at, owner_id, task_id, created_by, revision from equipment_reservations where id = ${bookingId}`;
	assert.deepEqual({ ...booking, startsAt: booking!.startsAt.toISOString(), endsAt: booking!.endsAt.toISOString(), occupiedStartsAt: booking!.occupiedStartsAt.toISOString(),
		occupiedEndsAt: booking!.occupiedEndsAt.toISOString() }, { title: 'Brew the autumn lager on the kettle', kind: 'booking', status: 'confirmed', equipmentId: kettle.id,
		startsAt: '2031-10-13T22:00:00.000Z', endsAt: '2031-10-14T02:00:00.000Z', setupMinutes: 30, cleanupMinutes: 45, occupiedStartsAt: '2031-10-13T21:30:00.000Z',
		occupiedEndsAt: '2031-10-14T02:45:00.000Z', ownerId: b.member.user.id, taskId: null, createdBy: b.owner.user.id, revision: 1 });
	assert.equal(await count('select count(*) as n from threads where organisation_id = $1', b.org), threadsBefore, 'no second thread');
	assert.equal(await count('select count(*) as n from threads where reservation_id = $1', bookingId), 1, 'the booking has exactly one thread');
	const after = await b.messages(b.member, topic.id);
	assert.deepEqual(after.slice(0, before.length).map(m => m.body), before.map(m => m.body), 'the messages stay where they are');
	assert.deepEqual(after.slice(before.length).map(m => [m.kind, m.changeSetId]), [['change', changeSetId]], 'the creation is a change line in this thread');
	assert.deepEqual(after.at(-1)!.change!.changes.filter(c => c.field === null).map(c => [c.recordKind, c.operation]), [['reservation', 'create']]);
	// Journalled as the booking's creation: its history starts there and the creation is not reversible.
	const history = await b.history(b.member, 'reservation', bookingId);
	assert.deepEqual(history.changeSets.map(set => set.id), [changeSetId]);
	assert.deepEqual([history.changeSets[0]!.changes[0]!.operation, history.changeSets[0]!.changes[0]!.reason], ['create', 'record_created']);
	assert.deepEqual([history.start?.kind, history.start?.changeSetId], ['created', changeSetId]);
	// It occupies the schedule like any booking, with the thread's tags.
	const range = await json<{ reservations: { id: string; tagIds: string[] }[] }>(request('GET',
		`${b.base}/equipment/${kettle.id}/reservations?from=${encodeURIComponent('2031-10-13T00:00:00Z')}&to=${encodeURIComponent('2031-10-15T00:00:00Z')}`, b.member));
	assert.deepEqual(range.reservations.map(r => [r.id, r.tagIds]), [[bookingId, [tag.id]]]);
	const card = await json<Detail>(request('GET', `${b.base}/threads/${topic.id}`, b.member));
	assert.equal(card.card.fold.equipmentName, 'Brew kettle');

	// The retry rule: the same id and body answers the same; the same id for anything else is refused; a new request is
	// refused because the thread is now a record's, as making it a task is.
	const retried = await b.makeBooking(b.owner, topic.id, body);
	const again = await json<Detail>(retried);
	assert.deepEqual([again.thread.kind, again.card.record?.id, retried.headers.get(changeSetHeader)], ['record', bookingId, changeSetId]);
	assert.equal(await code(b.makeBooking(b.owner, topic.id, { ...body, setupMinutes: 0 }), 409), 'change_set_id_unavailable');
	assert.equal(await code(b.makeBooking(b.member, topic.id, body), 409), 'change_set_id_unavailable', 'another person cannot reuse the id');
	assert.equal(await code(b.makeBooking(b.owner, topic.id, { ...body, changeSetId: randomUUID(), expectedRevision: 3 }), 409), 'thread_is_record');
	assert.equal(await code(request('POST', `${b.base}/threads/${topic.id}/task`, b.owner, { expectedRevision: 3 }), 409), 'thread_is_record');
	assert.equal(await count('select count(*) as n from equipment_reservations where organisation_id = $1', b.org), 1);
	assert.equal(await count('select count(*) as n from tasks where organisation_id = $1', b.org), 0);
	// A topic still becomes a task as before (0048 keeps working beside 0049).
	const other = await b.topic(b.member, 'Order pallet wrap');
	const task = await json<Detail>(request('POST', `${b.base}/threads/${other.id}/task`, b.owner, { expectedRevision: 1 }));
	assert.deepEqual([task.thread.kind, task.card.record?.kind], ['record', 'task']);
	assert.equal(await code(b.makeBooking(b.owner, other.id, { expectedRevision: 2, equipmentId: kettle.id, ...slot, startsAt: '2031-11-01T09:00:00Z', endsAt: '2031-11-01T10:00:00Z' }), 409),
		'thread_is_record', 'a task’s thread never becomes a booking’s');
});

it('an overlap is refused with the booking’s own 409 and nothing written; the unused id then makes the booking at a free time', async () => {
	const b = await business('Overlap');
	const tank = await b.equipment(b.owner, { name: 'Fermenter 2' });
	const held = await json<{ id: string }>(request('POST', `${b.base}/equipment/${tank.id}/reservations`, b.owner,
		{ id: randomUUID(), title: 'Pale ale ferment', startsAt: '2031-10-14T00:00:00Z', endsAt: '2031-10-14T02:00:00Z' }), 201);
	const topic = await b.topic(b.member, 'Dry hop the IPA');
	const changesBefore = await count('select count(*) as n from record_changes where organisation_id = $1', b.org);
	const setsBefore = await count('select count(*) as n from change_sets where organisation_id = $1', b.org);
	const changeSetId = randomUUID();
	// Touching is fine (half-open ranges); 15 minutes of cleanup reaching into the held slot is not.
	const body = { expectedRevision: 1, changeSetId, equipmentId: tank.id, startsAt: '2031-10-13T22:00:00Z', endsAt: '2031-10-13T23:50:00Z', cleanupMinutes: 15 };
	const refused = await json<{ code: string; error: string }>(b.makeBooking(b.member, topic.id, body), 409);
	assert.equal(refused.code, 'reservation_conflict');
	assert.ok(!refused.error.includes('Pale ale'), 'the refusal names nothing; the client reads the holder from the schedule');
	assert.equal(await count('select count(*) as n from equipment_reservations where organisation_id = $1', b.org), 1, 'no booking');
	assert.deepEqual(await b.threadRow(topic.id), { kind: 'topic', reservationId: null, revision: 1, title: 'Dry hop the IPA' }, 'the thread is unchanged');
	assert.equal(await count('select count(*) as n from record_changes where organisation_id = $1', b.org), changesBefore, 'no journal');
	assert.equal(await count('select count(*) as n from change_sets where organisation_id = $1', b.org), setsBefore, 'no change set kept');
	assert.equal((await b.messages(b.member, topic.id)).filter(m => m.kind === 'change').length, 0, 'no change line');
	const made = await b.makeBooking(b.member, topic.id, { ...body, endsAt: '2031-10-13T23:45:00Z' });
	assert.equal((await json<Detail>(made)).card.record?.kind, 'booking');
	assert.equal(made.headers.get(changeSetHeader), changeSetId, 'the refused attempt stored nothing beside it, so its id was free');
	assert.equal(await count('select count(*) as n from equipment_reservations where organisation_id = $1 and status = $2', b.org, 'confirmed'), 2);
	void held;
});

it('topic to booking refuses private threads, stale revisions, inactive owners, archived or unknown equipment, bad times and strangers', async () => {
	const b = await business('Refusals');
	const line = await b.equipment(b.owner, { name: 'Canning line' });
	const old = await b.equipment(b.owner, { name: 'Old kettle' });
	await json(request('PATCH', `${b.base}/equipment/${old.id}`, b.owner, { expectedRevision: 1, archived: true }));
	const valid = { equipmentId: line.id, startsAt: '2031-12-01T09:00:00Z', endsAt: '2031-12-01T11:00:00Z' };
	const secret = (await json<{ thread: { id: string } }>(request('POST', `${b.base}/threads`, b.owner, { id: randomUUID(), kind: 'private', title: 'Margins', participantIds: [] }), 201)).thread.id;
	const refusedPrivate = await json<{ code: string; error: string }>(b.makeBooking(b.owner, secret, { expectedRevision: 1, ...valid }), 400);
	assert.deepEqual([refusedPrivate.code, refusedPrivate.error], ['thread_not_topic', 'Only a topic becomes a booking. A private thread stays private.']);
	assert.equal((await b.makeBooking(b.member, secret, { expectedRevision: 1, ...valid })).status, 404, 'a private thread is invisible to others');
	const topic = await b.topic(b.member, 'Can the summer lager');
	assert.equal(await code(b.makeBooking(b.owner, topic.id, { expectedRevision: 2, ...valid }), 409), 'stale_revision');
	assert.equal(await code(b.makeBooking(b.owner, topic.id, { expectedRevision: 1, ...valid, ownerId: randomUUID() }), 400), 'owner_invalid');
	assert.equal(await code(b.makeBooking(b.owner, topic.id, { expectedRevision: 1, ...valid, equipmentId: old.id }), 409), 'equipment_archived');
	assert.equal((await b.makeBooking(b.owner, topic.id, { expectedRevision: 1, ...valid, equipmentId: randomUUID() })).status, 404);
	for (const bad of [{ endsAt: valid.startsAt }, { endsAt: '2033-01-01T09:00:00Z' }, { startsAt: '2031-12-01 09:00' }, { setupMinutes: -1 }, { cleanupMinutes: 10081 },
		{ equipmentId: undefined }, { title: 'Not allowed' }, { kind: 'maintenance' }, { tagIds: [] }])
		assert.equal(await code(b.makeBooking(b.owner, topic.id, { expectedRevision: 1, ...valid, ...bad }), 400), 'invalid_request', JSON.stringify(bad));
	const stranger = await business('Strangers');
	assert.equal((await b.makeBooking(stranger.owner, topic.id, { expectedRevision: 1, ...valid })).status, 404);
	const theirs = await stranger.equipment(stranger.owner, { name: 'Their kettle' });
	assert.equal((await b.makeBooking(b.owner, topic.id, { expectedRevision: 1, ...valid, equipmentId: theirs.id })).status, 404, 'another tenant’s equipment is unknown here');
	assert.equal(await count('select count(*) as n from equipment_reservations where organisation_id = $1', b.org), 0, 'none of those made a booking');
	assert.equal((await b.threadRow(topic.id)).kind, 'topic');
	// A removed member can no longer make it a booking; the database refuses a direct call without the API too.
	await db.owner`update memberships set status = 'removed' where organisation_id = ${b.org} and user_id = ${b.member.user.id}`;
	assert.equal((await b.makeBooking(b.member, topic.id, { expectedRevision: 1, ...valid })).status, 404);
});

it('equipment writes are journalled, revision-checked and retry-safe with the client’s change set id', async () => {
	const b = await business('Equipment writes');
	const createId = randomUUID();
	const made = await request('POST', `${b.base}/equipment`, b.member, { name: 'Bright tank', changeSetId: createId });
	const tank = await json<Equipment>(made, 201);
	assert.deepEqual([tank.changeSetId, made.headers.get(changeSetHeader), tank.revision], [createId, createId, 1]);
	const replay = await json<Equipment>(request('POST', `${b.base}/equipment`, b.member, { name: 'Bright tank', changeSetId: createId }), 201);
	assert.deepEqual([replay.id, replay.changeSetId], [tank.id, createId], 'a retry answers with the equipment it made');
	assert.equal(await code(request('POST', `${b.base}/equipment`, b.member, { name: 'Brite tank', changeSetId: createId }), 409), 'change_set_id_unavailable');
	assert.equal(await count('select count(*) as n from equipment where organisation_id = $1', b.org), 1);
	const renameId = randomUUID();
	const renamed = await json<Equipment>(request('PATCH', `${b.base}/equipment/${tank.id}`, b.owner, { expectedRevision: 1, name: 'Bright tank 1', changeSetId: renameId }));
	assert.deepEqual([renamed.name, renamed.revision, renamed.changeSetId], ['Bright tank 1', 2, renameId]);
	assert.equal((await json<Equipment>(request('PATCH', `${b.base}/equipment/${tank.id}`, b.owner, { expectedRevision: 1, name: 'Bright tank 1', changeSetId: renameId }))).revision, 2,
		'a retry of the rename answers with the equipment as it is now');
	assert.equal(await code(request('PATCH', `${b.base}/equipment/${tank.id}`, b.member, { expectedRevision: 1, name: 'Stale' }), 409), 'stale_revision');
	const archiveId = randomUUID();
	const archived = await json<Equipment>(request('PATCH', `${b.base}/equipment/${tank.id}`, b.member, { expectedRevision: 2, archived: true, changeSetId: archiveId }));
	assert.ok(archived.archivedAt);
	// Archived equipment refuses new bookings, by either route, and leaves the active list.
	assert.equal(await code(request('POST', `${b.base}/equipment/${tank.id}/reservations`, b.member,
		{ id: randomUUID(), title: 'Carbonate', startsAt: '2031-12-02T09:00:00Z', endsAt: '2031-12-02T10:00:00Z' }), 409), 'equipment_archived');
	const topic = await b.topic(b.member, 'Carbonate the lager');
	assert.equal(await code(b.makeBooking(b.member, topic.id, { expectedRevision: 1, equipmentId: tank.id, startsAt: '2031-12-02T09:00:00Z', endsAt: '2031-12-02T10:00:00Z' }), 409),
		'equipment_archived');
	assert.ok(!(await json<{ equipment: { id: string }[] }>(request('GET', `${b.base}/equipment`, b.member))).equipment.some(e => e.id === tank.id));
	const unarchiveId = randomUUID();
	await json(request('PATCH', `${b.base}/equipment/${tank.id}`, b.owner, { expectedRevision: 3, archived: false, changeSetId: unarchiveId }));
	const history = await b.history(b.member, 'equipment', tank.id);
	assert.deepEqual(history.changeSets.map(set => set.id), [unarchiveId, archiveId, renameId, createId], 'one change set per write, newest first');
	assert.deepEqual(history.changeSets.slice(0, 3).map(set => set.changes.map(c => c.field)), [['archivedAt'], ['archivedAt'], ['name']]);
	const booked = await json<Detail>(b.makeBooking(b.member, topic.id, { expectedRevision: 1, equipmentId: tank.id, startsAt: '2031-12-02T09:00:00Z', endsAt: '2031-12-02T10:00:00Z' }));
	assert.equal(booked.card.record?.kind, 'booking', 'restored equipment takes bookings again');
});
