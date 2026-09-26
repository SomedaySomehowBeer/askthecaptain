/** A thread's state as snapshots and the change feed arrive (web plan §2 "Convergence", handoff §8). Pure.
 *
 *  The stream renders only messages inside loaded seq ranges. Messages known from pin hydration, from edits to older
 *  rows, or from changes beyond the loaded tail are kept for pins and "Go to message" but never become isolated stream
 *  rows. Every entity is upserted by id, keeping the row with the higher `changeSeq`. Gaps are found by `seq` only. */
import type { ChangesPage, Message, MessageIntent, MessagesPage, MessageWindow, Pin, PinsPage, PinWithMessage } from './types.ts';

/** Inclusive; ranges are contiguous, non-overlapping and sorted. */
export type SeqRange = { from: number; to: number };
export type ThreadState = {
	conversationId: string; revision: number; lastSeq: number;
	/** The `after` for the next changes request. */
	cursor: number;
	/** The latest changes page was complete. */
	caughtUp: boolean;
	/** Caught up and no seq gap open: only then may reads advance or the thread say it is up to date. */
	current: boolean;
	/** Every known message by id, including those outside the loaded ranges. */
	messages: Map<string, Message>;
	ranges: SeqRange[];
	/** The first seq missing after the tail; the thread loads `after: gapFrom - 1` until it is covered. */
	gapFrom: number | null;
	/** Pins by id, live and unpinned; and messages known from pin hydration. */
	pins: Map<string, Pin>; pinMessages: Map<string, Message>;
	pinsWatermark: number;
	deleted: Set<string>;
};

const newer = <T extends { changeSeq: number }>(known: T | undefined, next: T): boolean => !known || next.changeSeq > known.changeSeq;
function upsert<T extends { id: string; changeSeq: number }>(map: Map<string, T>, row: T): void {
	if (newer(map.get(row.id), row)) map.set(row.id, row);
}
const tailOf = (ranges: SeqRange[]): number => ranges.at(-1)?.to ?? 0;

/** The seqs a messages page covers, given the window it was asked for. Every seq up to `lastSeq` exists (a deleted
 *  message keeps its seq as a tombstone), so a page without more reaches the end or the start of the conversation. */
export function pageRange(page: MessagesPage, window: MessageWindow): SeqRange | null {
	const first = page.messages[0], last = page.messages.at(-1);
	if (!first || !last) return null;
	if ('latest' in window) return { from: page.hasMore ? first.seq : 1, to: Math.max(last.seq, page.conversation.lastSeq) };
	if ('after' in window) return { from: window.after + 1, to: page.hasMore ? last.seq : Math.max(last.seq, page.conversation.lastSeq) };
	return { from: page.hasMore ? first.seq : 1, to: Math.max(last.seq, window.before - 1) };
}

/** Insert a range, joining any it overlaps or touches. */
export function mergeRange(ranges: SeqRange[], range: SeqRange): SeqRange[] {
	const all = [...ranges, range].sort((a, b) => a.from - b.from);
	const merged: SeqRange[] = [];
	for (const r of all) {
		const prev = merged.at(-1);
		if (prev && r.from <= prev.to + 1) prev.to = Math.max(prev.to, r.to);
		else merged.push({ ...r });
	}
	return merged;
}

/** Changes start after the older of two independently read snapshots, then catch up before claiming current state. */
export const initialCursor = (messages: MessagesPage, pins: PinsPage): number => Math.min(messages.conversation.lastChange, pins.conversation.lastChange);

function trackDeleted(deleted: Set<string>, m: Message) { if (m.deletedAt) deleted.add(m.id); }

export function initialState(messages: MessagesPage, window: MessageWindow, pins: PinsPage): ThreadState {
	const state: ThreadState = {
		conversationId: messages.conversation.id, revision: messages.conversation.revision, lastSeq: messages.conversation.lastSeq,
		cursor: initialCursor(messages, pins), caughtUp: false, current: false,
		messages: new Map(), ranges: [], gapFrom: null, pins: new Map(), pinMessages: new Map(),
		pinsWatermark: pins.conversation.lastChange, deleted: new Set()
	};
	for (const m of messages.messages) { upsert(state.messages, m); trackDeleted(state.deleted, m); }
	const range = pageRange(messages, window);
	if (range) state.ranges = [range];
	for (const { message, ...pin } of pins.pins) { upsert(state.pins, pin); upsert(state.pinMessages, message); trackDeleted(state.deleted, message); }
	return state;
}

function copy(s: ThreadState): ThreadState {
	return { ...s, messages: new Map(s.messages), ranges: s.ranges.map((r) => ({ ...r })), pins: new Map(s.pins), pinMessages: new Map(s.pinMessages), deleted: new Set(s.deleted) };
}

/** After messages arrive from any page: the gap runs from the tail to the known end. A page whose snapshot knows of
 *  messages beyond the tail opens one; the tail reaching the end closes it; a partial load moves it forward. */
function settleTail(next: ThreadState): ThreadState {
	const tail = tailOf(next.ranges);
	next.gapFrom = tail >= next.lastSeq ? null : tail + 1;
	next.current = next.caughtUp && next.gapFrom === null;
	return next;
}

function takeMessages(s: ThreadState, page: MessagesPage): ThreadState {
	const next = copy(s);
	for (const m of page.messages) { upsert(next.messages, m); trackDeleted(next.deleted, m); }
	next.lastSeq = Math.max(next.lastSeq, page.conversation.lastSeq);
	return next;
}

/** A loaded page (earlier messages, "Go to message", or filling a gap): upsert and merge its range. */
export function applyMessages(s: ThreadState, page: MessagesPage, window: MessageWindow): ThreadState {
	const next = takeMessages(s, page);
	const range = pageRange(page, window);
	if (range) next.ranges = mergeRange(next.ranges, range);
	return settleTail(next);
}

/** A reconciliation re-read (`after: seq - 1, limit: 1`): update the known messages without adding a stream range, so
 *  re-reading a message outside the loaded windows never shows it as an isolated row. */
export function upsertMessages(s: ThreadState, page: MessagesPage): ThreadState {
	return settleTail(takeMessages(s, page));
}

/** A bounded changes page, in change order. */
export function applyChanges(s: ThreadState, page: ChangesPage): { state: ThreadState; refetchDetail: boolean; refetchPins: boolean; gapFrom: number | null } {
	const next = copy(s);
	// Judged once, against the state before this page: had the loaded tail reached every message then known?
	const atTail = s.gapFrom === null && tailOf(s.ranges) >= s.lastSeq;
	let refetchPins = false;
	const fresh = new Set<number>();
	const startTail = tailOf(next.ranges);
	for (const change of page.changes) {
		if (change.kind === 'message') {
			upsert(next.messages, change.message);
			trackDeleted(next.deleted, change.message);
			if (change.message.seq > startTail) fresh.add(change.message.seq);
		} else {
			upsert(next.pins, change.pin);
		}
	}
	for (const pin of next.pins.values()) {
		if (pin.unpinnedAt === null && !next.messages.has(pin.messageId) && !next.pinMessages.has(pin.messageId)) refetchPins = true;
	}
	// New seqs above the tail, ascending: every contiguous one extends it, so L+1, L+2… in one page leave no gap.
	let tail = startTail;
	let extendedFrom: number | null = null;
	for (const seq of [...fresh].sort((a, b) => a - b)) {
		if (atTail && next.gapFrom === null && seq === tail + 1) { if (extendedFrom === null) extendedFrom = seq; tail = seq; continue; }
		if (next.gapFrom === null) next.gapFrom = tail + 1;
		break;
	}
	if (extendedFrom !== null) next.ranges = mergeRange(next.ranges, { from: extendedFrom, to: tail });
	next.lastSeq = Math.max(s.lastSeq, page.conversation.lastSeq);
	const refetchDetail = page.conversation.revision !== s.revision;
	next.revision = Math.max(s.revision, page.conversation.revision);
	next.cursor = Math.max(s.cursor, page.next);
	next.caughtUp = page.complete;
	next.current = next.caughtUp && next.gapFrom === null;
	return { state: next, refetchDetail, refetchPins, gapFrom: next.gapFrom };
}

/** A pins snapshot. It never resurrects an unpin already seen in the feed, and a snapshot older than one already
 *  applied changes nothing. A pin known as live but absent from a newer snapshot has ended. */
export function applyPins(s: ThreadState, page: PinsPage): ThreadState {
	if (page.conversation.lastChange < s.pinsWatermark) return s;
	const next = copy(s);
	const listed = new Set<string>();
	for (const { message, ...pin } of page.pins) {
		listed.add(pin.id);
		upsert(next.pins, pin); upsert(next.pinMessages, message); trackDeleted(next.deleted, message);
	}
	for (const pin of s.pins.values()) {
		if (pin.unpinnedAt === null && !listed.has(pin.id) && pin.changeSeq <= page.conversation.lastChange) {
			// Recorded at the snapshot's change number, so no older feed replay can make it live again.
			next.pins.set(pin.id, { ...pin, changeSeq: page.conversation.lastChange, unpinnedAt: pin.pinnedAt, unpinnedBy: null });
		}
	}
	next.pinsWatermark = page.conversation.lastChange;
	return next;
}

/** The most recent version of a message from either source. */
export function knownMessage(s: ThreadState, id: string): Message | undefined {
	const a = s.messages.get(id), b = s.pinMessages.get(id);
	if (!a) return b; if (!b) return a;
	return b.changeSeq > a.changeSeq ? b : a;
}

const inRanges = (ranges: SeqRange[], seq: number) => ranges.some((r) => seq >= r.from && seq <= r.to);

/** Messages whose seq lies in a loaded range, one row per message id, by seq. */
export function streamRows(s: ThreadState): Message[] {
	const rows: Message[] = [];
	for (const m of s.messages.values()) if (inRanges(s.ranges, m.seq)) rows.push(knownMessage(s, m.id) ?? m);
	return rows.sort((a, b) => a.seq - b.seq);
}

/** Every live pin whose message is known and not deleted, in pin order. */
export function livePins(s: ThreadState): PinWithMessage[] {
	const live: PinWithMessage[] = [];
	for (const pin of s.pins.values()) {
		if (pin.unpinnedAt !== null) continue;
		const message = knownMessage(s, pin.messageId);
		if (!message || message.deletedAt || s.deleted.has(message.id)) continue;
		live.push({ ...pin, message });
	}
	return live.sort((a, b) => a.changeSeq - b.changeSeq);
}

/** Whether an unclear edit or delete took effect, from `readMessages({ after: seq - 1, limit: 1 })`. `gone` means the
 *  intent can no longer happen: the message is not there, or an edit's message was deleted. */
export function reconcileIntent(intent: MessageIntent, page: MessagesPage): 'done' | 'not-done' | 'gone' {
	const row = page.messages.find((m) => m.id === intent.messageId.toLowerCase());
	if (!row) return 'gone';
	if (intent.kind === 'delete') return row.deletedAt ? 'done' : 'not-done';
	if (row.deletedAt) return 'gone';
	return row.revision > intent.fromRevision && row.body === intent.body ? 'done' : 'not-done';
}

/** The highest displayed seq that is part of the loaded stream, for the read position; 0 when none. */
export function highestDisplayed(seqs: Iterable<number>, s: ThreadState): number {
	let highest = 0;
	for (const seq of seqs) if (seq > highest && seq <= s.lastSeq && inRanges(s.ranges, seq)) highest = seq;
	return highest;
}
