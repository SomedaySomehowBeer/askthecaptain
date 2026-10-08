import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dueWords, firstPeriod, parseSeries, repeatForm, repeatRule, repeatsWords, seriesChanges, seriesForm, seriesWrites } from './series.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { epoch: 'one', userId: id(1), organisationId: id(2) };
const at = '2026-10-01T00:00:00.000Z';
const series = (x: Record<string, unknown> = {}) => ({ id: id(30), tagIds: [id(3)], title: 'Excise return', body: 'File it', ownerId: id(4), evidenceRequired: true, recurrence: 'monthly', everyMonths: null,
	anchor: '2026-10-01', dueOffsetDays: -10, pausedAt: null, nextDue: '2026-10-21', revision: 2, createdAt: at, updatedAt: at, ...x });

test('repeat this task opens monthly from the task’s month, due as many days before its end as the task is', () => {
	const form = repeatForm({ due: '2026-10-21', ownerId: id(4), evidenceRequired: false }, '2026-10-08');
	assert.deepEqual(form, { recurrence: 'monthly', everyMonths: '2', anchor: '2026-10-01', dueDays: '10', dueWhen: 'before', ownerId: id(4), evidenceRequired: false });
	assert.deepEqual(repeatRule(form), { recurrence: 'monthly', everyMonths: null, anchor: '2026-10-01', dueOffsetDays: -10, ownerId: id(4), evidenceRequired: false });
	assert.deepEqual(repeatForm({ due: null, ownerId: null, evidenceRequired: true }, '2026-10-08'), { recurrence: 'monthly', everyMonths: '2', anchor: '2026-10-01', dueDays: '0', dueWhen: 'before', ownerId: '', evidenceRequired: true });
	assert.equal(repeatForm({ due: '2026-11-03', ownerId: null, evidenceRequired: false }, '2026-10-08').anchor, '2026-11-01');
	assert.deepEqual(repeatRule({ ...form, recurrence: 'custom', everyMonths: '0' }), { error: 'Repeat every 1 to 120 months.' });
	assert.deepEqual(repeatRule({ ...form, recurrence: 'custom', everyMonths: '6', dueWhen: 'after', dueDays: '5' }), { recurrence: 'custom', everyMonths: 6, anchor: '2026-10-01', dueOffsetDays: 5, ownerId: id(4), evidenceRequired: false });
	assert.deepEqual(repeatRule({ ...form, anchor: '2026-02-30' }), { error: 'Choose the date the series starts from.' });
	assert.deepEqual(repeatRule({ ...form, dueDays: '400' }), { error: 'Enter 0 to 366 days for when it falls due.' });
	assert.deepEqual(repeatRule({ ...form, dueDays: '-3' }), { error: 'Enter 0 to 366 days for when it falls due.' });
});

test('the words: due after or before the period ends, the repeats line, and which period the task becomes', () => {
	assert.deepEqual([dueWords(5, 'monthly'), dueWords(-1, 'quarterly'), dueWords(0, 'yearly'), dueWords(0, 'weekdays'), dueWords(2, 'weekdays')],
		['due 5 days after the period ends', 'due 1 day before the period ends', 'due when the period ends', 'due on the day', 'due 2 days after the day']);
	const s = parseSeries(series());
	assert.equal(repeatsWords(s), 'Repeats monthly from 1 Oct 2026, due 10 days before the period ends.');
	assert.equal(repeatsWords(parseSeries(series({ recurrence: 'custom', everyMonths: 2 }))), 'Repeats every 2 months from 1 Oct 2026, due 10 days before the period ends.');
	assert.equal(repeatsWords(parseSeries(series({ pausedAt: at, nextDue: null }))), 'Paused. It repeats monthly when resumed.');
	assert.deepEqual(firstPeriod({ recurrence: 'monthly', everyMonths: null, anchor: '2026-10-01' }, '2026-10-08'), { start: '2026-10-01', end: '2026-10-31' });
	assert.deepEqual(firstPeriod({ recurrence: 'quarterly', everyMonths: null, anchor: '2026-01-01' }, '2026-10-08'), { start: '2026-10-01', end: '2026-12-31' });
	assert.deepEqual(firstPeriod({ recurrence: 'yearly', everyMonths: null, anchor: '2031-01-01' }, '2026-10-08'), { start: '2031-01-01', end: '2031-12-31' }, 'a later start is its own first period');
	assert.deepEqual(firstPeriod({ recurrence: 'weekdays', everyMonths: null, anchor: '2026-10-01' }, '2026-10-10'), { start: '2026-10-12', end: '2026-10-12' }, 'Saturday: the next weekday');
});

test('series answers are read strictly; repeat sends the task as fromTask with its title, body and tags; edits send only changes', () => {
	for (const bad of [series({ recurrence: 'custom' }), series({ everyMonths: 3 }), series({ pausedAt: at }), series({ nextDue: null }), series({ tagIds: [id(3), id(3)] }), series({ extra: 1 }), series({ dueOffsetDays: 400 })])
		assert.throws(() => parseSeries(bad), TypeError, JSON.stringify(bad).slice(0, 60));
	const rule = { recurrence: 'monthly' as const, everyMonths: null, anchor: '2026-10-01', dueOffsetDays: -10, ownerId: id(4), evidenceRequired: true };
	const w = seriesWrites.repeat(scope, { id: id(40), title: 'Excise return', body: 'File it', revision: 5 }, [id(3)], rule, id(900));
	assert.deepEqual([w.method, w.path], ['POST', `/v1/organisations/${id(2)}/series`]);
	assert.deepEqual(w.body, { changeSetId: id(900), title: 'Excise return', body: 'File it', tagIds: [id(3)], ownerId: id(4), evidenceRequired: true, recurrence: 'monthly', everyMonths: null,
		anchor: '2026-10-01', dueOffsetDays: -10, fromTask: { id: id(40), expectedRevision: 5 } });
	assert.equal(w.parse({ ...series(), changeSetId: id(900) }).id, id(30));
	assert.throws(() => w.parse(series()), TypeError, 'the change set must come back');
	const s = parseSeries(series());
	const form = seriesForm(s), same = repeatRule(form);
	assert.ok(!('error' in same)); assert.equal(seriesChanges(s, same as never, 'Excise return'), null);
	const changed = repeatRule({ ...form, recurrence: 'quarterly', dueWhen: 'after', dueDays: '7' });
	assert.deepEqual(seriesChanges(s, changed as never, ' BAS return '), { title: 'BAS return', recurrence: 'quarterly', everyMonths: null, dueOffsetDays: 7 });
	const pause = seriesWrites.update(scope, s, id(901), { paused: true });
	assert.deepEqual([pause.method, pause.body], ['PATCH', { changeSetId: id(901), expectedRevision: 2, paused: true }]);
});
