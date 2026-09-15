import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, eventTime, localDate, onDay, weekStart, type Event } from './calendar.ts';
test('weeks and event days use organisation time, all-day dates are exclusive, DST does not change date arithmetic', () => {
 assert.equal(weekStart('2026-09-20', 'Australia/Perth'), '2026-09-14'); assert.equal(addDays('2026-12-28', 7), '2027-01-04');
 assert.equal(localDate('2026-09-14T16:01:00Z', 'Australia/Perth'), '2026-09-15');
 const timed = { allDay: false, startsAt: '2026-09-14T15:30:00Z', endsAt: '2026-09-14T16:00:00Z' } as Event;
 assert.equal(onDay(timed, '2026-09-14', 'Australia/Perth'), true); assert.equal(onDay(timed, '2026-09-15', 'Australia/Perth'), false);
 const holiday = { allDay: true, startDate: '2026-09-16', endDate: '2026-09-18' } as Event;
 assert.equal(onDay(holiday, '2026-09-17', 'America/New_York'), true); assert.equal(onDay(holiday, '2026-09-18', 'Australia/Perth'), false);
 assert.equal(addDays('2026-03-08', 1), '2026-03-09');
 assert.match(eventTime({ ...timed, endsAt: '2026-09-14T17:00:00Z' }, 'Australia/Perth'), /Monday 14 Sept.*11:30 pm.*Tuesday 15 Sept.*1:00 am/);
});
