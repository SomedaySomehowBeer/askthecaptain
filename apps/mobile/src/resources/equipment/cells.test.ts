import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReadOutcome } from '../../account/contracts.ts';
import {
	bound, canTryAgain, cellKey, cellOf, combined, emptyOccupancy, failureOf, finish, keepEquipment, maxPayloadCells, mayShowFree, plan,
	reanchor, refresh, reservationsBetween, rowsOf, slotOf, start, stateBetween, stateOf, tryAgain, wanted, wayOut,
	type Occupancy, type Slot
} from './cells.ts';
import type { Coverage, OccupancyAnswer, Reservation } from './data.ts';
import type { Chunk } from './range.ts';

type Outcome = ReadOutcome<OccupancyAnswer>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const a = id(10), b = id(11), c = id(12), d = id(13);
const r1 = id(901), r2 = id(902);
const chunk = (from: string, to: string): Chunk => ({ from: `${from}T00:00:00.000Z`, to: `${to}T00:00:00.000Z`, fromDate: from, toDate: to });
const cm1 = chunk('2026-08-31', '2026-09-28'), c0 = chunk('2026-09-28', '2026-10-26'), c1 = chunk('2026-10-26', '2026-11-23'), c2 = chunk('2026-11-23', '2026-12-21');
const chunks = [cm1, c0, c1, c2];
const booking = (rid: string, starts: string, ends: string, revision = 1): Reservation => ({
	id: rid, title: rid, kind: 'booking', startsAt: starts, endsAt: ends, occupiedStartsAt: starts, occupiedEndsAt: ends,
	setupMinutes: 0, cleanupMinutes: 0, revision
});
const ok = (reservations: Reservation[], coverage: Coverage = 'complete'): Outcome => ({ kind: 'ok', value: { kind: 'read', coverage, reservations } });
const network: Outcome = { kind: 'unavailable', wait: null };
const everything = [0, Date.parse('2100-01-01T00:00:00.000Z')] as const;
/** Sends one planned read and applies its answer, as the hook does after the coordinator admits it. */
function load(occupancy: Occupancy, slot: Slot, outcome: Outcome) {
	const request = {};
	const done = finish(start(occupancy, slot, request), slot, request, outcome);
	assert.equal(done.applied, outcome.kind !== 'superseded');
	return done;
}
const ids = (occupancy: Occupancy, equipmentId: string) => reservationsBetween(occupancy, equipmentId, ...everything).map((r) => [r.id, r.title, r.revision]);

test('cells are keyed by equipment and exact instants, never a chunk index', () => {
	const s = slotOf(a, c0);
	assert.equal(cellKey(s), `${a} ${c0.from} ${c0.to}`);
	const occupancy = load(emptyOccupancy, s, ok([])).occupancy;
	assert.equal(stateOf(cellOf(occupancy, s)), 'complete');
	const shifted = chunk('2026-09-29', '2026-10-27');
	assert.equal(stateOf(cellOf(occupancy, slotOf(a, shifted))), 'unread', 'the same position in another range is another cell');
	assert.equal(stateOf(cellOf(occupancy, slotOf(b, c0))), 'unread');
	assert.equal(stateOf(cellOf(reanchor(occupancy, [cm1, c0, c1]), s)), 'complete', 're-anchoring keeps keys that match by instants');
	assert.deepEqual(reanchor(occupancy, [shifted, c1]).cells, {}, 'and drops every other key');
});

test('wanted cells: visible columns and the partly visible next one, visible chunks then either side, nearest the centre first', () => {
	const view = { visible: [a, b, c], next: d, chunks, low: Date.parse('2026-10-05T00:00:00.000Z'), high: Date.parse('2026-10-12T00:00:00.000Z') };
	const order = [b, a, c, d];
	assert.deepEqual(wanted(view), [c0, cm1, c1].flatMap((k) => order.map((e) => slotOf(e, k))));
	const across = wanted({ ...view, low: Date.parse('2026-10-20T00:00:00.000Z'), high: Date.parse('2026-10-30T00:00:00.000Z') });
	assert.deepEqual([...new Set(across.map((s) => s.from))], [c0.from, c1.from, cm1.from, c2.from]);
	assert.equal(across.length, 16);
	assert.deepEqual(wanted({ ...view, visible: [a, a], next: a }).map((s) => s.equipmentId), [a, a, a], 'no column twice');
	assert.deepEqual(wanted({ ...view, visible: [] }), []);
	assert.deepEqual(wanted({ ...view, high: view.low }), []);
	assert.deepEqual(wanted({ ...view, low: Date.parse('2030-01-01T00:00:00.000Z'), high: Date.parse('2030-02-01T00:00:00.000Z') }), [], 'nothing outside the range');
	const edge = wanted({ ...view, low: Date.parse('2026-09-01T00:00:00.000Z'), high: Date.parse('2026-09-05T00:00:00.000Z') });
	assert.deepEqual([...new Set(edge.map((s) => s.from))], [cm1.from, c0.from], 'no chunk past the range end');
});

test('reads go one at a time to the first wanted cell never read; failed, partial and loading cells are not read again', () => {
	const want = [slotOf(a, c0), slotOf(b, c0), slotOf(a, c1), slotOf(b, c1)] as const;
	let occupancy = load(emptyOccupancy, want[0], ok([], 'partial')).occupancy;
	occupancy = load(occupancy, want[1], network).occupancy;
	assert.equal(stateOf(cellOf(occupancy, want[1])), 'failed');
	assert.deepEqual(plan(occupancy, want), want[2]);
	occupancy = start(occupancy, want[2], {});
	assert.equal(stateOf(cellOf(occupancy, want[2])), 'loading');
	assert.deepEqual(plan(occupancy, want), want[3], 'a loading cell is not requested twice');
	for (const slot of want.slice(0, 3)) assert.equal(start(occupancy, slot, {}), occupancy, 'only a plannable cell starts');
	assert.equal(plan(occupancy, want.slice(0, 3)), null, 'a failed or partial cell is never read automatically');
	assert.equal(plan(occupancy, []), null, 'nothing unwanted is read');
});

test('an answer applies only to the cell still waiting on that exact request', () => {
	const s = slotOf(a, c0), first = {}, second = {};
	const loading = start(emptyOccupancy, s, first);
	const other = finish(loading, s, second, ok([]));
	assert.equal(other.applied, false);
	assert.equal(other.occupancy, loading, 'a superseded request is ignored');
	assert.equal(finish(loading, slotOf(b, c0), first, ok([])).applied, false, 'another cell is not answered');
	const done = finish(loading, s, first, ok([], 'partial'));
	assert.equal(stateOf(cellOf(done.occupancy, s)), 'partial');
	const again = finish(done.occupancy, s, first, ok([]));
	assert.equal(again.occupancy, done.occupancy, 'a repeated answer cannot upgrade a settled cell');
	assert.equal(finish(reanchor(loading, [c0]), s, first, ok([])).applied, false, 'a re-anchor forgets the old request');
	assert.equal(finish(refresh(loading), s, first, ok([])).applied, false, 'so does Refresh');
	const superseded = finish(loading, s, first, { kind: 'superseded' });
	assert.equal(superseded.applied, false);
	assert.equal(cellOf(superseded.occupancy, s), undefined, 'superseded applies nothing');
});

test('failures keep their reason and wait; no failure can show free time', () => {
	const s = slotOf(a, c0), wait = { until: 5_000, about: '2026-09-28T00:00:05.000Z' };
	const unreadable = { reason: 'unreadable', wait: null } as const, access = { reason: 'access', wait: null } as const;
	const cases: [Outcome, { reason: string; wait: unknown }][] = [
		[{ kind: 'unavailable', wait }, { reason: 'unavailable', wait }],
		[network, { reason: 'unavailable', wait: null }],
		[{ kind: 'refused', status: 403 }, access],
		[{ kind: 'refused', status: 404 }, access],
		[{ kind: 'refused', status: 400 }, unreadable],
		[{ kind: 'refused', status: 409 }, unreadable],
		[{ kind: 'client-bug' }, unreadable]
	];
	for (const [outcome, expected] of cases) {
		const done = load(emptyOccupancy, s, outcome), cell = cellOf(done.occupancy, s);
		assert.equal(stateOf(cell), 'failed');
		assert.equal(done.stop, null, 'the coordinator, not the cells, stops on a failure');
		assert.deepEqual(failureOf(cell), expected);
		assert.equal(rowsOf(cell), null, 'a failed cell holds only a marker');
		assert.equal(mayShowFree(stateOf(cell)), false);
		assert.equal(canTryAgain(cell), expected.reason !== 'access', 'an access refusal lifts only by Refresh');
	}
	for (const state of ['unread', 'loading', 'failed', 'partial', 'conflict', 'stale'] as const) assert.equal(mayShowFree(state), false);
	assert.equal(mayShowFree('complete'), true);
});

test('Try again reopens only failed cells; partial, conflict, complete, access and unread cells are not retried', () => {
	const s = slotOf(a, c0), request = {};
	const retried = tryAgain(load(emptyOccupancy, s, network).occupancy, s, request);
	assert.equal(stateOf(cellOf(retried, s)), 'loading');
	assert.equal(stateOf(cellOf(finish(retried, s, request, ok([])).occupancy, s)), 'complete');
	const refusals: Outcome[] = [ok([], 'partial'), ok([]), { kind: 'refused', status: 404 }];
	for (const outcome of refusals) {
		const occupancy = load(emptyOccupancy, s, outcome).occupancy;
		assert.equal(canTryAgain(cellOf(occupancy, s)), false);
		assert.equal(tryAgain(occupancy, s, {}), occupancy);
	}
	assert.equal(tryAgain(emptyOccupancy, s, {}), emptyOccupancy, 'an unread cell is planned, not retried');
});

test('the same reservation at the same revision with different details is never chosen silently', () => {
	const x = booking(r1, '2026-10-25T20:00:00.000Z', '2026-10-26T04:00:00.000Z'), other = booking(r2, '2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z');
	const s0 = slotOf(a, c0), s1 = slotOf(a, c1);
	const occupancy = load(emptyOccupancy, s0, ok([x, other])).occupancy;
	const same = load(occupancy, s1, ok([{ ...x }]));
	assert.equal(same.stop, null, 'identical copies across chunks agree');
	assert.deepEqual(ids(same.occupancy, a), [[r2, r2, 1], [r1, r1, 1]], 'and are drawn once');
	const newer = load(occupancy, s1, ok([{ ...x, revision: 2, title: 'Moved' }]));
	assert.equal(newer.stop, null, 'different revisions are not a conflict');
	assert.deepEqual(ids(newer.occupancy, a), [[r2, r2, 1], [r1, 'Moved', 2]], 'the highest revision is drawn');

	const conflict = load(occupancy, s1, ok([{ ...x, title: 'Changed' }], 'partial'));
	assert.equal(conflict.stop, 'conflict');
	assert.equal(stateOf(cellOf(conflict.occupancy, s0)), 'conflict');
	assert.equal(stateOf(cellOf(conflict.occupancy, s1)), 'conflict');
	assert.deepEqual(ids(conflict.occupancy, a), [[r2, r2, 1]], 'the contradicted reservation is drawn from neither cell');
	assert.equal(canTryAgain(cellOf(conflict.occupancy, s0)), false, 'no Try again');
	assert.equal(plan(conflict.occupancy, [s0, s1]), null, 'no automatic re-read');
	assert.equal(stateBetween(conflict.occupancy, a, chunks, Date.parse(c0.from), Date.parse(c1.to)), 'conflict');

	const changes = [{ title: 'Other' }, { kind: 'maintenance' }, { startsAt: '2026-10-25T21:00:00.000Z' }, { endsAt: '2026-10-26T05:00:00.000Z' },
		{ occupiedStartsAt: '2026-10-25T19:00:00.000Z' }, { occupiedEndsAt: '2026-10-26T05:00:00.000Z' }, { setupMinutes: 5 }, { cleanupMinutes: 5 }];
	for (const change of changes) assert.equal(load(occupancy, s1, ok([{ ...x, ...change } as Reservation])).stop, 'conflict', Object.keys(change)[0]);
	const elsewhere = load(occupancy, slotOf(b, c0), ok([{ ...x }]));
	assert.equal(elsewhere.stop, 'conflict', 'one reservation reported under two equipment is contradictory');
	assert.deepEqual(ids(elsewhere.occupancy, b), []);

	const later = load(conflict.occupancy, slotOf(a, c2), ok([{ ...x, revision: 3, title: 'Newest' }]));
	assert.deepEqual(ids(later.occupancy, a), [[r2, r2, 1]], 'a contradicted ID stays undrawn until Refresh');

	const refreshed = refresh(conflict.occupancy);
	assert.deepEqual(refreshed.conflicted, [], 'only Refresh clears the conflict');
	assert.equal(stateOf(cellOf(refreshed, s0)), 'stale');
	assert.deepEqual(ids(refreshed, a), [[r2, r2, 1]], 'stale rows never include a contradicted copy');
	assert.deepEqual(plan(refreshed, [s0, s1]), s0, 'and Refresh re-reads them');
});

test('a zone change applies nothing: every payload becomes stale and the queue must stop', () => {
	const x = booking(r1, '2026-10-01T00:00:00.000Z', '2026-10-01T02:00:00.000Z');
	const s0 = slotOf(a, c0), s1 = slotOf(a, c1), s2 = slotOf(b, c0);
	let occupancy = load(emptyOccupancy, s0, ok([x])).occupancy;
	occupancy = load(occupancy, s2, network).occupancy;
	const request = {};
	const done = finish(start(occupancy, s1, request), s1, request, { kind: 'ok', value: { kind: 'zone-changed' } });
	assert.equal(done.applied, true);
	assert.equal(done.stop, 'zone');
	assert.equal(stateOf(cellOf(done.occupancy, s0)), 'stale');
	assert.equal(stateOf(cellOf(done.occupancy, s1)), 'unread', 'the answering cell applies nothing');
	assert.equal(stateOf(cellOf(done.occupancy, s2)), 'failed');
	assert.deepEqual(ids(done.occupancy, a), [[r1, r1, 1]], 'the last bars stay, labelled stale');
});

test('Refresh: payloads become stale, markers and failures clear, a failed re-read keeps the stale rows', () => {
	const x = booking(r1, '2026-10-01T00:00:00.000Z', '2026-10-01T02:00:00.000Z'), y = booking(r2, '2026-10-02T00:00:00.000Z', '2026-10-02T02:00:00.000Z');
	const s0 = slotOf(a, c0), s1 = slotOf(a, c1), s2 = slotOf(b, c0), s3 = slotOf(b, c1), inFlight = {};
	let occupancy = load(emptyOccupancy, s0, ok([x])).occupancy;
	occupancy = load(occupancy, s1, ok([], 'partial')).occupancy;
	occupancy = load(occupancy, s2, network).occupancy;
	occupancy = start(occupancy, s3, inFlight);
	const fresh = refresh(occupancy);
	assert.deepEqual([s0, s1, s2, s3].map((s) => stateOf(cellOf(fresh, s))), ['stale', 'stale', 'unread', 'unread']);
	assert.equal(finish(fresh, s3, inFlight, ok([])).applied, false, 'answers of the previous generation are dropped');
	assert.deepEqual(plan(fresh, [s0, s1, s2, s3]), s0, 'stale cells are re-read');

	const request = {};
	const sent = start(fresh, s0, request);
	assert.equal(stateOf(cellOf(sent, s0)), 'stale', 'the stale bars stay while re-reading');
	assert.deepEqual(plan(sent, [s0, s1]), s1);
	const failed = finish(sent, s0, request, network).occupancy;
	const cell = cellOf(failed, s0);
	assert.equal(stateOf(cell), 'stale');
	assert.deepEqual(failureOf(cell), { reason: 'unavailable', wait: null });
	assert.deepEqual(ids(failed, a), [[r1, r1, 1]]);
	assert.equal(plan(failed, [s0]), null, 'a failed re-read is not repeated automatically');
	assert.equal(canTryAgain(cell), true);

	const again = {};
	const retrying = tryAgain(failed, s0, again);
	assert.equal(failureOf(cellOf(retrying, s0)), null);
	const replaced = finish(retrying, s0, again, ok([y])).occupancy;
	assert.equal(stateOf(cellOf(replaced, s0)), 'complete');
	assert.deepEqual(ids(replaced, a), [[r2, r2, 1]], 'a successful read replaces the stale rows');

	const refused = finish(start(fresh, s0, request), s0, request, { kind: 'refused', status: 403 }).occupancy;
	assert.equal(canTryAgain(cellOf(refused, s0)), false, 'a stale access refusal needs Refresh');
	assert.deepEqual(refresh(refused).cells[cellKey(s0)], { ...s0, state: 'stale', previous: [x], failure: null, request: null });
});

test('retained payloads are bounded; only complete cells return to unread, others leave markers never read again', () => {
	const columns = [a, b, c, d], centre = { columns, column: 0, chunks, at: Date.parse('2026-10-10T00:00:00.000Z') };
	const near = slotOf(a, c0), side = slotOf(b, c1), far = slotOf(c, c0), farthest = slotOf(d, c0);
	let occupancy = load(emptyOccupancy, near, ok([booking(r1, '2026-10-01T00:00:00.000Z', '2026-10-01T02:00:00.000Z')])).occupancy;
	occupancy = load(occupancy, side, ok([], 'partial')).occupancy;
	occupancy = load(occupancy, far, ok([])).occupancy;
	occupancy = load(occupancy, farthest, ok([booking(r2, '2026-10-01T00:00:00.000Z', '2026-10-01T02:00:00.000Z')], 'partial')).occupancy;
	assert.equal(bound(occupancy, centre, 4), occupancy);
	const kept = bound(occupancy, centre, 2);
	assert.deepEqual([near, side, far, farthest].map((s) => stateOf(cellOf(kept, s))), ['complete', 'partial', 'unread', 'partial']);
	assert.equal(cellOf(kept, farthest)?.state, 'marker');
	assert.equal(rowsOf(cellOf(kept, farthest)), null);
	assert.deepEqual(ids(kept, d), [], 'a marker draws no bars');
	assert.equal(stateBetween(kept, d, chunks, Date.parse(c0.from), Date.parse(c0.to)), 'partial', 'and shows no free time');
	assert.deepEqual(plan(kept, [farthest, far]), far, 'an evicted complete cell may be read again, a marker never');
	assert.equal(plan(kept, [farthest]), null);
	assert.equal(stateOf(cellOf(refresh(kept), farthest)), 'unread', 'Refresh clears markers');
	assert.equal(cellOf(reanchor(kept, [c0]), farthest)?.state, 'marker', 'a re-anchor keeps markers in range');

	const staleCells = refresh(occupancy), pending = {};
	const reading = start(staleCells, farthest, pending);
	const trimmed = bound(reading, centre, 2);
	assert.equal(cellOf(trimmed, farthest)?.state, 'stale', 'a cell awaiting its re-read is not evicted');
	assert.deepEqual([near, side, far].map((s) => cellOf(trimmed, s)?.state), ['stale', 'marker', 'marker'], 'the farthest others are evicted instead');
	const failedStale = finish(start(staleCells, far, pending), far, pending, network).occupancy;
	const marker = cellOf(bound(failedStale, centre, 1), far);
	assert.equal(marker?.state, 'marker');
	assert.equal(canTryAgain(marker), true, 'a failed stale marker keeps its Try again');

	let many = emptyOccupancy;
	const listed = Array.from({ length: maxPayloadCells + 1 }, (_, i) => id(100 + i));
	for (const equipmentId of listed) many = load(many, slotOf(equipmentId, c0), ok([])).occupancy;
	const limited = bound(many, { ...centre, columns: listed });
	assert.equal(Object.keys(limited.cells).length, maxPayloadCells);
	assert.equal(cellOf(limited, slotOf(listed[maxPayloadCells]!, c0)), undefined, 'the farthest column goes first');
	const unknown = bound(many, { ...centre, columns: listed.slice(1) });
	assert.equal(cellOf(unknown, slotOf(listed[0]!, c0)), undefined, 'a column no longer loaded is farthest');
});

test('only complete coverage across every cell is complete', () => {
	assert.equal(combined(['complete', 'complete']), 'complete');
	assert.equal(combined(['complete', 'partial']), 'partial');
	assert.equal(combined(['partial', 'loading']), 'loading');
	assert.equal(combined(['loading', 'unread']), 'unread');
	assert.equal(combined(['unread', 'stale']), 'stale');
	assert.equal(combined(['stale', 'conflict']), 'conflict');
	assert.equal(combined(['complete', 'failed', 'conflict']), 'failed');
	assert.equal(combined([]), 'unread');
	const occupancy = [slotOf(a, c0), slotOf(a, c1)].reduce((o, s) => load(o, s, ok([])).occupancy, emptyOccupancy);
	const at = (date: string) => Date.parse(`${date}T00:00:00.000Z`);
	assert.equal(stateBetween(occupancy, a, chunks, at('2026-10-01'), at('2026-10-02')), 'complete');
	assert.equal(stateBetween(occupancy, a, chunks, at('2026-10-20'), at('2026-11-01')), 'complete');
	assert.equal(stateBetween(occupancy, a, chunks, at('2026-11-20'), at('2026-11-25')), 'unread');
	assert.equal(stateBetween(occupancy, b, chunks, at('2026-10-01'), at('2026-10-02')), 'unread');
	assert.equal(stateBetween(occupancy, a, [c0, c1], at('2026-09-27'), at('2026-10-02')), 'unread', 'time outside the range is never complete');
	assert.equal(stateBetween(occupancy, a, chunks, at('2026-10-02'), at('2026-10-02')), 'unread');
	assert.equal(stateBetween(occupancy, a, [], at('2026-10-01'), at('2026-10-02')), 'unread');
});

test('reservations across chunk reads are deduplicated at their newest revision and clipped to the window', () => {
	const spanning = booking(r1, '2026-10-23T20:00:00.000Z', '2026-10-27T08:00:00.000Z');
	let occupancy = load(emptyOccupancy, slotOf(a, c0), ok([spanning, booking(r2, '2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z')])).occupancy;
	occupancy = load(occupancy, slotOf(a, c1), ok([{ ...spanning, revision: 2, title: 'moved' }])).occupancy;
	const shown = reservationsBetween(occupancy, a, Date.parse('2026-10-20T00:00:00.000Z'), Date.parse('2026-10-30T00:00:00.000Z'));
	assert.deepEqual(shown.map((r) => [r.id, r.title]), [[r1, 'moved']]);
	assert.deepEqual(reservationsBetween(occupancy, b, ...everything), []);
	const older = load(load(emptyOccupancy, slotOf(a, c1), ok([{ ...spanning, revision: 2, title: 'moved' }])).occupancy, slotOf(a, c0), ok([spanning])).occupancy;
	assert.deepEqual(ids(older, a), [[r1, 'moved', 2]], 'arrival order does not matter');
	const edge = reservationsBetween(occupancy, a, Date.parse('2026-10-01T01:00:00.000Z'), Date.parse('2026-10-02T00:00:00.000Z'));
	assert.deepEqual(edge, [], 'a reservation ending at the window start is outside it');
});

test('the way out of a stop: Try again while a shown cell offers it, otherwise Refresh (A\'s C3)', () => {
	const s0 = slotOf(a, c0), s1 = slotOf(a, c1);
	const failed = load(load(emptyOccupancy, s0, network).occupancy, s1, ok([])).occupancy;
	assert.equal(wayOut(failed, [s0, s1], 'retry'), 'try-again');
	const moved = reanchor(failed, [c1, c2]);
	assert.equal(wayOut(moved, [s1], 'retry'), 'refresh', 'the failed cell was re-anchored away');
	assert.equal(wayOut(failed, [s1], 'retry'), 'refresh', 'the failed cell is not shown');
	for (const stop of ['access', 'conflict', 'zone'] as const) assert.equal(wayOut(failed, [s0, s1], stop), 'refresh');
	assert.equal(wayOut(failed, [s0], 'superseded'), null);
	assert.equal(wayOut(failed, [s0], null), null);
	const refused = load(emptyOccupancy, s0, { kind: 'refused', status: 403 }).occupancy;
	assert.equal(wayOut(refused, [s0], 'retry'), 'refresh');
});

test('cells for equipment no longer listed are dropped', () => {
	const occupancy = [slotOf(a, c0), slotOf(b, c0)].reduce((o, s) => load(o, s, ok([])).occupancy, emptyOccupancy);
	const kept = keepEquipment(occupancy, [b]);
	assert.equal(cellOf(kept, slotOf(a, c0)), undefined);
	assert.equal(stateOf(cellOf(kept, slotOf(b, c0))), 'complete');
});
