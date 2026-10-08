/** Stocktake (docs/plans/stock-2026-10.md §3; design board 12): every active item grouped by location, the counts a person
 *  types, and one save. The rules, as the card writes' (versions contract §5, §6):
 *  - a save sends the filled rows only, with a client change set id; an uncertain answer (no response, a 5xx) keeps the
 *    id and the exact body and locks the form until the person saves again with the same id or discards. Nothing is
 *    retried by itself;
 *  - a stale refusal names its items: the list is reloaded, those rows are marked and their typed counts cleared, the
 *    rest stay typed, and the next save takes a new id. An archived refusal drops those rows the same way;
 *  - a 429 keeps the form with its wait; a 404 is lost access;
 *  - typed counts (and an uncertain save) persist for this person and organisation in session storage, so a stocktake
 *    can walk the building; cleared on save, on Cancel, on sign-out and for another person.
 *  Pure: injected calls, clock, id source and storage, so Node tests drive it. */
import type { ReadScope } from '../../account/contracts.ts';
import { isCanonicalUuid } from '../../api/paths.ts';
import type { Result, ThreadCalls } from '../../threads/api.ts';
import type { WebStorage } from '../../threads/storage.ts';
import { send } from '../../threads/cards/records.ts';
import { countProblem, parseStockList, stockListPath, stocktakeLimit, stockWrites, type CountLine, type StockItem, type StockList, type Taken } from './stock.ts';

export const stocktakeCopy = {
	heading: 'Stocktake',
	hint: 'Type what you count. Items you skip are left as they are.',
	loading: 'Loading the stock list…',
	failed: 'Couldn’t load the stock list. Try again.',
	wait: 'Captain asked you to wait before loading this again.',
	lost: 'This organisation’s stock is no longer available to you.',
	empty: 'No stock items yet. Add the first one below.',
	saving: 'Saving the stocktake…',
	nothing: 'Type at least one count to save.',
	invalid: 'Some counts are not numbers. Use digits and an optional decimal point, zero or more.',
	tooMany: `A stocktake saves at most ${stocktakeLimit} items at a time. Save these, then count the rest.`,
	unknown: 'This stocktake may have been saved. Your counts and their change ID are kept; save again with the same ID to confirm, or discard.',
	rate: 'Too many requests. Your counts are still here; wait before saving again.',
	stale: 'Someone changed the marked items since you opened Stocktake, so nothing was saved. They are shown as they are now; type their counts again, then save.',
	archived: 'Some items were archived since you opened Stocktake, so nothing was saved. They are no longer listed; save again to count the rest.',
	idUnavailable: 'That change ID was already used for something else. Nothing was saved; save again to use a new one.',
	refused: 'Captain refused this stocktake. Check the counts and try again.',
	discarded: 'Discarded. If the stocktake was saved, each count is in its item’s thread; check the last counts before saving again.',
	staleRow: 'Changed since you opened Stocktake. Type your count again.',
	counted: (n: number, of: number) => `${n} of ${of} counted`,
	saved: (n: number) => `Stocktake saved: ${n} ${n === 1 ? 'item' : 'items'} counted. Each count is in its item’s thread.`,
	discardConfirm: (n: number) => `Discard ${n} typed ${n === 1 ? 'count' : 'counts'}? Nothing has been saved.`
} as const;

export type StocktakeBody = { changeSetId: string; counts: CountLine[] };
export type Draft = { values: Record<string, string>; pending: StocktakeBody | null };
export type StocktakeStorage = { load(scope: ReadScope): Draft | null; save(scope: ReadScope, draft: Draft): boolean; clear(scope: ReadScope): void; person(userId: string | null): void };
const prefix = 'captain.stocktake.';
const validValue = (v: unknown) => typeof v === 'string' && v.length <= 80;
function validDraft(x: unknown): x is Draft {
	if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
	const d = x as Record<string, unknown>;
	if (Object.keys(d).sort().join(',') !== 'pending,values') return false;
	const values = d.values;
	if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
	const entries = Object.entries(values);
	if (entries.length > 5000 || !entries.every(([k, v]) => isCanonicalUuid(k) && validValue(v))) return false;
	if (d.pending === null) return true;
	const p = d.pending as Record<string, unknown>;
	if (!p || typeof p !== 'object' || Object.keys(p).sort().join(',') !== 'changeSetId,counts' || !isCanonicalUuid(p.changeSetId)) return false;
	if (!Array.isArray(p.counts) || !p.counts.length || p.counts.length > stocktakeLimit) return false;
	const ids = new Set<string>();
	return p.counts.every((c: unknown) => {
		const r = c as Record<string, unknown>;
		if (!r || typeof r !== 'object' || Object.keys(r).sort().join(',') !== 'count,expectedRevision,itemId' || !isCanonicalUuid(r.itemId) || ids.has(r.itemId)) return false;
		ids.add(r.itemId);
		return typeof r.expectedRevision === 'number' && Number.isInteger(r.expectedRevision) && r.expectedRevision >= 1 && typeof r.count === 'string' && countProblem(r.count) === null;
	});
}
export function createStocktakeStorage(get: () => WebStorage | null): StocktakeStorage {
	const key = (s: ReadScope) => `${prefix}${s.userId}.${s.organisationId}`;
	const clear = (s: ReadScope) => { try { get()?.removeItem(key(s)); } catch { /* nothing to claim */ } };
	return {
		load(s) { try { const raw = get()?.getItem(key(s)); if (!raw) return null; const x: unknown = JSON.parse(raw); if (!validDraft(x)) { clear(s); return null; } return x; } catch { clear(s); return null; } },
		save(s, draft) {
			try {
				const store = get(); if (!store) return false;
				if (!draft.pending && !Object.values(draft.values).some((v) => v.trim())) { store.removeItem(key(s)); return true; }
				store.setItem(key(s), JSON.stringify(draft)); return true;
			} catch { return false; }
		},
		clear,
		person(userId) { try { const store = get(); if (!store) return; for (let i = store.length - 1; i >= 0; i--) { const k = store.key(i); if (k?.startsWith(prefix) && (!userId || !k.startsWith(`${prefix}${userId}.`))) store.removeItem(k); } } catch { /* best effort */ } }
	};
}
export const browserStocktakes = createStocktakeStorage(() => typeof window === 'undefined' ? null : window.sessionStorage);

/** What a save would send from the typed values: the filled rows of listed items, and what is wrong with any of them. */
export function stocktakeLines(items: readonly StockItem[], values: Readonly<Record<string, string>>): { lines: CountLine[]; problems: Record<string, string>; counted: number } {
	const lines: CountLine[] = [], problems: Record<string, string> = {};
	for (const item of items) {
		const v = values[item.id]?.trim() ?? '';
		if (!v) continue;
		const problem = countProblem(v);
		if (problem) problems[item.id] = problem; else lines.push({ itemId: item.id, expectedRevision: item.revision, count: v });
	}
	return { lines, problems, counted: lines.length + Object.keys(problems).length };
}

export type Phase = 'loading' | 'ready' | 'failed' | 'lost';
export type StocktakeState = {
	readonly phase: Phase; readonly list: StockList | null; readonly values: Readonly<Record<string, string>>;
	/** Rows a stale refusal marked, until their count is typed again. */
	readonly stale: readonly string[];
	readonly busy: boolean; readonly uncertain: boolean; readonly pending: StocktakeBody | null;
	readonly message: string; readonly tone: 'plain' | 'ok' | 'warn'; readonly waitUntil: number;
	/** Set once a save is confirmed: the number of items it counted. */
	readonly saved: number | null;
};
export type Stocktake = {
	snapshot(): StocktakeState; subscribe(fn: () => void): () => void; dispose(): void;
	load(): Promise<void>; type(itemId: string, value: string): void; save(): Promise<void>; retry(): Promise<void>; discard(): void;
	/** Cancel: forget the typed counts (an uncertain save stays until it is retried or discarded). */
	cancel(): void;
};
export function createStocktake(deps: { calls: ThreadCalls; scope: ReadScope; now(): number; randomId(): string; storage: StocktakeStorage }): Stocktake {
	const { calls, scope, now, storage } = deps;
	const restored = storage.load(scope);
	let live = true, unusedId: string | null = null, loading: Promise<void> | null = null;
	let state: StocktakeState = { phase: 'loading', list: null, values: restored?.values ?? {}, stale: [], busy: false, uncertain: Boolean(restored?.pending), pending: restored?.pending ?? null,
		message: restored?.pending ? stocktakeCopy.unknown : '', tone: restored?.pending ? 'warn' : 'plain', waitUntil: 0, saved: null };
	const listeners = new Set<() => void>();
	const set = (next: Partial<StocktakeState>) => { if (!live || !calls.current(scope)) return; state = { ...state, ...next }; listeners.forEach((fn) => fn()); };
	const persist = () => { storage.save(scope, { values: { ...state.values }, pending: state.pending }); };
	const blocked = () => !live || state.busy || state.uncertain || now() < state.waitUntil || state.phase !== 'ready';
	async function read() {
		const r = await calls.request(scope, 'GET', stockListPath(scope), undefined, (v) => parseStockList(v, false));
		if (!live || r.kind === 'stale') return;
		if (r.kind === 'ok') {
			// Typed counts of items no longer listed (archived or gone) are dropped; an uncertain save's are kept with it.
			const known = new Set(r.value.items.map((i) => i.id));
			const values = Object.fromEntries(Object.entries(state.values).filter(([id]) => known.has(id)));
			set({ phase: 'ready', list: r.value, values, stale: state.stale.filter((id) => known.has(id)) }); persist(); return;
		}
		if (r.status === 404 || r.status === 403) { set({ phase: 'lost' }); return; }
		if (!state.list) set({ phase: 'failed', message: r.status === 429 ? stocktakeCopy.wait : stocktakeCopy.failed, tone: 'warn' });
	}
	async function run(body: StocktakeBody) {
		const write = stockWrites.stocktake(scope, body.changeSetId, body.counts);
		const result: Result<Taken> = await send(calls, scope, write);
		if (!live || result.kind === 'stale' || state.pending !== body) return;
		if (result.kind === 'ok') {
			storage.clear(scope); unusedId = null;
			set({ busy: false, pending: null, uncertain: false, values: {}, stale: [], message: stocktakeCopy.saved(result.value.items.length), tone: 'ok', saved: result.value.items.length });
			return;
		}
		if (result.status === 404) { storage.clear(scope); set({ busy: false, pending: null, uncertain: false, phase: 'lost' }); return; }
		if (result.status === 429) { unusedId = body.changeSetId; set({ busy: false, pending: null, waitUntil: now() + Math.max(1, result.retryAfter) * 1000, message: stocktakeCopy.rate, tone: 'warn' }); persist(); return; }
		if (result.uncertain) { set({ busy: false, uncertain: true, waitUntil: now() + result.retryAfter * 1000, message: stocktakeCopy.unknown, tone: 'warn' }); persist(); return; }
		unusedId = null;
		const named = Array.isArray(result.detail?.itemIds) ? (result.detail.itemIds as unknown[]).filter((id): id is string => isCanonicalUuid(id) && body.counts.some((c) => c.itemId === id)) : [];
		if (result.code === 'stale_revision' || result.code === 'stock_archived') {
			const values = Object.fromEntries(Object.entries(state.values).filter(([id]) => !named.includes(id)));
			set({ busy: false, pending: null, uncertain: false, values, stale: result.code === 'stale_revision' ? [...new Set([...state.stale, ...named])] : state.stale,
				message: result.code === 'stale_revision' ? stocktakeCopy.stale : stocktakeCopy.archived, tone: 'warn' });
			persist(); await read(); return;
		}
		set({ busy: false, pending: null, uncertain: false, tone: 'warn', message: result.code === 'change_set_id_unavailable' ? stocktakeCopy.idUnavailable : stocktakeCopy.refused });
		persist();
	}
	return {
		snapshot: () => state,
		subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
		dispose() { live = false; listeners.clear(); },
		load() {
			if (loading) return loading;
			loading = read().finally(() => { loading = null; });
			return loading;
		},
		type(itemId, value) {
			if (!live || state.busy || state.uncertain || !validValue(value)) return;
			const values = { ...state.values }; if (value) values[itemId] = value; else delete values[itemId];
			set({ values, stale: state.stale.filter((id) => id !== itemId), ...(state.tone === 'warn' && now() >= state.waitUntil ? { message: '', tone: 'plain' } : {}) });
			persist();
		},
		async save() {
			if (blocked() || !state.list) return;
			const { lines, problems } = stocktakeLines(state.list.items, state.values);
			if (Object.keys(problems).length) { set({ message: stocktakeCopy.invalid, tone: 'warn' }); return; }
			if (!lines.length) { set({ message: stocktakeCopy.nothing, tone: 'warn' }); return; }
			if (lines.length > stocktakeLimit) { set({ message: stocktakeCopy.tooMany, tone: 'warn' }); return; }
			// A 429 left the id unused: keep it, so the same intent keeps one change set id.
			const body: StocktakeBody = { changeSetId: unusedId ?? deps.randomId(), counts: lines };
			set({ busy: true, pending: body, uncertain: false, message: stocktakeCopy.saving, tone: 'plain' }); persist();
			await run(body);
		},
		async retry() {
			if (!live || state.busy || !state.uncertain || !state.pending || now() < state.waitUntil) return;
			const body = state.pending;
			set({ busy: true, uncertain: false, message: stocktakeCopy.saving, tone: 'plain' });
			await run(body);
		},
		discard() {
			if (!live || state.busy || !state.pending) return;
			set({ pending: null, uncertain: false, message: stocktakeCopy.discarded, tone: 'plain' }); persist();
			void read();
		},
		cancel() {
			if (!live || state.busy) return;
			set({ values: {}, stale: [] }); persist();
		}
	};
}

/** The line the thread list shows after a save, for this person and organisation only, taken once. */
let flash: { key: string; message: string } | null = null;
const flashKey = (s: ReadScope) => `${s.userId}.${s.organisationId}.${s.epoch}`;
export const stocktakeFlash = {
	set(scope: ReadScope, message: string) { flash = { key: flashKey(scope), message }; },
	take(scope: ReadScope): string | null { const f = flash; flash = null; return f && f.key === flashKey(scope) ? f.message : null; }
};
