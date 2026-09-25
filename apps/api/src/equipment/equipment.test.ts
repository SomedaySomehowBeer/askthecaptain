import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { withTenant } from '@captain/db';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import type { IdentityProvider } from '../auth/google.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { OrganisationLifecycle } from '../organisations/lifecycle.ts';
import { RateLimiter } from '../ratelimit.ts';

// Equipment scheduling (D24): the database, not the client, prevents overlapping confirmed
// occupancy. Every case below runs against a real, freshly migrated Postgres.
const it = databaseUrl ? test : test.skip;
let db: Harness, app: ReturnType<typeof createApp>;
type Person = { token: string; user: { id: string } };
type Equipment = { id: string; name: string; archivedAt: string | null; revision: number; createdAt: string; updatedAt: string };
type Reservation = { id: string; equipmentId: string; title: string; kind: 'booking' | 'maintenance'; status: 'confirmed' | 'cancelled';
	startsAt: string; endsAt: string; setupMinutes: number; cleanupMinutes: number; occupiedStartsAt: string; occupiedEndsAt: string;
	projectId: string | null; taskId: string | null; ownerId: string | null; createdBy: string; revision: number; createdAt: string; updatedAt: string };
type Range = { reservations: Reservation[]; nextOffset: number | null; coverage: 'complete' | 'partial'; from: string; to: string; timezone: string };
type Failure = { code: string; error: string };
let owner: Person, member: Person, outsider: Person, org: string, otherOrg: string, project: string, task: string;
const google: IdentityProvider & { next: { subject: string; email: string; name: string } } = {
	next: { subject: 'owner', email: 'owner@example.test', name: 'Owner' },
	authorizationUrl: ({ state }) => `https://google.test/auth?state=${state}`, async exchange() { return google.next; },
};
/** The stored revision, for requests that are not testing staleness. */
const rev = async (table: 'tasks' | 'projects' | 'task_series', id: string) => Number((await db.owner.unsafe(`select revision from ${table} where id = $1`, [id]))[0]!.revision);
const request = (method: string, path: string, person?: Person, data?: unknown) => app.request(path, { method,
	headers: { 'content-type': 'application/json', ...(person ? { authorization: `Bearer ${person.token}` } : {}) },
	body: data === undefined ? undefined : JSON.stringify(data) });
async function json<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
	const value = await response; assert.equal(value.status, status, await value.clone().text()); return value.json() as Promise<T>;
}
async function signIn(subject: string): Promise<Person> {
	google.next = { subject, email: `${subject}@example.test`, name: subject };
	const start = await app.request('/auth/google/start');
	const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
	const callback = await app.request(`/auth/google/callback?code=abc&state=${state}`);
	const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
	return json(request('POST', '/auth/session/exchange', undefined, { code }));
}
const base = (organisation = org) => `/v1/organisations/${organisation}`;
const makeEquipment = (name: string, person = member, organisation = org) =>
	json<Equipment>(request('POST', `${base(organisation)}/equipment`, person, { name }), 201);
const reservations = (equipmentId: string, organisation = org) => `${base(organisation)}/equipment/${equipmentId}/reservations`;
const book = (equipmentId: string, body: Record<string, unknown>, person = member, organisation = org) =>
	request('POST', reservations(equipmentId, organisation), person, { id: randomUUID(), title: 'Brew day', ...body });
const edit = (r: Reservation, change: Record<string, unknown>, person = member) =>
	request('PATCH', `${reservations(r.equipmentId)}/${r.id}`, person, { expectedRevision: r.revision, title: r.title, kind: r.kind,
		startsAt: r.startsAt, endsAt: r.endsAt, setupMinutes: r.setupMinutes, cleanupMinutes: r.cleanupMinutes,
		projectId: r.projectId, taskId: r.taskId, ownerId: r.ownerId, ...change });
const cancel = (r: Pick<Reservation, 'id' | 'equipmentId'>, expectedRevision: number, person = member) =>
	request('POST', `${reservations(r.equipmentId)}/${r.id}/cancel`, person, { expectedRevision });
const range = (equipmentId: string, from: string, to: string, extra = '') =>
	request('GET', `${reservations(equipmentId)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${extra}`, member);
const audits = (subjectId: string) => db.owner<{ action: string }[]>`select action from audit_events where subject_id = ${subjectId} order by created_at, id`;
const stored = (id: string) => db.owner`select title, starts_at, ends_at, status, revision from equipment_reservations where id = ${id}`;
const setMembership = (userId: string, status: 'active' | 'removed') =>
	db.owner`update memberships set status = ${status} where organisation_id = ${org} and user_id = ${userId}`;

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	// A clock that moves a whole window per hit keeps the per-IP limit out of these tests; the
	// limiter itself is tested elsewhere.
	let now = 0;
	app = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 }),
		organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), rateLimiter: new RateLimiter(() => (now += 120_000)) });
	owner = await signIn('equipment-owner'); member = await signIn('equipment-member'); outsider = await signIn('equipment-outsider');
	org = (await json<{ id: string }>(request('POST', '/v1/organisations', owner, { name: 'Brewery' }), 201)).id;
	otherOrg = (await json<{ id: string }>(request('POST', '/v1/organisations', outsider, { name: 'Other business' }), 201)).id;
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${member.user.id}, 'member')`;
	project = (await json<{ id: string }>(request('POST', `${base()}/projects`, owner, { name: 'Autumn lager' }), 201)).id;
	task = (await json<{ id: string }>(request('POST', `${base()}/tasks`, owner, { title: 'Brew the lager', projectId: project }), 201)).id;
});
after(async () => { await db?.close(); });

it('equipment is shared, named once per tenant, revision-checked, archived only when idle, and audited', async () => {
	const kettle = await makeEquipment('  Kettle  ');
	assert.equal(kettle.name, 'Kettle'); assert.equal(kettle.revision, 1); assert.equal(kettle.archivedAt, null);
	for (const name of ['kettle', 'KETTLE ']) assert.equal((await json<Failure>(request('POST', `${base()}/equipment`, member, { name }), 409)).code, 'equipment_name_exists');
	for (const body of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(101) }, { name: 'Fermenter', shared: false }, {}])
		assert.equal((await request('POST', `${base()}/equipment`, member, body)).status, 400, JSON.stringify(body));
	const racing = await Promise.all([request('POST', `${base()}/equipment`, member, { name: 'Canning line' }), request('POST', `${base()}/equipment`, owner, { name: 'canning LINE' })]);
	assert.deepEqual(racing.map(r => r.status).sort(), [201, 409]);

	const renamed = await json<Equipment>(request('PATCH', `${base()}/equipment/${kettle.id}`, owner, { expectedRevision: 1, name: 'Brew kettle' }));
	assert.equal(renamed.revision, 2); assert.equal(renamed.name, 'Brew kettle');
	assert.equal((await json<Failure>(request('PATCH', `${base()}/equipment/${kettle.id}`, member, { expectedRevision: 1, name: 'Stale' }), 409)).code, 'stale_revision');
	assert.equal((await request('PATCH', `${base()}/equipment/${kettle.id}`, member, { expectedRevision: 2 })).status, 400, 'a patch must change something');

	// A booking that has already ended does not keep equipment in use; a future one does.
	await json<Reservation>(book(kettle.id, { startsAt: '2020-01-01T00:00:00Z', endsAt: '2020-01-01T02:00:00Z' }), 201);
	const future = await json<Reservation>(book(kettle.id, { startsAt: '2031-01-01T00:00:00Z', endsAt: '2031-01-01T02:00:00Z' }), 201);
	assert.equal((await json<Failure>(request('PATCH', `${base()}/equipment/${kettle.id}`, member, { expectedRevision: 2, archived: true }), 409)).code, 'equipment_in_use');
	await json(cancel(future, 1));
	const archived = await json<Equipment>(request('PATCH', `${base()}/equipment/${kettle.id}`, member, { expectedRevision: 2, archived: true }));
	assert.ok(archived.archivedAt); assert.equal(archived.revision, 3);
	assert.equal((await json<Failure>(book(kettle.id, { startsAt: '2031-02-01T00:00:00Z', endsAt: '2031-02-01T01:00:00Z' }), 409)).code, 'equipment_archived', 'archived equipment takes no new bookings');
	const active = await json<{ equipment: Equipment[] }>(request('GET', `${base()}/equipment`, member));
	const shelved = await json<{ equipment: Equipment[] }>(request('GET', `${base()}/equipment?archived=true`, member));
	assert.ok(!active.equipment.some(e => e.id === kettle.id)); assert.ok(shelved.equipment.some(e => e.id === kettle.id));
	assert.equal((await json<Equipment>(request('GET', `${base()}/equipment/${kettle.id}`, member))).archivedAt, archived.archivedAt);
	assert.equal((await json<Failure>(request('POST', `${base()}/equipment`, member, { name: 'brew KETTLE' }), 409)).code, 'equipment_name_exists', 'archived names stay reserved');
	const reopened = await json<Equipment>(request('PATCH', `${base()}/equipment/${kettle.id}`, member, { expectedRevision: 3, archived: false }));
	assert.equal(reopened.archivedAt, null);
	assert.deepEqual((await audits(kettle.id)).map(a => a.action), ['equipment.created', 'equipment.updated', 'equipment.updated', 'equipment.updated']);
	const page = await json<{ equipment: Equipment[]; nextOffset: number | null }>(request('GET', `${base()}/equipment?limit=1`, member));
	assert.equal(page.equipment.length, 1); assert.equal(page.nextOffset, 1);
	for (const query of ['limit=0', 'limit=101', 'offset=-1', 'archived=maybe']) assert.equal((await request('GET', `${base()}/equipment?${query}`, member)).status, 400, query);
});

it('concurrent overlapping bookings: exactly one is confirmed and the refusal names nothing', async () => {
	const tank = await makeEquipment('Fermenter 1');
	const slot = { startsAt: '2030-03-02T01:00:00Z', endsAt: '2030-03-02T05:00:00Z' };
	const titles = ['Secret collab brew A', 'Secret collab brew B', 'Secret collab brew C', 'Secret collab brew D', 'Secret collab brew E'];
	const results = await Promise.all(titles.map((title, i) => book(tank.id, { ...slot, title, startsAt: `2030-03-02T0${1 + (i % 2)}:00:00Z` })));
	assert.deepEqual(results.map(r => r.status).sort(), [201, 409, 409, 409, 409]);
	const winner = await results.find(r => r.status === 201)!.json() as Reservation;
	for (const refused of results.filter(r => r.status === 409)) {
		const body = await refused.json() as Failure; assert.equal(body.code, 'reservation_conflict');
		const text = JSON.stringify(body);
		assert.ok(!text.includes(winner.id) && !text.includes(winner.title), 'a conflict never reveals the competing booking');
	}
	const rows = await db.owner`select count(*)::int as n from equipment_reservations where equipment_id = ${tank.id} and status = 'confirmed'`;
	assert.equal(rows[0]!.n, 1);
	assert.equal((await db.owner`select count(*)::int as n from audit_events where action = 'equipment.reservation_created' and subject_id in (select id::text from equipment_reservations where equipment_id = ${tank.id})`)[0]!.n, 1);
});

it('setup, cleanup and maintenance occupy time; half-open ranges let back-to-back work touch', async () => {
	const line = await makeEquipment('Canning line 2');
	const first = await json<Reservation>(book(line.id, { startsAt: '2030-04-01T10:00:00Z', endsAt: '2030-04-01T11:00:00Z', setupMinutes: 15, cleanupMinutes: 30 }), 201);
	assert.equal(first.kind, 'booking'); assert.equal(first.status, 'confirmed'); assert.equal(first.revision, 1);
	assert.equal(first.occupiedStartsAt, '2030-04-01T09:45:00.000Z'); assert.equal(first.occupiedEndsAt, '2030-04-01T11:30:00.000Z');
	assert.equal(first.projectId, null); assert.equal(first.taskId, null); assert.equal(first.ownerId, null); assert.equal(first.createdBy, member.user.id);
	// Maintenance is exclusive too, and its own buffers count.
	assert.equal((await book(line.id, { kind: 'maintenance', title: 'CIP', startsAt: '2030-04-01T11:29:00Z', endsAt: '2030-04-01T12:00:00Z' })).status, 409, 'inside cleanup');
	assert.equal((await book(line.id, { kind: 'maintenance', title: 'CIP', startsAt: '2030-04-01T11:40:00Z', endsAt: '2030-04-01T12:00:00Z', setupMinutes: 11 })).status, 409, 'setup reaches back into cleanup');
	const cip = await json<Reservation>(book(line.id, { kind: 'maintenance', title: 'CIP', startsAt: '2030-04-01T11:30:00Z', endsAt: '2030-04-01T12:00:00Z' }), 201);
	assert.equal(cip.kind, 'maintenance');
	const before = await json<Reservation>(book(line.id, { startsAt: '2030-04-01T09:00:00Z', endsAt: '2030-04-01T09:30:00Z', cleanupMinutes: 15 }), 201);
	assert.equal(before.occupiedEndsAt, first.occupiedStartsAt, 'touching at the boundary is not overlap');
	// Another piece of equipment is independent.
	const other = await makeEquipment('Canning line 3');
	await json(book(other.id, { startsAt: '2030-04-01T10:00:00Z', endsAt: '2030-04-01T11:00:00Z' }), 201);
});

it('the database refuses overlapping or inconsistent rows even when a caller bypasses the service', async () => {
	const tank = await makeEquipment('Bright tank');
	const held = await json<Reservation>(book(tank.id, { startsAt: '2030-05-01T00:00:00Z', endsAt: '2030-05-01T04:00:00Z' }), 201);
	const insert = (starts: string, ends: string, occupiedStarts: string, occupiedEnds: string, status = 'confirmed') =>
		withTenant(db.app, { organisationId: org, userId: member.user.id }, tx => tx`insert into equipment_reservations
			(id, organisation_id, equipment_id, title, kind, status, starts_at, ends_at, setup_minutes, cleanup_minutes, occupied_starts_at, occupied_ends_at, created_by)
			values (${randomUUID()}, ${org}, ${tank.id}, 'Direct', 'booking', ${status}, ${starts}, ${ends}, 0, 0, ${occupiedStarts}, ${occupiedEnds}, ${member.user.id})`);
	await assert.rejects(insert('2030-05-01T03:00:00Z', '2030-05-01T05:00:00Z', '2030-05-01T03:00:00Z', '2030-05-01T05:00:00Z'), (e: { code?: string }) => e.code === '23P01');
	await assert.rejects(insert('2030-06-01T03:00:00Z', '2030-06-01T05:00:00Z', '2030-06-01T02:00:00Z', '2030-06-01T05:00:00Z'), (e: { code?: string }) => e.code === '23514', 'occupied range must equal actual ± buffers');
	await assert.rejects(insert('2030-06-02T05:00:00Z', '2030-06-02T05:00:00Z', '2030-06-02T05:00:00Z', '2030-06-02T05:00:00Z'), (e: { code?: string }) => e.code === '23514', 'empty duration');
	// A cancelled row does not occupy the slot, so the exclusion applies to confirmed rows only.
	await insert('2030-05-01T03:00:00Z', '2030-05-01T05:00:00Z', '2030-05-01T03:00:00Z', '2030-05-01T05:00:00Z', 'cancelled');
	assert.equal((await stored(held.id))[0]!.status, 'confirmed');
});

it('replaying a create with the same client id returns the original once; any other payload is refused', async () => {
	const tank = await makeEquipment('Fermenter 2');
	const id = randomUUID();
	const body = { id, title: 'Pilsner', startsAt: '2030-07-01T08:00:00+08:00', endsAt: '2030-07-01T12:00:00+08:00' };
	const created = await json<Reservation>(request('POST', reservations(tank.id), member, body), 201);
	assert.equal(created.startsAt, '2030-07-01T00:00:00.000Z');
	// The same instants written another way, and defaults spelled out, are the same request.
	const replay = await json<Reservation>(request('POST', reservations(tank.id), member,
		{ ...body, startsAt: '2030-07-01T00:00:00Z', endsAt: '2030-07-01T04:00:00.000Z', kind: 'booking', setupMinutes: 0, cleanupMinutes: 0, projectId: null, taskId: null, ownerId: null }), 200);
	assert.deepEqual(replay, created);
	assert.deepEqual((await audits(id)).map(a => a.action), ['equipment.reservation_created']);
	for (const change of [{ title: 'Lager' }, { endsAt: '2030-07-01T05:00:00Z' }, { setupMinutes: 5 }])
		assert.equal((await json<Failure>(request('POST', reservations(tank.id), member, { ...body, ...change }), 409)).code, 'reservation_id_exists');
	assert.equal((await json<Failure>(request('POST', reservations(tank.id), owner, body), 409)).code, 'reservation_id_exists', 'another creator is not a replay');
	// A cancelled booking is no longer replayable, and a future booking keeps its equipment from being archived.
	const archivable = await makeEquipment('Fermenter 3');
	const later = { id: randomUUID(), title: 'Ale', startsAt: '2030-08-01T00:00:00Z', endsAt: '2030-08-01T01:00:00Z' };
	const booked = await json<Reservation>(request('POST', reservations(archivable.id), member, later), 201);
	await json(request('PATCH', `${base()}/equipment/${archivable.id}`, member, { expectedRevision: 1, archived: true }), 409);
	const cancelled = await json<Reservation>(cancel(booked, 1));
	assert.equal((await json<Failure>(request('POST', reservations(archivable.id), member, later), 409)).code, 'reservation_id_exists', 'a cancelled id is not replayable');
	assert.equal(cancelled.status, 'cancelled');
	// A revised booking is no longer the original request either.
	const revised = await json<Reservation>(edit(created, { title: 'Pilsner v2' }));
	assert.equal((await json<Failure>(request('POST', reservations(tank.id), member, body), 409)).code, 'reservation_id_exists');
	assert.equal(revised.revision, 2);
	// The same id in another tenant is refused without saying whose it is.
	const foreignEquipment = await makeEquipment('Their kettle', outsider, otherOrg);
	const foreign = await request('POST', reservations(foreignEquipment.id, otherOrg), outsider, { ...body, startsAt: '2030-09-01T00:00:00Z', endsAt: '2030-09-01T01:00:00Z' });
	assert.equal(foreign.status, 409); const text = await foreign.text();
	assert.ok(!text.includes('Pilsner') && !text.includes(tank.id) && !text.includes(org), text);
});

it('an archived resource still answers a replay of a booking made before archiving, when that booking has ended', async () => {
	const kettle = await makeEquipment('Old kettle');
	const past = { id: randomUUID(), title: 'Last brew', startsAt: '2021-03-01T00:00:00Z', endsAt: '2021-03-01T03:00:00Z' };
	const created = await json<Reservation>(request('POST', reservations(kettle.id), member, past), 201);
	await json(request('PATCH', `${base()}/equipment/${kettle.id}`, member, { expectedRevision: 1, archived: true }));
	assert.deepEqual(await json<Reservation>(request('POST', reservations(kettle.id), member, past), 200), created);
	assert.deepEqual((await audits(past.id)).map(a => a.action), ['equipment.reservation_created']);
});

it('edits are revision-checked and atomic: a conflicting or stale edit leaves the original untouched', async () => {
	const tank = await makeEquipment('Fermenter 4');
	const a = await json<Reservation>(book(tank.id, { title: 'A', startsAt: '2030-10-01T00:00:00Z', endsAt: '2030-10-01T02:00:00Z' }), 201);
	const b = await json<Reservation>(book(tank.id, { title: 'B', startsAt: '2030-10-01T03:00:00Z', endsAt: '2030-10-01T05:00:00Z' }), 201);
	const original = await stored(b.id);
	const conflict = await json<Failure>(edit(b, { startsAt: '2030-10-01T01:00:00Z' }), 409);
	assert.equal(conflict.code, 'reservation_conflict'); assert.ok(!JSON.stringify(conflict).includes(a.id) && !JSON.stringify(conflict).includes('"A"'));
	assert.equal((await json<Failure>(edit(b, { cleanupMinutes: 10, endsAt: '2030-10-01T05:00:00Z', startsAt: '2030-10-01T02:05:00Z', setupMinutes: 10 }), 409)).code, 'reservation_conflict', 'setup buffer overlaps A');
	assert.deepEqual(await stored(b.id), original);
	assert.deepEqual((await audits(b.id)).map(x => x.action), ['equipment.reservation_created']);
	// Moving within its own occupied time does not conflict with itself.
	const moved = await json<Reservation>(edit(b, { startsAt: '2030-10-01T02:30:00Z', endsAt: '2030-10-01T04:30:00Z', title: 'B moved' }));
	assert.equal(moved.revision, 2); assert.equal(moved.title, 'B moved'); assert.equal(moved.id, b.id);
	assert.equal((await json<Failure>(edit(b, { title: 'Stale' }), 409)).code, 'stale_revision');
	// Two edits from the same revision: exactly one wins, the other is stale.
	const racing = await Promise.all([edit(moved, { title: 'First' }), edit(moved, { title: 'Second' })]);
	assert.deepEqual(racing.map(r => r.status).sort(), [200, 409]);
	const current = (await stored(b.id))[0]!;
	assert.equal(current.revision, 3); assert.ok(['First', 'Second'].includes(current.title));
	assert.deepEqual((await audits(b.id)).map(x => x.action), ['equipment.reservation_created', 'equipment.reservation_updated', 'equipment.reservation_updated']);
	// A reservation cannot move to other equipment by being edited through another resource's path.
	const elsewhere = await makeEquipment('Fermenter 5');
	assert.equal((await request('PATCH', `${reservations(elsewhere.id)}/${a.id}`, member,
		{ expectedRevision: 1, title: 'A', kind: 'booking', startsAt: a.startsAt, endsAt: a.endsAt, setupMinutes: 0, cleanupMinutes: 0, projectId: null, taskId: null, ownerId: null })).status, 404);
	assert.equal((await stored(a.id))[0]!.revision, 1);
});

it('cancelling frees the slot at once, retries safely at the current revision, and refuses stale or edited-after-cancel writes', async () => {
	const tank = await makeEquipment('Fermenter 6');
	const slot = { startsAt: '2030-11-01T00:00:00Z', endsAt: '2030-11-01T02:00:00Z' };
	const first = await json<Reservation>(book(tank.id, slot), 201);
	const cancelled = await json<Reservation>(cancel(first, 1));
	assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.revision, 2);
	assert.deepEqual(await json<Reservation>(cancel(first, 2)), cancelled, 'retry at the now-current revision is a no-op');
	assert.equal((await json<Failure>(cancel(first, 1), 409)).code, 'stale_revision');
	assert.deepEqual((await audits(first.id)).map(a => a.action), ['equipment.reservation_created', 'equipment.reservation_cancelled']);
	const rebooked = await json<Reservation>(book(tank.id, slot), 201);
	assert.equal(rebooked.status, 'confirmed');
	assert.equal((await json<Failure>(edit(cancelled, { title: 'Revived' }), 409)).code, 'reservation_cancelled', 'a cancelled booking cannot be edited back into the slot');
	assert.equal((await stored(first.id))[0]!.status, 'cancelled');
});

it('links must be eligible work in this tenant; owners must be active members', async () => {
	const tank = await makeEquipment('Fermenter 7');
	let hour = 0;
	const slot = () => { hour += 2; const at = new Date(Date.UTC(2030, 11, 1, hour)); return { startsAt: at.toISOString(), endsAt: new Date(at.getTime() + 3_600_000).toISOString() }; };
	const linked = await json<Reservation>(book(tank.id, { ...slot(), projectId: project, taskId: task, ownerId: member.user.id }), 201);
	assert.equal(linked.projectId, project); assert.equal(linked.taskId, task); assert.equal(linked.ownerId, member.user.id);
	assert.equal((await book(tank.id, { ...slot(), projectId: project })).status, 201, 'a project alone is enough');
	assert.equal((await book(tank.id, { ...slot(), taskId: task })).status, 404, "a task's project must be named with it");
	// A standalone task links with no project, and not with one it does not belong to (D7).
	const standalone = (await json<{ id: string; projectId: string | null }>(request('POST', `${base()}/tasks`, owner, { title: 'Clean the tank' }), 201));
	assert.equal(standalone.projectId, null);
	const loose = await json<Reservation>(book(tank.id, { ...slot(), taskId: standalone.id }), 201);
	assert.deepEqual([loose.projectId, loose.taskId], [null, standalone.id]);
	assert.equal((await book(tank.id, { ...slot(), projectId: project, taskId: standalone.id })).status, 404, 'a standalone task is not in that project');
	const otherProject = (await json<{ id: string }>(request('POST', `${base()}/projects`, owner, { name: 'Winter stout' }), 201)).id;
	const step = (await json<{ id: string }>(request('POST', `${base()}/tasks`, owner, { title: 'Mill grain', parentId: task, expectedParentRevision: await rev('tasks', task) }), 201)).id;
	const cancelledTask = (await json<{ id: string }>(request('POST', `${base()}/tasks`, owner, { title: 'Dropped', projectId: project, status: 'cancelled' }), 201)).id;
	const archivedProject = (await json<{ id: string }>(request('POST', `${base()}/projects`, owner, { name: 'Retired' }), 201)).id;
	await json(request('PATCH', `${base()}/projects/${archivedProject}`, owner, { expectedRevision: await rev('projects', archivedProject), archived: true }));
	const foreignProject = (await json<{ id: string }>(request('POST', `${base(otherOrg)}/projects`, outsider, { name: 'Theirs' }), 201)).id;
	for (const links of [{ projectId: otherProject, taskId: task }, { projectId: project, taskId: step }, { projectId: project, taskId: cancelledTask },
		{ projectId: archivedProject }, { projectId: foreignProject }, { projectId: randomUUID() }, { ownerId: outsider.user.id }, { ownerId: randomUUID() }])
		assert.equal((await book(tank.id, { ...slot(), ...links })).status, 404, JSON.stringify(links));
	for (const links of [{ projectId: 'nope' }, { ownerId: 42 }, { kind: 'party' }, { setupMinutes: -1 }, { cleanupMinutes: 10081 }, { setupMinutes: 1.5 }])
		assert.equal((await book(tank.id, { ...slot(), ...links })).status, 400, JSON.stringify(links));
	// A removed owner blocks new bookings for them but not cancelling existing ones.
	await setMembership(member.user.id, 'removed');
	try {
		assert.equal((await book(tank.id, { ...slot(), ownerId: member.user.id }, owner)).status, 404);
		assert.equal((await book(tank.id, slot(), member)).status, 404, 'a removed member cannot book');
		assert.equal((await request('GET', `${base()}/equipment/${tank.id}`, member)).status, 404);
		assert.equal((await json<Reservation>(cancel(linked, 1, owner))).status, 'cancelled');
	} finally { await setMembership(member.user.id, 'active'); }
});

it('timestamps must be explicit instants in bounds, with a positive duration of at most 366 days', async () => {
	const tank = await makeEquipment('Fermenter 8');
	for (const times of [
		{ startsAt: '2030-12-01T00:00:00', endsAt: '2030-12-01T01:00:00' },
		{ startsAt: '2030-12-01', endsAt: '2030-12-02' },
		{ startsAt: 'tomorrow', endsAt: '2030-12-01T01:00:00Z' },
		{ startsAt: '2030-12-01T01:00:00Z', endsAt: '2030-12-01T01:00:00Z' },
		{ startsAt: '2030-12-01T02:00:00Z', endsAt: '2030-12-01T01:00:00Z' },
		{ startsAt: '2030-01-01T00:00:00Z', endsAt: '2031-01-02T00:00:01Z' },
		{ startsAt: '1899-12-31T23:00:00Z', endsAt: '1900-01-01T01:00:00Z' },
		{ startsAt: '2200-12-31T00:00:00Z', endsAt: '2201-01-01T01:00:00Z' },
		{ startsAt: 1_900_000_000_000, endsAt: 1_900_000_360_000 }
	]) assert.equal((await book(tank.id, times)).status, 400, JSON.stringify(times));
	assert.equal((await book(tank.id, { startsAt: '2030-01-01T00:00:00Z', endsAt: '2031-01-02T00:00:00Z' })).status, 201, 'exactly 366 days');
});

it('bookings across a daylight-saving change keep their real duration', async () => {
	await db.owner`update organisations set timezone = 'Australia/Sydney' where id = ${org}`;
	try {
		const tank = await makeEquipment('Fermenter 9');
		// Sydney moves from +10:00 to +11:00 at 02:00 local on 4 October 2026: 01:30 to 03:30 local is one hour.
		const across = await json<Reservation>(book(tank.id, { startsAt: '2026-10-04T01:30:00+10:00', endsAt: '2026-10-04T03:30:00+11:00' }), 201);
		assert.equal(across.startsAt, '2026-10-03T15:30:00.000Z'); assert.equal(across.endsAt, '2026-10-03T16:30:00.000Z');
		assert.equal((await book(tank.id, { startsAt: '2026-10-04T03:30:00+11:00', endsAt: '2026-10-04T04:00:00+11:00' })).status, 201, 'adjacent after the change');
		assert.equal((await book(tank.id, { startsAt: '2026-10-04T01:00:00+10:00', endsAt: '2026-10-04T01:31:00+10:00' })).status, 409);
		const view = await json<Range>(range(tank.id, '2026-10-03T13:00:00Z', '2026-10-04T13:00:00Z'));
		assert.equal(view.timezone, 'Australia/Sydney'); assert.equal(view.reservations.length, 2);
	} finally { await db.owner`update organisations set timezone = 'Australia/Perth' where id = ${org}`; }
});

it('range reads return confirmed occupancy overlapping [from, to), say when coverage is partial, and accept no other filters', async () => {
	const tank = await makeEquipment('Fermenter 10');
	const early = await json<Reservation>(book(tank.id, { title: 'Early', startsAt: '2031-03-01T10:00:00Z', endsAt: '2031-03-01T11:00:00Z', cleanupMinutes: 60 }), 201);
	const maintenance = await json<Reservation>(book(tank.id, { kind: 'maintenance', title: 'Service', startsAt: '2031-03-01T13:00:00Z', endsAt: '2031-03-01T14:00:00Z' }), 201);
	const dropped = await json<Reservation>(book(tank.id, { title: 'Dropped', startsAt: '2031-03-01T15:00:00Z', endsAt: '2031-03-01T16:00:00Z' }), 201);
	await json(cancel(dropped, 1));
	// Only cleanup reaches into the window: it still counts.
	const cleanupOnly = await json<Range>(range(tank.id, '2031-03-01T11:30:00Z', '2031-03-01T12:00:00Z'));
	assert.deepEqual(cleanupOnly.reservations.map(r => r.id), [early.id]); assert.equal(cleanupOnly.coverage, 'complete');
	// Occupied time ending exactly at `from`, or starting exactly at `to`, is outside.
	assert.deepEqual((await json<Range>(range(tank.id, '2031-03-01T12:00:00Z', '2031-03-01T13:00:00Z'))).reservations, []);
	const all = await json<Range>(range(tank.id, '2031-03-01T00:00:00+08:00', '2031-03-02T00:00:00Z'));
	assert.deepEqual(all.reservations.map(r => r.id), [early.id, maintenance.id], 'cancelled bookings are not occupancy');
	assert.equal(all.from, '2031-02-28T16:00:00.000Z'); assert.equal(all.timezone, 'Australia/Perth');
	const first = await json<Range>(range(tank.id, '2031-03-01T00:00:00Z', '2031-03-02T00:00:00Z', '&limit=1'));
	assert.equal(first.reservations.length, 1); assert.equal(first.coverage, 'partial'); assert.equal(first.nextOffset, 1);
	const second = await json<Range>(range(tank.id, '2031-03-01T00:00:00Z', '2031-03-02T00:00:00Z', '&limit=1&offset=1'));
	assert.equal(second.reservations.length, 1); assert.equal(second.coverage, 'partial', 'a later page never claims the whole range'); assert.equal(second.nextOffset, null);
	for (const extra of ['&projectId=' + project, '&ownerId=' + member.user.id, '&tagId=' + randomUUID(), '&limit=201', '&limit=0', '&offset=-1'])
		assert.equal((await range(tank.id, '2031-03-01T00:00:00Z', '2031-03-02T00:00:00Z', extra)).status, 400, extra);
	const windows: [string, string][] = [['2031-03-01T00:00:00Z', '2031-03-01T00:00:00Z'], ['2031-03-02T00:00:00Z', '2031-03-01T00:00:00Z'],
		['2031-01-01T00:00:00Z', '2031-04-04T00:00:01Z'], ['2031-03-01T00:00:00', '2031-03-02T00:00:00Z']];
	for (const [from, to] of windows)
		assert.equal((await range(tank.id, from, to)).status, 400, `${from}..${to}`);
	assert.equal((await request('GET', reservations(tank.id), member)).status, 400, 'a range is required');
	assert.equal((await range(tank.id, '2031-01-01T00:00:00Z', '2031-04-04T00:00:00Z')).status, 200, 'exactly 93 days');
});

it('other tenants, unauthenticated people and removed members see and change nothing, through the API or directly', async () => {
	const tank = await makeEquipment('Fermenter 11');
	const booking = await json<Reservation>(book(tank.id, { startsAt: '2031-05-01T00:00:00Z', endsAt: '2031-05-01T01:00:00Z' }), 201);
	assert.equal((await request('GET', `${base()}/equipment`)).status, 401);
	for (const [method, path, body] of [['GET', `${base()}/equipment`, undefined], ['GET', `${base()}/equipment/${tank.id}`, undefined],
		['PATCH', `${base()}/equipment/${tank.id}`, { expectedRevision: 1, name: 'Mine now' }],
		['GET', `${reservations(tank.id)}?from=2031-05-01T00:00:00Z&to=2031-05-02T00:00:00Z`, undefined],
		['POST', reservations(tank.id), { id: randomUUID(), title: 'Intrusion', startsAt: '2031-05-02T00:00:00Z', endsAt: '2031-05-02T01:00:00Z' }],
		['POST', `${reservations(tank.id)}/${booking.id}/cancel`, { expectedRevision: 1 }]] as const)
		assert.equal((await request(method, path, outsider, body)).status, 404, `${method} ${path}`);
	// Their own tenant's path with our equipment id finds nothing either.
	assert.equal((await request('GET', `${base(otherOrg)}/equipment/${tank.id}`, outsider)).status, 404);
	assert.equal((await book(tank.id, { startsAt: '2031-05-03T00:00:00Z', endsAt: '2031-05-03T01:00:00Z' }, outsider, otherOrg)).status, 404);
	const visible = await withTenant(db.app, { organisationId: org, userId: outsider.user.id }, tx => tx`select id from equipment_reservations union all select id from equipment`);
	assert.equal(visible.length, 0, 'row security hides another tenant from a non-member');
	// A foreign-tenant link cannot be written directly: keys carry the tenant.
	const theirs = await makeEquipment('Their tank', outsider, otherOrg);
	await assert.rejects(withTenant(db.app, { organisationId: org, userId: member.user.id }, tx => tx`insert into equipment_reservations
		(id, organisation_id, equipment_id, title, kind, status, starts_at, ends_at, setup_minutes, cleanup_minutes, occupied_starts_at, occupied_ends_at, created_by)
		values (${randomUUID()}, ${org}, ${theirs.id}, 'Cross', 'booking', 'confirmed', '2031-06-01T00:00:00Z', '2031-06-01T01:00:00Z', 0, 0, '2031-06-01T00:00:00Z', '2031-06-01T01:00:00Z', ${member.user.id})`),
		(e: { code?: string }) => e.code === '23503');
	await setMembership(member.user.id, 'removed');
	try {
		assert.equal((await request('GET', `${base()}/equipment`, member)).status, 404);
		const hidden = await withTenant(db.app, { organisationId: org, userId: member.user.id }, tx => tx`select id from equipment_reservations`);
		assert.equal(hidden.length, 0, 'a removed member reads nothing directly');
	} finally { await setMembership(member.user.id, 'active'); }
	assert.equal((await stored(booking.id))[0]!.status, 'confirmed');
});

it('archiving and booking the same resource at once never leave a future booking on archived equipment', async () => {
	for (let round = 0; round < 3; round++) {
		const tank = await makeEquipment(`Race tank ${round}`);
		const [archive, booking] = await Promise.all([
			request('PATCH', `${base()}/equipment/${tank.id}`, member, { expectedRevision: 1, archived: true }),
			book(tank.id, { startsAt: '2032-01-01T00:00:00Z', endsAt: '2032-01-01T01:00:00Z' })
		]);
		assert.ok(!(archive.status === 200 && booking.status === 201), `round ${round}: both succeeded`);
		const state = await db.owner`select e.archived_at, (select count(*)::int from equipment_reservations r where r.equipment_id = e.id and r.status = 'confirmed' and r.occupied_ends_at > now()) as future
			from equipment e where e.id = ${tank.id}`;
		assert.ok(!(state[0]!.archivedAt && state[0]!.future > 0), `round ${round}: archived with a future booking`);
	}
});

it('a booking and its audit event commit together or not at all', async () => {
	const tank = await makeEquipment('Fermenter 12');
	await db.owner.unsafe(`create function fail_equipment_audit() returns trigger language plpgsql as $$ begin
		if new.action like 'equipment.reservation_%' then raise exception 'audit refused'; end if; return new; end $$;
		create trigger fail_equipment_audit before insert on audit_events for each row execute function fail_equipment_audit()`);
	const id = randomUUID();
	try {
		const failed = await request('POST', reservations(tank.id), member, { id, title: 'Unaudited', startsAt: '2031-07-01T00:00:00Z', endsAt: '2031-07-01T01:00:00Z' });
		assert.equal(failed.status, 500);
		assert.equal((await stored(id)).length, 0, 'no booking without its audit');
	} finally { await db.owner.unsafe('drop trigger fail_equipment_audit on audit_events; drop function fail_equipment_audit()'); }
	assert.equal((await request('POST', reservations(tank.id), member, { id, title: 'Unaudited', startsAt: '2031-07-01T00:00:00Z', endsAt: '2031-07-01T01:00:00Z' })).status, 201, 'the slot and id are still free');
});

const directInsert = (tx: Parameters<Parameters<typeof withTenant>[2]>[0], equipmentId: string, createdBy: string, starts: string, ends: string) => tx`insert into equipment_reservations
	(id, organisation_id, equipment_id, title, kind, status, starts_at, ends_at, setup_minutes, cleanup_minutes, occupied_starts_at, occupied_ends_at, created_by)
	values (${randomUUID()}, ${org}, ${equipmentId}, 'Direct', 'booking', 'confirmed', ${starts}, ${ends}, 0, 0, ${starts}, ${ends}, ${createdBy})`;
const rlsDenied = (e: { code?: string }) => e.code === '42501';

it('row security refuses direct writes by outsiders, removed members and forged creators on both tables', async () => {
	const tank = await makeEquipment('Fermenter 13');
	const booking = await json<Reservation>(book(tank.id, { startsAt: '2031-09-01T00:00:00Z', endsAt: '2031-09-01T01:00:00Z' }), 201);
	const as = (userId: string) => <T>(work: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) => withTenant(db.app, { organisationId: org, userId }, work);
	await assert.rejects(as(outsider.user.id)(tx => tx`insert into equipment (organisation_id, name) values (${org}, 'Outsider tank')`), rlsDenied);
	await assert.rejects(as(outsider.user.id)(tx => directInsert(tx, tank.id, outsider.user.id, '2031-09-02T00:00:00Z', '2031-09-02T01:00:00Z')), (e: { code?: string }) => ['42501', '23503'].includes(e.code!));
	assert.equal((await as(outsider.user.id)(tx => tx`update equipment set name = 'Taken' where id = ${tank.id}`)).count, 0);
	assert.equal((await as(outsider.user.id)(tx => tx`update equipment_reservations set status = 'cancelled' where id = ${booking.id}`)).count, 0);
	// A member cannot write a booking in someone else's name.
	await assert.rejects(as(member.user.id)(tx => directInsert(tx, tank.id, owner.user.id, '2031-09-03T00:00:00Z', '2031-09-03T01:00:00Z')), rlsDenied);
	await setMembership(member.user.id, 'removed');
	try {
		await assert.rejects(as(member.user.id)(tx => tx`insert into equipment (organisation_id, name) values (${org}, 'Removed tank')`), rlsDenied);
		await assert.rejects(as(member.user.id)(tx => directInsert(tx, tank.id, member.user.id, '2031-09-04T00:00:00Z', '2031-09-04T01:00:00Z')), rlsDenied);
		assert.equal((await as(member.user.id)(tx => tx`update equipment set name = 'Gone' where id = ${tank.id}`)).count, 0);
		assert.equal((await as(member.user.id)(tx => tx`update equipment_reservations set title = 'Gone' where id = ${booking.id}`)).count, 0);
	} finally { await setMembership(member.user.id, 'active'); }
	assert.equal((await db.owner`select name from equipment where id = ${tank.id}`)[0]!.name, 'Fermenter 13');
	assert.deepEqual((await stored(booking.id))[0]!.status, 'confirmed');
});

it('two direct transactions inserting overlapping occupancy at once: the constraint lets exactly one commit', async () => {
	const tank = await makeEquipment('Fermenter 14');
	const attempt = (starts: string, ends: string) => withTenant(db.app, { organisationId: org, userId: member.user.id }, async tx => {
		await directInsert(tx, tank.id, member.user.id, starts, ends);
		await tx`select pg_sleep(0.3)`; // hold the uncommitted row while the other transaction arrives
	});
	const results = await Promise.allSettled([attempt('2031-10-01T00:00:00Z', '2031-10-01T02:00:00Z'), attempt('2031-10-01T01:00:00Z', '2031-10-01T03:00:00Z')]);
	assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
	const refused = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
	assert.equal((refused.reason as { code?: string }).code, '23P01');
	assert.equal((await db.owner`select count(*)::int as n from equipment_reservations where equipment_id = ${tank.id}`)[0]!.n, 1);
});

it('the same client id sent twice at once creates one booking and one audit event', async () => {
	const tank = await makeEquipment('Fermenter 15');
	const body = { id: randomUUID(), title: 'Double tap', startsAt: '2031-11-01T00:00:00Z', endsAt: '2031-11-01T01:00:00Z' };
	const results = await Promise.all([request('POST', reservations(tank.id), member, body), request('POST', reservations(tank.id), member, body)]);
	assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
	const [a, b] = await Promise.all(results.map(r => r.json() as Promise<Reservation>));
	assert.deepEqual(a, b);
	assert.deepEqual((await audits(body.id)).map(x => x.action), ['equipment.reservation_created']);
});

it('bookings keep occupying the equipment after their project is archived or task cancelled', async () => {
	const tank = await makeEquipment('Fermenter 16');
	const launch = (await json<{ id: string }>(request('POST', `${base()}/projects`, owner, { name: 'Spring bock' }), 201)).id;
	const step = (await json<{ id: string }>(request('POST', `${base()}/tasks`, owner, { title: 'Brew the bock', projectId: launch }), 201)).id;
	const linked = await json<Reservation>(book(tank.id, { startsAt: '2031-12-01T00:00:00Z', endsAt: '2031-12-01T04:00:00Z', projectId: launch, taskId: step }), 201);
	await json(request('PATCH', `${base()}/tasks/${step}`, owner, { expectedRevision: await rev('tasks', step), status: 'cancelled' }));
	await json(request('PATCH', `${base()}/projects/${launch}`, owner, { expectedRevision: await rev('projects', launch), archived: true }));
	const view = await json<Range>(range(tank.id, '2031-12-01T00:00:00Z', '2031-12-02T00:00:00Z'));
	assert.deepEqual(view.reservations.map(r => r.id), [linked.id], 'archived work still holds the slot');
	assert.equal((await book(tank.id, { startsAt: '2031-12-01T01:00:00Z', endsAt: '2031-12-01T02:00:00Z' })).status, 409);
	// Changing it now means clearing the ineligible links; cancelling needs nothing.
	assert.equal((await edit(linked, { title: 'Renamed' })).status, 404);
	assert.equal((await json<Reservation>(edit(linked, { title: 'Renamed', projectId: null, taskId: null }))).revision, 2);
	for (const startsAt of ['2031-12-01T00:00:00', 'soon']) assert.equal((await edit({ ...linked, revision: 2, projectId: null, taskId: null }, { startsAt })).status, 400, startsAt);
	assert.equal((await stored(linked.id))[0]!.revision, 2);
});

it('a single reservation reads back, cancelled or not, only through its own equipment and tenant', async () => {
	const tank = await makeEquipment('Fermenter 17');
	const other = await makeEquipment('Fermenter 18');
	const booking = await json<Reservation>(book(tank.id, { startsAt: '2032-02-01T00:00:00Z', endsAt: '2032-02-01T01:00:00Z' }), 201);
	const path = `${reservations(tank.id)}/${booking.id}`;
	assert.deepEqual(await json<Reservation>(request('GET', path, member)), booking);
	const cancelled = await json<Reservation>(cancel(booking, 1));
	const read = await json<Reservation>(request('GET', path, owner));
	assert.equal(read.status, 'cancelled'); assert.equal(read.revision, cancelled.revision, 'a client can reconcile an uncertain cancel');
	assert.equal((await request('GET', `${reservations(other.id)}/${booking.id}`, member)).status, 404, 'wrong equipment');
	assert.equal((await request('GET', `${reservations(tank.id)}/${randomUUID()}`, member)).status, 404);
	assert.equal((await request('GET', path, outsider)).status, 404);
	assert.equal((await request('GET', `${reservations(tank.id, otherOrg)}/${booking.id}`, outsider)).status, 404);
	assert.equal((await request('GET', path)).status, 401);
	assert.equal((await request('GET', `${reservations(tank.id)}/not-an-id`, member)).status, 400);
});

it('equipment tables appear in the organisation export and go with a deleted organisation', async () => {
	const lifecycle = new OrganisationLifecycle(db.app);
	const lines: { table?: string; row?: { organisationId: string } }[] = [];
	for await (const line of lifecycle.export({ userId: owner.user.id, requestId: 'equipment-export' }, org)) lines.push(JSON.parse(line));
	for (const table of ['equipment', 'equipment_reservations']) {
		assert.ok(lines.some(l => l.table === table), table);
		assert.ok(lines.filter(l => l.table === table).every(l => l.row!.organisationId === org));
	}
	// Delete only this test's second tenant.
	const theirs = await makeEquipment('Cascade tank', outsider, otherOrg);
	await json(book(theirs.id, { startsAt: '2031-08-01T00:00:00Z', endsAt: '2031-08-01T01:00:00Z' }, outsider, otherOrg), 201);
	await lifecycle.delete({ userId: outsider.user.id, email: 'equipment-outsider@example.test', requestId: 'equipment-delete' }, otherOrg, 'Other business');
	assert.equal((await db.owner`select * from equipment where organisation_id = ${otherOrg}`).length, 0);
	assert.equal((await db.owner`select * from equipment_reservations where organisation_id = ${otherOrg}`).length, 0);
});

it('a linked task that changes project takes its confirmed reservations with it, with a new revision; history stays', async () => {
	const vessel = await makeEquipment('Bright tank 3');
	const autumn = (await json<{ id: string }>(request('POST', `${base()}/projects`, owner, { name: 'Autumn release' }), 201)).id;
	const winter = (await json<{ id: string }>(request('POST', `${base()}/projects`, owner, { name: 'Winter release' }), 201)).id;
	const moving = (await json<{ id: string }>(request('POST', `${base()}/tasks`, owner, { title: 'Carbonate the release', projectId: autumn }), 201)).id;
	const live = await json<Reservation>(book(vessel.id, { startsAt: '2032-03-01T00:00:00Z', endsAt: '2032-03-01T04:00:00Z', projectId: autumn, taskId: moving }), 201);
	const past = await json<Reservation>(book(vessel.id, { startsAt: '2032-03-02T00:00:00Z', endsAt: '2032-03-02T04:00:00Z', projectId: autumn, taskId: moving }), 201);
	await json(cancel(past, past.revision));
	const read = async (id: string) => (await db.owner<{ projectId: string | null; taskId: string | null; revision: number }[]>`select project_id, task_id, revision from equipment_reservations where id = ${id}`)[0]!;

	// Out of any project: the reservation keeps its task and now names no project either.
	await json(request('PATCH', `${base()}/tasks/${moving}`, owner, { expectedRevision: await rev('tasks', moving), projectId: null }));
	assert.deepEqual(await read(live.id), { projectId: null, taskId: moving, revision: live.revision + 1 });
	assert.deepEqual(await read(past.id), { projectId: autumn, taskId: moving, revision: past.revision + 1 }, 'a cancelled reservation keeps its history (only its cancellation moved the revision)');
	const [followed] = await db.owner`select actor_kind, detail from audit_events where subject_id = ${live.id} and action = 'equipment.reservation_updated' order by created_at desc limit 1`;
	assert.equal(followed!.actorKind, 'person');
	assert.deepEqual((followed!.detail as { cause: string; before: unknown; after: unknown }).before, { projectId: autumn });

	// A client still holding the old revision cannot write the old project back.
	assert.equal((await json<Failure>(edit(live, { title: 'Stale' }), 409)).code, 'stale_revision');
	const current = { ...live, projectId: null, revision: live.revision + 1 };
	assert.equal((await json<Reservation>(edit(current, { title: 'Carbonate' }))).projectId, null);

	// Into another project: it follows again; an edit that names the task's old project is refused.
	await json(request('PATCH', `${base()}/tasks/${moving}`, owner, { expectedRevision: await rev('tasks', moving), projectId: winter }));
	const now = await read(live.id);
	assert.equal(now.projectId, winter);
	assert.equal((await edit({ ...current, revision: now.revision }, { projectId: null })).status, 404, "the reservation must name its task's project");
	// Other fields only: no reservation moves, no revision bump.
	await json(request('PATCH', `${base()}/tasks/${moving}`, owner, { expectedRevision: await rev('tasks', moving), title: 'Carbonate the winter release' }));
	assert.equal((await read(live.id)).revision, now.revision);
});
