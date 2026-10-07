import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Result } from '../api.ts';
import { createSaver, saveCopy } from './saver.ts';
import { bookingChanged, bookingControls, bookingForm, bookingPlan, bookingStart, instantIn, refusedForGood, minuteChoices, occupancyWords, taskChanges, taskForm, validCount, validTaskForm } from './forms.ts';
import { parseBooking, parseCount, parseTaskDetail, parseTaskWrite, writes, type Booking, type Task } from './records.ts';
import { namesFor } from './store.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const copy = { saving: 'Saving…', saved: 'Saved.', confirmed: 'Confirmed.' };
function harness(answers: Result<string>[]) {
	let now = 0, n = 0; const sent: unknown[] = [], events: string[] = [];
	const saver = createSaver<string>({ now: () => now, randomId: () => id(900 + ++n), copy, saved: (v) => { events.push(`saved:${v}`); }, reload: () => { events.push('reload'); }, lost: () => { events.push('lost'); } });
	const save = (body: object) => saver.save((changeSetId) => { const b = { ...body, changeSetId }; return { body: b, send: async () => { sent.push(b); return answers.shift()!; } }; });
	return { saver, sent, events, save, tick: (ms: number) => { now += ms; } };
}
const unknown: Result<string> = { kind: 'error', status: 503, code: 'unavailable', retryAfter: 0, uncertain: true };

test('an uncertain save keeps its id and exact body for an explicit retry; nothing is retried by itself', async () => {
	const h = harness([unknown, { kind: 'ok', value: 'task' }]);
	await h.save({ title: 'Package summer lager' });
	assert.equal(h.saver.snapshot().uncertain, true); assert.equal(h.saver.snapshot().message, saveCopy.unknown); assert.equal(h.sent.length, 1);
	await h.save({ title: 'Something else' });
	assert.equal(h.sent.length, 1, 'a new save is refused while one is uncertain');
	await h.saver.retry();
	assert.deepEqual(h.sent[1], h.sent[0], 'the same id and the same body');
	assert.equal((h.sent[0] as { changeSetId: string }).changeSetId, id(901));
	assert.deepEqual(h.events, ['saved:task']); assert.equal(h.saver.snapshot().pending, null);
});

test('a change line carrying the uncertain id confirms it; discard reloads', async () => {
	const h = harness([unknown]);
	await h.save({ due: '2026-10-08' });
	h.saver.confirm([id(1)]); assert.equal(h.saver.snapshot().uncertain, true, 'another change set confirms nothing');
	h.saver.confirm([id(901)]);
	assert.equal(h.saver.snapshot().uncertain, false); assert.equal(h.saver.snapshot().message, 'Confirmed.'); assert.deepEqual(h.events, ['saved:null']);
	const d = harness([unknown]); await d.save({}); d.saver.discard();
	assert.deepEqual(d.events, ['reload']); assert.equal(d.saver.snapshot().pending, null);
});

test('429 keeps the form editable with its wait and the same id; stale reloads; lost and refusals are said', async () => {
	const h = harness([{ kind: 'error', status: 429, code: 'unavailable', retryAfter: 30, uncertain: false }, { kind: 'ok', value: 'ok' }]);
	await h.save({ a: 1 });
	assert.equal(h.saver.snapshot().uncertain, false); assert.equal(h.saver.snapshot().message, saveCopy.rate);
	await h.save({ a: 2 }); assert.equal(h.sent.length, 1, 'refused during the wait');
	h.tick(30_000); await h.save({ a: 2 });
	assert.equal((h.sent[1] as { changeSetId: string }).changeSetId, id(901), 'an unused id is kept for the same intent');
	const s = harness([{ kind: 'error', status: 409, code: 'stale_revision', retryAfter: 0, uncertain: false }]);
	await s.save({}); assert.equal(s.saver.snapshot().message, saveCopy.stale); assert.deepEqual(s.events, ['reload']); assert.equal(s.saver.snapshot().pending, null);
	const l = harness([{ kind: 'error', status: 404, code: 'not_found', retryAfter: 0, uncertain: false }]);
	await l.save({}); assert.deepEqual(l.events, ['lost']);
	const r = harness([{ kind: 'error', status: 409, code: 'reservation_conflict', retryAfter: 0, uncertain: false }, { kind: 'error', status: 409, code: 'change_set_id_unavailable', retryAfter: 0, uncertain: false }]);
	await r.save({}); assert.match(r.saver.snapshot().message, /unavailable during this time/); assert.equal(r.saver.snapshot().refusal, 'reservation_conflict');
	await r.save({}); assert.equal(r.saver.snapshot().message, saveCopy.idUnavailable);
	assert.notEqual((r.sent[1] as { changeSetId: string }).changeSetId, (r.sent[0] as { changeSetId: string }).changeSetId, 'a refused id is not reused');
});

const task: Task = { id: id(1), parentId: null, title: 'Package summer lager', body: '', status: 'in_progress', ownerId: id(4), ownerName: 'Maya Chen', due: '2026-10-06', evidenceRequired: false, evidenceCount: 0, revision: 3 };
test('a task save names only the fields the person changed, and the form refuses what the API would', () => {
	const form = taskForm(task);
	assert.equal(taskChanges(task, form), null);
	assert.deepEqual(taskChanges(task, { ...form, due: '2026-10-08', ownerId: '' }), { ownerId: null, due: '2026-10-08' });
	assert.deepEqual(taskChanges(task, { ...form, title: '  Package summer lager  ' }), null, 'surrounding spaces are not a change');
	assert.equal(validTaskForm({ ...form, title: ' ' }), 'A task needs a title.');
	assert.match(validTaskForm({ ...form, due: '2026-02-30' })!, /due date/);
	const w = writes.task({ epoch: 'e', userId: id(4), organisationId: id(2) }, task.id, id(77), 3, { due: '2026-10-08' });
	assert.deepEqual([w.method, w.path, w.body], ['PATCH', `/v1/organisations/${id(2)}/tasks/${id(1)}`, { changeSetId: id(77), expectedRevision: 3, due: '2026-10-08' }]);
});

const booking: Booking = { id: id(6), equipmentId: id(8), title: 'Summer lager canning run', kind: 'booking', status: 'confirmed', startsAt: '2026-10-07T21:00:00.000Z', endsAt: '2026-10-08T01:00:00.000Z', setupMinutes: 30, cleanupMinutes: 30, taskId: null, ownerId: null, revision: 2 };
test('a booking form is in the organisation zone; its plan keeps kind, task and owner and computes the occupied time', () => {
	const zone = 'Australia/Sydney', form = bookingForm(booking, zone);
	assert.deepEqual(form, { title: 'Summer lager canning run', date: '2026-10-08', start: '08:00', endDate: '2026-10-08', end: '12:00', setup: 30, cleanup: 30 });
	const plan = bookingPlan(booking, { ...form, start: '09:00', end: '13:00' }, zone, false);
	assert.ok('time' in plan);
	assert.deepEqual(plan.time, { title: booking.title, kind: 'booking', startsAt: '2026-10-07T22:00:00.000Z', endsAt: '2026-10-08T02:00:00.000Z', setupMinutes: 30, cleanupMinutes: 30, taskId: null, ownerId: null });
	assert.deepEqual([plan.occupiedFrom, plan.occupiedTo], ['2026-10-07T21:30:00.000Z', '2026-10-08T02:30:00.000Z']);
	assert.equal(bookingChanged(booking, plan.time), true);
	const same = bookingPlan(booking, form, zone, false); assert.ok('time' in same); assert.equal(bookingChanged(booking, same.time), false);
	assert.deepEqual(bookingPlan(booking, { ...form, end: '07:00' }, zone, false), { error: 'The end must be after the start on the same day.' });
	assert.equal(instantIn('2026-10-04', '02:30', zone), null, 'a time skipped by daylight saving');
	assert.equal(occupancyWords('2026-10-07T20:30:00.000Z', '2026-10-08T01:30:00.000Z', zone, 2026), '7:30 am to 12:30 pm');
	assert.deepEqual(minuteChoices(30).map((o) => o.label).slice(0, 4), ['None', '15 minutes', '30 minutes', '45 minutes']);
	assert.equal(minuteChoices(25).some((o) => o.value === '25'), true, 'a current value outside the list stays choosable');
});

test('a booking that spans days opens with its end date and no warning, whenever its record loaded', () => {
	const zone = 'Australia/Sydney', long = { ...booking, endsAt: '2026-10-10T01:00:00.000Z' };
	const start = bookingStart(long, zone);
	assert.equal(start.multiDay, true); assert.equal(start.form.endDate, '2026-10-10');
	const plan = bookingPlan(long, start.form, zone, start.multiDay); assert.ok('time' in plan); assert.equal(bookingChanged(long, plan.time), false);
	// Read as one day (the bug): an untouched card either says the end is before the start or offers to shorten it.
	const oneDay = bookingPlan(long, start.form, zone, false); assert.ok('time' in oneDay); assert.equal(oneDay.time.endsAt, '2026-10-08T01:00:00.000Z'); assert.equal(bookingChanged(long, oneDay.time), true);
	assert.deepEqual(bookingPlan(long, { ...start.form, end: '07:00' }, zone, false), { error: 'The end must be after the start on the same day.' });
	assert.equal(bookingStart(booking, zone).multiDay, false);
});

test('a booking card offers an action only when it can succeed: a warning disables Save; cautions do not; cancel is offered on an untouched card', () => {
	const zone = 'Australia/Sydney', form = bookingForm(booking, zone);
	const idle = { busy: false, uncertain: false, refusal: null };
	const moved = bookingPlan(booking, { ...form, end: '13:00' }, zone, false), same = bookingPlan(booking, form, zone, false);
	const at = (over: Partial<Parameters<typeof bookingControls>[0]> = {}) => bookingControls({ locked: false, cancelled: false, waiting: false, changed: true, plan: moved, free: { kind: 'free' }, save: idle, cancel: idle, ...over });
	assert.deepEqual(at({ changed: false, plan: same }), { editable: true, warning: null, save: false, discard: false, cancel: true, confirmCancel: true }, 'untouched: nothing to save, cancel offered');
	assert.deepEqual(at(), { editable: true, warning: null, save: true, discard: true, cancel: true, confirmCancel: true });
	const taken = at({ free: { kind: 'taken', holders: ['Bright tank clean (12:00 pm to 2:00 pm)'] } });
	assert.equal(taken.warning, 'taken'); assert.equal(taken.save, false, 'the overlap note says the save will be refused'); assert.equal(taken.discard, true); assert.equal(taken.cancel, true);
	const invalid = at({ plan: bookingPlan(booking, { ...form, end: '07:00' }, zone, false) });
	assert.equal(invalid.warning, 'invalid'); assert.equal(invalid.save, false); assert.equal(invalid.discard, true);
	for (const kind of ['checking', 'partial', 'unchecked', 'idle'] as const) assert.equal(at({ free: { kind } }).save, true, `${kind} is a caution, not a refusal`);
	assert.equal(at({ waiting: true }).save, false); assert.equal(at({ waiting: true }).cancel, false);
	assert.equal(at({ locked: true }).cancel, false); assert.equal(at({ save: { ...idle, busy: true } }).cancel, false);
	assert.equal(at({ save: { ...idle, uncertain: true } }).confirmCancel, false);
	assert.equal(at({ save: { ...idle, refusal: 'forbidden' } }).save, false, 'a refusal that holds keeps Save off until something changes');
	assert.equal(at({ save: { ...idle, refusal: 'reservation_conflict' } }).save, true, 'an overlap refusal is said by the occupancy note, which re-checks');
	assert.equal(at({ cancel: { ...idle, refusal: 'equipment_archived' } }).cancel, false);
	assert.deepEqual(at({ cancelled: true }), { editable: false, warning: null, save: false, discard: true, cancel: false, confirmCancel: false });
	assert.equal(refusedForGood(null), false); assert.equal(refusedForGood('stale_revision'), false); assert.equal(refusedForGood('stock_archived'), true);
});

test('a refusal saying the record changed reloads it; other refusals do not', async () => {
	for (const [code, reloads] of [['reservation_cancelled', true], ['stock_archived', true], ['reservation_conflict', false], ['forbidden', false]] as const) {
		const h = harness([{ kind: 'error', status: 409, code, retryAfter: 0, uncertain: false }]);
		await h.save({ title: 'x' });
		assert.equal(h.events.includes('reload'), reloads, code); assert.equal(h.saver.snapshot().refusal, code);
	}
});

test('a count is a decimal of zero or more', () => {
	assert.equal(validCount('4.5'), null); assert.equal(validCount('0'), null);
	for (const bad of ['', '-1', '1e3', '4,5', '.5', 'x'.repeat(81)]) assert.ok(validCount(bad), bad);
});

test('record parsers check identity and the change set; extra or missing fields are refused', () => {
	const row = { id: task.id, parentId: null, title: task.title, body: '', status: 'in_progress', ownerId: id(4), ownerName: 'Maya Chen', due: '2026-10-06', sourceKind: 'person', sourceId: id(4),
		seriesId: null, periodStart: null, periodEnd: null, evidenceRequired: false, completedBy: null, completedAt: null, revision: 3, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', evidenceCount: 0, evidence: [] };
	const detail = { task: row, parent: null, series: null, checklist: { tasks: [{ ...row, id: id(2), parentId: task.id, title: 'Book the canning line', status: 'done' }], nextOffset: null }, evidenceNextOffset: null,
		tags: { items: [], nextOffset: null }, today: '2026-10-02', timezone: 'Australia/Sydney' };
	assert.equal(parseTaskDetail(detail, task.id).steps[0]?.title, 'Book the canning line');
	assert.throws(() => parseTaskDetail(detail, id(9))); assert.throws(() => parseTaskDetail({ ...detail, extra: 1 }, task.id));
	assert.equal(parseTaskWrite({ ...row, changeSetId: id(77) }, { id: task.id, changeSetId: id(77) }).revision, 3);
	assert.throws(() => parseTaskWrite({ ...row, changeSetId: id(78) }, { id: task.id, changeSetId: id(77) }));
	const b = { ...booking, occupiedStartsAt: '2026-10-07T20:30:00.000Z', occupiedEndsAt: '2026-10-08T01:30:00.000Z', createdBy: id(4), createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', tagIds: [] };
	assert.equal(parseBooking(b, { id: booking.id, equipmentId: booking.equipmentId }).revision, 2);
	assert.throws(() => parseBooking(b, { id: booking.id, equipmentId: id(99) }));
	assert.throws(() => parseBooking(b, { id: booking.id, equipmentId: booking.equipmentId, changeSetId: id(77) }), 'a write answer must carry its change set');
	const count = { id: id(30), organisationId: id(2), itemId: id(7), countedAt: '2026-10-02T00:00:00.000Z', countedBy: id(4), count: '4.5', note: '', changeSetId: id(77) };
	assert.equal(parseCount(count, { itemId: id(7), changeSetId: id(77) }).count, '4.5');
	assert.throws(() => parseCount({ ...count, count: '-1' }, { itemId: id(7), changeSetId: id(77) }));
});

test('change-line names come from what the screen loaded, never guessed', () => {
	const detail = { thread: { id: id(11), kind: 'record' as const, title: 't', revision: 1, lastSeq: 1, lastChange: 1, readPosition: 0, unread: 0, starred: false, createdAt: '2026-10-01T00:00:00.000Z' },
		card: { record: { kind: 'task' as const, id: task.id }, title: 't', status: null, facts: ['', ''] as [string, string], fold: { ownerId: id(4), ownerName: 'Maya Chen' } }, tags: [{ id: id(3), name: 'Production' }], pin: null };
	const names = namesFor(detail, { task: { task, steps: [{ ...task, id: id(2), parentId: task.id, title: 'Book the canning line' }], stepsNext: null, today: '2026-10-02', timezone: 'UTC' }, booking: null, zone: null, members: null, tags: null, busy: false, message: '', waitUntil: 0 }, []);
	assert.deepEqual([names.person!(id(4)), names.tag!(id(3)), names.step!(id(2)), names.person!(id(5))], ['Maya Chen', 'Production', 'Book the canning line', undefined]);
});
