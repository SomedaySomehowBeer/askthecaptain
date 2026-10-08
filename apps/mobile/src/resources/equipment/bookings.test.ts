import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bookingThread, newBookingForm, newBookingHref, newBookingPlan, newBookingWrite, readPrefill, schedulePrefill } from './new-booking.ts';
import { equipmentNameProblem, equipmentWrites, parseEquipmentList, parseEquipmentWrite, parseManagedEquipment } from './manage.ts';
import { makeBookingBody, parseMadeBooking } from '../../threads/cards/make-booking.ts';
import { createSaver } from '../../threads/cards/saver.ts';
import type { Result } from '../../threads/api.ts';

// H2 B-B (bookings contract §3): the schedule's prefill, the new-booking form and write, the Equipment screen's parsers
// and writes, and "Make this a booking". Pure: no React Native, no network.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { epoch: 'e', userId: id(1), organisationId: id(2) };
const zone = 'Australia/Sydney';
const columns = [{ id: id(10), name: 'Canning line' }, { id: id(11), name: 'Fermenter 2' }, { id: id(12), name: 'Bright tank' }];

test('the schedule prefills the equipment column and the day in view, falling back to the first and today', () => {
	const now = Date.parse('2026-10-08T02:00:00.000Z'); // Thu 8 Oct, 1 pm in Sydney
	assert.deepEqual(schedulePrefill({ columns, settled: null, zone, now }), { equipment: id(10), day: '2026-10-08' }, 'nothing settled: the first and today');
	// Scrolled one column across and down at the Days scale: the first day mostly in view. With 7 am on the 11th at the
	// top that is the 11th; with 10 pm on the 10th at the top (two hours of it showing) it is the 11th too.
	const low = Date.parse('2026-10-10T20:00:00.000Z'), high = low + 5 * 86_400_000;
	assert.deepEqual(schedulePrefill({ columns, settled: { x: 130, width: 390, columnWidth: 130, low, high }, zone, now }), { equipment: id(11), day: '2026-10-11' });
	const late = Date.parse('2026-10-10T11:00:00.000Z');
	assert.deepEqual(schedulePrefill({ columns, settled: { x: 0, width: 390, columnWidth: 130, low: late, high: late + 5 * 86_400_000 }, zone, now }), { equipment: id(10), day: '2026-10-11' });
	// At the Hours scale (less than a day in view) the middle of the view; past the last column, the last.
	assert.deepEqual(schedulePrefill({ columns, settled: { x: 999, width: 390, columnWidth: 130, low: Date.parse('2026-10-11T12:00:00.000Z'), high: Date.parse('2026-10-11T14:00:00.000Z') }, zone, now }),
		{ equipment: id(12), day: '2026-10-12' }, '11 pm to 1 am in Sydney: the middle is midnight, so the 12th');
	assert.deepEqual(schedulePrefill({ columns: [], settled: null, zone: null, now }), { equipment: null, day: null });
	assert.equal(newBookingHref({ equipment: id(11), day: '2026-10-11' }), `/equipment/new?equipment=${id(11)}&day=2026-10-11`);
	assert.equal(newBookingHref({ equipment: null, day: null }), '/equipment/new');
	assert.equal(newBookingHref({ equipment: 'not-a-uuid', day: '2026-02-30' }), '/equipment/new', 'nothing unreadable goes into the link');
});

test('the form reads its link strictly: unknown equipment or an unreal day falls back and says so', () => {
	assert.deepEqual(readPrefill({ equipment: id(11), day: '2026-10-11' }, columns, '2026-10-08'), { equipmentId: id(11), date: '2026-10-11', notes: [] });
	assert.deepEqual(readPrefill({}, columns, '2026-10-08'), { equipmentId: id(10), date: '2026-10-08', notes: [] }, 'nothing prefilled is fine');
	assert.deepEqual(readPrefill({ equipment: id(99), day: '2026-02-30' }, columns, '2026-10-08'), { equipmentId: id(10), date: '2026-10-08', notes: ['equipment', 'day'] });
	assert.deepEqual(readPrefill({ equipment: [id(11), id(12)], day: ['2026-10-11'] }, columns, '2026-10-08'), { equipmentId: id(10), date: '2026-10-08', notes: ['equipment', 'day'] }, 'repeated parameters are not read');
	assert.deepEqual(readPrefill({ equipment: 'Canning line' }, columns, '2026-10-08').notes, ['equipment'], 'only ids');
	assert.deepEqual(readPrefill({ equipment: id(11) }, [], '2026-10-08'), { equipmentId: null, date: '2026-10-08', notes: ['equipment'] });
});

test('a new booking plan is the booking card’s, as kind booking with no task or owner, and its write is retry-safe', () => {
	const form = { ...newBookingForm('2026-10-08'), title: '  Can the summer lager ', start: '08:00', end: '12:00', setup: 30, cleanup: 30 };
	assert.deepEqual(newBookingForm('2026-10-08'), { title: '', date: '2026-10-08', start: '09:00', endDate: '2026-10-08', end: '10:00', setup: 0, cleanup: 0 });
	assert.deepEqual(newBookingPlan({ ...form, title: ' ' }, zone, false), { error: 'A booking needs a title.' });
	assert.deepEqual(newBookingPlan({ ...form, end: '07:00' }, zone, false), { error: 'The end must be after the start on the same day.' });
	assert.deepEqual(newBookingPlan({ ...form, endDate: '2026-10-09', end: '07:00' }, zone, true).hasOwnProperty('time'), true, 'a booking may end on another day');
	const plan = newBookingPlan(form, zone, false);
	assert.ok('time' in plan);
	assert.deepEqual(plan, { time: { title: 'Can the summer lager', kind: 'booking', startsAt: '2026-10-07T21:00:00.000Z', endsAt: '2026-10-08T01:00:00.000Z', setupMinutes: 30, cleanupMinutes: 30, taskId: null, ownerId: null },
		occupiedFrom: '2026-10-07T20:30:00.000Z', occupiedTo: '2026-10-08T01:30:00.000Z' });
	const w = newBookingWrite(scope, id(10), id(500), id(900), plan.time);
	assert.equal(w.method, 'POST'); assert.equal(w.path, `/v1/organisations/${id(2)}/equipment/${id(10)}/reservations`);
	assert.deepEqual(w.body, { id: id(500), changeSetId: id(900), title: 'Can the summer lager', kind: 'booking', startsAt: plan.time.startsAt, endsAt: plan.time.endsAt, setupMinutes: 30,
		cleanupMinutes: 30, taskId: null, ownerId: null, tagIds: [] });
	const answer = { id: id(500), equipmentId: id(10), title: 'Can the summer lager', kind: 'booking', status: 'confirmed', startsAt: plan.time.startsAt, endsAt: plan.time.endsAt, setupMinutes: 30,
		cleanupMinutes: 30, occupiedStartsAt: plan.occupiedFrom, occupiedEndsAt: plan.occupiedTo, taskId: null, ownerId: null, createdBy: id(1), revision: 1, createdAt: plan.occupiedFrom,
		updatedAt: plan.occupiedFrom, tagIds: [], changeSetId: id(900) };
	assert.equal(w.parse(answer).id, id(500));
	for (const wrong of [{ id: id(501) }, { changeSetId: id(901) }, { equipmentId: id(11) }, { extra: true }]) assert.throws(() => w.parse({ ...answer, ...wrong }), TypeError, JSON.stringify(wrong));
});

test('the new booking’s thread is found in the Bookings list by its record, or not at all', () => {
	const row = (thread: number, kind: 'booking' | 'task', record: number) => ({ id: id(thread), kind: 'record' as const, title: 'x', record: { kind, id: id(record) }, facts: ['', ''] as [string, string], status: null,
		lastMessageAt: null, lastMessage: null, unread: 0, needsYou: false, starred: false, tags: [] });
	assert.equal(bookingThread({ threads: [row(20, 'task', 500), row(21, 'booking', 501), row(22, 'booking', 500)] }, id(500)), id(22));
	assert.equal(bookingThread({ threads: [row(21, 'booking', 501)] }, id(500)), null);
});

test('the Equipment screen’s parsers are strict and its writes carry the revision and the change set id', () => {
	const row = (n: number, archivedAt: string | null = null, extra = {}) => ({ id: id(n), name: `Tank ${n}`, archivedAt, revision: 2, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', ...extra });
	const list = parseEquipmentList({ equipment: [row(10), row(11)], nextOffset: null }, false);
	assert.deepEqual([list.archived, list.more, list.equipment.map((e) => e.name)], [false, false, ['Tank 10', 'Tank 11']]);
	assert.equal(parseEquipmentList({ equipment: [row(10, '2026-10-03T00:00:00.000Z')], nextOffset: null }, true).equipment[0]!.archivedAt, '2026-10-03T00:00:00.000Z');
	for (const bad of [{ equipment: [row(10, '2026-10-03T00:00:00.000Z')], nextOffset: null }, { equipment: [row(10), row(10)], nextOffset: null }, { equipment: [row(10)], nextOffset: 100 },
		{ equipment: [row(10, null, { shared: true })], nextOffset: null }, { equipment: [{ ...row(10), name: ' Tank ' }], nextOffset: null }, { equipment: [] }])
		assert.throws(() => parseEquipmentList(bad, false), TypeError, JSON.stringify(bad));
	const item = parseManagedEquipment(row(10));
	const rename = equipmentWrites.rename(scope, item, id(900), '  Bright tank 1 ');
	assert.deepEqual([rename.method, rename.path, rename.body], ['PATCH', `/v1/organisations/${id(2)}/equipment/${id(10)}`, { changeSetId: id(900), expectedRevision: 2, name: 'Bright tank 1' }]);
	assert.equal(rename.parse({ ...row(10), name: 'Bright tank 1', revision: 3, changeSetId: id(900) }).revision, 3);
	assert.throws(() => rename.parse({ ...row(10), name: 'Tank 10', revision: 3, changeSetId: id(900) }), TypeError, 'the name asked for');
	const archive = equipmentWrites.archive(scope, item, id(901), true);
	assert.deepEqual(archive.body, { changeSetId: id(901), expectedRevision: 2, archived: true });
	assert.throws(() => archive.parse({ ...row(10), changeSetId: id(901) }), TypeError, 'still active');
	assert.deepEqual(equipmentWrites.archive(scope, item, id(902), false).body, { changeSetId: id(902), expectedRevision: 2, archived: false });
	const add = equipmentWrites.add(scope, id(903), ' Fermenter 3 ');
	assert.deepEqual([add.method, add.path, add.body], ['POST', `/v1/organisations/${id(2)}/equipment`, { changeSetId: id(903), name: 'Fermenter 3' }]);
	assert.throws(() => parseEquipmentWrite({ ...row(12), name: 'Fermenter 3', changeSetId: id(904) }, { changeSetId: id(903) }), TypeError, 'the change set sent');
	assert.deepEqual([equipmentNameProblem(''), equipmentNameProblem('   '), equipmentNameProblem('x'.repeat(101)), equipmentNameProblem(' Kettle ')],
		['Enter a name for the equipment.', 'Enter a name for the equipment.', 'A name is at most 100 characters.', null]);
});

test('make this a booking: the body carries the revision, equipment and time; the answer must be this thread on a booking', () => {
	assert.deepEqual(makeBookingBody(id(900), 3, id(10), { startsAt: '2026-10-07T21:00:00.000Z', endsAt: '2026-10-08T01:00:00.000Z', setupMinutes: 30, cleanupMinutes: 0 }),
		{ changeSetId: id(900), expectedRevision: 3, equipmentId: id(10), startsAt: '2026-10-07T21:00:00.000Z', endsAt: '2026-10-08T01:00:00.000Z', setupMinutes: 30, cleanupMinutes: 0 });
	const detail = (kind: string, record: unknown) => ({ thread: { id: id(30), kind, title: 'Brew day', revision: 4, lastSeq: 2, lastChange: 2, readPosition: 2, unread: 0, starred: false, createdAt: '2026-10-01T00:00:00.000Z' },
		card: { record, title: 'Brew day', status: kind === 'topic' ? null : 'confirmed', facts: ['Kettle', '2026-10-07T21:00:00Z'], fold: (record as { kind?: string } | null)?.kind === 'booking'
			? { equipmentId: id(10), equipmentName: 'Kettle', kind: 'booking', status: 'confirmed', startsAt: '2026-10-07T21:00:00.000Z', endsAt: '2026-10-08T01:00:00.000Z', setupMinutes: 30, cleanupMinutes: 0,
				taskId: null, ownerId: null, ownerName: null, open: { kind: 'equipment', equipmentId: id(10) } }
			: (record as { kind?: string } | null)?.kind === 'task' ? { body: '', status: 'open', ownerId: null, ownerName: null, due: null, evidenceRequired: false, seriesId: null, open: null } : { createdBy: id(1), open: null } },
		tags: [], pin: null });
	assert.equal(parseMadeBooking(detail('record', { kind: 'booking', id: id(500) }), id(30)).card.record?.id, id(500));
	assert.throws(() => parseMadeBooking(detail('record', { kind: 'task', id: id(500) }), id(30)), TypeError);
	assert.throws(() => parseMadeBooking(detail('topic', null), id(30)), TypeError);
	assert.throws(() => parseMadeBooking(detail('record', { kind: 'booking', id: id(500) }), id(31)), TypeError);
});

test('a screen’s own refusal words come first; an overlap keeps the form for another try with a new change set id', async () => {
	let n = 0; const sent: unknown[] = [];
	const answers: Result<string>[] = [{ kind: 'error', status: 409, code: 'reservation_conflict', retryAfter: 0, uncertain: false }, { kind: 'ok', value: 'made' }];
	const saver = createSaver<string>({ now: () => 0, randomId: () => id(900 + ++n), saved: () => {}, reload: () => {}, lost: () => {},
		copy: { saving: 'Making…', saved: 'Made.', confirmed: 'Confirmed.', refusals: { reservation_conflict: 'Booked then. Nothing was made; choose another time.' } } });
	const save = () => saver.save((changeSetId) => { const body = { changeSetId }; return { body, send: async () => { sent.push(body); return answers.shift()!; } }; });
	await save();
	assert.deepEqual([saver.snapshot().message, saver.snapshot().refusal, saver.snapshot().uncertain], ['Booked then. Nothing was made; choose another time.', 'reservation_conflict', false]);
	await save();
	assert.deepEqual(sent, [{ changeSetId: id(901) }, { changeSetId: id(902) }], 'a refused write left nothing; the next try is a new change');
	assert.equal(saver.snapshot().message, 'Made.');
});
