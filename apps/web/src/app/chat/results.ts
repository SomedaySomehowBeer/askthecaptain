/** How a chat action ended, for every read and write (web plan §2). Only `uncertain` may have changed something without
 *  saying so; `rate-limited` was not processed. Pure apart from recognising `ApiError`. */
import { ApiError } from '../../lib/api.ts';
import { chatTiming } from './types.ts';

type Base = { requestId: string | null; error: string };
export type ChatFailure<T = never> =
	| ({ ok: false; kind: 'not-sent'; retryAfter: null } & Base)          // invalid input or no session; nothing sent
	| ({ ok: false; kind: 'signed-out'; retryAfter: null } & Base)        // 401
	| ({ ok: false; kind: 'wrong-scope'; retryAfter: null } & Base)       // another person or organisation is now active; nothing sent
	| ({ ok: false; kind: 'rate-limited'; retryAfter: number } & Base)    // 429, not processed
	| ({ ok: false; kind: 'gone'; retryAfter: null } & Base)              // 404: access lost, or never had it
	| ({ ok: false; kind: 'stale'; retryAfter: null; current: T | null } & Base) // 409 stale_revision, with a re-read
	| ({ ok: false; kind: 'id-unavailable'; retryAfter: null } & Base)    // 409 conversation_id_unavailable | message_id_unavailable
	| ({ ok: false; kind: 'refused'; retryAfter: null; code: string } & Base) // any other 4xx: nothing changed
	| ({ ok: false; kind: 'uncertain'; retryAfter: null } & Base);        // unreachable, 5xx or no answer: may have changed
export type ChatResult<T> = { ok: true; value: T; requestId: string | null } | ChatFailure<T>;
type ReadFailureKinds = 'gone' | 'rate-limited' | 'wrong-scope' | 'signed-out' | 'not-sent';
export type ChatRead<T> = { ok: true; value: T }
	| Extract<ChatFailure, { kind: ReadFailureKinds }>
	| ({ ok: false; kind: 'unreadable'; retryAfter: null } & Base);     // unreachable, 5xx or any other refusal of a read
export type ChatReadFailure = Exclude<ChatRead<never>, { ok: true }>;

/** One plain sentence per API code or result kind, saying what happened and what to do next. */
export const chatWords: Record<string, string> = {
	participant_limit: 'A conversation can have up to 50 people, you included. Remove someone before adding more.',
	link_limit: 'A conversation can link up to 10 tasks and projects. Remove a link before adding another.',
	pin_limit: 'This conversation already has 50 pinned messages. Unpin one before pinning another.',
	message_already_pinned: 'That message is already pinned.',
	message_deleted: 'That message was deleted, so it cannot be pinned or changed.',
	link_exists: 'That task or project is already linked to this conversation.',
	participant_unavailable: 'Someone you chose is no longer an active member of this organisation. Nobody was added; check the people and try again.',
	link_target_unavailable: 'A task or project you chose is no longer available. Nothing was saved; check the links and try again.',
	invalid_body: 'A message is 1 to 4,000 characters of plain text.',
	invalid_request: 'Captain could not accept that request. Reload the page and try again.',
	forbidden: 'You cannot do that in this conversation.',
	conversation_id_unavailable: 'This new conversation could not use its reserved identity, so nothing was created. Start again to keep these details.',
	message_id_unavailable: 'This message could not use its reserved identity, so nothing was sent. Send it as a new message or discard it.',
	stale_revision: 'This changed since you opened it. Check what is there now and choose again.',
	'signed-out': 'Your session has ended. Sign in again; nothing more was sent.',
	'wrong-scope': 'This page was opened for a different sign-in or organisation than the one now active in this browser, so nothing was sent. Reload the page to continue in the current organisation.',
	gone: 'This conversation is not available to you.',
	'rate-limited': 'Captain is receiving too many requests from you. Nothing was sent; wait before trying again.',
	uncertain: 'Captain could not confirm whether that happened.',
	unreadable: 'Captain could not read this just now.'
};

const requestIdOf = (error: unknown) => error instanceof ApiError ? error.requestId : null;

/** Seconds to wait after a 429: the header's value, or 60 without one, never more than 300. */
export function retryAfterOf(error: ApiError): number {
	return Math.min(Math.max(error.retryAfter ?? 60, 1), chatTiming.retryAfterCapS);
}

/** Nothing was sent: bad input, or the session could not be checked. */
export const notSent = (error: string): Extract<ChatFailure, { kind: 'not-sent' }> => ({ ok: false, kind: 'not-sent', retryAfter: null, requestId: null, error });
export const wrongScope = (): Extract<ChatFailure, { kind: 'wrong-scope' }> => ({ ok: false, kind: 'wrong-scope', retryAfter: null, requestId: null, error: chatWords['wrong-scope']! });
export const signedOut = (): Extract<ChatFailure, { kind: 'signed-out' }> => ({ ok: false, kind: 'signed-out', retryAfter: null, requestId: null, error: chatWords['signed-out']! });

/** A failed write. A 4xx refusal means nothing changed; anything else may have. `current` is the stale re-read. */
export function toWriteFailure<T>(error: unknown, current: T | null = null): ChatFailure<T> {
	const requestId = requestIdOf(error);
	if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.status < 400) {
		return { ok: false, kind: 'uncertain', retryAfter: null, requestId, error: chatWords.uncertain! };
	}
	if (error.status === 401) return { ...signedOut(), requestId };
	if (error.status === 429) {
		const wait = retryAfterOf(error);
		return { ok: false, kind: 'rate-limited', retryAfter: wait, requestId, error: `${chatWords['rate-limited']} Try again in ${wait === 1 ? 'a second' : `${wait} seconds`}.` };
	}
	if (error.status === 404) return { ok: false, kind: 'gone', retryAfter: null, requestId, error: chatWords.gone! };
	if (error.code === 'stale_revision') return { ok: false, kind: 'stale', retryAfter: null, requestId, current, error: chatWords.stale_revision! };
	if (error.code === 'conversation_id_unavailable' || error.code === 'message_id_unavailable') {
		return { ok: false, kind: 'id-unavailable', retryAfter: null, requestId, error: chatWords[error.code]! };
	}
	return { ok: false, kind: 'refused', retryAfter: null, requestId, code: error.code, error: chatWords[error.code] ?? error.message };
}

/** A failed read. Nothing is guessed: anything but 401, 404 and 429 is `unreadable`, with the API's own words. */
export function toReadFailure(error: unknown): ChatReadFailure {
	const requestId = requestIdOf(error);
	if (error instanceof ApiError) {
		if (error.status === 401) return { ...signedOut(), requestId };
		if (error.status === 404) return { ok: false, kind: 'gone', retryAfter: null, requestId, error: chatWords.gone! };
		if (error.status === 429) {
			const wait = retryAfterOf(error);
			return { ok: false, kind: 'rate-limited', retryAfter: wait, requestId, error: `Captain is receiving too many requests from you. Try again in ${wait === 1 ? 'a second' : `${wait} seconds`}.` };
		}
	}
	return { ok: false, kind: 'unreadable', retryAfter: null, requestId, error: error instanceof ApiError ? error.message : chatWords.unreadable! };
}
