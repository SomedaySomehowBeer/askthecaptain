import { ApiError } from './api.ts';

/** What a failed `/v1/me` means. Only a confirmed 401 ends a session; everything else (the API
 *  unreachable, rate limited, failing or answering oddly) says nothing about the session, so the
 *  cookie is kept and the person is told the service is unavailable instead of being signed out. */
export function sessionFailure(error: unknown): 'signed-out' | 'unavailable' {
	return error instanceof ApiError && error.status === 401 ? 'signed-out' : 'unavailable';
}

/** A local path to come back to, or the default. Never another origin. */
export function safeReturn(value: string | undefined | null, fallback = '/work'): string {
	// One leading slash, no backslash (some browsers read it as a slash) and no control characters
	// (browsers strip tabs and newlines, which can turn `/\t/host` into `//host`).
	return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\u0000-\u001f\u007f]/.test(value) ? value : fallback;
}

/** Where to go when the session cannot be checked: a page that makes no session call, so it can
 *  never bounce between itself and sign-in. */
export const unavailableHref = (returnTo: string) => `/unavailable?return_to=${encodeURIComponent(safeReturn(returnTo))}`;
