/** Revoking a session the app must not keep (docs/plans/expo-mobile-auth-core-2026-09.md: stale successful sign-ins
 *  are handed to cleanup; cleanup credentials stay in private memory, with bounded attempts and explicit retry). Pure:
 *  the transport, the clock and the timer are injected.
 *
 *  The token is held only in this closure: never in any returned value, state, error, log or storage. Only a confirmed
 *  revoke (2xx) or a confirmed 401 (the session is already unusable) ends the cleanup and drops the token. The
 *  session's expiry time is never treated as revocation: the device clock can be changed, so a held token stays held
 *  after its `expiresAt` has passed on this device, until the server confirms. Anything else is retried on a bounded
 *  schedule (by default three sends over about 30 seconds), then the cleanup is pending until the person retries.
 *
 *  `retry-after` is honoured, never shortened: no send happens before the time the server named. If that time is
 *  further away than the schedule allows (30 seconds), the cleanup goes pending instead of sending early, `retryAt()`
 *  names the time, and an explicit retry before it sends nothing. A long server back-off therefore means a long
 *  pending state; the runner must show it with that time and a Try again action, not as a failure or a success.
 *  (`retryAt()` converts the server's relative delay with the device clock, so it is wording and pacing only.)
 *
 *  If the app is closed while pending, the token is lost with memory and that session stays valid until it expires;
 *  remote revocation (contract step 6) is the remedy. */
import type { Transport } from '../api/client.ts';
import { apiPaths } from '../api/paths.ts';

export type CleanupState = 'none' | 'running' | 'pending';
export type Cleanup = {
	state(): CleanupState;
	/** Takes the token and starts revoking it. Resolves once revoked or pending. Throws if one is already held. */
	begin(token: string, expiresAt: string): Promise<'revoked' | 'still-pending'>;
	/** Only while pending, and only once the server's `retry-after` time has passed: exactly one more send. Before that
	 *  time, or while already running, it answers 'still-pending' without sending. With nothing held it answers
	 *  'revoked' without sending. */
	retry(): Promise<'revoked' | 'still-pending'>;
	/** The held session's expiry, for wording only; null when nothing is held. */
	expiresAt(): string | null;
	/** While a session is held and the server's `retry-after` time is still ahead: that time, as an ISO instant (not a
	 *  secret). Null when nothing is held or a send is allowed now. Cleared when the cleanup completes. */
	retryAt(): string | null;
};

export const defaultCleanupDelaysMs: readonly number[] = [0, 10_000, 20_000];
/** The longest the automatic schedule waits before one send. A longer `retry-after` makes the cleanup pending. */
export const maxCleanupWaitMs = 30_000;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createCleanup(options: {
	transport: Transport; sleep?: (ms: number) => Promise<void>; now?: () => number; delaysMs?: readonly number[]
}): Cleanup {
	const { transport } = options;
	const sleep = options.sleep ?? wait; const now = options.now ?? Date.now; const delays = options.delaysMs ?? defaultCleanupDelaysMs;
	let held: { token: string; expiresAt: string } | null = null;
	let phase: CleanupState = 'none';
	/** No send before this time (ms since the epoch): the last answer's `retry-after`, or 0. */
	let notBefore = 0;

	/** One sign-out: true when the session is confirmed unusable. Records any `retry-after`. */
	const sendOnce = async (token: string): Promise<boolean> => {
		let retryAfter: number | undefined;
		try {
			const answer = await transport.request('POST', apiPaths.signOut, token);
			if (answer.kind === 'answered' && ((answer.status >= 200 && answer.status < 300) || answer.status === 401)) return true;
			if (answer.kind === 'answered') retryAfter = answer.retryAfter;
		} catch { /* just another failure */ }
		notBefore = retryAfter === undefined ? 0 : now() + retryAfter * 1000;
		return false;
	};
	const finish = (done: boolean): 'revoked' | 'still-pending' => {
		if (done) { held = null; phase = 'none'; notBefore = 0; return 'revoked'; }
		phase = 'pending'; return 'still-pending';
	};

	return {
		state: () => phase,
		async begin(token, expiresAt) {
			if (held !== null) throw new Error('cleanup: a session is already held for revocation');
			held = { token, expiresAt }; phase = 'running'; notBefore = 0;
			for (const delay of delays) {
				const ms = Math.max(delay, notBefore - now());
				if (ms > maxCleanupWaitMs) return finish(false);
				if (ms > 0) await sleep(ms);
				if (now() < notBefore) return finish(false);
				if (await sendOnce(token)) return finish(true);
			}
			return finish(false);
		},
		async retry() {
			if (held === null) return 'revoked';
			if (phase !== 'pending' || now() < notBefore) return 'still-pending';
			phase = 'running';
			return finish(await sendOnce(held.token));
		},
		expiresAt: () => held?.expiresAt ?? null,
		retryAt: () => (held !== null && now() < notBefore ? new Date(notBefore).toISOString() : null)
	};
}
