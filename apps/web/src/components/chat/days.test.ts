import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayKey, dayLabel, timeLabel, withDays } from './days.ts';

const now = new Date('2026-09-27T02:00:00Z');

test('days start at midnight in the organisation’s timezone, not the server’s', () => {
	// 15:30 UTC on the 21st is 23:30 in Perth (UTC+8) and 01:30 on the 22nd in Sydney (UTC+10).
	assert.equal(dayKey('2026-09-21T15:30:00Z', 'Australia/Perth'), '2026-09-21');
	assert.equal(dayKey('2026-09-21T15:30:00Z', 'Australia/Sydney'), '2026-09-22');
	assert.equal(dayLabel('2026-09-22T01:00:00Z', 'Australia/Perth', now), 'Tuesday 22 September');
	assert.equal(timeLabel('2026-09-22T01:05:00Z', 'Australia/Perth'), '09:05');
});

test('daylight saving: the same UTC hour falls on the local clock either side of the change', () => {
	// Sydney moves to UTC+11 on 4 October 2026 at 02:00 local.
	assert.equal(timeLabel('2026-10-03T14:30:00Z', 'Australia/Sydney'), '00:30');
	assert.equal(timeLabel('2026-10-04T14:30:00Z', 'Australia/Sydney'), '01:30');
});

test('another year is named; separators appear only where the day changes', () => {
	assert.equal(dayLabel('2025-12-31T01:00:00Z', 'Australia/Perth', now), 'Wednesday 31 December 2025');
	const rows = [{ createdAt: '2026-09-22T01:00:00Z' }, { createdAt: '2026-09-22T09:00:00Z' }, { createdAt: '2026-09-23T01:00:00Z' }];
	assert.deepEqual(withDays(rows, 'Australia/Perth', now).map(r => r.kind === 'day' ? r.label : 'row'),
		['Tuesday 22 September', 'row', 'row', 'Wednesday 23 September', 'row']);
	assert.deepEqual(withDays([], 'Australia/Perth', now), []);
});
