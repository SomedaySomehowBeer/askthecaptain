import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPoller, type PollDeps, type StopReason } from './poll.ts';
import type { ChatRead } from './results.ts';
import type { ChangesPage } from './types.ts';

type Answer = ChatRead<ChangesPage>;
const page = (next: number, complete = true): ChangesPage => ({ conversation: { id: 'c', revision: 1, lastSeq: next, highWater: next }, changes: [], next, complete });
const ok = (next: number, complete = true): Answer => ({ ok: true, value: page(next, complete) });
const failure = (kind: 'unreadable' | 'gone' | 'wrong-scope' | 'signed-out'): Answer => ({ ok: false, kind, retryAfter: null, requestId: null, error: kind }) as Answer;
const limited = (retryAfter: number): Answer => ({ ok: false, kind: 'rate-limited', retryAfter, requestId: null, error: 'wait' });

/** A fake browser: a clock, timers, visibility and focus, and a fetch whose answers the test releases. */
function world() {
	let now = 0;
	let timers: { at: number; fn: () => void; id: number }[] = [];
	let nextId = 1;
	const w = {
		visible: true, focused: true,
		requests: [] as { after: number; resolve(a: Answer): void }[],
		stops: [] as StopReason[],
		applied: [] as number[],
		get now() { return now; },
		timers: () => timers.map((t) => t.at - now),
		deps: null as unknown as PollDeps,
		/** Run the clock forward, firing timers that come due. */
		async advance(ms: number) {
			const end = now + ms;
			for (;;) {
				const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
				if (!due) break;
				timers = timers.filter((t) => t !== due);
				now = due.at; due.fn(); await settle();
			}
			now = end;
		},
		async answer(a: Answer) { const r = w.requests.shift(); assert.ok(r, 'a request was made'); r.resolve(a); await settle(); }
	};
	w.deps = {
		now: () => now,
		setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: now + ms, fn, id }); return id; },
		clearTimer: (id) => { timers = timers.filter((t) => t.id !== id); },
		visible: () => w.visible, focused: () => w.focused,
		fetch: (after) => new Promise<Answer>((resolve) => { w.requests.push({ after, resolve }); }),
		onPage: (p) => { w.applied.push(p.next); return p.next; },
		onStop: (reason) => { w.stops.push(reason); }
	};
	return w;
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('one page per tick, even when incomplete, with at most one request in flight', async () => {
	const w = world(); const poller = createPoller(w.deps);
	poller.start(10);
	assert.equal(w.requests.length, 1);
	assert.equal(w.requests[0]!.after, 10);
	poller.visibilityChanged(); // a repeated event with no change moves nothing
	assert.equal(w.requests.length, 1, 'never two in flight');
	await w.answer(ok(110, false));
	assert.deepEqual(w.applied, [110]);
	assert.equal(w.requests.length, 0, 'an incomplete page does not fetch again at once');
	await w.advance(14_999);
	assert.equal(w.requests.length, 0);
	await w.advance(1);
	assert.equal(w.requests.length, 1);
	assert.equal(w.requests[0]!.after, 110);
});

test('hidden or blurred: the timer is cancelled and a late answer applies nothing and schedules nothing', async () => {
	const w = world(); const poller = createPoller(w.deps);
	poller.start(0);
	w.visible = false; poller.visibilityChanged();
	await w.answer(ok(5));
	assert.deepEqual(w.applied, [], 'late answer dropped');
	assert.deepEqual(w.timers(), [], 'nothing scheduled');
	await w.advance(60_000);
	assert.equal(w.requests.length, 0);
	// Return: one immediate tick, then the normal cadence.
	w.visible = true; poller.visibilityChanged();
	assert.equal(w.requests.length, 1);
	await w.answer(ok(5));
	assert.deepEqual(w.timers(), [15_000]);
	w.focused = false; poller.visibilityChanged();
	assert.deepEqual(w.timers(), [], 'blur cancels the timer');
});

test('a late answer after stop never restarts the loop', async () => {
	const w = world(); const poller = createPoller(w.deps);
	poller.start(0);
	poller.stop();
	assert.deepEqual(w.stops, ['stopped']);
	await w.answer(ok(9));
	assert.deepEqual(w.applied, []);
	assert.deepEqual(w.timers(), []);
	assert.equal(poller.running, false);
});

test('returning while an older request is out: that answer is dropped and the return tick follows it', async () => {
	const w = world(); const poller = createPoller(w.deps);
	poller.start(0);
	w.visible = false; poller.visibilityChanged();
	w.visible = true; poller.visibilityChanged();
	assert.equal(w.requests.length, 1, 'still one in flight');
	await w.answer(ok(3));
	assert.deepEqual(w.applied, [], 'the older generation’s answer is not applied');
	assert.equal(w.requests.length, 1, 'the return tick runs now');
	await w.answer(ok(3));
	assert.deepEqual(w.applied, [3]);
});

test('read failures back off 15, 30, 60, 60 seconds and reset on success', async () => {
	const w = world(); const poller = createPoller(w.deps);
	poller.start(0);
	for (const wait of [15_000, 30_000, 60_000, 60_000]) {
		await w.answer(failure('unreadable'));
		assert.deepEqual(w.timers(), [wait]);
		await w.advance(wait);
	}
	await w.answer(ok(1));
	assert.deepEqual(w.timers(), [15_000]);
	await w.advance(15_000);
	await w.answer(failure('unreadable'));
	assert.deepEqual(w.timers(), [15_000], 'reset after success');
});

test('Retry-After is a floor at the poll interval and capped at 300 seconds', async () => {
	const w = world(); const poller = createPoller(w.deps);
	poller.start(0);
	await w.answer(limited(7));
	assert.deepEqual(w.timers(), [15_000]);
	await w.advance(15_000);
	await w.answer(limited(40));
	assert.deepEqual(w.timers(), [40_000]);
	await w.advance(40_000);
	await w.answer(limited(3_600));
	assert.deepEqual(w.timers(), [300_000]);
});

test('gone, another scope and sign-out stop polling with their reason', async () => {
	for (const [kind, reason] of [['gone', 'gone'], ['wrong-scope', 'scope'], ['signed-out', 'signed-out']] as const) {
		const w = world(); const poller = createPoller(w.deps);
		poller.start(0);
		await w.answer(failure(kind));
		assert.deepEqual(w.stops, [reason]);
		assert.equal(poller.running, false);
		assert.deepEqual(w.timers(), []);
	}
});

test('ten minutes without activity stops; activity restarts with one tick', async () => {
	const w = world(); const poller = createPoller(w.deps);
	poller.start(0);
	await w.answer(ok(1));
	for (let i = 0; i < 39; i++) { await w.advance(15_000); await w.answer(ok(1)); }
	await w.advance(15_000);
	assert.deepEqual(w.stops, ['idle']);
	assert.equal(w.requests.length, 0);
	assert.equal(poller.running, false);
	poller.activity();
	assert.equal(poller.running, true);
	assert.equal(w.requests.length, 1);
	assert.equal(w.requests[0]!.after, 1);
});
