/** Exact callback validation (mobile foundation contract §3.2 step 6; docs/plans/expo-mobile-auth-core-2026-09.md). Pure,
 *  and deliberately not built on URL or URLSearchParams: the callback is a custom-scheme URL, parsers disagree about
 *  those, and React Native's URL support is partial. The accepted form is fixed text, so it is checked as text. */

/** This build's scheme. The callback has no host: `app.askthecaptain.dev:/auth/callback`. */
export const callbackScheme = 'app.askthecaptain.dev';
/** The redirect prefix given to the authentication session, and the exact start of an accepted callback. */
export const callbackUrl = `${callbackScheme}:/auth/callback`;

const handoffCode = /^nh_[A-Za-z0-9_-]{43}$/;
const maxLength = 512;

/** The handoff code from the browser's return value, or null. It is accepted only if:
 *  - it starts with exactly `app.askthecaptain.dev:/auth/callback?` (so: this scheme in lower case, no `//` host form, no
 *    other path, no trailing slash);
 *  - it has no fragment;
 *  - its query is exactly one `code` matching `nh_` plus 43 base64url characters and exactly one `attempt` equal to
 *    this attempt's value, in either order, with nothing else and no percent-encoding.
 *  The code is returned only to the attempt core, which sends it once to the exchange. */
export function readCallback(returned: unknown, attempt: string): { code: string } | null {
	if (typeof returned !== 'string' || returned.length > maxLength || returned.includes('#')) return null;
	const prefix = `${callbackUrl}?`;
	if (!returned.startsWith(prefix)) return null;
	const pairs = returned.slice(prefix.length).split('&');
	if (pairs.length !== 2) return null;
	const found = new Map<string, string>();
	for (const pair of pairs) {
		const equals = pair.indexOf('=');
		if (equals <= 0) return null;
		const key = pair.slice(0, equals);
		if ((key !== 'code' && key !== 'attempt') || found.has(key)) return null;
		found.set(key, pair.slice(equals + 1));
	}
	const code = found.get('code');
	if (code === undefined || !handoffCode.test(code) || found.get('attempt') !== attempt) return null;
	return { code };
}
