/** Build-time configuration (docs/plans/expo-mobile-auth-composition-2026-09.md §2 step 2). The only file that reads
 *  `EXPO_PUBLIC_API_URL`, which Expo inlines at build time. It is the API origin for iOS and Android, checked with the
 *  API transport's origin rule (`apiOrigin`): https, or loopback http in a development build; lower case; no
 *  credentials, path, query, fragment or default port. A refused value is null here and is never repeated in any
 *  message, state or log. On the web the API serves the export from its own origin, so the page's origin is used
 *  instead (src/platform/app-web.ts) and this value is not read.
 *
 *  Pure apart from the one read at the bottom, so node tests cover `readConfig` directly. */
import { apiOrigin } from './api/client.ts';

/** Metro defines it in app bundles; it does not exist in node tests, where it counts as not development. */
declare const __DEV__: boolean | undefined;

export type AppConfig = {
	/** The API origin for the native transport, or null: account composition answers `misconfigured` and builds nothing. */
	readonly apiOrigin: string | null;
};

/** The origin from a raw value. `development` allows loopback http and nothing else. */
export function readConfig(values: { api: unknown }, development: boolean): AppConfig {
	let origin: string | null;
	try { origin = apiOrigin(values.api, development); } catch { origin = null; }
	return Object.freeze({ apiOrigin: origin });
}

/** This build's configuration. */
export const config: AppConfig = readConfig({ api: process.env.EXPO_PUBLIC_API_URL }, typeof __DEV__ !== 'undefined' && __DEV__ === true);
