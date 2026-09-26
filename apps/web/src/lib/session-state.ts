import { ApiError } from './api.ts';

/** What a failed `/v1/me` means. Only a confirmed 401 ends a session; everything else (the API
 *  unreachable, rate limited, failing or answering oddly) says nothing about the session, so the
 *  cookie is kept and the person is told the service is unavailable instead of being signed out. */
export function sessionFailure(error: unknown): 'signed-out' | 'unavailable' {
	return error instanceof ApiError && error.status === 401 ? 'signed-out' : 'unavailable';
}

const returnProbe = 'https://return-path.invalid';

/** A local path to come back to (with any query and fragment, unchanged), or the default. Never another origin.
 *  The API keeps the same rule in `apps/api/src/auth/return-path.ts`; change both together.
 *  - Exactly one leading slash: `//host` is protocol-relative.
 *  - No backslash (browsers and the URL parser read it as a slash, so `/\host` is `//host`).
 *  - No control characters (URL parsing strips tabs and newlines, which can turn `/\t/host` into `//host`).
 *  - Resolved against a fixed origin it stays there, and its path does not begin with `//` (`/..//host`). */
export function safeReturn(value: unknown, fallback = '/work'): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return fallback;
	if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
	let resolved: URL;
	try { resolved = new URL(value, returnProbe); } catch { return fallback; }
	return resolved.origin === returnProbe && !resolved.pathname.startsWith('//') ? value : fallback;
}

/** An absolute URL on this app for a return path, for route handlers that must redirect with a full URL.
 *  Checked twice: the path by `safeReturn`, then the resolved origin against the app's own. */
export function appReturnUrl(value: unknown, appOrigin: string, fallback = '/'): URL {
	const app = new URL(appOrigin);
	const target = new URL(safeReturn(value, fallback), app);
	return target.origin === app.origin ? target : new URL(fallback, app);
}

/** Where to go when the session cannot be checked: a page that makes no session call, so it can
 *  never bounce between itself and sign-in. */
export const unavailableHref = (returnTo: string) => `/unavailable?return_to=${encodeURIComponent(safeReturn(returnTo))}`;
