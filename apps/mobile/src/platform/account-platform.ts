/** What account composition receives from the device (docs/plans/expo-mobile-auth-composition-2026-09.md §2, §3). Types
 *  only, so the pure `compose` (src/account/compose.ts) and its node tests can build fakes of it. The one real value is
 *  `appAccountPlatform` in ./app-account.ts, which binds the installed modules.
 *
 *  Interface agreed between the platform side (A) and composition (B):
 *  - `compose` checks `authPlatform` first: null means misconfigured, and nothing else here is touched.
 *  - Then `apiOrigin`: null means misconfigured (the value is never repeated).
 *  - Then `openDeviceStorage()`, exactly once, never timed out into a second call.
 *  - `send` goes only into `createTransport({ origin: apiOrigin, send })`.
 *  - `monotonicNow` is raw. `compose` wraps it once in the clamp (a reading below the last one counts as the last one)
 *    and passes that single clamped function to the account runner, to both `createCleanup({ now })` calls and to the
 *    token-free account source's `now` for screens and the harness. Nothing else reads it.
 *  - `wallNow` is for wording only ("about {time}"): no send is ever decided with it. */
import type { Send } from '../api/client.ts';
import type { AuthPlatform } from '../auth/contracts.ts';
import type { DeviceStorage } from './secure-storage.ts';

export type AccountPlatform = {
	/** The attempt core's platform services on iOS and Android; null on platforms without native adapters; web uses its own cookie source. */
	readonly authPlatform: AuthPlatform | null;
	/** The validated API origin from src/config.ts, or null when the build's value was refused. */
	readonly apiOrigin: string | null;
	/** Opens the device's credential storage; answers unavailable rather than throwing when it can't. */
	readonly openDeviceStorage: () => Promise<DeviceStorage>;
	/** The transport's `send`: `expo/fetch` with `redirect: 'error'` and `credentials: 'omit'` forced. */
	readonly send: Send;
	/** Milliseconds from a monotonic source for pacing and timers. Not clamped here; see above. */
	readonly monotonicNow: () => number;
	/** Milliseconds since the epoch, only to display an approximate time. */
	readonly wallNow: () => number;
};
