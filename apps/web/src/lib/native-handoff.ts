import { ApiError } from './api.ts';
import { appReturnUrl } from './session-state.ts';

/** The web side of the native sign-in handoff (docs/plans/expo-mobile-foundation-2026-09.md §3.2 steps 3–5,
 *  A2). A mobile app runs Google and any passkey step-up in its authentication browser. When the API answers
 *  a native sign-in, the web never creates, replaces or clears its own session cookie. It passes the one-time
 *  handoff code and the app's attempt to the app's fixed callback, and nothing else. The API decides whether a
 *  sign-in is native; the web only passes codes on.
 *
 *  The target is this constant, never a request parameter or configuration value. It is a private-use scheme,
 *  which any app can register, so it is for isolated development and synthetic-account proofs only.
 *  NATIVE_SIGN_IN stays off on shared staging and for real accounts until a claimed HTTPS callback passes the
 *  app-identity gate (contract §2, §10). */
export const nativeCallback = 'app.askthecaptain.dev:/auth/callback';

const handoffCode = /^nh_[A-Za-z0-9_-]{43}$/;
const attemptValue = /^[A-Za-z0-9_-]{43}$/;

export type SessionAnswer = { token: string; expiresAt: string; returnTo: string };
export type HandoffAnswer = { nativeHandoff: string; attempt: string };
/** What POST /auth/session/exchange answers. */
export type Exchanged = SessionAnswer | { stepUp: true; native?: true; token: string; returnTo: string } | HandoffAnswer;

/** The app's callback URL for a handoff, carrying exactly `code` and `attempt`. Null unless the answer holds a
 *  well-formed handoff code and attempt. */
export function nativeTarget(answer: unknown): string | null {
	if (!answer || typeof answer !== 'object') return null;
	const { nativeHandoff, attempt } = answer as Record<string, unknown>;
	if (typeof nativeHandoff !== 'string' || !handoffCode.test(nativeHandoff)) return null;
	if (typeof attempt !== 'string' || !attemptValue.test(attempt)) return null;
	return `${nativeCallback}?${new URLSearchParams({ code: nativeHandoff, attempt })}`;
}

export type CallbackOutcome =
	| { kind: 'native'; location: string }
	| { kind: 'redirect'; location: URL }
	| { kind: 'session'; location: URL; token: string; maxAgeSeconds: number };

/** The sign-in page, with an error to say. */
export function signInError(error: string, appUrl: string): URL {
	const url = new URL('/sign-in', appUrl); url.searchParams.set('error', error); return url;
}

/** What /auth/callback does with the API's answer.
 *  - A handoff goes to the app's fixed callback, with no cookie. A malformed handoff goes to a failed sign-in.
 *  - A step-up goes to the passkey page, marked `native=1` only when the API marked it native.
 *  - A session sets the web cookie and returns to a checked path on this app, exactly as before. */
export function callbackOutcome(answer: Exchanged, appUrl: string, now = Date.now()): CallbackOutcome {
	if ('nativeHandoff' in answer) {
		const location = nativeTarget(answer);
		return location ? { kind: 'native', location } : { kind: 'redirect', location: signInError('exchange_failed', appUrl) };
	}
	if ('stepUp' in answer) {
		const stepUp = new URL('/auth/passkey', appUrl); stepUp.searchParams.set('token', answer.token);
		if (answer.native === true) stepUp.searchParams.set('native', '1');
		return { kind: 'redirect', location: stepUp };
	}
	// The API checks the destination too; this is the sink, so it never trusts that alone.
	return { kind: 'session', location: appReturnUrl(answer.returnTo, appUrl), token: answer.token,
		maxAgeSeconds: Math.max(60, Math.floor((Date.parse(answer.expiresAt) - now) / 1000)) };
}

/** The sign-in page error for an exchange the API refused or could not answer. */
export function callbackFailure(caught: unknown): string {
	if (caught instanceof ApiError && caught.code === 'native_sign_in_disabled') return 'native_sign_in_disabled';
	return caught instanceof ApiError && caught.unauthorised ? 'request_invalid' : 'exchange_failed';
}

/** The passkey page is a mobile step-up only for exactly `native=1`. That marker only stops the page from
 *  skipping the step-up because this browser also holds an unrelated web sign-in; a Custom Tab can share one.
 *  The API alone decides whether the verified step-up yields a handoff or a web session. */
export const nativeStepUp = (value: unknown): boolean => value === '1';
