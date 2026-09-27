/** The single sign-in attempt (mobile foundation contract §3.2 steps 1–7; docs/plans/expo-mobile-auth-core-2026-09.md). Pure: the platform
 *  and the transport are injected. Only the account effect runner calls it; screens read `state()` through the runner.
 *
 *  - `start()` throws AttemptActive unless idle: while an attempt is opening, awaiting its callback, exchanging or
 *    closing, and while a cleanup is running or pending.
 *  - `cancel()` works only before the exchange is sent. It discards the attempt and dismisses the browser, then the
 *    state is `closing` until the platform call already under way (crypto or the authentication session) settles, so a
 *    new attempt never overlaps the old browser. A callback that still arrives is not delivered and nothing is sent.
 *    If that platform call never settles, the state stays `closing`: the runner bounds the wait and tells the person
 *    (next increment); the core does not pretend it is idle.
 *
 *  Invariant: at most one exchange is ever in flight, and the attempt that sent it stays current until it is answered,
 *  because `cancel()` is refused while exchanging and nothing else discards an attempt. The late-answer branch at the
 *  end of `start()` (revoke a session that arrives for a discarded attempt) is therefore unreachable through this
 *  interface and has no test of its own; the cleanup it calls is tested directly. It is a guard, not a feature: any
 *  change that can discard an attempt mid-exchange must keep it and add a test that reaches it. The cleanup states are
 *  likewise reached today only through an injected cleanup (as the tests do); the runner (next increment) must still
 *  present `cleanup-pending` as an actionable state, with `pendingCleanupRetryAt()` and a Try again action. */
import type { Transport } from '../api/client.ts';
import { nativeStartPath } from '../api/paths.ts';
import { linkTarget, refusedLink, safeReturnPath } from '../lib/links.ts';
import { callbackUrl, readCallback } from './callback.ts';
import { createCleanup, type Cleanup } from './cleanup.ts';
import { AttemptActive, type Attempts, type AttemptOutcome, type AttemptState, type AuthPlatform } from './contracts.ts';
import { exchange } from './exchange.ts';
import { createPkce, type Pkce } from './pkce.ts';

/** `{origin}/auth/google/start?client=native&code_challenge=…&code_challenge_method=S256&attempt=…[&return_to=…]`.
 *  `return_to` is included only when it is a same-origin path, unchanged, that opens an app route; otherwise it is left
 *  out and the API's default applies. */
export function startUrl(origin: string, pkce: Pick<Pkce, 'challenge' | 'attempt'>, returnTo?: string): string {
	const query = `client=native&code_challenge=${pkce.challenge}&code_challenge_method=S256&attempt=${pkce.attempt}`;
	const kept = returnTo !== undefined && safeReturnPath(returnTo) === returnTo && linkTarget(returnTo) !== refusedLink ? `&return_to=${encodeURIComponent(returnTo)}` : '';
	return `${origin}${nativeStartPath}?${query}${kept}`;
}

type Phase = 'idle' | 'opening' | 'awaiting-callback' | 'exchanging' | 'closing';

export function createAttempts(options: {
	platform: AuthPlatform; transport: Transport; cleanup?: Cleanup; sleep?: (ms: number) => Promise<void>; now?: () => number; cleanupDelaysMs?: readonly number[]
}): Attempts {
	const { platform, transport } = options;
	const cleanup = options.cleanup ?? createCleanup({
		transport, ...(options.sleep ? { sleep: options.sleep } : {}), ...(options.now ? { now: options.now } : {}), ...(options.cleanupDelaysMs ? { delaysMs: options.cleanupDelaysMs } : {})
	});
	let phase: Phase = 'idle';
	let current = 0;

	const state = (): AttemptState => {
		const held = cleanup.state();
		if (held === 'running') return 'cleaning-up';
		if (held === 'pending') return 'cleanup-pending';
		return phase;
	};

	return {
		state,
		async start(returnTo) {
			if (state() !== 'idle') throw new AttemptActive();
			const attempt = ++current; phase = 'opening';
			const isCurrent = () => attempt === current;
			// Only this call can end its attempt: no other start can begin until the phase is idle again, so resetting
			// the phase here, after its own platform call has settled, is always this attempt's to do.
			const end = (outcome: AttemptOutcome): AttemptOutcome => { phase = 'idle'; return isCurrent() ? outcome : { kind: 'cancelled' }; };

			let pkce: Pkce;
			// The platform's crypto failing is not a cancellation; nothing was sent, and the person can start again.
			try { pkce = await createPkce(platform); } catch { return end({ kind: 'cannot-finish' }); }
			if (!isCurrent()) return end({ kind: 'cancelled' });

			phase = 'awaiting-callback';
			let result: { type: string; url?: unknown };
			try { result = await platform.openAuthSession(startUrl(transport.origin, pkce, returnTo), callbackUrl); } catch { return end({ kind: 'cancelled' }); }
			if (!isCurrent()) return end({ kind: 'cancelled' });
			// Every result other than success (cancel, dismiss, locked, Android's opened, anything new) is a cancellation.
			if (result.type !== 'success' || typeof result.url !== 'string') return end({ kind: 'cancelled' });
			const callback = readCallback(result.url, pkce.attempt);
			if (callback === null) return end({ kind: 'callback-invalid' });

			phase = 'exchanging';
			const outcome = await exchange(transport, callback.code, pkce.verifier, pkce.attempt);
			if (isCurrent()) return end(outcome);
			// Unreachable through this interface (see the invariant above): a late answer is never delivered, and a
			// session in it is revoked, not stranded.
			if (outcome.kind === 'signed-in') void cleanup.begin(outcome.session.token, outcome.session.expiresAt).catch(() => undefined);
			return end({ kind: 'cancelled' });
		},
		cancel() {
			if (phase !== 'opening' && phase !== 'awaiting-callback') return false;
			current += 1; phase = 'closing';
			try { platform.dismissAuthSession(); } catch { /* the browser may already be closed */ }
			return true;
		},
		retryCleanup: () => cleanup.retry(),
		pendingCleanupExpiresAt: () => cleanup.expiresAt(),
		pendingCleanupRetryAt: () => cleanup.retryAt()
	};
}
