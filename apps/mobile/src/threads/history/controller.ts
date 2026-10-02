/** History, selection, preview and apply for one thread's record (versions contract §4–§6; design boards 5–11). Pure:
 *  injected calls, clock, id source and storage, so Node tests drive it.
 *
 *  - The thread's detail says which record's history this is: a task, a booking or a stock item, or the thread itself
 *    (a topic's or private thread's own tags). Pages load newest first; "Show earlier changes" follows the cursor.
 *  - Ticking an entry selects all its change ids. The preview is read-only; the sheet may add the later changes a
 *    conflict names, or a coupled group's missing members, and preview again. Captain never chooses for the person.
 *  - Apply is one request with a new client id and the preview's basis. An uncertain answer keeps the id and body (and
 *    stores only those, scoped to the person and organisation) for an explicit retry; nothing is retried by itself. A
 *    `409 stale_preview` undid nothing: its fresh preview replaces the sheet and History reloads.
 *  - Every answer is checked against the screen's scope and the operation that asked; a late one is dropped. */
import type { ReadScope } from '../../account/contracts.ts';
import type { Result, ThreadCalls } from '../api.ts';
import type { Detail } from '../contracts.ts';
import { reads } from '../cards/records.ts';
import type { Names as LineNames } from '../wording.ts';
import { historyCalls, type ApplyBody, type Target } from './api.ts';
import type { Basis, ChangeSet, Entry, HistoryPage, HistoryStart, Names, Preview, Version } from './contracts.ts';
import { parseStale } from './parse.ts';
import type { PendingUndoStorage } from './storage.ts';
import { historyCopy, undone } from './copy.ts';

export type SheetState = {
	readonly phase: 'loading' | 'ready' | 'failed' | 'applying' | 'uncertain';
	/** The change ids this preview is for. */
	readonly selection: readonly string[];
	readonly preview: Preview | null;
	/** Set after a `409 stale_preview`: what moved. `preview` is then the fresh one. */
	readonly stale: { readonly moved: readonly Basis[] } | null;
	readonly message: string;
	readonly waitUntil: number;
	/** The apply in flight, uncertain, or held after a 429 (its id is reused for the same intent). */
	readonly pending: ApplyBody | null;
};
export type HistoryState = {
	readonly phase: 'idle' | 'loading' | 'ready' | 'failed' | 'lost';
	readonly detail: Detail | null;
	readonly target: Target | null;
	readonly record: HistoryPage['record'] | null;
	readonly sets: readonly ChangeSet[];
	readonly nextCursor: string | null;
	readonly start: HistoryStart | null;
	readonly names: Names;
	readonly loadingMore: boolean;
	readonly message: string;
	readonly waitUntil: number;
	readonly selected: readonly string[];
	readonly sheet: SheetState | null;
	readonly notice: string | null;
	/** An undo from an earlier visit whose answer was lost, until History shows it or the person forgets it. */
	readonly recovered: ApplyBody | null;
	readonly recoveredBusy: boolean;
	readonly recoveredMessage: string;
	readonly version: { readonly phase: 'loading' | 'ready' | 'failed'; readonly revision: number; readonly value: Version | null } | null;
	/** What the screen loaded to name steps and say times: the organisation's zone and the task's step titles. */
	readonly zone: string | null;
	readonly steps: Readonly<Record<string, string>>;
};

export function targetOf(detail: Detail): Target {
	const r = detail.card.record;
	if (!r) return { kind: 'thread', id: detail.thread.id };
	return { kind: r.kind === 'task' ? 'task' : r.kind === 'booking' ? 'reservation' : 'stock_item', id: r.id };
}

/** Entries of the loaded pages by change id, with their change set. */
export function entryIndex(sets: readonly ChangeSet[]): Map<string, { entry: Entry; set: ChangeSet }> {
	const map = new Map<string, { entry: Entry; set: ChangeSet }>();
	for (const set of sets) for (const entry of set.changes) for (const id of entry.changeIds) map.set(id, { entry, set });
	return map;
}
export const isTickable = (entry: Entry) => entry.state === 'reversible' || entry.state === 'conflict';

const emptyNames = (): Names => ({ people: {}, tags: {} });
const mergeNames = (a: Names, b: Names): Names => ({ people: { ...a.people, ...b.people }, tags: { ...a.tags, ...b.tags } });

export function createHistory(deps: {
	calls: ThreadCalls; scope: ReadScope; threadId: string; now(): number; randomId(): string; storage: PendingUndoStorage;
}) {
	const { calls, scope, threadId, now, storage } = deps;
	let live = true, loadSeq = 0, previewSeq = 0, applySeq = 0;
	let state: HistoryState = { phase: 'idle', detail: null, target: null, record: null, sets: [], nextCursor: null, start: null, names: emptyNames(), loadingMore: false,
		message: '', waitUntil: 0, selected: [], sheet: null, notice: null, recovered: null, recoveredBusy: false, recoveredMessage: '', version: null, zone: null, steps: {} };
	const listeners = new Set<() => void>();
	const active = () => live && calls.current(scope);
	const set = (next: Partial<HistoryState>) => { if (!active()) return; state = { ...state, ...next }; listeners.forEach((fn) => fn()); };
	const setSheet = (next: Partial<SheetState>) => { if (state.sheet) set({ sheet: { ...state.sheet, ...next } }); };
	const lost = () => { previewSeq++; applySeq++; set({ phase: 'lost', detail: null, sets: [], sheet: null, selected: [], message: '', version: null }); };
	const failed = (r: { status: number; retryAfter: number }) => {
		if (r.status === 404) { lost(); return; }
		set({ phase: state.record ? 'ready' : 'failed', loadingMore: false, message: r.status === 429 ? historyCopy.wait : historyCopy.failed, waitUntil: now() + Math.max(r.retryAfter, 3) * 1000 });
	};

	/** A loaded page shows the undo it was waiting for: it happened. */
	function reconcile(sets: readonly ChangeSet[]) {
		const ids = new Set(sets.map((s) => s.id));
		const pending = state.sheet?.pending ?? null;
		if (pending && state.sheet && state.sheet.phase !== 'applying' && ids.has(pending.id)) {
			storage.clear(scope, threadId);
			set({ sheet: null, selected: [], notice: undone(entriesCovered(pending.changeIds)) });
		}
		if (state.recovered && ids.has(state.recovered.id)) {
			storage.clear(scope, threadId);
			set({ recovered: null, recoveredMessage: '', notice: undone(entriesCovered(state.recovered.changeIds)) });
		}
	}
	/** How many entries a set of change ids covers, from the loaded pages (or the count of ids). */
	function entriesCovered(ids: readonly string[]): number {
		const index = entryIndex(state.sets), seen = new Set<string>();
		for (const id of ids) seen.add(index.get(id)?.entry.id ?? id);
		return seen.size;
	}

	async function extras(detail: Detail, seq: number) {
		const zone = await reads.zone(calls, scope);
		if (seq !== loadSeq || zone.kind !== 'ok') return;
		set({ zone: zone.value });
		if (detail.card.record?.kind === 'task') {
			const task = await reads.task(calls, scope, detail.card.record.id);
			if (seq !== loadSeq || task.kind !== 'ok') return;
			set({ steps: Object.fromEntries(task.value.steps.map((s) => [s.id, s.title])) });
		}
	}

	/** The thread, then the first page of its record's history. A reload keeps the notice. */
	async function load(): Promise<void> {
		if (!active() || now() < state.waitUntil || state.phase === 'lost') return;
		const seq = ++loadSeq;
		set({ phase: state.record ? state.phase : 'loading', message: '' });
		const detail = await calls.detail(scope, threadId);
		if (seq !== loadSeq || detail.kind === 'stale') return;
		if (detail.kind === 'error') { failed(detail); return; }
		const target = targetOf(detail.value);
		if (!state.target) void extras(detail.value, seq);
		const page = await historyCalls.page(calls, scope, target);
		if (seq !== loadSeq || page.kind === 'stale') return;
		if (page.kind === 'error') { failed(page); return; }
		const p = page.value;
		set({ phase: 'ready', detail: detail.value, target, record: p.record, sets: p.changeSets, nextCursor: p.nextCursor, start: p.start, names: p.names, loadingMore: false, message: '', waitUntil: 0,
			// Ticks stay on what is still tickable.
			selected: state.selected.filter((id) => { const e = entryIndex(p.changeSets).get(id)?.entry; return !e || isTickable(e); }) });
		if (state.recovered === null && !state.sheet) {
			const held = storage.load(scope, threadId);
			if (held) set({ recovered: held, recoveredMessage: historyCopy.recovered });
		}
		reconcile(p.changeSets);
	}

	async function more(): Promise<void> {
		if (!active() || !state.nextCursor || !state.target || state.loadingMore || now() < state.waitUntil) return;
		const seq = loadSeq, cursor = state.nextCursor;
		set({ loadingMore: true });
		const page = await historyCalls.page(calls, scope, state.target, cursor);
		if (seq !== loadSeq || page.kind === 'stale') { if (seq === loadSeq) set({ loadingMore: false }); return; }
		if (page.kind === 'error') { failed(page); return; }
		const known = new Set(state.sets.map((s) => s.id));
		const sets = [...state.sets, ...page.value.changeSets.filter((s) => !known.has(s.id))];
		set({ sets, nextCursor: page.value.nextCursor, start: page.value.start, names: mergeNames(state.names, page.value.names), loadingMore: false, message: '' });
		reconcile(page.value.changeSets);
	}

	function toggle(entry: Entry) {
		if (!isTickable(entry) || state.sheet) return;
		const on = entry.changeIds.every((id) => state.selected.includes(id));
		set({ selected: on ? state.selected.filter((id) => !entry.changeIds.includes(id)) : [...state.selected, ...entry.changeIds.filter((id) => !state.selected.includes(id))], notice: null });
	}

	async function preview(selection: readonly string[], keep: Partial<SheetState> = {}): Promise<void> {
		if (!active() || !selection.length) return;
		const seq = ++previewSeq;
		set({ sheet: { phase: 'loading', selection, preview: null, stale: null, message: historyCopy.previewing, waitUntil: 0, pending: null, ...keep }, notice: null });
		const result = await historyCalls.preview(calls, scope, selection);
		if (seq !== previewSeq || result.kind === 'stale' || !state.sheet) return;
		if (result.kind === 'error') {
			if (result.status === 404) { lost(); return; }
			setSheet({ phase: 'failed', message: result.status === 429 ? historyCopy.previewWait : historyCopy.previewFailed, waitUntil: now() + Math.max(result.retryAfter, 1) * 1000 });
			return;
		}
		setSheet({ phase: 'ready', preview: result.value, message: '' });
	}

	async function send(body: ApplyBody, entries: number) {
		const seq = ++applySeq;
		setSheet({ phase: 'applying', pending: body, message: historyCopy.applying });
		const result: Result<unknown> = await historyCalls.apply(calls, scope, body);
		if (seq !== applySeq || result.kind === 'stale' || !state.sheet) return;
		if (result.kind === 'ok') {
			storage.clear(scope, threadId);
			set({ sheet: null, selected: [], notice: undone(entries) });
			await load();
			return;
		}
		if (result.status === 404) { storage.clear(scope, threadId); lost(); return; }
		if (result.status === 429) { storage.clear(scope, threadId); setSheet({ phase: 'ready', message: historyCopy.rate, waitUntil: now() + Math.max(1, result.retryAfter) * 1000 }); return; }
		if (result.uncertain) {
			storage.save(scope, threadId, body);
			setSheet({ phase: 'uncertain', message: historyCopy.uncertain, waitUntil: now() + result.retryAfter * 1000 });
			return;
		}
		storage.clear(scope, threadId);
		if (result.code === 'stale_preview') {
			let fresh: ReturnType<typeof parseStale> | null = null;
			try { fresh = result.detail ? parseStale(result.detail, body.changeIds) : null; } catch { fresh = null; }
			if (fresh) setSheet({ phase: 'ready', preview: fresh.preview, stale: { moved: fresh.moved }, pending: null, message: '' });
			else await preview(body.changeIds, { stale: { moved: [] } });
			void load();
			return;
		}
		setSheet({ phase: 'ready', pending: null, message: result.code === 'change_set_id_unavailable' ? historyCopy.idUnavailable : historyCopy.refused });
	}

	return {
		snapshot: () => state,
		subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
		dispose() { live = false; listeners.clear(); },
		load, more, toggle,
		clear() { if (!state.sheet) set({ selected: [] }); },
		/** Board 6 → 7: preview what is ticked. */
		openPreview() { if (!state.sheet && state.selected.length) void preview(state.selected); },
		/** Board 8: also undo the later changes a conflict names (or a group's other members), and preview again. */
		add(ids: readonly string[]) {
			const sheet = state.sheet;
			if (!sheet || sheet.phase === 'applying' || sheet.phase === 'uncertain' || sheet.phase === 'loading') return;
			const selection = [...sheet.selection, ...ids.filter((id) => !sheet.selection.includes(id))];
			set({ selected: [...state.selected, ...ids.filter((id) => !state.selected.includes(id))] });
			void preview(selection);
		},
		retryPreview() { const s = state.sheet; if (s && s.phase === 'failed' && now() >= s.waitUntil) void preview(s.selection); },
		closeSheet() { const s = state.sheet; if (!s || s.phase === 'applying' || s.phase === 'uncertain') return; previewSeq++; set({ sheet: null }); },
		/** Apply the preview, or after a stale answer the part of it that still applies (board 10). One request; a new id
		 *  per intent (kept after a 429), the preview's basis. */
		apply() {
			const s = state.sheet;
			if (!active() || !s || s.phase !== 'ready' || !s.preview || now() < s.waitUntil) return;
			const usable = s.preview.changes.filter((c) => c.state === 'reversible');
			if (!usable.length || (!s.preview.applicable && !s.stale)) return;
			const changeIds = s.preview.applicable ? [...s.selection] : usable.flatMap((c) => c.changeIds);
			const basis = s.preview.basis.map((b) => ({ ...b }));
			// A 429 left the id unused: the same intent keeps it; anything else is a new undo with a new id.
			const same = s.pending && JSON.stringify([s.pending.changeIds, s.pending.basis]) === JSON.stringify([changeIds, basis]) ? s.pending : null;
			const body: ApplyBody = { id: same?.id ?? deps.randomId(), changeIds, basis };
			void send(body, usable.length);
		},
		/** The uncertain undo again: the same id, the same body. Never automatic. */
		retry() {
			const s = state.sheet;
			if (!s || s.phase !== 'uncertain' || !s.pending || now() < s.waitUntil) return;
			void send(s.pending, entriesCovered(s.pending.changeIds));
		},
		/** Look for the uncertain undo in History. */
		check() { void load(); },
		/** An undo held from an earlier visit: retry it with the same id and body, or forget it. */
		async retryRecovered() {
			const held = state.recovered;
			if (!held || state.recoveredBusy || !active()) return;
			set({ recoveredBusy: true, recoveredMessage: historyCopy.applying });
			const result = await historyCalls.apply(calls, scope, held);
			if (!active() || result.kind === 'stale' || state.recovered?.id !== held.id) return;
			if (result.kind === 'ok') { storage.clear(scope, threadId); set({ recovered: null, recoveredBusy: false, recoveredMessage: '', notice: undone(entriesCovered(held.changeIds)) }); await load(); return; }
			if (result.status === 404) { storage.clear(scope, threadId); lost(); return; }
			if (result.uncertain || result.status === 429) { set({ recoveredBusy: false, recoveredMessage: result.status === 429 ? historyCopy.rate : historyCopy.recovered }); return; }
			storage.clear(scope, threadId);
			set({ recovered: null, recoveredBusy: false, recoveredMessage: '', message: result.code === 'stale_preview' ? 'That undo was not applied: something changed since. Nothing was undone; tick the changes again to preview it.' : historyCopy.refused });
			void load();
		},
		forgetRecovered() { if (state.recovered && !state.recoveredBusy) { storage.clear(scope, threadId); set({ recovered: null, recoveredMessage: '', message: historyCopy.forgotten }); } },
		/** The record as it was at a revision (the baseline row's link). */
		async openVersion(revision: number) {
			if (!state.target || !active()) return;
			const target = state.target;
			set({ version: { phase: 'loading', revision, value: null } });
			const result = await historyCalls.version(calls, scope, target, revision);
			if (!active() || result.kind === 'stale' || state.version?.revision !== revision) return;
			if (result.kind === 'error') { if (result.status === 404 && state.detail === null) { lost(); return; } set({ version: { phase: 'failed', revision, value: null } }); return; }
			set({ version: { phase: 'ready', revision, value: result.value } });
		},
		closeVersion() { set({ version: null }); },
		dismissNotice() { set({ notice: null }); },
		/** Names for wording, from what this screen loaded (never guessed). */
		loadedNames(): LineNames {
			const fold = state.detail?.card.fold;
			const equipment = fold && typeof fold.equipmentId === 'string' && typeof fold.equipmentName === 'string' ? { [fold.equipmentId]: fold.equipmentName } : {};
			return { step: (id) => state.steps[id], equipment: (id) => (equipment as Record<string, string>)[id] };
		}
	};
}
export type HistoryController = ReturnType<typeof createHistory>;
