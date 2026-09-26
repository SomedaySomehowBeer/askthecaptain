import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY, addMonths, chunkDays, chunksBetween, dateAt, renderWindow, scheduleRange, ticks } from './range.ts';
import { zonedDay } from './time.ts';
const contiguous = (range: ReturnType<typeof scheduleRange>) => {
 assert.equal(range.chunks[0]!.from, range.start); assert.equal(range.chunks.at(-1)!.to, range.end);
 range.chunks.forEach((chunk, i) => {
  if (i) assert.equal(chunk.from, range.chunks[i - 1]!.to, 'no gap or overlap between reads');
  const elapsed = Date.parse(chunk.to) - Date.parse(chunk.from);
  assert.ok(elapsed > 0 && elapsed <= (chunkDays + 2) * DAY && elapsed <= 93 * DAY, 'each read stays inside the API limit');
 });
};
test('calendar months clamp to the last day and wrap years', () => {
 assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
 assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
 assert.equal(addMonths('2026-08-31', 6), '2027-02-28');
 assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
 assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
 assert.throws(() => addMonths('soon', 1));
});
test('the range covers one month back and six months forward in contiguous bounded reads', () => {
 const range = scheduleRange('2026-09-26', 'Australia/Perth');
 assert.equal(range.startDate, '2026-08-26'); assert.equal(range.endDate, '2027-03-27');
 assert.equal(range.anchorAt, zonedDay('2026-09-26', 'Australia/Perth'));
 assert.equal(range.chunks[range.anchorChunk]!.fromDate, '2026-09-26', 'the first read starts at the opened date');
 assert.ok(Date.parse(range.end) - Date.parse(range.start) >= 210 * DAY);
 contiguous(range);
 assert.ok(range.chunks.length <= 10, 'seven months stays a handful of reads');
});
test('clock changes and skipped dates keep chunk boundaries exact', () => {
 const sydney = scheduleRange('2026-09-20', 'Australia/Sydney'); contiguous(sydney);
 const spring = sydney.chunks.find(c => c.fromDate <= '2026-10-04' && c.toDate > '2026-10-04')!;
 assert.equal(Date.parse(spring.to) - Date.parse(spring.from), chunkDays * DAY - 3_600_000);
 // 2011-12-30 does not exist in Apia; the boundary moves to the next existing day.
 const apia = scheduleRange('2011-12-02', 'Pacific/Apia'); contiguous(apia);
 assert.ok(apia.chunks.some(c => c.toDate === '2011-12-30' && c.to === zonedDay('2011-12-31', 'Pacific/Apia')));
 assert.throws(() => scheduleRange('2011-12-30', 'Pacific/Apia'), /clock change/);
});
test('the range stays inside the API time limits', () => {
 const late = scheduleRange('2199-10-01', 'Pacific/Kiritimati'); contiguous(late);
 assert.equal(late.endDate, '2199-12-31'); assert.ok(late.end < '2200-01-01');
 const early = scheduleRange('1900-01-15', 'UTC'); contiguous(early);
 assert.equal(early.startDate, '1900-01-02'); assert.ok(early.start >= '1900-01-01');
 assert.throws(() => scheduleRange('2199-12-31', 'UTC')); assert.throws(() => scheduleRange('2026-02-30', 'UTC'));
});
test('wanted reads are nearest the view first', () => {
 const range = scheduleRange('2026-09-26', 'UTC'), at = Date.parse(range.anchorAt);
 assert.deepEqual(chunksBetween(range.chunks, at, at + DAY), [range.anchorChunk]);
 assert.deepEqual(chunksBetween(range.chunks, at - DAY, at + 3 * DAY), [range.anchorChunk, range.anchorChunk - 1]);
 assert.deepEqual(chunksBetween(range.chunks, at - 3 * DAY, at + DAY), [range.anchorChunk - 1, range.anchorChunk]);
});
test('the rendered window changes only when the view nears its edge', () => {
 const start = 0, end = 100 * DAY, first = renderWindow(null, 10 * DAY, 12 * DAY, start, end);
 assert.deepEqual(first, { low: 7 * DAY, high: 15 * DAY });
 assert.equal(renderWindow(first, 10.5 * DAY, 12.5 * DAY, start, end), first);
 assert.notEqual(renderWindow(first, 13 * DAY, 15 * DAY, start, end), first);
 assert.deepEqual(renderWindow(null, 0, 2 * DAY, start, end), { low: 0, high: 5 * DAY });
});
test('axis ticks are bounded to the rendered window and follow civil time', () => {
 const range = scheduleRange('2026-09-20', 'Australia/Sydney');
 const day = (date: string) => Date.parse(zonedDay(date, 'Australia/Sydney'));
 assert.equal(ticks('hours', range, 'Australia/Sydney', day('2026-10-04'), day('2026-10-05')).length, 23);
 assert.equal(ticks('hours', range, 'Australia/Sydney', day('2026-10-10'), day('2026-10-12')).length, 48);
 assert.deepEqual(ticks('days', range, 'Australia/Sydney', day('2026-10-03'), day('2026-10-06')).map(t => t.at), [day('2026-10-03'), day('2026-10-04'), day('2026-10-05')]);
 assert.equal(ticks('weeks', range, 'Australia/Sydney', day('2026-09-20'), day('2026-10-18')).length, 4);
 assert.equal(ticks('hours', range, 'Australia/Sydney', Date.parse(range.start), Date.parse(range.start) + 3 * DAY).length, 72);
 const apia = scheduleRange('2011-12-02', 'Pacific/Apia');
 assert.equal(ticks('days', apia, 'Pacific/Apia', Date.parse(zonedDay('2011-12-29', 'Pacific/Apia')), Date.parse(zonedDay('2012-01-01', 'Pacific/Apia'))).length, 2);
 assert.equal(dateAt(day('2026-10-04') + 3 * 3_600_000, 'Australia/Sydney'), '2026-10-04');
});
