import { unknownResult, type RevokeResult } from './revoke-result.ts';

/** How the server action's call to `POST /v1/me/sessions/revoke-others` ended, already reduced by the action (which
 *  alone imports the API client), so this module and its tests load nothing server-side. */
export type RevokeAnswer =
	| { readonly ok: true; readonly body: unknown }
	/** An `ApiError`: status 0 when the API could not be reached. */
	| { readonly ok: false; readonly status: number; readonly retryAfter: number | null }
	/** Anything else thrown, such as a 2xx whose body is not JSON (a 204 included). */
	| { readonly failed: true };

/** A post-send 401: the calling session has ended. Internal to the action, which redirects to sign-in on it. */
export type SignedOutAfterSend = { readonly kind: 'signed-out-after-send' };

/** A 200's body: only `ended` is read (other keys are ignored), and only a non-negative safe integer is accepted. */
export function parseEnded(body: unknown): RevokeResult {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return unknownResult;
	const ended = (body as { ended?: unknown }).ended;
	return Number.isSafeInteger(ended) && (ended as number) >= 0 ? { kind: 'ended', ended: ended as number } : unknownResult;
}

/** The result for an answer (contract §2 "Outcomes the client sees", §3 "Results"). */
export function classify(answer: RevokeAnswer): RevokeResult | SignedOutAfterSend {
	if ('failed' in answer) return unknownResult;
	if (answer.ok) return parseEnded(answer.body);
	const { status } = answer;
	if (status === 401) return { kind: 'signed-out-after-send' };
	if (status === 429) return { kind: 'rate-limited', retryAfter: Number.isSafeInteger(answer.retryAfter) && (answer.retryAfter as number) >= 0 ? answer.retryAfter : null };
	if (status >= 400 && status < 500) return { kind: 'refused' };
	return unknownResult; // 0 (no answer), 5xx, and anything unexpected
}
