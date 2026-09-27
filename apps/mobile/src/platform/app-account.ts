/** The installed modules account composition uses (docs/plans/expo-mobile-auth-composition-2026-09.md §2), in the shape
 *  of ./account-platform.ts. Typecheck-only: it imports native modules, so node tests cover the adapters and `compose`
 *  with fakes.
 *
 *  Nothing runs at import beyond building adapter objects and reading the build configuration: no storage is opened, no
 *  browser shown and no request made until composition calls these. The web preview imports this too; there
 *  `authPlatform` is null, so composition stops at web-only before touching anything else. */
import { config } from '../config.ts';
import type { AccountPlatform } from './account-platform.ts';
import { authPlatform, openDeviceStorage } from './expo.ts';
import { nativeSend } from './fetch.ts';

export const appAccountPlatform: AccountPlatform = Object.freeze({
	authPlatform,
	apiOrigin: config.apiOrigin,
	openDeviceStorage,
	send: nativeSend,
	// React Native's performance.now() is monotonic (it does not follow the phone's date and time settings).
	monotonicNow: () => performance.now(),
	wallNow: () => Date.now()
});
