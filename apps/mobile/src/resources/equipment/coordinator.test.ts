import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { beginScheduleRead, createScheduleCoordinator, finishScheduleRead, restartSchedule,
	scheduleReadBlock, stopSchedule, type ScheduleCoordinator, type ScheduleReadKind } from './coordinator.ts';

const scope = { epoch: 'one', userId: 'person', organisationId: 'business' };
const ok = { kind: 'ok', value: {} } as const;
function start(state: ScheduleCoordinator, now = 0, kind: ScheduleReadKind = 'occupancy', retry = false) {
	const read = beginScheduleRead(state, scope, kind, 'requested-cell', now, retry);
	assert.ok(read); return read;
}

test('organisation, catalogue and occupancy share one flight and the rolling budget', () => {
	let state = createScheduleCoordinator(scope);
	const kinds = ['organisation', 'catalogue', 'occupancy'] as const;
	for (let i = 0; i < 30; i++) {
		const read = start(state, i * 100, kinds[i % 3]);
		assert.equal(beginScheduleRead(read.state, scope, 'catalogue', 'next', i * 100), null);
		state = finishScheduleRead(read.state, read.ticket, ok).state;
	}
	assert.equal(scheduleReadBlock(state, scope, 59_999), 'budget');
	assert.equal(restartSchedule(state, scope, 59_999, 'refresh'), null);
	assert.equal(restartSchedule(state, scope, 59_999, 'reanchor'), null);
	const next = start(state, 60_000);
	assert.equal(next.state.starts.length, 30);
	assert.equal(next.state.starts[0], 100);
});

test('a wait from any read blocks every kind; Refresh cannot erase it or the rolling log', () => {
	const read = start(createScheduleCoordinator(scope), 10, 'catalogue');
	const state = finishScheduleRead(read.state, read.ticket,
		{ kind: 'unavailable', wait: { until: 5_010, about: 'later' } }).state;
	for (const kind of ['organisation', 'catalogue', 'occupancy'] as const)
		assert.equal(beginScheduleRead(state, scope, kind, 'next', 5_009, true), null);
	assert.equal(restartSchedule(state, scope, 5_009, 'refresh'), null);
	const refreshed = restartSchedule(state, scope, 5_010, 'refresh');
	assert.ok(refreshed);
	assert.deepEqual(refreshed.starts, [10]);
	assert.deepEqual(refreshed.wait, state.wait);
	assert.equal(scheduleReadBlock(refreshed, scope, 5_010), null);
});

test('network failure requires explicit retry and only its success resumes automatic reads', () => {
	let read = start(createScheduleCoordinator(scope));
	let state = finishScheduleRead(read.state, read.ticket, { kind: 'unavailable', wait: null }).state;
	assert.equal(scheduleReadBlock(state, scope, 0), 'stopped');
	read = start(state, 0, 'occupancy', true);
	state = finishScheduleRead(read.state, read.ticket,
		{ kind: 'unavailable', wait: { until: 10, about: 'later' } }).state;
	assert.equal(scheduleReadBlock(state, scope, 10), 'stopped');
	read = start(state, 10, 'occupancy', true);
	state = finishScheduleRead(read.state, read.ticket, ok).state;
	assert.equal(scheduleReadBlock(state, scope, 10), null);
});

test('access stop needs checked membership and Refresh, not retry or re-anchoring', () => {
	const read = start(createScheduleCoordinator(scope));
	const state = finishScheduleRead(read.state, read.ticket, { kind: 'refused', status: 404 }).state;
	assert.equal(beginScheduleRead(state, scope, 'occupancy', 'cell', 0, true), null);
	assert.equal(restartSchedule(state, scope, 0, 'refresh'), null);
	assert.equal(restartSchedule(state, scope, 0, 'reanchor')?.stop, 'access');
	assert.equal(restartSchedule(state, scope, 0, 'refresh', true)?.stop, null);
});

test('conflict and zone stops survive re-anchoring and cannot be lifted by another retry', () => {
	for (const reason of ['conflict', 'zone'] as const) {
		const state = stopSchedule(createScheduleCoordinator(scope), reason);
		assert.equal(beginScheduleRead(state, scope, 'occupancy', 'other-cell', 0, true), null);
		assert.equal(restartSchedule(state, scope, 0, 'reanchor')?.stop, reason);
		assert.equal(restartSchedule(state, scope, 0, 'refresh')?.stop, null);
	}
});

test('scope epochs prevent A to B to A reuse; superseded results apply nothing and cannot resume', () => {
	const state = createScheduleCoordinator(scope);
	for (const changed of [{ ...scope, epoch: 'two' }, { ...scope, userId: 'other' }, { ...scope, organisationId: 'other' }])
		assert.equal(beginScheduleRead(state, changed, 'organisation', 'org', 0), null);
	const read = start(state);
	const result = finishScheduleRead(read.state, read.ticket, { kind: 'superseded' });
	assert.equal(result.apply, false);
	assert.equal(restartSchedule(result.state, scope, 0, 'refresh', true), null);
});

test('a late failure cannot weaken a conflict stop into a retryable stop', () => {
	const read = start(createScheduleCoordinator(scope));
	const conflicted = stopSchedule(read.state, 'conflict');
	for (const outcome of [{ kind: 'unavailable', wait: null }, { kind: 'client-bug' }] as const) {
		const state = finishScheduleRead(conflicted, read.ticket, outcome).state;
		assert.equal(state.stop, 'conflict');
		assert.equal(beginScheduleRead(state, scope, 'occupancy', 'next', 0, true), null);
	}
});

test('old and duplicate tickets cannot overwrite a new generation or release its request', () => {
	const first = start(createScheduleCoordinator(scope));
	assert.equal(restartSchedule(first.state, scope, 0, 'refresh'), null);
	const settled = finishScheduleRead(first.state, first.ticket, ok).state;
	const refreshed = restartSchedule(settled, scope, 0, 'refresh'); assert.ok(refreshed);
	const next = start(refreshed);
	const ignored = finishScheduleRead(next.state, first.ticket, { kind: 'refused', status: 404 });
	assert.equal(ignored.apply, false);
	assert.equal(ignored.state, next.state);
	assert.equal(finishScheduleRead(next.state, next.ticket, ok).apply, true);
});
