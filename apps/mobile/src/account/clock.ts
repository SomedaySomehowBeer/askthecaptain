/** The one clock that decides when a request may be sent (docs/plans/expo-mobile-auth-composition-2026-09.md §3).
 *  It reads a monotonic source (`performance.now()` on Hermes, injected) and never goes backwards: a reading lower than
 *  the last one, or one that is not a finite number, is treated as the last one. So changing the phone's date or time,
 *  or a misbehaving source, can only make a wait longer, never end it early. The runner, both revocation cleanups and
 *  the screens' wait timers share one instance. Wall-clock time is used only to word "about {time}". */
export type Clock = { readonly now: () => number };

export function createClampedClock(read: () => number): Clock {
	let last = 0;
	return Object.freeze({
		now(): number {
			const value = read();
			if (Number.isFinite(value) && value > last) last = value;
			return last;
		}
	});
}

/** A server's wait, fixed when its answer arrived: `until` on the clamped clock (for pacing and timers) and `about`
 *  on the wall clock (for wording only). */
export type Wait = { readonly until: number; readonly about: string };

/** The wait for a delay of `ms` from now, or null for none. */
export function waitFor(ms: number | null | undefined, clock: Clock, wallNow: () => number): Wait | null {
	if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
	return Object.freeze({ until: clock.now() + ms, about: new Date(wallNow() + ms).toISOString() });
}

/** The later of two waits (a longer server wait always wins; nothing ever shortens one). */
export const laterWait = (a: Wait | null, b: Wait | null): Wait | null => (a === null ? b : b === null ? a : b.until > a.until ? b : a);

/** Milliseconds left before `wait` ends, or 0 when a send may happen now (at exactly `until`, it may). */
export const remaining = (wait: Wait | null, now: number): number => (wait === null || now >= wait.until ? 0 : wait.until - now);
