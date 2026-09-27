import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StockList } from './stock.ts';
import { beginStockRead, finishStockRead, initialStockList, stockBlocked, stockRetryOp, stockScreen, stockWaiting, type StockListState } from './stock-list.ts';

const wait = (until: number) => ({ until, about: '2030-01-01T12:05:00.000Z' });
const row = (id: string, name: string) => ({ id, name, count: '12.50', unit: 'kegs', reorderPoint: null, below: false });
const listOf = (...locations: string[]): StockList => ({
	groups: locations.map((location, i) => ({ location, items: [row(`00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, `Item ${location}`)] }))
});
const empty: StockList = { groups: [] };
/** Starts `op` (asserting it may start), then applies `outcome`. */
function run(state: StockListState, op: 'first' | 'refresh', outcome: Parameters<typeof finishStockRead>[2], now = 0): StockListState {
	const started = beginStockRead(state, op, now);
	assert.ok(started, `${op} should start`);
	return finishStockRead(started.state, started.seq, outcome);
}

test('first read: once per mount; a strict-mode second start is refused while it is in flight; nothing before it is shown as stock', () => {
	assert.deepEqual(stockScreen(initialStockList, false), { kind: 'loading' });
	const first = beginStockRead(initialStockList, 'first', 0)!;
	assert.deepEqual(first.state.inFlight, { seq: 1, op: 'first' });
	assert.equal(beginStockRead(first.state, 'first', 0), null, 'a second first read while one is in flight');
	assert.equal(beginStockRead(first.state, 'refresh', 0), null, 'no refresh before a list is loaded');
	assert.deepEqual(stockScreen(first.state, false), { kind: 'loading' });
	const loaded = finishStockRead(first.state, first.seq, { kind: 'ok', value: listOf('Cellar', 'Brewhouse') });
	assert.equal(loaded.inFlight, null); assert.equal(loaded.problem, null);
	assert.equal(beginStockRead(loaded, 'first', 0), null, 'never a second first read once loaded');
	const shown = stockScreen(loaded, false);
	assert.ok(shown.kind === 'list');
	assert.deepEqual(shown.groups.map((g) => g.location), ['Cellar', 'Brewhouse'], 'the parser\'s order, never re-sorted');
});

test('empty is only a successful answer with no items; a failed, pending or inert read is never empty', () => {
	const loadedEmpty = run(initialStockList, 'first', { kind: 'ok', value: empty });
	assert.deepEqual(stockScreen(loadedEmpty, false), { kind: 'empty', problem: null });
	const failed = run(initialStockList, 'first', { kind: 'unavailable', wait: null });
	assert.deepEqual(stockScreen(failed, false), { kind: 'failed', problem: { op: 'first', kind: 'unavailable', wait: null } });
	const retrying = beginStockRead(failed, 'first', 0)!;
	assert.deepEqual(stockScreen(retrying.state, false), { kind: 'loading' }, 'retrying a failed first read: loading, not empty');
	const loaded = run(initialStockList, 'first', { kind: 'ok', value: listOf('Cellar') });
	for (const state of [initialStockList, failed, loadedEmpty, loaded]) {
		assert.deepEqual(stockScreen(state, true), { kind: 'loading' }, 'inert: the neutral loading line, never empty or old rows');
	}
});

test('refresh: a success replaces the list; a failure keeps the rows with the refresh problem; Try again repeats refresh', () => {
	const loaded = run(initialStockList, 'first', { kind: 'ok', value: listOf('Cellar') });
	const refreshed = run(loaded, 'refresh', { kind: 'ok', value: listOf('Store', 'Cellar') });
	const shown = stockScreen(refreshed, false);
	assert.ok(shown.kind === 'list'); assert.deepEqual(shown.groups.map((g) => g.location), ['Store', 'Cellar']);
	const failed = run(refreshed, 'refresh', { kind: 'unavailable', wait: null });
	const kept = stockScreen(failed, false);
	assert.ok(kept.kind === 'list', 'the rows are kept');
	assert.deepEqual(kept.groups.map((g) => g.location), ['Store', 'Cellar']);
	assert.deepEqual(kept.problem, { op: 'refresh', kind: 'unavailable', wait: null });
	assert.equal(stockRetryOp(failed), 'refresh');
	const again = run(failed, 'refresh', { kind: 'ok', value: listOf('Cellar') });
	assert.equal(again.problem, null, 'a later success clears the problem');
	// A failed refresh of an empty list stays empty (a successful empty answer), with the problem shown.
	const emptyThenFailed = run(run(initialStockList, 'first', { kind: 'ok', value: empty }), 'refresh', { kind: 'refused', status: 500 });
	assert.deepEqual(stockScreen(emptyThenFailed, false), { kind: 'empty', problem: { op: 'refresh', kind: 'list', wait: null } });
});

test('problems: 403/404 are access; other refusals and client bugs are the list problem; unavailable keeps its own wait', () => {
	for (const status of [403, 404]) assert.equal(run(initialStockList, 'first', { kind: 'refused', status }).problem?.kind, 'access');
	for (const status of [400, 409, 422]) assert.equal(run(initialStockList, 'first', { kind: 'refused', status }).problem?.kind, 'list');
	assert.deepEqual(run(initialStockList, 'first', { kind: 'client-bug' }).problem, { op: 'first', kind: 'list', wait: null });
	assert.deepEqual(run(initialStockList, 'first', { kind: 'unavailable', wait: wait(20_000) }).problem, { op: 'first', kind: 'unavailable', wait: wait(20_000) });
});

test('a server wait blocks Try again and Refresh until exactly its end', () => {
	const limited = run(initialStockList, 'first', { kind: 'unavailable', wait: wait(20_000) });
	assert.equal(stockWaiting(limited, 19_999), true);
	assert.equal(stockBlocked(limited, 19_999), 'waiting');
	assert.equal(beginStockRead(limited, 'first', 19_999), null, 'nothing before the wait');
	assert.equal(stockWaiting(limited, 20_000), false);
	assert.ok(beginStockRead(limited, 'first', 20_000), 'at exactly the wait, Try again may read');
	const loaded = run(initialStockList, 'first', { kind: 'ok', value: listOf('Cellar') });
	const refreshLimited = run(loaded, 'refresh', { kind: 'unavailable', wait: wait(5_000) });
	assert.equal(beginStockRead(refreshLimited, 'refresh', 4_999), null);
	assert.ok(beginStockRead(refreshLimited, 'refresh', 5_000));
	const busy = beginStockRead(loaded, 'refresh', 0)!;
	assert.equal(stockBlocked(busy.state, 0), 'loading');
});

test('only the latest read applies; a superseded answer changes nothing', () => {
	const first = beginStockRead(initialStockList, 'first', 0)!;
	assert.equal(finishStockRead(first.state, first.seq, { kind: 'superseded' }), first.state, 'superseded: the same object');
	assert.equal(finishStockRead(first.state, first.seq + 1, { kind: 'ok', value: listOf('Cellar') }), first.state, 'not this read');
	assert.equal(finishStockRead(initialStockList, 1, { kind: 'ok', value: listOf('Cellar') }), initialStockList, 'nothing in flight');
	const loaded = finishStockRead(first.state, first.seq, { kind: 'ok', value: listOf('Cellar') });
	assert.equal(finishStockRead(loaded, first.seq, { kind: 'ok', value: empty }), loaded, 'a late duplicate answer');
});
