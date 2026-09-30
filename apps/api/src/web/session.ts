import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { Exchanged } from '../auth/service.ts';
import { HttpError } from '../errors.ts';
import { safeReturnPath } from '../auth/return-path.ts';

/** The web session on the API's own origin (docs/plans/expo-web-session-2026-09.md §A, D37). The API serves the
 *  Expo web export and the browser holds the session in an HttpOnly cookie; no token ever reaches a page. What the
 *  Next.js callback route, its `native-handoff.ts` and its passkey action did is re-expressed here, unchanged in
 *  behaviour: the same cookies, the same redirects, the same error vocabulary. */

export const sessionCookie = 'captain_session';
/** Holds the `pks_` step-up token between the callback and the passkey page, scoped to the auth routes only. */
export const stepUpCookie = 'captain_stepup';
export const stepUpCookieMaxAge = 600;
export const stepUpCookiePath = '/auth';
/** The header a web page must send with a cookie session. The API sends no CORS headers, so a cross-site page cannot
 *  add it, and SameSite=Lax keeps the cookie off cross-site subrequests; a cookie without it is a navigation or a
 *  form post, never the app. */
export const clientHeader = 'x-captain-client';
export const clientHeaderValue = 'web';
export const csrfHeaderMissing = () => new HttpError(401, 'csrf_header_missing', `a cookie session needs the ${clientHeader} header`);

export type CookieSettings = { secure: boolean };

const cookie = (secure: boolean, path: string, maxAge: number) => ({ httpOnly: true, secure, sameSite: 'Lax' as const, path, maxAge });
/** Max-age from the session's expiry, at least a minute, exactly as the web computed it. */
export const sessionMaxAge = (expiresAt: Date, now = Date.now()) => Math.max(60, Math.floor((expiresAt.getTime() - now) / 1000));

export function setSessionCookie(c: Context, token: string, expiresAt: Date, settings: CookieSettings) {
	setCookie(c, sessionCookie, token, cookie(settings.secure, '/', sessionMaxAge(expiresAt)));
}
export function setStepUpCookie(c: Context, token: string, settings: CookieSettings) {
	setCookie(c, stepUpCookie, token, cookie(settings.secure, stepUpCookiePath, stepUpCookieMaxAge));
}
/** Both cookies with max-age 0 and their own paths, so the browser drops them whatever their state. */
export function clearSessionCookies(c: Context, settings: CookieSettings) {
	deleteCookie(c, sessionCookie, { httpOnly: true, secure: settings.secure, sameSite: 'Lax', path: '/' });
	clearStepUpCookie(c, settings);
}
export function clearStepUpCookie(c: Context, settings: CookieSettings) {
	deleteCookie(c, stepUpCookie, { httpOnly: true, secure: settings.secure, sameSite: 'Lax', path: stepUpCookiePath });
}

/** The app's fixed callback for a native handoff. It is this constant, never a request parameter or configuration
 *  value: a private-use scheme, so it is for isolated development and synthetic-account proofs only (mobile
 *  foundation contract §2, §10). */
export const nativeCallback = 'app.askthecaptain.dev:/auth/callback';
const handoffCode = /^nh_[A-Za-z0-9_-]{43}$/;
const attemptValue = /^[A-Za-z0-9_-]{43}$/;
/** The app's callback URL for a handoff, carrying exactly `code` and `attempt`. Null unless both are well formed. */
export function nativeTarget(answer: unknown): string | null {
	if (!answer || typeof answer !== 'object') return null;
	const { nativeHandoff, attempt } = answer as Record<string, unknown>;
	if (typeof nativeHandoff !== 'string' || !handoffCode.test(nativeHandoff)) return null;
	if (typeof attempt !== 'string' || !attemptValue.test(attempt)) return null;
	return `${nativeCallback}?${new URLSearchParams({ code: nativeHandoff, attempt })}`;
}

/** The welcome page's error vocabulary, as the Next.js sign-in page understood it: `request_invalid`, `google_failed`,
 *  `exchange_failed`, `passkey_failed`, `native_sign_in_disabled`. Anything else is said as "did not finish". */
export const welcomeError = (error: string) => `/welcome?error=${encodeURIComponent(error)}`;
const errorCode = /^[a-z_]+$/;
/** The error the callback repeats from the API's own Google callback, or `request_invalid` for anything unusable. */
export const callbackErrorCode = (error: string | undefined) => (error && errorCode.test(error) ? error : 'request_invalid');
/** The welcome error for an exchange the API refused. */
export function callbackFailure(caught: unknown): string {
	if (caught instanceof HttpError && caught.code === 'native_sign_in_disabled') return 'native_sign_in_disabled';
	return caught instanceof HttpError && caught.status === 401 ? 'request_invalid' : 'exchange_failed';
}

export type CallbackOutcome =
	| { kind: 'native'; location: string }
	| { kind: 'redirect'; location: string }
	| { kind: 'stepUp'; location: string; token: string }
	| { kind: 'session'; location: string; token: string; expiresAt: Date };

/** What /auth/callback does with the exchange's answer.
 *  - A handoff goes to the app's fixed callback, with no cookie. A malformed handoff goes to a failed sign-in.
 *  - A step-up goes to the passkey page with the token in the step-up cookie, marked `native=1` only when the
 *    exchange marked it native.
 *  - A session sets the session cookie and returns to a checked path on this app. The service checked the
 *    destination too; this is the sink, so it never trusts that alone. */
export function callbackOutcome(answer: Exchanged): CallbackOutcome {
	if ('nativeHandoff' in answer) {
		const location = nativeTarget(answer);
		return location ? { kind: 'native', location } : { kind: 'redirect', location: welcomeError('exchange_failed') };
	}
	if ('stepUp' in answer) return { kind: 'stepUp', location: answer.native === true ? '/auth/passkey?native=1' : '/auth/passkey', token: answer.token };
	return { kind: 'session', location: safeReturnPath(answer.returnTo) ?? '/', token: answer.token, expiresAt: answer.session.expiresAt };
}
