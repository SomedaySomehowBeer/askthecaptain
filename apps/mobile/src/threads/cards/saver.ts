/** One card write with the thread composer's uncertain-write rules (versions contract §5, §6):
 *  - each save carries a client change set id; the server returns the first result for a retry with the same id and the
 *    same content, and refuses that id for anything else;
 *  - an uncertain answer (no response, a 5xx) keeps the id and the exact body, locks the form, and waits for the person
 *    to retry it or discard it. Nothing is retried automatically. A change line carrying the id confirms it;
 *  - a 429 keeps the form editable with its wait; a 409 stale revision reloads and says so; a 404 is lost access.
 *  Pure: injected send, clock and id source, so Node tests drive it. */
import type { Result } from '../api.ts';

export type SaveTone = 'plain' | 'ok' | 'warn';
export type SaveState = {
	readonly busy: boolean;
	/** The write in flight or awaiting an explicit retry: its id and the exact body sent. */
	readonly pending: { readonly id: string; readonly body: unknown } | null;
	/** True after an answer that cannot say whether the write happened: the form is locked until retry or discard. */
	readonly uncertain: boolean;
	readonly message: string;
	readonly tone: SaveTone;
	readonly waitUntil: number;
	/** The last refusal's code, for a screen that explains one (a booking overlap). */
	readonly refusal: string | null;
};
/** `refusals`: words for a screen's own refusal codes, taking precedence over the shared ones below. */
export type SaveCopy = { saving: string; saved: string; confirmed: string; refusals?: Readonly<Record<string, string>> };
export const saveCopy = {
	unknown: 'This change may have been saved. Your changes and their change ID are kept; save again with the same ID to confirm, or discard them.',
	rate: 'Too many requests. Your changes are still here; wait before saving again.',
	stale: 'Someone changed this since you opened it. The current version is shown; check it, then make your change again.',
	idUnavailable: 'That change ID was already used for something else. Nothing was saved; save again to use a new one.',
	refused: 'Captain refused this change. Review it and try again.',
	discarded: 'Changes discarded. Anything already saved is in the thread.'
} as const;
/** Refusal codes the API documents for these writes, in words. */
const refusals: Record<string, string> = {
	evidence_required: 'This task needs evidence attached before it can be done.',
	owner_invalid: 'The owner must be an active member of this organisation.',
	title_required: 'A title is needed.',
	step_depth: 'A step cannot have steps of its own.',
	reservation_conflict: 'That equipment is unavailable during this time, including setup and cleanup. Choose another time.',
	reservation_cancelled: 'This booking is cancelled. Make a new booking to use the equipment again.',
	equipment_archived: 'This equipment is archived. A booking on it cannot be changed.',
	stock_archived: 'This item is archived. Restore it before counting it.',
	invalid_request: 'Captain could not accept these values. Check them and try again.',
	forbidden: 'You can no longer change this.',
	thread_is_record: 'This thread already belongs to a record, so it can’t become a task. It is shown as it is now.',
	thread_not_topic: 'Only a topic can become a task. A private thread stays private.'
};

export type Saver<T> = {
	snapshot(): SaveState; subscribe(fn: () => void): () => void; dispose(): void;
	/** A new save. Refused while one is in flight, uncertain or waiting. `body` gets the change set id. */
	save(build: (changeSetId: string) => { body: unknown; send: () => Promise<Result<T>> }): Promise<void>;
	/** The uncertain write again: the same id, the same body. */
	retry(): Promise<void>;
	/** Drop an uncertain or refused write; the record is reloaded. */
	discard(): void;
	/** A change line (or a reload) showed this change set: the uncertain write happened. */
	confirm(changeSetIds: readonly string[]): void;
	/** Clears a message after a later, unrelated success (a step tick). */
	clear(): void;
};
export function createSaver<T>(hooks: {
	now(): number; randomId(): string; copy: SaveCopy;
	/** After a confirmed write: reconcile the card and thread from the server. */
	saved(value: T | null): void | Promise<void>;
	/** After a 409 stale revision or a discard: reload the record. */
	reload(): void | Promise<void>;
	lost(): void;
}): Saver<T> {
	let live = true, again: (() => Promise<Result<T>>) | null = null;
	let state: SaveState = { busy: false, pending: null, uncertain: false, message: '', tone: 'plain', waitUntil: 0, refusal: null };
	const listeners = new Set<() => void>();
	const set = (next: Partial<SaveState>) => { if (!live) return; state = { ...state, ...next }; listeners.forEach((fn) => fn()); };
	const blocked = () => !live || state.busy || state.uncertain || hooks.now() < state.waitUntil;
	async function run(send: () => Promise<Result<T>>) {
		const sent = state.pending;
		const result = await send();
		if (!live || result.kind === 'stale' || state.pending !== sent) return;
		if (result.kind === 'ok') {
			again = null; set({ busy: false, pending: null, uncertain: false, message: hooks.copy.saved, tone: 'ok', refusal: null });
			await hooks.saved(result.value); return;
		}
		if (result.status === 404) { again = null; set({ busy: false, pending: null, uncertain: false, message: '', refusal: null }); hooks.lost(); return; }
		if (result.status === 429) { set({ busy: false, uncertain: false, waitUntil: hooks.now() + Math.max(1, result.retryAfter) * 1000, message: saveCopy.rate, tone: 'warn', refusal: null }); return; }
		if (result.uncertain) { set({ busy: false, uncertain: true, waitUntil: hooks.now() + result.retryAfter * 1000, message: saveCopy.unknown, tone: 'warn', refusal: null }); return; }
		again = null;
		if (result.code === 'stale_revision') { set({ busy: false, pending: null, uncertain: false, message: saveCopy.stale, tone: 'warn', refusal: result.code }); await hooks.reload(); return; }
		set({ busy: false, pending: null, uncertain: false, tone: 'warn', refusal: result.code,
			message: result.code === 'change_set_id_unavailable' ? saveCopy.idUnavailable : hooks.copy.refusals?.[result.code] ?? refusals[result.code] ?? saveCopy.refused });
		// The record changed under the card (someone cancelled the booking or archived the item): show it as it is now.
		if (result.code === 'reservation_cancelled' || result.code === 'stock_archived') await hooks.reload();
	}
	return {
		snapshot: () => state,
		subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
		dispose() { live = false; listeners.clear(); },
		async save(build) {
			if (blocked()) return;
			// A 429 left the id unused: keep it, so the same intent keeps one change set id.
			const id = state.pending?.id ?? hooks.randomId();
			const { body, send } = build(id);
			again = send;
			set({ busy: true, pending: { id, body }, uncertain: false, message: hooks.copy.saving, tone: 'plain', refusal: null });
			await run(send);
		},
		async retry() {
			if (!live || state.busy || !state.uncertain || !again || hooks.now() < state.waitUntil) return;
			set({ busy: true, uncertain: false, message: hooks.copy.saving, tone: 'plain' });
			await run(again);
		},
		discard() {
			if (!live || state.busy) return;
			again = null; set({ pending: null, uncertain: false, message: saveCopy.discarded, tone: 'plain', refusal: null });
			void hooks.reload();
		},
		confirm(ids) {
			if (!live || !state.pending || state.busy || !ids.includes(state.pending.id)) return;
			again = null; set({ pending: null, uncertain: false, message: hooks.copy.confirmed, tone: 'ok', refusal: null });
			void hooks.saved(null);
		},
		clear() { if (live && !state.busy && !state.uncertain) set({ message: '', tone: 'plain', refusal: null }); }
	};
}
