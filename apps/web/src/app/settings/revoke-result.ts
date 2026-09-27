/** "Sign out everywhere else" on the web (docs/plans/mobile-session-revocation-2026-09.md §3): the results the page can
 *  show and their exact wording. Pure, with no app imports, so the browser can import it. The server action returns
 *  only these shapes; the browser checks what it received before showing anything, and anything else is `unknown`. */

export type RevokeResult =
	| { readonly kind: 'ended'; readonly ended: number }
	/** The session check before sending failed, so nothing was sent. */
	| { readonly kind: 'not-sent'; readonly reason: 'signed-out' | 'unavailable' }
	| { readonly kind: 'rate-limited'; readonly retryAfter: number | null }
	/** Any other 4xx. It says nothing about what changed. */
	| { readonly kind: 'refused' }
	/** 5xx, no answer, an unusable answer, or a failed action call: whether anything changed is not known. */
	| { readonly kind: 'unknown' };

export const unknownResult: RevokeResult = Object.freeze({ kind: 'unknown' });

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const exactKeys = (value: object, keys: readonly string[]) => {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => own.includes(key));
};

/** What the action returned, accepted only in an exact allowed shape (no other keys); anything else is `unknown`. */
export function checkResult(value: unknown): RevokeResult {
	if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return unknownResult;
	const result = value as Record<string, unknown>;
	const { kind, ended, reason, retryAfter } = result;
	switch (kind) {
		case 'ended':
			return exactKeys(result, ['kind', 'ended']) && count(ended) ? { kind: 'ended', ended } : unknownResult;
		case 'not-sent':
			return exactKeys(result, ['kind', 'reason']) && (reason === 'signed-out' || reason === 'unavailable') ? { kind: 'not-sent', reason } : unknownResult;
		case 'rate-limited':
			return exactKeys(result, ['kind', 'retryAfter']) && (retryAfter === null || count(retryAfter)) ? { kind: 'rate-limited', retryAfter } : unknownResult;
		case 'refused':
			return exactKeys(result, ['kind']) ? { kind: 'refused' } : unknownResult;
		default:
			return unknownResult;
	}
}

export const revokeCopy = {
	button: 'Sign out everywhere else',
	confirm: 'Sign out of Captain in every other browser and app where you’re signed in, including on phones? This browser stays signed in.',
	cancel: 'Cancel',
	pending: 'Signing out everywhere else…',
	stillVisible: 'Anything already open on another screen stays visible until that screen next checks with Captain. Sign-ins already in progress, and new sign-ins, can still start new sessions.',
	none: 'No other active sessions were ended.',
	signedOut: 'Your session has ended. Sign in again; nothing was sent.',
	// The same line as `actionSession`'s (lib/session.ts), copied so this module imports nothing server-side.
	unavailable: 'Captain could not reach its service to check your session, so nothing was sent. Your sign-in has been kept; try again in a moment.',
	later: 'Too many attempts. Try again later.',
	refused: 'Captain couldn’t sign out your other sessions.',
	unknown: 'Captain couldn’t confirm whether your other sessions were ended. It’s safe to try again.'
} as const;

/** The result in words, one line per paragraph. Refused and unknown never claim that nothing changed. */
export function revokeResultText(result: RevokeResult): string[] {
	switch (result.kind) {
		case 'ended':
			if (result.ended === 0) return [revokeCopy.none];
			return [`${result.ended === 1 ? '1 other active session' : `${result.ended} other active sessions`} ended.`, revokeCopy.stillVisible];
		case 'not-sent':
			return [result.reason === 'signed-out' ? revokeCopy.signedOut : revokeCopy.unavailable];
		case 'rate-limited':
			if (result.retryAfter === null) return [revokeCopy.later];
			return [`Too many attempts. Try again in ${result.retryAfter === 1 ? '1 second' : `${result.retryAfter} seconds`}.`];
		case 'refused':
			return [revokeCopy.refused];
		case 'unknown':
			return [revokeCopy.unknown];
	}
}
