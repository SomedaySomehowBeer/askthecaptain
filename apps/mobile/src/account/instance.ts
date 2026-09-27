import type { AccountPlatform } from '../platform/account-platform.ts';
import { createAccountSource, type AccountSource } from './account-source.ts';
import { compose } from './compose.ts';

/** The one account source per app process (docs/plans/expo-mobile-auth-composition-2026-09.md §2.1). It holds the single
 *  composition; a re-render or a strict-mode double effect reuses it. No React component is exported here.
 *
 *  Release builds evaluate this module once per process: one composition, one runner. In development, Fast Refresh can
 *  re-execute this module, so the source is also kept on a global symbol and a re-executed module reuses it rather than
 *  composing again. The reused source still runs the code it was built with: after editing anything under src/auth,
 *  src/account or src/platform, fully restart the app (reload the bundle). A reload loses in-memory tokens and pending
 *  cleanups, like killing the app; remote revocation is the remedy. No hot-dispose hook is relied on.
 *
 *  `platform` is resolved only inside the composition, so a throw while resolving it gives the fixed `startup-failed`
 *  snapshot, never a render error. (A failure while importing the platform binding happens at bundle load, before
 *  this runs; that is a device gate, not something code here can catch.) */

declare const __DEV__: boolean | undefined;
export const instanceKey = Symbol.for('captain.account.instance');

/** Where the source is kept: the development global, or this module's own slot in release builds. */
export type Holder = { [instanceKey]?: AccountSource };
const releaseHolder: Holder = {};

export function accountInstance(
	platform: () => AccountPlatform,
	options: {
		/** Tests only: replaces the development global or the release slot, so each test is isolated. */
		holder?: Holder; development?: boolean;
		create?: (platform: () => AccountPlatform) => AccountSource;
	} = {}
): AccountSource {
	const development = options.development ?? (typeof __DEV__ !== 'undefined' && __DEV__ === true);
	const holder = options.holder ?? (development ? (globalThis as Holder) : releaseHolder);
	const existing = holder[instanceKey];
	if (existing) return existing;
	const create = options.create ?? ((resolve: () => AccountPlatform) => createAccountSource(() => compose(resolve())));
	const source = create(platform);
	holder[instanceKey] = source;
	return source;
}
