import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReadOutcome } from '../../account/contracts.ts';
import { equipmentCopy } from '../../account/copy.ts';
import { catalogueView } from './catalogue.ts';
import { cellOf, slotOf, stateOf } from './cells.ts';
import { DAY, labelFormatsOk, scheduleRange } from './range.ts';
import {
	beginRead, columnsAt, createSchedule, panelRow, press, pressEdge, pressRefresh, readRequest, receive, retryableSlots, scheduleScreen, settle, settledFrom,
	wakeDelay, wayOutAll, type InFlight, type ScheduleState, type SettledView
} from './schedule.ts';

const organisationId = '00000000-0000-4000-8000-0000000000aa', userId = '00000000-0000-4000-8000-0000000000bb';
const scope = { epoch: 'e1', userId, organisationId };
const wall = new Date('2026-09-28T02:00:00.000Z'); // midday on 28 September in Sydney
const sydney = 'Australia/Sydney';
const anchorAt = Date.parse(scheduleRange('2026-09-28', sydney).anchorAt);
const hour = 3_600_000;
const eq = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);
const stamp = '2026-01-01T00:00:00.000Z';
const iso = (at: number) => new Date(at).toISOString();

type Occupancy = Extract<InFlight, { kind: 'occupancy' }>;
type Fixture = {
	zone: string; occupancyZone?: string;
	pages: Record<number, { ids: number[]; more: boolean }>;
	rows?: (read: Occupancy) => unknown[];
};
const three: Fixture = { zone: sydney, pages: { 0: { ids: ids(1, 3), more: false } } };
const hundred: Fixture = { zone: sydney, pages: { 0: { ids: ids(1, 100), more: true }, 100: { ids: [101, 102, 103], more: false } } };

/** The raw API body for a read, as the harness serves it by path. */
function body(read: InFlight, fx: Fixture): unknown {
	if (read.kind === 'organisation') return { id: organisationId, name: 'Harbour', timezone: fx.zone, locale: 'en-AU', createdAt: stamp, role: 'owner' };
	if (read.kind === 'catalogue') {
		const page = fx.pages[read.request.offset] ?? { ids: [], more: false };
		return {
			equipment: page.ids.map((n) => ({ id: eq(n), name: `Kit ${n}`, archivedAt: null, revision: 1, createdAt: stamp, updatedAt: stamp })),
			nextOffset: page.more ? read.request.offset + 100 : null
		};
	}
	return { reservations: fx.rows?.(read) ?? [], nextOffset: null, coverage: 'complete', from: read.slot.from, to: read.slot.to, timezone: fx.occupancyZone ?? fx.zone };
}
/** Every answer goes through the request's own real parser. */
const served = (fx: Fixture) => (read: InFlight): ReadOutcome<unknown> => ({ kind: 'ok', value: readRequest(read).parse(body(read, fx)) });
const answer = (outcome: ReadOutcome<unknown>) => (): ReadOutcome<unknown> => outcome;
const offline: ReadOutcome<unknown> = { kind: 'unavailable', wait: null };
const waitUntil = (until: number): ReadOutcome<unknown> => ({ kind: 'unavailable', wait: { until, about: '2026-09-28T02:05:00.000Z' } });

function send(state: ScheduleState, now: number, reply: (read: InFlight) => ReadOutcome<unknown>) {
	const begun = beginRead(state, now);
	assert.ok(begun.read, 'a read is sent');
	return { state: receive(begun.state, begun.read, reply(begun.read), wall), read: begun.read };
}
function mount(fx: Fixture = three): ScheduleState {
	const bootstrapped = send(createSchedule(scope), 0, served(fx)).state;
	return send(bootstrapped, 0, served(fx)).state;
}
const view = (over: Partial<SettledView> = {}): SettledView => ({ x: 0, width: 375, columnWidth: 125, low: anchorAt + hour, high: anchorAt + DAY, ...over });
/** Sends and answers reads until none is sent, spacing them so the rolling budget never binds. */
function drain(state: ScheduleState, fx: Fixture, from = 0, reply = served(fx)) {
	const reads: InFlight[] = [];
	let s = state, now = from;
	for (let i = 0; i < 60; i++, now += 3_000) {
		const begun = beginRead(s, now);
		if (!begun.read) { s = begun.state; break; }
		reads.push(begun.read);
		s = receive(begun.state, begun.read, reply(begun.read), wall);
	}
	return { state: s, reads, now };
}

test('mount order: the organisation read alone first, a page only after the zone gate, occupancy only after page 0 and a settle', () => {
	let s = createSchedule(scope);
	assert.equal(scheduleScreen(s, 0, true).body, 'loading');
	const first = beginRead(s, 0);
	assert.equal(first.read?.kind, 'organisation');
	assert.equal(beginRead(first.state, 0).read, null, 'one flight: nothing else while the bootstrap is out');
	s = receive(first.state, first.read!, served(three)(first.read!), wall);
	assert.equal(s.zone.kind, 'ok');
	assert.equal(s.range?.anchor, '2026-09-28', "today in the organisation's zone, captured once");
	const page = beginRead(s, 0);
	assert.equal(page.read?.kind, 'catalogue');
	assert.equal(page.read?.kind === 'catalogue' && page.read.request.offset, 0);
	s = receive(page.state, page.read!, served(three)(page.read!), wall);
	assert.equal(scheduleScreen(s, 0, true).body, 'timeline');
	assert.equal(beginRead(s, 0).read, null, 'no occupancy before the view has settled');
	const read = beginRead(settle(s, view()), 0).read;
	assert.equal(read?.kind, 'occupancy');
	assert.equal(read?.kind === 'occupancy' && read.slot.equipmentId, eq(2), 'the centre column of the settled view first');
});

test('an unsupported zone reads no catalogue or occupancy; Refresh bootstraps again and a passing zone continues', () => {
	let s = send(createSchedule(scope), 0, served({ ...three, zone: 'Not/AZone' })).state;
	assert.equal(s.zone.kind, 'unsupported');
	assert.equal(beginRead(s, 0).read, null);
	assert.equal(beginRead(press(s, { kind: 'more' }), 0).read, null, 'not even an explicit press');
	const screen = scheduleScreen(s, 0, true);
	assert.equal(screen.body, 'zone-unsupported');
	assert.equal(screen.bodyText, equipmentCopy.zoneUnsupported);
	assert.deepEqual(screen.refresh, { disabled: false, reason: null, queued: false });
	s = pressRefresh(s, 0, true)!;
	s = send(s, 0, served(three)).state;
	assert.equal(s.zone.kind, 'ok');
	const page = beginRead(s, 0).read;
	assert.equal(page?.kind === 'catalogue' && page.request.intent, 'refresh', 'page 0 follows the new bootstrap');
	assert.equal(labelFormatsOk(sydney), true);
	assert.equal(labelFormatsOk('Not/AZone'), false, 'an unusable zone fails the label formatter check (review N3)');
});

test('settle maths: the body top excludes the body itself, and the sticky row hides the first pixels (review N1)', () => {
	const range = scheduleRange('2026-09-28', sydney), start = Date.parse(range.start), days = 84;
	const layout = { x: 0, y: 0, columnsWidth: 300, columnWidth: 125, viewportHeight: 800, bodyTop: 240, stickyHeight: 40 };
	const top = settledFrom(layout, range, 'days');
	assert.equal(top.low, start, 'header 200 + sticky 40: at y = 0 the first visible instant is the range start');
	assert.equal(top.high, start + (800 - 240) / days * DAY);
	const scrolled = settledFrom({ ...layout, y: 1_000 }, range, 'days');
	assert.equal(scrolled.low, start + (1_000 + 40 - 240) / days * DAY, 'below the sticky row once scrolled');
	assert.ok(settledFrom({ ...layout, y: 1e9 }, range, 'days').high <= Date.parse(range.end), 'clipped to the range');
	assert.deepEqual(columnsAt({ x: 0, width: 300, columnWidth: 125, low: 0, high: 1 }, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]),
		{ visible: ['a', 'b', 'c'], next: 'd', centre: 1 });
	assert.deepEqual(columnsAt({ x: 250, width: 300, columnWidth: 125, low: 0, high: 1 }, [{ id: 'a' }]), { visible: [], next: null, centre: 0 });
});

test('one flight across every kind; a press made while busy is queued and sent before occupancy', () => {
	let s = settle(mount(hundred), view());
	const cell = beginRead(s, 0);
	assert.equal(cell.read?.kind, 'occupancy');
	s = press(cell.state, { kind: 'more' });
	assert.equal(beginRead(s, 0).read, null, 'busy');
	assert.equal(scheduleScreen(s, 0, true).more?.kind, 'offered');
	s = receive(s, cell.read!, served(hundred)(cell.read!), wall);
	const next = beginRead(s, 0).read;
	assert.equal(next?.kind === 'catalogue' && next.request.offset, 100, 'the queued More goes first');
});

test('the rolling budget: the 31st start in a minute waits, and the wake sends it exactly at the boundary', () => {
	let s = settle(mount(hundred), view({ width: 1_250 }));
	for (let i = 0; i < 28; i++) s = send(s, 0, served(hundred)).state;
	assert.equal(s.gate.starts.length, 30);
	assert.equal(beginRead(s, 0).read, null);
	assert.equal(wakeDelay(s, 0), 60_000);
	assert.equal(scheduleScreen(s, 0, true).refresh?.reason, equipmentCopy.pacing);
	assert.equal(beginRead(s, 59_999).read, null);
	assert.equal(beginRead(s, 60_000).read?.kind, 'occupancy');
});

test('a wait from a catalogue page blocks occupancy and Refresh; Refresh after it keeps the wait and the rate log', () => {
	let s = settle(mount(hundred), view());
	s = send(press(s, { kind: 'more' }), 10, answer(waitUntil(5_000))).state;
	assert.equal(beginRead(s, 100).read, null);
	assert.equal(pressRefresh(s, 100, true), null, 'nothing changes (W1)');
	assert.match(scheduleScreen(s, 100, true).refresh?.reason ?? '', /^Try again after about /);
	assert.equal(wakeDelay(s, 100), 4_900);
	const refreshed = pressRefresh(s, 5_000, true)!;
	assert.deepEqual(refreshed.gate.starts, s.gate.starts);
	assert.deepEqual(refreshed.gate.wait, s.gate.wait);
	assert.equal(beginRead(refreshed, 5_000).read?.kind, 'organisation', 'Refresh bootstraps first (W2)');
});

test('Refresh drops equipment no longer listed, and no read is ever sent for it (design E1)', () => {
	let s = mount(hundred);
	s = send(press(s, { kind: 'more' }), 0, served(hundred)).state;
	assert.equal(s.catalogue.columns.length, 103);
	s = settle(s, view({ x: 100 * 125 }));
	let run = drain(s, hundred, 3_000);
	assert.ok(run.reads.some((r) => r.kind === 'occupancy' && r.slot.equipmentId === eq(101)));
	s = pressRefresh(run.state, run.now + 60_000, true)!;
	run = drain(s, hundred, run.now + 60_000);
	assert.deepEqual(run.reads.slice(0, 2).map((r) => r.kind), ['organisation', 'catalogue'], 'bootstrap, then page 0 (W2)');
	assert.equal(run.state.catalogue.columns.length, 100, 'only page 0 after Refresh');
	const later = new Set([eq(101), eq(102), eq(103)]);
	assert.ok(!run.reads.some((r) => r.kind === 'occupancy' && later.has(r.slot.equipmentId)), 'no read for dropped equipment before the next settle');
	assert.equal(cellOf(run.state.occupancy, slotOf(eq(101), run.state.range!.chunks[run.state.range!.anchorChunk]!)), undefined, 'their cells are dropped');
	run = drain(settle(run.state, view({ x: 97 * 125 })), hundred, run.now);
	assert.ok(run.reads.length > 0);
	assert.ok(run.reads.every((r) => r.kind === 'occupancy' && !later.has(r.slot.equipmentId)), 'nor after it');
});

test('an access refusal stops everything; Refresh waits for the account check (design E2)', () => {
	let s = settle(mount(), view());
	s = send(s, 0, answer({ kind: 'refused', status: 404 })).state;
	assert.equal(s.gate.stop, 'access');
	const screen = scheduleScreen(s, 0, false);
	assert.equal(screen.problem, equipmentCopy.access);
	assert.deepEqual(screen.refresh, { disabled: true, reason: equipmentCopy.checkingAccess, queued: false });
	assert.equal(screen.cellRetry, null, 'an access failure offers no Try again');
	assert.equal(pressRefresh(s, 0, false), null, 'while the account is still refreshing');
	assert.equal(pressRefresh(s, 0, true)?.gate.stop, null, 'once it has checked, with the scope unchanged');
});

/** Three failed cells without a stop: each failure carried a server wait. */
function threeFailed(fx: Fixture = hundred) {
	let s = settle(mount(fx), view());
	for (let t = 0; t < 3; t++) s = send(s, t, answer(waitUntil(t + 1))).state;
	assert.equal(s.gate.stop, null);
	const failed = retryableSlots(s);
	assert.equal(failed.length, 3);
	return { s, failed };
}

test('"Try again for the dates shown" offline sends exactly one read; a success continues one at a time (design E3)', () => {
	const { s, failed } = threeFailed();
	const screen = scheduleScreen(s, 3, true);
	assert.equal(screen.cellRetry?.label, equipmentCopy.tryAgainShown);
	let batch = press(s, screen.cellRetry!.intent);
	const sent = send(batch, 3, answer(offline));
	assert.equal(sent.read.kind === 'occupancy' && sent.read.slot.equipmentId, failed[0]!.equipmentId);
	assert.equal(sent.state.intent, null, 'the rest of the batch is dropped');
	assert.equal(sent.state.gate.stop, 'retry');
	assert.equal(beginRead(sent.state, 4).read, null, 'offline: one failing read, not three');

	batch = press(s, { kind: 'cell-retry', slots: failed });
	let run = send(batch, 3, served(hundred));
	assert.equal(run.state.intent?.kind === 'cell-retry' && run.state.intent.slots.length, 2);
	run = send(run.state, 4, served(hundred));
	run = send(run.state, 5, served(hundred));
	assert.equal(run.state.intent, null);
	assert.ok(failed.every((slot) => stateOf(cellOf(run.state.occupancy, slot)) === 'complete'));
	const waited = send(press(s, { kind: 'cell-retry', slots: failed }), 3, answer(waitUntil(9)));
	assert.equal(waited.state.intent, null, 'a wait drops the rest too');
});

test('a failed batch read clears only that batch: a More pressed meanwhile is still sent (review N2)', () => {
	const { s, failed } = threeFailed();
	const begun = beginRead(press(s, { kind: 'cell-retry', slots: failed }), 3);
	assert.ok(begun.read?.kind === 'occupancy' && begun.read.batch !== null);
	const more = press(begun.state, { kind: 'more' });
	const after = receive(more, begun.read!, waitUntil(10), wall);
	assert.deepEqual(after.intent, { kind: 'more' });
	assert.equal(beginRead(after, 5).read, null, 'kept through the wait');
	const next = beginRead(after, 10).read;
	assert.equal(next?.kind === 'catalogue' && next.request.offset, 100);
});

test('the latest press wins; a press with nothing to send, or refused as stopped, is dropped', () => {
	let s = mount(three);
	s = press(press(s, { kind: 'catalogue-retry' }), { kind: 'more' });
	assert.deepEqual(s.intent, { kind: 'more' });
	const dropped = beginRead(s, 0);
	assert.equal(dropped.state.intent, null, 'no more pages: dropped');
	const stopped = send(settle(mount(hundred), view()), 0, answer(offline)).state;
	assert.equal(stopped.gate.stop, 'retry');
	const refused = beginRead(press(stopped, { kind: 'more' }), 1);
	assert.equal(refused.read, null);
	assert.equal(refused.state.intent, null, 'More is refused by a retry stop and dropped');
});

test('a zone change applies nothing, stops occupancy only, and asks for Refresh', () => {
	const fx: Fixture = { ...hundred, occupancyZone: 'Australia/Perth' };
	let s = settle(mount(fx), view());
	s = send(s, 0, served(fx)).state;
	assert.equal(s.zone.kind, 'changed');
	assert.equal(s.gate.stop, 'zone');
	assert.equal(scheduleScreen(s, 0, true).problem, equipmentCopy.zoneChanged);
	assert.equal(beginRead(s, 1).read, null, 'no more occupancy');
	const more = beginRead(press(s, { kind: 'more' }), 1).read;
	assert.equal(more?.kind, 'catalogue', 'the catalogue does not depend on the zone');
	const refreshed = pressRefresh(s, 1, true)!;
	assert.equal(refreshed.zone.kind, 'ok');
	assert.equal(beginRead(refreshed, 1).read?.kind, 'organisation');
});

test('contradictory details for one reservation stop occupancy with the conflict wording', () => {
	const rid = '00000000-0000-4000-8000-00000000c0de';
	const fx: Fixture = {
		zone: sydney, pages: { 0: { ids: [1], more: false } },
		rows: (read) => [{
			id: rid, equipmentId: eq(1), title: read.slot.from === iso(anchorAt) ? 'Brew day' : 'Clean down', kind: 'booking', status: 'confirmed',
			startsAt: iso(anchorAt - 2 * hour), endsAt: iso(anchorAt + 2 * hour), setupMinutes: 0, cleanupMinutes: 0,
			occupiedStartsAt: iso(anchorAt - 2 * hour), occupiedEndsAt: iso(anchorAt + 2 * hour),
			projectId: null, taskId: null, ownerId: null, createdBy: userId, revision: 1, createdAt: stamp, updatedAt: stamp
		}]
	};
	const run = drain(settle(mount(fx), view({ low: anchorAt - 3 * hour, high: anchorAt + 3 * hour })), fx);
	assert.equal(run.state.gate.stop, 'conflict');
	assert.equal(scheduleScreen(run.state, run.now, true).problem, equipmentCopy.conflict);
	assert.equal(wayOutAll(run.state), 'refresh');
});

test('the detail panel shows only a reservation still drawn for its equipment, and closes once it is contradicted (review S2)', () => {
	const rid = '00000000-0000-4000-8000-00000000beef';
	const fx: Fixture = {
		zone: sydney, pages: { 0: { ids: [1, 2], more: false } },
		rows: (read) => read.slot.equipmentId !== eq(1) ? [] : [{
			id: rid, equipmentId: eq(1), title: read.slot.from === iso(anchorAt) ? 'Brew day' : 'Clean down', kind: 'booking', status: 'confirmed',
			startsAt: iso(anchorAt - 2 * hour), endsAt: iso(anchorAt + 2 * hour), setupMinutes: 0, cleanupMinutes: 0,
			occupiedStartsAt: iso(anchorAt - 2 * hour), occupiedEndsAt: iso(anchorAt + 2 * hour),
			projectId: null, taskId: null, ownerId: null, createdBy: userId, revision: 1, createdAt: stamp, updatedAt: stamp
		}]
	};
	// One column shown (and the next partly): the chunk before the anchor is read first, then the anchor's chunk.
	let s = settle(mount(fx), view({ width: 125, low: anchorAt - 3 * hour, high: anchorAt + 3 * hour }));
	s = send(s, 0, served(fx)).state;
	assert.equal(panelRow(s, eq(1), rid)?.title, 'Clean down', 'shown while drawn');
	assert.equal(panelRow(s, eq(2), rid), null, 'never under another equipment');
	assert.equal(panelRow(s, eq(1), '00000000-0000-4000-8000-000000000404'), null);
	s = drain(s, fx, 3_000).state;
	assert.equal(s.gate.stop, 'conflict');
	assert.equal(panelRow(s, eq(1), rid), null, 'a contradicted reservation closes the panel');
});

test('a re-anchor abandons an in-flight catalogue answer, so More is offered again (K1)', () => {
	const s = mount(hundred);
	const begun = beginRead(press(s, { kind: 'more' }), 0);
	assert.equal(begun.read?.kind, 'catalogue');
	const moved = pressEdge(begun.state, 'later', 1);
	assert.ok(moved);
	assert.equal(moved.edge, s.range!.endDate);
	assert.equal(moved.state.settled, null, 'planning waits for the new view to settle');
	const after = receive(moved.state, begun.read!, served(hundred)(begun.read!), wall);
	assert.equal(after.catalogue.columns.length, 100, 'the dropped answer applied nothing');
	assert.equal(after.catalogue.pending, null);
	assert.equal(catalogueView(after.catalogue).more, 'offered');
	assert.equal(beginRead(press(after, { kind: 'more' }), 2).read?.kind, 'catalogue');
});

test('a retry stop whose failed cell was re-anchored away offers Refresh (C3)', () => {
	let s = settle(mount(), view());
	s = send(s, 0, answer(offline)).state;
	assert.equal(s.gate.stop, 'retry');
	assert.equal(wayOutAll(s), 'try-again');
	assert.equal(scheduleScreen(s, 0, true).cellRetry?.label, equipmentCopy.tryAgain);
	const moved = pressEdge(s, 'later', 1)!.state;
	assert.equal(moved.gate.stop, 'retry', 'a re-anchor keeps the stop');
	assert.equal(wayOutAll(moved), 'refresh');
	assert.equal(scheduleScreen(moved, 1, true).problem, equipmentCopy.stoppedRefresh);
});

test('screen states: a failed bootstrap offers its own Try again; an empty first page says so; a failed first page fails', () => {
	const failed = send(createSchedule(scope), 0, answer(offline)).state;
	const screen = scheduleScreen(failed, 0, true);
	assert.equal(screen.body, 'bootstrap-failed');
	assert.equal(screen.bodyText, equipmentCopy.failedFirst);
	assert.deepEqual(screen.tryAgain?.intent, { kind: 'organisation-retry' });
	assert.equal(screen.tryAgain?.disabled, false, 'a retry ticket passes the retry stop');
	assert.equal(send(press(failed, { kind: 'organisation-retry' }), 1, served(three)).state.zone.kind, 'ok');
	const refused = send(createSchedule(scope), 0, answer({ kind: 'refused', status: 403 })).state;
	assert.equal(scheduleScreen(refused, 0, true).bodyText, equipmentCopy.access);
	assert.equal(scheduleScreen(refused, 0, true).tryAgain, null);
	assert.equal(scheduleScreen(mount({ zone: sydney, pages: { 0: { ids: [], more: false } } }), 0, true).body, 'empty');
	const pageFailed = send(send(createSchedule(scope), 0, served(three)).state, 0, answer(offline)).state;
	assert.equal(scheduleScreen(pageFailed, 0, true).body, 'catalogue-failed');
	assert.deepEqual(scheduleScreen(pageFailed, 0, true).tryAgain?.intent, { kind: 'catalogue-retry' });
	assert.equal(scheduleScreen(createSchedule(scope), 0, true).body, 'loading');
});
