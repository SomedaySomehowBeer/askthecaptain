/** The full thread's change poller (web plan §2 "Polling"), pure over injected clock, timers and visibility so it can
 *  be tested without a browser. One request per scheduled tick, one `changes` page each, at most one in flight. Every
 *  start, stop, hide and blur moves a generation on; a response from an older generation is dropped and schedules
 *  nothing, so a late answer can never restart a stopped loop. */
import type { ChatRead } from './results.ts';
import { chatTiming, type ChangesPage } from './types.ts';

export type StopReason = 'gone' | 'scope' | 'signed-out' | 'idle' | 'stopped';
export type PollDeps = {
	now(): number;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(timer: unknown): void;
	visible(): boolean;
	focused(): boolean;
	fetch(after: number): Promise<ChatRead<ChangesPage>>;
	/** Applies the page and returns the cursor for the next request. */
	onPage(page: ChangesPage): number;
	onStop(reason: StopReason): void;
};
export type Poller = { start(cursor: number): void; stop(): void; activity(): void; visibilityChanged(): void; readonly running: boolean };
type Timing = { pollMs: number; idleStopMs: number; backoffMaxMs: number; retryAfterCapS: number };

const backoffStartMs = 15_000;

export function createPoller(deps: PollDeps, t: Timing = chatTiming): Poller {
	let running = false;
	let cursor = 0;
	let generation = 0;
	let timer: unknown = null;
	let inFlight = false;
	let deferred = -1;
	let wasActive = deps.visible() && deps.focused();
	let failures = 0;
	let lastActivity = 0;
	let idle = false;

	const active = () => deps.visible() && deps.focused();
	function cancel() { if (timer !== null) { deps.clearTimer(timer); timer = null; } }
	function schedule(ms: number) {
		cancel();
		const mine = generation;
		timer = deps.setTimer(() => { timer = null; if (mine === generation) void tick(); }, ms);
	}
	function halt(reason: StopReason) {
		running = false; generation++; cancel();
		deps.onStop(reason);
	}

	async function tick() {
		if (!running || !active()) return;
		// One request at a time. A tick wanted by a newer generation waits for the older answer, which is then dropped.
		if (inFlight) { deferred = generation; return; }
		if (deps.now() - lastActivity >= t.idleStopMs) { idle = true; halt('idle'); return; }
		const mine = generation;
		inFlight = true;
		let result: ChatRead<ChangesPage>;
		try { result = await deps.fetch(cursor); }
		catch { result = { ok: false, kind: 'unreadable', retryAfter: null, requestId: null, error: 'The latest messages could not be read.' }; }
		finally { inFlight = false; }
		// Hidden, blurred, stopped or restarted since this request left: its answer is not applied and schedules nothing.
		// Only a tick the current generation itself asked for while this request was out runs now.
		if (mine !== generation || !running || !active()) {
			if (deferred === generation && deferred !== mine) { deferred = -1; void tick(); }
			return;
		}
		if (result.ok) {
			failures = 0;
			cursor = deps.onPage(result.value);
			// An incomplete page does not ask again at once: the rest arrives on later ticks.
			schedule(t.pollMs);
			return;
		}
		switch (result.kind) {
			case 'gone': halt('gone'); return;
			case 'wrong-scope': halt('scope'); return;
			case 'signed-out': halt('signed-out'); return;
			case 'rate-limited': schedule(Math.max(t.pollMs, Math.min(result.retryAfter, t.retryAfterCapS) * 1000)); return;
			default: {
				const wait = Math.min(backoffStartMs * 2 ** failures, t.backoffMaxMs);
				failures++;
				schedule(wait);
			}
		}
	}

	return {
		get running() { return running; },
		start(from: number) {
			cancel();
			running = true; idle = false; generation++; cursor = from; failures = 0; lastActivity = deps.now(); wasActive = active();
			if (active()) void tick();
		},
		stop() { if (running) halt('stopped'); else { generation++; cancel(); } },
		activity() {
			lastActivity = deps.now();
			// A person returning after an idle stop gets one immediate catch-up and the normal cadence again.
			if (!running && idle) { running = true; idle = false; generation++; failures = 0; if (active()) void tick(); }
		},
		visibilityChanged() {
			const now = active();
			const changed = now !== wasActive;
			wasActive = now;
			// Focus and visibility events can repeat without a change; only a real change moves the generation.
			if (!running || !changed) return;
			if (!now) { generation++; cancel(); return; }
			// Back to visible and focused: one immediate tick, then the normal cadence.
			generation++; cancel();
			lastActivity = deps.now();
			void tick();
		}
	};
}
