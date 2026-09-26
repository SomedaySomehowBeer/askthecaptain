/** Where a sign-in may send a person afterwards: a path on this app, never another origin.
 *  The web keeps the same rule in `apps/web/src/lib/session-state.ts` (`safeReturn`); change both together. */

const maxLength = 2048;
const probe = 'https://return-path.invalid';

/** The value unchanged when it is a same-origin path (with any query and fragment), otherwise null.
 *  - It must start with exactly one `/`: `//host` is protocol-relative.
 *  - No backslash anywhere: browsers and the WHATWG URL parser read `\` as `/`, so `/\host` is `//host`.
 *  - No control characters: URL parsing strips tabs and newlines, so `/\t/host` would become `//host`.
 *  - Resolved against a fixed origin, it must stay on that origin, and its path must not begin with `//`
 *    (dot segments such as `/..//host` normalise to that). */
export function safeReturnPath(value: unknown): string | null {
	if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return null;
	if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
	let resolved: URL;
	try { resolved = new URL(value, probe); } catch { return null; }
	if (resolved.origin !== probe || resolved.pathname.startsWith('//')) return null;
	return value;
}
