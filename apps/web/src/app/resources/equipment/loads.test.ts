import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellOf, combined, finish, plan, reservationsBetween, retry, seed, start, stateOf, validRead, type Cells } from './loads.ts';
import type { Reservation } from './types.ts';
const a = '00000000-0000-4000-8000-00000000000a', b = '00000000-0000-4000-8000-00000000000b';
const booking = (id: string, starts: string, ends: string, revision = 1) => ({ id, equipmentId: a, title: id, kind: 'booking', status: 'confirmed', startsAt: starts, endsAt: ends, setupMinutes: 0, cleanupMinutes: 0,
 occupiedStartsAt: starts, occupiedEndsAt: ends, projectId: null, taskId: null, ownerId: null, createdBy: a, revision, createdAt: starts, updatedAt: starts }) as Reservation;

test('reads go one at a time, nearest wanted chunk first, only for never-read cells', () => {
 let cells: Cells = seed(2, { [a]: { ok: true, reservations: [], coverage: 'complete' }, [b]: { ok: false, message: 'Down' } });
 assert.equal(stateOf(cellOf(cells, 2, a)), 'complete'); assert.equal(stateOf(cellOf(cells, 2, b)), 'failed');
 assert.equal(stateOf(cellOf(cells, 3, a)), 'unloaded');
 assert.equal(plan(cells, [2], [a, b], false), null, 'a failed cell is not re-read automatically');
 assert.deepEqual(plan(cells, [3, 1], [a, b], false), { chunk: 3, equipmentIds: [a, b] });
 assert.equal(plan(cells, [3, 1], [a, b], true), null, 'nothing while a read is in flight');
 cells = start(cells, 3, [a, b], 7);
 assert.equal(stateOf(cellOf(cells, 3, a)), 'loading');
 assert.deepEqual(plan(cells, [3, 1], [a, b], false), { chunk: 1, equipmentIds: [a, b] }, 'a loading cell is not requested twice');
});
test('responses apply only to the request they answer; missing equipment fails rather than looking free', () => {
 let cells = start({}, 0, [a, b], 1);
 assert.equal(finish(cells, 0, [a, b], 2, { [a]: { ok: true, reservations: [], coverage: 'complete' } }), cells, 'a superseded response is ignored');
 cells = finish(cells, 0, [a, b], 1, { [a]: { ok: true, reservations: [], coverage: 'partial' } });
 assert.equal(stateOf(cellOf(cells, 0, a)), 'partial'); assert.equal(stateOf(cellOf(cells, 0, b)), 'failed');
 const again = finish(cells, 0, [a, b], 1, { [a]: { ok: true, reservations: [], coverage: 'complete' } });
 assert.equal(again, cells, 'a repeated response cannot upgrade a settled cell');
 const whole = finish(start({}, 4, [a, b], 3), 4, [a, b], 3, { error: 'Session ended' });
 assert.deepEqual(cellOf(whole, 4, b), { status: 'failed', message: 'Session ended' });
});
test('retry reopens only failed cells', () => {
 const cells = seed(0, { [a]: { ok: false, message: 'Down' }, [b]: { ok: true, reservations: [], coverage: 'partial' } });
 assert.equal(stateOf(cellOf(retry(cells, 0, a), 0, a)), 'unloaded');
 assert.equal(retry(cells, 0, b), cells, 'a partial read is not retried into looking complete');
 assert.deepEqual(plan(retry(cells, 0, a), [0], [a, b], false), { chunk: 0, equipmentIds: [a] });
});
test('only complete coverage across every chunk is complete', () => {
 assert.equal(combined(['complete', 'complete']), 'complete');
 assert.equal(combined(['complete', 'partial']), 'partial');
 assert.equal(combined(['partial', 'loading']), 'loading');
 assert.equal(combined(['loading', 'unloaded']), 'unloaded');
 assert.equal(combined(['complete', 'failed', 'unloaded']), 'failed');
 assert.equal(combined([]), 'unloaded');
});
test('reservations across chunk reads are deduplicated at their newest revision and clipped to the window', () => {
 const spanning = booking('spanning', '2026-10-23T20:00:00.000Z', '2026-10-25T08:00:00.000Z');
 const cells = { ...seed(0, { [a]: { ok: true, reservations: [spanning, booking('early', '2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z')], coverage: 'complete' } }),
  ...seed(1, { [a]: { ok: true, reservations: [{ ...spanning, revision: 2, title: 'moved' }], coverage: 'complete' } }) };
 const shown = reservationsBetween(cells, [0, 1], a, Date.parse('2026-10-20T00:00:00Z'), Date.parse('2026-10-30T00:00:00Z'));
 assert.deepEqual(shown.map(r => [r.id, r.title]), [['spanning', 'moved']]);
 assert.deepEqual(reservationsBetween(cells, [0, 1], b, 0, Date.parse('2027-01-01')), []);
});
test('server reads accept one page of equipment and one window within the API limit', () => {
 const from = '2026-10-01T00:00:00.000Z', to93 = '2027-01-02T00:00:00.000Z';
 assert.deepEqual(validRead([a, b], from, to93), { equipmentIds: [a, b], from, to: to93 });
 assert.equal(validRead([a], from, '2027-01-02T00:00:00.001Z'), null, 'longer than 93 days');
 assert.equal(validRead([a], to93, from), null); assert.equal(validRead([a], from, from), null);
 assert.equal(validRead([a], '2026-10-01T00:00:00+10:00', to93), null);
 assert.equal(validRead([a, a], from, to93), null); assert.equal(validRead([], from, to93), null);
 assert.equal(validRead(['not-a-uuid'], from, to93), null); assert.equal(validRead(a, from, to93), null);
 assert.equal(validRead(Array.from({ length: 9 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`), from, to93), null);
});
