import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReadOutcome, ReadScope } from '../account/contracts.ts';
import {
	beginRead, blockedReason, capReached, finishRead, initialWorkList, listInert, maxWorkRows, moreAvailable, retryOp,
	type WorkListState, type WorkOp
} from './my-work-list.ts';
import type { WorkPage, WorkRow } from './my-work.ts';

const row = (n: number): WorkRow => Object.freeze({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, displayTitle: `Task ${n}`, owner: 'you', status: 'open', due: null, tags: [], tagCount: 0 });
const page = (from: number, count: number, nextOffset: number | null): ReadOutcome<WorkPage> =>
	({ kind: 'ok', value: { rows: Array.from({ length: count }, (_, i) => row(from + i)), nextOffset } });

/** Starts `op` and answers it with `outcome`; asserts the read was allowed. */
function step(state: WorkListState, op: WorkOp, outcome: ReadOutcome<WorkPage>, now = 0): WorkListState {
	const started = beginRead(state, op, now);
	assert.ok(started !== null, `${op} should start`);
	return finishRead(started.state, started.seq, outcome);
}

test('first read: page 0 once per mount; a strict-mode second start is refused while it is in flight', () => {
	const first = beginRead(initialWorkList, 'first', 0)!;
	assert.equal(first.offset, 0);
	assert.equal(beginRead(first.state, 'first', 0), null, 'one in flight');
	assert.equal(blockedReason(first.state, 0), 'loading');
	const loaded = finishRead(first.state, first.seq, page(0, 50, 50));
	assert.equal(loaded.loaded, true); assert.equal(loaded.rows.length, 50); assert.equal(loaded.pages, 1);
	assert.equal(beginRead(loaded, 'first', 0), null, 'never a second automatic first read');
});

test('a failed first read is never shown as empty; Try again repeats it, only when asked', () => {
	const failed = step(initialWorkList, 'first', { kind: 'unavailable', wait: null });
	assert.equal(failed.loaded, false); assert.equal(failed.rows.length, 0);
	assert.deepEqual(failed.problem, { op: 'first', kind: 'unavailable', wait: null });
	assert.equal(retryOp(failed), 'first');
	const again = step(failed, 'first', page(0, 0, null));
	assert.equal(again.loaded, true); assert.equal(again.rows.length, 0); assert.equal(again.problem, null);
});

test('refusals: 403/404 are access, 400 and client bugs are list; no automatic retry', () => {
	for (const [outcome, kind] of [
		[{ kind: 'refused', status: 404 }, 'access'], [{ kind: 'refused', status: 403 }, 'access'],
		[{ kind: 'refused', status: 400 }, 'list'], [{ kind: 'client-bug' }, 'list']
	] as const) {
		const s = step(initialWorkList, 'first', outcome);
		assert.equal(s.problem?.kind, kind); assert.equal(s.inFlight, null);
	}
});

test('refresh replaces and resets the page count; a failed refresh keeps the rows', () => {
	let s = step(initialWorkList, 'first', page(0, 50, 50));
	s = step(s, 'more', page(50, 50, 100));
	assert.equal(s.pages, 2); assert.equal(s.rows.length, 100);
	const kept = step(s, 'refresh', { kind: 'unavailable', wait: null });
	assert.equal(kept.rows.length, 100); assert.deepEqual(kept.problem?.op, 'refresh');
	const replaced = step(kept, 'refresh', page(200, 3, null));
	assert.equal(replaced.pages, 1); assert.deepEqual(replaced.rows.map((r) => r.id), [row(200).id, row(201).id, row(202).id]);
	assert.equal(replaced.nextOffset, null); assert.equal(moreAvailable(replaced), false); assert.equal(capReached(replaced), false);
});

test('more: appends, drops rows already shown, keeps rows on failure', () => {
	let s = step(initialWorkList, 'first', page(0, 50, 50));
	assert.equal(beginRead(s, 'more', 0)!.offset, 50);
	s = step(s, 'more', page(25, 50, 100)); // 25 repeat the first page
	assert.equal(s.rows.length, 75); assert.equal(new Set(s.rows.map((r) => r.id)).size, 75);
	const failed = step(s, 'more', { kind: 'unavailable', wait: null });
	assert.equal(failed.rows.length, 75); assert.equal(retryOp(failed), 'more');
});

test('caps: More stops at 10 pages or 500 rows; the notice only when the API said there is more', () => {
	let s = step(initialWorkList, 'first', page(0, 50, 50));
	for (let p = 1; p < 10; p += 1) s = step(s, 'more', page(p * 50, 50, (p + 1) * 50));
	assert.equal(s.pages, 10); assert.equal(s.rows.length, maxWorkRows);
	assert.equal(moreAvailable(s), false); assert.equal(beginRead(s, 'more', 0), null);
	assert.equal(capReached(s), true, 'nextOffset still set: website notice');
	// With duplicates, the page cap stops More with fewer than 500 rows.
	let d = step(initialWorkList, 'first', page(0, 50, 50));
	for (let p = 1; p < 10; p += 1) d = step(d, 'more', page(p * 50 - 25, 50, (p + 1) * 50));
	assert.equal(d.pages, 10); assert.ok(d.rows.length < maxWorkRows);
	assert.equal(moreAvailable(d), false); assert.equal(capReached(d), true);
	// The last page reached without a cap: no notice.
	const last = step(step(initialWorkList, 'first', page(0, 50, 50)), 'more', page(50, 3, null));
	assert.equal(moreAvailable(last), false); assert.equal(capReached(last), false);
});

test("a read's own server wait blocks every control until exactly its end", () => {
	const wait = { until: 5_000, about: '2030-01-01T00:00:05.000Z' };
	const s = step(initialWorkList, 'first', { kind: 'unavailable', wait });
	assert.equal(blockedReason(s, 4_999), 'waiting'); assert.equal(beginRead(s, 'first', 4_999), null);
	assert.equal(blockedReason(s, 5_000), null); assert.ok(beginRead(s, 'first', 5_000) !== null);
});

test('only the latest read applies; superseded and stale answers change nothing', () => {
	const first = beginRead(initialWorkList, 'first', 0)!;
	assert.equal(finishRead(first.state, first.seq, { kind: 'superseded' }), first.state, 'superseded: nothing');
	assert.equal(finishRead(first.state, first.seq + 1, page(0, 1, null)), first.state, 'not this read: nothing');
	const done = finishRead(first.state, first.seq, page(0, 1, null));
	assert.equal(finishRead(done, first.seq, page(0, 2, null)), done, 'a duplicate answer: nothing');
});

test('a list is bound to its first ready scope: any other scope makes it inert, before the tabs reset', () => {
	const a: ReadScope = { epoch: 'a1.o1', userId: 'u', organisationId: 'org-a' };
	assert.equal(listInert(a, a), false);
	assert.equal(listInert(a, { ...a }), false, 'an equal scope object is the same scope');
	// The render after a switch, before RootStack's effect returns to the thread list: a new epoch and organisation.
	assert.equal(listInert(a, { epoch: 'a1.o2', userId: 'u', organisationId: 'org-b' }), true);
	// A → B → A: the same organisation again is a new epoch, so still inert.
	assert.equal(listInert(a, { epoch: 'a1.o3', userId: 'u', organisationId: 'org-a' }), true);
	assert.equal(listInert(a, null), true, 'not ready');
	assert.equal(listInert(null, a), true, 'never bound');
});
