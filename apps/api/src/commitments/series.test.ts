import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addMonths, dueFor, nextPeriod, periodContaining, titleFor, todayIn, type SeriesRule } from './series.ts';

const monthly: SeriesRule = { recurrence: 'monthly', everyMonths: null, anchor: '2026-01-01', dueOffsetDays: 21 };

test('a monthly series anchored on the first has calendar-month periods and a due date after the period', () => {
	const period = periodContaining(monthly, '2026-09-15');
	assert.deepEqual(period, { start: '2026-09-01', end: '2026-09-30', label: 'September 2026' });
	assert.equal(dueFor(monthly, period!), '2026-10-21');
	assert.equal(titleFor('Excise return', period!), 'Excise return — September 2026');
	assert.equal(titleFor('Lodge {period} BAS', period!), 'Lodge September 2026 BAS');
});

test('periods are counted from the anchor, not the calendar', () => {
	const fromMid: SeriesRule = { ...monthly, anchor: '2026-01-15' };
	assert.deepEqual(periodContaining(fromMid, '2026-02-10'), { start: '2026-01-15', end: '2026-02-14', label: '15 Jan 2026 – 14 Feb 2026' });
	const financialYear: SeriesRule = { recurrence: 'yearly', everyMonths: null, anchor: '2025-07-01', dueOffsetDays: 0 };
	assert.deepEqual(periodContaining(financialYear, '2026-03-01'), { start: '2025-07-01', end: '2026-06-30', label: '1 Jul 2025 – 30 Jun 2026' });
	const quarterly: SeriesRule = { recurrence: 'quarterly', everyMonths: null, anchor: '2026-01-01', dueOffsetDays: 28 };
	assert.equal(periodContaining(quarterly, '2026-09-15')!.start, '2026-07-01');
	assert.equal(dueFor(quarterly, periodContaining(quarterly, '2026-09-15')!), '2026-10-28');
	const custom: SeriesRule = { recurrence: 'custom', everyMonths: 2, anchor: '2026-01-01', dueOffsetDays: -3 };
	assert.deepEqual(periodContaining(custom, '2026-04-30'), { start: '2026-03-01', end: '2026-04-30', label: '1 Mar 2026 – 30 Apr 2026' });
	assert.equal(dueFor(custom, periodContaining(custom, '2026-04-30')!), '2026-04-27');
});

test('a series has no period before its anchor, and the next period starts at the anchor', () => {
	assert.equal(periodContaining(monthly, '2025-12-31'), null);
	assert.equal(nextPeriod(monthly, '2025-12-31').start, '2026-01-01');
});

test('a weekdays series has one period per weekday and skips weekends', () => {
	const weekdays: SeriesRule = { recurrence: 'weekdays', everyMonths: null, anchor: '2026-09-01', dueOffsetDays: 0 };
	assert.deepEqual(periodContaining(weekdays, '2026-09-15'), { start: '2026-09-15', end: '2026-09-15', label: '15 Sep 2026' });
	assert.equal(periodContaining(weekdays, '2026-09-19'), null, 'Saturday');
	assert.equal(nextPeriod(weekdays, '2026-09-19').start, '2026-09-21', 'Monday');
});

test('month arithmetic clamps to the end of shorter months', () => {
	assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
	assert.equal(addMonths('2026-01-31', 2), '2026-03-31');
	assert.equal(addMonths('2024-02-29', 12), '2025-02-28');
});

test('a custom series without everyMonths is refused, and so is a date that is not a date', () => {
	assert.throws(() => periodContaining({ recurrence: 'custom', everyMonths: null, anchor: '2026-01-01', dueOffsetDays: 0 }, '2026-02-01'), /everyMonths/);
	assert.throws(() => periodContaining(monthly, '2026-02-30'), /calendar date/);
	assert.throws(() => periodContaining(monthly, 'yesterday'), /YYYY-MM-DD/);
});

test('today is computed in the organisation timezone', () => {
	const late = new Date('2026-09-15T22:30:00Z');
	assert.equal(todayIn('Australia/Perth', late), '2026-09-16');
	assert.equal(todayIn('UTC', late), '2026-09-15');
});
