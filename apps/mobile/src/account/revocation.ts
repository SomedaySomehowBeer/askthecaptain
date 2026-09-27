import type { ApiOutcome } from '../auth/contracts.ts';
import type { Wait } from './clock.ts';

/** Sign out everywhere else, the mobile half (docs/plans/mobile-session-revocation-2026-09.md §4, §5a.3-4). Pure: the
 *  types, the answer parser and the state rules the runner and the test harness share. Token-free: nothing here holds
 *  or derives from a token or a handle. */

/** Whose sessions a revocation is for: the verified person in this account generation. `epoch` is opaque (compare it
 *  for equality only). It changes on every sign-in, sign-out, session end and account switch, and never on a membership
 *  refresh or an organisation change: revocation belongs to the person and the session, not the organisation. */
export type PersonScope = { readonly epoch: string; readonly userId: string };

export const samePerson = (a: PersonScope | null, b: PersonScope | null): boolean =>
	a !== null && b !== null && a.epoch === b.epoch && a.userId === b.userId;

/** The API's answer: `{ ended }`, the number of other active sessions this call ended. */
export type Revoked = { readonly ended: number };

/** Strict: the one key, a non-negative safe integer. Throws otherwise, which the client reports as unavailable, so a
 *  malformed or oversized 200 is `unknown` here, never a count. */
export function parseRevoked(value: unknown): Revoked {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('revoke-others: not an object');
	const keys = Object.keys(value);
	const ended = (value as { ended?: unknown }).ended;
	if (keys.length !== 1 || keys[0] !== 'ended' || typeof ended !== 'number' || !Number.isSafeInteger(ended) || ended < 0)
		throw new TypeError('revoke-others: not a count');
	return Object.freeze({ ended });
}

/** A settled answer for the current person, kept as the view's `last` (C2: the status is kept, so a 429 is worded as
 *  one).
 *  - `ok`: the API answered with the count this call ended.
 *  - `unknown`: no usable answer (network, timeout, 429, 5xx, a 2xx that didn't parse, or a rejected request). Whether
 *    the write committed is unknown. `status` is the HTTP status (0 without one); `wait` is this call's own server wait
 *    from `Retry-After`; `seconds` is that `Retry-After`, for wording only.
 *  - `refused`: any other 4xx except 401. It may come from a proxy, so nothing is claimed about what changed. */
export type RevokeResult =
	| { readonly kind: 'ok'; readonly ended: number }
	| { readonly kind: 'unknown'; readonly status: number; readonly wait: Wait | null; readonly seconds: number | null }
	| { readonly kind: 'refused'; readonly status: number };

/** What `revokeOthers` answers. It never rejects.
 *  - A `RevokeResult`: the call was sent for the current person and settled.
 *  - `stale`: nothing sent, or the answer no longer applies: not signed in, a person scope other than `expected`, a 401
 *    (the session is ending), or the person scope changed while it was in flight.
 *  - `in-flight`: nothing sent; one is already in flight for this person.
 *  - `waiting`: nothing sent; this person's server wait has not passed.
 *  - `client-bug`: the request could not be made or something unexpected threw. The view shows it as `unknown`, since
 *    a request may have left. */
export type RevokeOutcome =
	| RevokeResult
	| { readonly kind: 'stale' }
	| { readonly kind: 'in-flight' }
	| { readonly kind: 'waiting'; readonly wait: Wait }
	| { readonly kind: 'client-bug' };

/** What the Account screen shows for the current person. One frozen object, replaced only when its content changes.
 *  - `inFlight`: a request is out; the control is disabled.
 *  - `slow`: in flight for ten seconds or more (wording only; it cancels nothing).
 *  - `wait`: the server's wait still recorded (the control is disabled until `wait.until` on the shared clock).
 *  - `last`: the latest settled answer, cleared when the next request is sent (C4). */
export type RevocationView = { readonly inFlight: boolean; readonly slow: boolean; readonly wait: Wait | null; readonly last: RevokeResult | null };

/** The view for a person with no revocation state, and for no person at all: one shared frozen object. */
export const idleRevocation: RevocationView = Object.freeze({ inFlight: false, slow: false, wait: null, last: null });

/** Sending: the previous result and any wait that has passed are cleared in the same change (C4). */
export const sendingRevocation: RevocationView = Object.freeze({ inFlight: true, slow: false, wait: null, last: null });

export const staleOutcome = Object.freeze({ kind: 'stale' as const });
export const inFlightOutcome = Object.freeze({ kind: 'in-flight' as const });
export const clientBugOutcome = Object.freeze({ kind: 'client-bug' as const });

/** Whether a new request may be sent for this person now: null if so, else why not. A wait blocks until exactly
 *  `until` (at `until` it no longer does, as elsewhere). */
export function admit(view: RevocationView, now: number): { readonly kind: 'in-flight' } | { readonly kind: 'waiting'; readonly wait: Wait } | null {
	if (view.inFlight) return inFlightOutcome;
	if (view.wait !== null && now < view.wait.until) return Object.freeze({ kind: 'waiting' as const, wait: view.wait });
	return null;
}

/** The view once in flight for ten seconds: the same, marked slow. Unchanged (the same object) if not in flight or
 *  already slow, so a late timer can never create a change. */
export const slowRevocation = (view: RevocationView): RevocationView =>
	(!view.inFlight || view.slow ? view : Object.freeze({ ...view, slow: true }));

/** The view after a settled answer: not in flight, not slow, the answer's own wait (if any), and the answer as `last`. */
export const settledRevocation = (result: RevokeResult): RevocationView =>
	Object.freeze({ inFlight: false, slow: false, wait: result.kind === 'unknown' ? result.wait : null, last: result } satisfies RevocationView);

/** The shown result for a request that may have left but gave nothing usable back (a rejected client, a bug). */
export const unknownResult: RevokeResult = Object.freeze({ kind: 'unknown' as const, status: 0, wait: null, seconds: null });

/** Maps the client's answer to a result, or `unauthorised` for a confirmed 401 (the caller ends the session). `waitOf`
 *  turns a `Retry-After` in seconds into a wait on the shared clock. */
export function resultOf(answer: ApiOutcome<Revoked>, waitOf: (seconds: number) => Wait | null): RevokeResult | 'unauthorised' {
	if (answer.ok) return Object.freeze({ kind: 'ok' as const, ended: answer.value.ended });
	if (answer.kind === 'unauthorised') return 'unauthorised';
	if (answer.kind === 'refused') return Object.freeze({ kind: 'refused' as const, status: answer.status });
	const seconds = answer.retryAfter === undefined ? null : answer.retryAfter;
	return Object.freeze({ kind: 'unknown' as const, status: answer.status, wait: seconds === null ? null : waitOf(seconds), seconds });
}
