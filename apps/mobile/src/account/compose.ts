import { createApiClient, createTransport, type Transport } from '../api/client.ts';
import { createAttempts } from '../auth/attempt.ts';
import { createCleanup, type Cleanup } from '../auth/cleanup.ts';
import type { AccountPlatform } from '../platform/account-platform.ts';
import { createClampedClock, type Clock } from './clock.ts';
import { createAccountRunner, type AccountRunner } from './runner.ts';
import { createCredentialStore } from './store.ts';

/** Building the account graph (docs/plans/expo-mobile-auth-composition-2026-09.md §2). Pure: every platform part is
 *  injected (../platform/account-platform.ts), so node tests cover it with fakes; ../platform/app-account.ts binds the
 *  installed modules. It is called once per process (instance.ts): nothing here times out into a second composition.
 *
 *  Order: `authPlatform` null is web-only and nothing else is touched; a refused `apiOrigin` is misconfigured (the value
 *  is never repeated); then storage is opened exactly once; then transport, client, two distinct cleanups, attempts and
 *  the runner, which is started. The raw monotonic source is clamped here, once, and that single clock goes to the
 *  runner, both cleanups and the attempt core, and back to the account source for screens. */

export type Composition =
	| { readonly kind: 'web-only' }
	| { readonly kind: 'misconfigured' }
	| { readonly kind: 'ready'; readonly runner: AccountRunner; readonly clock: Clock };

/** The constructors compose uses; tests replace them to observe the graph. */
export type Builders = {
	readonly createTransport: typeof createTransport;
	readonly createApiClient: typeof createApiClient;
	readonly createCleanup: (options: { transport: Transport; now: () => number }) => Cleanup;
	readonly createAttempts: typeof createAttempts;
	readonly createAccountRunner: typeof createAccountRunner;
};
export const defaultBuilders: Builders = Object.freeze({ createTransport, createApiClient, createCleanup, createAttempts, createAccountRunner });

const webOnly: Composition = Object.freeze({ kind: 'web-only' });
const misconfigured: Composition = Object.freeze({ kind: 'misconfigured' });

export async function compose(platform: AccountPlatform, build: Builders = defaultBuilders): Promise<Composition> {
	const authPlatform = platform.authPlatform;
	if (authPlatform === null) return webOnly;
	const origin = platform.apiOrigin;
	if (origin === null) return misconfigured;
	const storage = await platform.openDeviceStorage();
	const clock = createClampedClock(platform.monotonicNow);
	const transport = build.createTransport({ origin, send: platform.send });
	const client = build.createApiClient(transport);
	// Two cleanups: the attempt core's is private to late exchange answers; the runner's is credited only to the handle
	// it holds. Both pace on the one clamped clock, so a changed phone clock cannot bring a revocation retry early.
	const attemptCleanup = build.createCleanup({ transport, now: clock.now });
	const runnerCleanup = build.createCleanup({ transport, now: clock.now });
	if (attemptCleanup === runnerCleanup) throw new Error('compose: the attempt core and the runner must not share a cleanup');
	const attempts = build.createAttempts({ platform: authPlatform, transport, cleanup: attemptCleanup, now: clock.now });
	const runner = build.createAccountRunner({
		createStore: storage.available ? (current) => createCredentialStore(storage.storage, current) : null,
		attempts, client, cleanup: runnerCleanup, clock, wallNow: platform.wallNow
	});
	runner.start();
	return Object.freeze({ kind: 'ready', runner, clock });
}
