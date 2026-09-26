'use client';
import { useCallback, useRef, useState } from 'react';
import { applyPins, livePins, reconcileIntent, upsertMessages, type ThreadState } from '../../app/chat/feed.ts';
import { deleteMessage, editMessage, pinMessage, readMessages, readPins, unpinMessage } from '../../app/chat/actions.ts';
import { chatWords } from '../../app/chat/results.ts';
import { normaliseBody, type Message, type MessageIntent, type Pin } from '../../app/chat/types.ts';
import type { Viewer } from './viewer-types.ts';

/** The feed state with a synchronous mirror: the poller's `onPage` must compute the next cursor from the state as
 *  it is now, not as of the last render. Every change goes through `update`. */
export function useFeed(initial: () => ThreadState) {
	const [state, setState] = useState(initial);
	const ref = useRef(state);
	const update = useCallback((change: (s: ThreadState) => ThreadState) => { ref.current = change(ref.current); setState(ref.current); return ref.current; }, []);
	return { state, ref, update };
}
export type Feed = ReturnType<typeof useFeed>;

/** How a row action ended, in words for the row. `current` is the text now stored when the edit was stale.
 *  `unresolved`: the write may or may not have landed and the re-read failed too; the row stays locked with its intent,
 *  and `check` only reads (never writes) until the outcome is known. `waitUntil`: rate limited, nothing was changed,
 *  and no further write from this row is allowed before that time. */
export type RowOutcome = { ok: true; note?: string }
	| { ok: false; error: string; current?: string | null; stale?: true; latest?: Message | null; unresolved?: () => Promise<RowOutcome>; waitUntil?: number };
// `latest` (stale only): the exact message the stale re-read returned, which the next attempt must be based on;
// null when that re-read failed, so the row keeps its old snapshot and says the current version is unknown.

type Hooks = { viewer: Viewer; conversationId: string; feed: Feed; onGone(): void; onScope(message: string): void; onSignedOut(): void };

const notConfirmed = 'Captain could not confirm whether that was saved. Check your connection, then check again.';
const words = (code: string, fallback: string) => chatWords[code] ?? fallback;
/** A write call that threw (the request may have reached Captain) is treated exactly like an uncertain result. */
const lost = { ok: false as const, kind: 'uncertain' as const, error: notConfirmed, retryAfter: null, requestId: null };
const limited = (retryAfter: number | null): RowOutcome => {
	const seconds = Math.max(1, retryAfter ?? 1);
	return { ok: false, error: `Too many changes just now. Try again in ${seconds} seconds; nothing was changed.`, waitUntil: Date.now() + seconds * 1000 };
};

/** Edit, delete, pin and unpin for one conversation, shared by the full thread and the item panel. Nothing retries on
 *  its own: a stale or uncertain result re-reads the intended state (by seq for messages, the pins page for pins) and
 *  reports whether it holds (plan §2). Every re-read is a real page applied through the feed's upsert rules. */
export function messageActions({ viewer, conversationId, feed, onGone, onScope, onSignedOut }: Hooks) {
	const scope = viewer.scope;
	const oneAt = (seq: number) => ({ after: seq - 1, limit: 1 });

	async function reread(seq: number) {
		const page = await readMessages(scope, conversationId, oneAt(seq)).catch(() => null);
		if (page?.ok) feed.update(s => upsertMessages(s, page.value));
		else if (page?.kind === 'gone') onGone();
		else if (page?.kind === 'signed-out') onSignedOut();
		else if (page?.kind === 'wrong-scope') onScope(page.error);
		return page ?? { ok: false as const, kind: 'unreadable' as const };
	}
	async function refreshPins() {
		const page = await readPins(scope, conversationId).catch(() => null);
		if (page?.ok) feed.update(s => applyPins(s, page.value));
		else if (page?.kind === 'gone') onGone();
		else if (page?.kind === 'signed-out') onSignedOut();
		else if (page?.kind === 'wrong-scope') onScope(page.error);
		return page?.ok ?? false;
	}
	const liveFor = (messageId: string) => livePins(feed.ref.current).some(p => p.messageId === messageId);

	/** Read the message back and say whether the intended edit or delete holds. Only reads; while the read fails the
	 *  outcome stays unresolved and the row keeps its intent and its lock. */
	async function settleMessage(intent: MessageIntent): Promise<RowOutcome> {
		const page = await reread(intent.seq);
		if (!page.ok) return page.kind === 'gone' ? { ok: false, error: 'This conversation is not available to you.' }
			: { ok: false, error: notConfirmed, unresolved: () => settleMessage(intent) };
		const outcome = reconcileIntent(intent, page.value);
		if (outcome === 'done') {
			if (intent.kind === 'delete') await refreshPins();
			return { ok: true, note: intent.kind === 'edit' ? 'Saved.' : 'Deleted.' };
		}
		if (outcome === 'gone') return { ok: false, error: 'This message is no longer available.' };
		return { ok: false, error: `Not ${intent.kind === 'edit' ? 'saved' : 'deleted'}. Try again when you are ready.` };
	}
	/** Read the pins back and say whether the intended pin or unpin holds, on the same terms. */
	async function settlePin(holds: () => boolean, done: string, notDone: string): Promise<RowOutcome> {
		if (!await refreshPins()) return { ok: false, error: notConfirmed, unresolved: () => settlePin(holds, done, notDone) };
		return holds() ? { ok: true, note: done } : { ok: false, error: notDone };
	}

	/** The common failure paths of a message write, after the kind-specific ones. */
	async function failed(intent: MessageIntent, result: { kind: string; error: string; retryAfter: number | null; code?: string }): Promise<RowOutcome> {
		switch (result.kind) {
			case 'uncertain': return settleMessage(intent);
			case 'gone': {
				// 404 on a message write: the message was deleted meanwhile, or this person lost access to the conversation.
				const page = await reread(intent.seq);
				return { ok: false, error: page.ok ? 'This message was deleted by someone else.' : 'This conversation is not available to you.' };
			}
			case 'rate-limited': return limited(result.retryAfter);
			case 'wrong-scope': onScope(result.error); return { ok: false, error: result.error };
			case 'signed-out': onSignedOut(); return { ok: false, error: result.error };
			case 'refused': return { ok: false, error: words(result.code ?? '', result.error) };
			default: return { ok: false, error: result.error };
		}
	}

	return {
		refreshPins,
		async edit(message: Message, input: string): Promise<RowOutcome> {
			const body = normaliseBody(input);
			if (typeof body !== 'string') return { ok: false, error: body.error };
			if (body === message.body) return { ok: true };
			const intent = { messageId: message.id, seq: message.seq, kind: 'edit' as const, fromRevision: message.revision, body };
			const result = await editMessage({ scope, conversationId, intent }).catch(() => lost);
			if (result.ok) { await reread(message.seq); return { ok: true }; }
			if (result.kind === 'stale') {
				const page = await reread(message.seq);
				const now = page.ok ? page.value.messages.find(m => m.id === message.id) ?? null : null;
				return now
					? { ok: false, stale: true, latest: now, current: now.body, error: 'This message changed since you opened it. Its current text is shown; your draft is kept. Save again to replace that version.' }
					: { ok: false, stale: true, latest: null, current: null, error: 'This message changed since you opened it, and its current version could not be read. Your draft is kept; nothing was saved. Try saving again to check.' };
			}
			return failed(intent, result);
		},
		async remove(message: Message): Promise<RowOutcome> {
			const intent = { messageId: message.id, seq: message.seq, kind: 'delete' as const, fromRevision: message.revision };
			const result = await deleteMessage({ scope, conversationId, intent }).catch(() => lost);
			// A live pin on it is unpinned in the same transaction; re-read pins so no panel keeps showing it.
			if (result.ok) { await reread(message.seq); await refreshPins(); return { ok: true }; }
			if (result.kind === 'stale') {
				const page = await reread(message.seq);
				const now = page.ok ? page.value.messages.find(m => m.id === message.id) ?? null : null;
				return now
					? { ok: false, stale: true, latest: now, error: 'This message changed since you chose Delete. Check it above, then delete that version if you still want to.' }
					: { ok: false, stale: true, latest: null, error: 'This message changed since you chose Delete, and its current version could not be read. Nothing was deleted.' };
			}
			return failed(intent, result);
		},
		async pin(messageId: string): Promise<RowOutcome> {
			const result = await pinMessage({ scope, conversationId, messageId }).catch(() => lost);
			if (result.ok) { await refreshPins(); return { ok: true }; }
			// Already pinned is the intended state (the action resolves it to the live pin when it can read one).
			if (result.kind === 'refused' && result.code === 'message_already_pinned') { await refreshPins(); return { ok: true, note: 'Already pinned.' }; }
			if (result.kind === 'uncertain') return settlePin(() => liveFor(messageId), 'Pinned.', 'Not pinned. Try again when you are ready.');
			if (result.kind === 'gone') { onGone(); return { ok: false, error: 'This conversation is not available to you.' }; }
			if (result.kind === 'rate-limited') return limited(result.retryAfter);
			if (result.kind === 'wrong-scope') { onScope(result.error); return { ok: false, error: result.error }; }
			if (result.kind === 'signed-out') { onSignedOut(); return { ok: false, error: result.error }; }
			return { ok: false, error: result.kind === 'refused' ? words(result.code, result.error) : result.error };
		},
		async unpin(pin: Pin): Promise<RowOutcome> {
			const result = await unpinMessage({ scope, conversationId, pinId: pin.id }).catch(() => lost);
			const gone = () => !livePins(feed.ref.current).some(p => p.id === pin.id);
			if (result.ok) { await refreshPins(); return { ok: true }; }
			if (result.kind === 'uncertain') return settlePin(gone, 'Unpinned.', 'Not unpinned. Try again when you are ready.');
			// 404: the pin is no longer live, or this person lost access (the pins read says which).
			if (result.kind === 'gone') return settlePin(gone, 'Already unpinned.', 'Not unpinned. Try again when you are ready.');
			if (result.kind === 'rate-limited') return limited(result.retryAfter);
			if (result.kind === 'wrong-scope') { onScope(result.error); return { ok: false, error: result.error }; }
			if (result.kind === 'signed-out') { onSignedOut(); return { ok: false, error: result.error }; }
			return { ok: false, error: result.kind === 'refused' ? words(result.code, result.error) : result.error };
		},
	};
}
export type MessageActions = ReturnType<typeof messageActions>;
