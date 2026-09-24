import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayTime, localChoices, localValue, resolveLocal, shiftDate, todayInZone, zonedDay } from './time.ts';
test('Perth instants use organisation time and preserve seconds and milliseconds on edit', () => {
 assert.equal(resolveLocal('2026-09-28T09:00', 'Australia/Perth'), '2026-09-28T01:00:00.000Z');
 const value = '2026-09-28T01:00:45.123Z';
 assert.equal(resolveLocal(localValue(value, 'Australia/Perth'), 'Australia/Perth'), value);
 assert.equal(todayInZone('Australia/Perth', new Date('2026-09-28T17:00:00Z')), '2026-09-29');
 assert.equal(zonedDay('2026-09-28', 'Australia/Perth'), '2026-09-27T16:00:00.000Z');
 assert.match(displayTime(value, 'Australia/Perth'), /UTC\+08:00/);
});
test('Sydney gap is refused and repeated hour requires an explicit offset choice', () => {
 assert.deepEqual(localChoices('2026-10-04T02:30', 'Australia/Sydney'), []);
 assert.throws(() => resolveLocal('2026-10-04T02:30', 'Australia/Sydney'), /does not exist/);
 const choices = localChoices('2026-04-05T02:30', 'Australia/Sydney');
 assert.deepEqual(choices, [{ instant: '2026-04-04T15:30:00.000Z', offset: '+11:00' }, { instant: '2026-04-04T16:30:00.000Z', offset: '+10:00' }]);
 assert.throws(() => resolveLocal('2026-04-05T02:30', 'Australia/Sydney'), /happens twice/);
 assert.throws(() => resolveLocal('2026-04-05T02:30', 'Australia/Sydney', 'forged'), /happens twice/);
 assert.equal(resolveLocal('2026-04-05T02:30', 'Australia/Sydney', choices[1]!.instant), choices[1]!.instant);
 assert.equal(Date.parse(zonedDay('2026-10-05', 'Australia/Sydney')) - Date.parse(zonedDay('2026-10-04', 'Australia/Sydney')), 23 * 3_600_000);
 assert.equal(Date.parse(zonedDay('2026-04-06', 'Australia/Sydney')) - Date.parse(zonedDay('2026-04-05', 'Australia/Sydney')), 25 * 3_600_000);
});
test('non-hour transitions and a skipped calendar date remain explicit', () => {
 assert.equal(zonedDay('2026-09-06', 'America/Santiago'), '2026-09-06T04:00:00.000Z');
 assert.equal(localChoices('2026-04-05T01:45', 'Australia/Lord_Howe').length, 2);
 assert.deepEqual(localChoices('2011-12-30T12:00', 'Pacific/Apia'), []);
 assert.throws(() => zonedDay('2011-12-30', 'Pacific/Apia'), /clock change/);
});
test('invalid dates and timezones fail without normalising into another day', () => {
 for (const value of ['2026-02-30T09:00', '2026-09-01T25:00', 'tomorrow', '2026-09-01', '1899-12-31T12:00', '2200-01-01T00:00']) assert.throws(() => localChoices(value, 'Australia/Perth'));
 assert.throws(() => localChoices('2026-09-01T09:00', 'Bad/Zone'));
 assert.equal(shiftDate('2028-02-28', 1), '2028-02-29');
 assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
});
