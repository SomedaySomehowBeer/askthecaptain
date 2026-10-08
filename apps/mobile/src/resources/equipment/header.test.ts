import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayHeading, dayInView, stepDays, stepTo, todayLine } from './header.ts';

const zone = 'Australia/Sydney';
const range = { start: '2026-09-01T14:00:00.000Z', end: '2027-04-01T13:00:00.000Z' };
test('the header names the day in the middle of the view, in the zone; today before anything settles', () => {
	const now = new Date('2026-10-08T01:00:00Z');
	assert.equal(dayInView(null, zone, now), '2026-10-08');
	// 30 Sep 22:00Z to 1 Oct 04:00Z: the middle is 1 Oct 01:00Z, 11 am on 1 October in Sydney.
	assert.equal(dayInView({ low: Date.parse('2026-09-30T22:00:00Z'), high: Date.parse('2026-10-01T04:00:00Z') }, zone, now), '2026-10-01');
	assert.equal(dayHeading('2026-10-01'), 'Thursday 1 October');
	assert.equal(todayLine('2026-09-29'), 'Today is Tue 29 Sep');
});
test('‹ and › move a day (a week on Weeks) to that day’s midday, and stop at the loaded range', () => {
	assert.deepEqual([stepDays('hours'), stepDays('days'), stepDays('weeks')], [1, 1, 7]);
	const next = stepTo('2026-10-01', 'hours', 1, zone, range)!;
	assert.equal(next.date, '2026-10-02'); assert.equal(new Date(next.at).toISOString(), '2026-10-02T02:00:00.000Z', 'midday in Sydney (UTC+10)');
	assert.equal(stepTo('2026-10-08', 'weeks', -1, zone, range)!.date, '2026-10-01');
	// The clock change on 4 October: the 23-hour day's middle is still inside it.
	const short = stepTo('2026-10-03', 'days', 1, zone, range)!;
	assert.equal(short.date, '2026-10-04'); assert.equal(new Date(short.at).toISOString(), '2026-10-04T01:30:00.000Z');
	assert.equal(stepTo('2026-09-02', 'days', -1, zone, range), null, 'before the range');
	assert.equal(stepTo('2027-03-31', 'days', 1, zone, range)!.date, '2027-04-01', 'the last day is in range');
	assert.equal(stepTo('2027-04-01', 'days', 1, zone, range), null, 'after the range');
});
