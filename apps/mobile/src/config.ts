/** Build-time configuration (docs/plans/expo-mobile-auth-composition-2026-09.md §2 step 2 and §4.6). The only file that
 *  reads the two public variables, `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_APP_URL`, which Expo inlines at build time.
 *  Both are checked with the API transport's origin rule (`apiOrigin`): https, or loopback http in a development build;
 *  lower case; no credentials, path, query, fragment or default port. A refused value is null here and is never
 *  repeated in any message, state or log.
 *
 *  Pure apart from the two reads at the bottom, so node tests cover `readConfig` and `webLink` directly. */
import { apiOrigin } from './api/client.ts';

/** Metro defines it in app bundles; it does not exist in node tests, where it counts as not development. */
declare const __DEV__: boolean | undefined;

export type AppConfig = {
	/** The API origin for the transport, or null: account composition answers `misconfigured` and builds nothing. */
	readonly apiOrigin: string | null;
	/** The Captain website's origin for "Open Captain on the web" links, or null: the links are hidden and the page
	 *  says the address isn't set in this build. */
	readonly webOrigin: string | null;
};

const originOrNull = (value: unknown, development: boolean): string | null => {
	try { return apiOrigin(value, development); } catch { return null; }
};

/** Both origins from raw values. `development` allows loopback http and nothing else. */
export function readConfig(values: { api: unknown; app: unknown }, development: boolean): AppConfig {
	return Object.freeze({ apiOrigin: originOrNull(values.api, development), webOrigin: originOrNull(values.app, development) });
}

/** The only website paths the app links to. Anything else is not linkable. */
export const webPaths = ['/', '/settings'] as const;
export type WebPath = (typeof webPaths)[number];

/** The website link for an allow-listed path, built as text from the validated origin and a fixed path; never from
 *  anything a server or incoming link supplied. Null when the origin was refused or the path is not on the list. Opened
 *  with the external browser (`Linking.openURL`), never the authentication session. */
export function webLink(webOrigin: string | null, path: WebPath): string | null {
	if (webOrigin === null || !(webPaths as readonly string[]).includes(path)) return null;
	return `${webOrigin}${path}`;
}

/** This build's configuration. */
export const config: AppConfig = readConfig(
	{ api: process.env.EXPO_PUBLIC_API_URL, app: process.env.EXPO_PUBLIC_APP_URL },
	typeof __DEV__ !== 'undefined' && __DEV__ === true
);
