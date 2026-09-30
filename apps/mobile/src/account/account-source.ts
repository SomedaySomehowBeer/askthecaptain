import type { Composition } from './compose.ts';
import type { ScopedRead } from './contracts.ts';
import { slowAfterMs, type AccountSnapshot, type AccountView } from './machine.ts';
import { idleRevocation, staleOutcome, type PersonScope, type RevocationView, type RevokeOutcome } from './revocation.ts';
import type { Timers, UiCommand } from './runner.ts';
import type { WebCalls } from './web-calls.ts';

/** The token-free surface screens read (docs/plans/expo-mobile-auth-composition-2026-09.md §3). Production builds it
 *  over the composition (below); the test harness passes a scripted one. Never a runner, handle or token.
 *
 *  `subscribe` and `snapshot` are stable functions that go straight to `useSyncExternalStore`: `snapshot` returns the
 *  same object until the state changes. `now` is the clamped monotonic clock the snapshot's waits are measured on. */
export type AccountSource = {
	readonly subscribe: (listener: () => void) => () => void;
	readonly snapshot: () => AccountSnapshot;
	readonly send: (command: UiCommand) => void;
	readonly now: () => number;
	/** Organisation-scoped reads (docs/plans/expo-mobile-my-work-read-2026-09.md §3.1): the runner's own, token-free.
	 *  With no runner (starting, misconfigured, startup failed) it answers `superseded` and sends nothing. */
	readonly read: ScopedRead;
	/** Sign out everywhere else (docs/plans/mobile-session-revocation-2026-09.md §4): the runner's own, token-free. With
	 *  no runner it answers `stale` and sends nothing. */
	readonly revokeOthers: (expected: PersonScope) => Promise<RevokeOutcome>;
	/** The current person's revocation state, for `useSyncExternalStore` with `subscribe`: the same object until it
	 *  changes; the shared idle object with no runner. */
	readonly revocationView: () => RevocationView;
	/** The web-only calls (docs/plans/expo-web-session-2026-09.md §B.2): the sign-in link, the passkey step-up, the
	 *  passkeys list and accepting an invitation. Null on iOS and Android, whose screens say so. */
	readonly web: WebCalls | null;
};

const noRead: ScopedRead = () => Promise.resolve(Object.freeze({ kind: 'superseded' as const }));

const frozen = (account: AccountView): AccountSnapshot =>
	Object.freeze({ account: Object.freeze(account), signInOffered: false, fault: false, strays: Object.freeze([]) });

/** The fixed snapshots outside any runner. Frozen, so identity never changes and nothing can edit them. */
export const outsideSnapshots = Object.freeze({
	starting: frozen({ kind: 'starting', slow: false }),
	startingSlow: frozen({ kind: 'starting', slow: true }),
	misconfigured: frozen({ kind: 'misconfigured' }),
	startupFailed: frozen({ kind: 'startup-failed' })
});

/** A source that never changes: one fixed snapshot, no runner, no commands. The web binding uses it when the page's
 *  own origin is not usable (`misconfigured`). */
export function fixedAccountSource(snapshot: AccountSnapshot): AccountSource {
	return Object.freeze({
		subscribe: () => () => undefined,
		snapshot: () => snapshot,
		send: () => undefined,
		now: () => 0,
		read: noRead,
		revokeOthers: () => Promise.resolve(staleOutcome),
		revocationView: () => idleRevocation,
		web: null
	});
}

const defaultTimers: Timers = {
	set: (ms, run) => setTimeout(run, ms),
	clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

/** The provider's source over one composition. `composition` is called exactly once, here; nothing here ever calls it
 *  again, so the slow notice is only wording (a slow storage open is never timed out into a second composition).
 *
 *  - Until it answers: `starting`, and after ten seconds on this source's own timer, `starting` slow.
 *  - `misconfigured`, or a rejected promise (`startup-failed`): a fixed snapshot for the life of the
 *    process. The rejection's reason is neither shown nor logged; only a full restart composes again.
 *  - A runner: its cached snapshot. If the slow notice has already appeared, the runner's own `starting` is shown slow
 *    too, so the wording never steps back while starting continues.
 *  - Commands before a runner exists are dropped: no state before then offers an action. */
export function createAccountSource(composition: () => Promise<Composition>, timers: Timers = defaultTimers): AccountSource {
	type Phase = { kind: 'waiting' } | { kind: 'fixed'; snapshot: AccountSnapshot } | { kind: 'runner'; ready: Extract<Composition, { kind: 'ready' }> };
	let phase: Phase = { kind: 'waiting' };
	let slowShown = false;
	const listeners = new Set<() => void>();
	const notify = () => { for (const listener of [...listeners]) { try { listener(); } catch { /* a screen's error is its own */ } } };

	// The runner's snapshot as shown: the runner's object itself, except a `starting` that must stay slow. Cached by
	// the runner snapshot's identity, so the same runner snapshot always gives the same object.
	let seen: AccountSnapshot | null = null; let shown: AccountSnapshot | null = null;
	const fromRunner = (snapshot: AccountSnapshot): AccountSnapshot => {
		if (snapshot === seen && shown !== null) return shown;
		seen = snapshot;
		shown = slowShown && snapshot.account.kind === 'starting' && !snapshot.account.slow
			? Object.freeze({ ...snapshot, account: outsideSnapshots.startingSlow.account })
			: snapshot;
		return shown;
	};

	const timer = timers.set(slowAfterMs, () => {
		if (phase.kind !== 'waiting') return;
		slowShown = true; notify();
	});
	const settle = (next: Phase) => {
		if (phase.kind !== 'waiting') return;
		timers.clear(timer);
		phase = next;
		if (next.kind === 'runner') next.ready.runner.subscribe(() => notify());
		notify();
	};

	let started: Promise<Composition>;
	try { started = composition(); } catch { started = Promise.reject(new Error('composition threw')); }
	started.then(
		(result) => settle(result.kind === 'ready' ? { kind: 'runner', ready: result }
			: { kind: 'fixed', snapshot: outsideSnapshots.misconfigured }),
		() => settle({ kind: 'fixed', snapshot: outsideSnapshots.startupFailed }));

	return Object.freeze({
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		snapshot(): AccountSnapshot {
			if (phase.kind === 'runner') return fromRunner(phase.ready.runner.snapshot());
			if (phase.kind === 'fixed') return phase.snapshot;
			return slowShown ? outsideSnapshots.startingSlow : outsideSnapshots.starting;
		},
		send(command: UiCommand) { if (phase.kind === 'runner') phase.ready.runner.send(command); },
		// Before a runner there is no wait to measure; 0 keeps every wait calculation at "nothing left".
		now: () => (phase.kind === 'runner' ? phase.ready.clock.now() : 0),
		read: ((expected, path, parse) => phase.kind === 'runner' ? phase.ready.runner.organisationRead(expected, path, parse) : noRead(expected, path, parse)) as ScopedRead,
		revokeOthers: (expected: PersonScope): Promise<RevokeOutcome> => (phase.kind === 'runner' ? phase.ready.runner.revokeOthers(expected) : Promise.resolve(staleOutcome)),
		revocationView: (): RevocationView => (phase.kind === 'runner' ? phase.ready.runner.revocationView() : idleRevocation),
		web: null
	});
}
