/** Search in the thread list (H4 contract §2, §3; docs/plans/tags-series-search-2026-10.md). The header's field: at
 *  least 2 characters, debounced, replaces the grouped list with result rows; clearing returns to the list. The answer is
 *  read strictly: the list's row shape plus `match`, for exactly the filter and words asked. Pure: injected timers and
 *  clock, so Node tests drive it; no React Native import. */
import type { ReadScope } from '../account/contracts.ts';
import type { ThreadCalls } from './api.ts';
import { queryPath, threadPath } from './api.ts';
import type { Filter, Row } from './contracts.ts';
import { filters } from './contracts.ts';
import { array, keys, object, parseRow, text } from './parse.ts';

const bad = (): never => { throw new TypeError('search: unexpected response'); };
export type Match = { kind: 'title' | 'message'; excerpt: string; authorName: string | null };
export type ResultRow = Row & { match: Match };
export type SearchResult = { filter: Filter; q: string; available: boolean; threads: ResultRow[] };
/** The API's floor and ceiling, counted in characters after trimming. */
export const searchFloor = 2, searchCeiling = 200;
/** How long typing must pause before a search is sent. */
export const searchDelay = 300;

export function parseMatch(raw: unknown): Match {
	const x = object(raw); keys(x, ['kind', 'excerpt', 'authorName']);
	const kind = x.kind === 'title' || x.kind === 'message' ? x.kind : bad();
	const authorName = x.authorName === null ? null : text(x.authorName, 500);
	if (kind === 'title' && authorName !== null) bad();
	const excerpt = text(x.excerpt, 2000);
	return { kind, excerpt, authorName };
}
/** `GET …/threads?q=&filter=&limit=50`: the rows for exactly the words and filter asked, unique, at most 50. */
export function parseSearch(raw: unknown, expected: { filter: Filter; q: string }): SearchResult {
	const x = object(raw); keys(x, ['filter', 'q', 'available', 'threads']);
	if (x.filter !== expected.filter || !filters.includes(x.filter as Filter) || x.q !== expected.q || typeof x.available !== 'boolean') bad();
	const threads = array(x.threads, (r) => { const row = object(r); const { match, ...rest } = row; if (match === undefined) bad(); return { ...parseRow(rest), match: parseMatch(match) }; }, 50);
	if (new Set(threads.map((t) => t.id)).size !== threads.length || (!x.available && threads.length)) bad();
	return { filter: expected.filter, q: expected.q, available: x.available as boolean, threads };
}

/** The words to search for, or null while there are too few (the list stays) or too many characters. */
export function searchText(value: string): string | null {
	const q = value.trim(), n = [...q].length;
	return n >= searchFloor && n <= searchCeiling ? q : null;
}
export type Part = { text: string; mark: boolean };
/** An excerpt in runs: the text between « and » is a match, shown with emphasis. An unpaired mark is shown as written. */
export function excerptParts(excerpt: string): Part[] {
	const parts: Part[] = [];
	const push = (value: string, mark: boolean) => { if (!value) return; const last = parts.at(-1); if (last && last.mark === mark) last.text += value; else parts.push({ text: value, mark }); };
	let rest = excerpt;
	for (;;) {
		const open = rest.indexOf('«');
		if (open < 0) { push(rest, false); break; }
		const close = rest.indexOf('»', open + 1);
		if (close < 0) { push(rest, false); break; }
		push(rest.slice(0, open), false); push(rest.slice(open + 1, close), true); rest = rest.slice(close + 1);
	}
	return parts;
}
/** The words of the result count: "1 result", "12 results". */
export const resultsWords = (n: number) => `${n} ${n === 1 ? 'result' : 'results'}`;
export const searchCopy = {
	label: 'Search threads', clear: 'Clear the search', close: 'Close search', open: 'Search threads',
	hint: 'Type at least 2 characters to search titles and messages you can see.',
	searching: 'Searching…', none: 'No threads match', failed: 'Couldn’t search. Check the connection and try again.',
	wait: 'Captain asked you to wait before searching again.', long: 'A search is at most 200 characters.',
	unavailable: 'Files and People are not available yet, so there is nothing to search there.', firstFifty: 'Showing the best 50. Add words to narrow the search.'
} as const;

export type SearchState = {
	/** The field is shown (the list's header magnifier opened it). */
	readonly open: boolean;
	readonly text: string;
	/** The words the shown results are for; null while the list is shown. */
	readonly q: string | null;
	readonly phase: 'idle' | 'waiting' | 'loading' | 'ready' | 'failed';
	readonly result: SearchResult | null;
	readonly message: string;
	readonly waitUntil: number;
};
type Timers = { now(): number; set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
/** The search field's controller. Typing schedules one search after `searchDelay`; an answer for older words or another
 *  filter is dropped; fewer than 2 characters returns to the list. While `active()`, the list's polling pauses. */
export function createSearch(calls: ThreadCalls, scope: ReadScope, timers: Timers) {
	let live = true, timer: unknown = null, asked = 0, filter: Filter = 'all';
	let state: SearchState = { open: false, text: '', q: null, phase: 'idle', result: null, message: '', waitUntil: 0 };
	const listeners = new Set<() => void>();
	const set = (next: Partial<SearchState>) => { if (!live || !calls.current(scope)) return; state = { ...state, ...next }; listeners.forEach((fn) => fn()); };
	const cancel = () => { if (timer !== null) { timers.clear(timer); timer = null; } };
	async function run(q: string) {
		timer = null;
		if (!live) return;
		const wait = state.waitUntil - timers.now();
		if (wait > 0) { timer = timers.set(() => { void run(q); }, wait); return; }
		const mine = ++asked, f = filter;
		set({ phase: 'loading', message: '' });
		const r = await calls.request(scope, 'GET', queryPath(threadPath(scope), { q, filter: f, limit: 50 }), undefined, (v) => parseSearch(v, { filter: f, q }));
		if (!live || mine !== asked || r.kind === 'stale') return;
		if (r.kind === 'ok') { set({ phase: 'ready', q, result: r.value, message: r.value.available ? '' : searchCopy.unavailable, waitUntil: 0 }); return; }
		set({ phase: 'failed', q, result: null, message: r.status === 429 ? searchCopy.wait : searchCopy.failed, waitUntil: timers.now() + Math.max(r.retryAfter, r.status === 429 ? 1 : 0) * 1000 });
	}
	const schedule = () => {
		cancel(); asked++;
		const q = searchText(state.text);
		if (q === null) { set({ q: null, phase: 'idle', result: null, message: [...state.text.trim()].length > searchCeiling ? searchCopy.long : '' }); return; }
		set({ phase: 'waiting', message: '' });
		timer = timers.set(() => { void run(q); }, searchDelay);
	};
	return {
		snapshot: () => state,
		subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
		dispose() { live = false; cancel(); listeners.clear(); },
		/** True while results (or a search on its way) replace the list: the list's polling pauses. */
		active: () => state.open && searchText(state.text) !== null,
		open() { set({ open: true }); },
		/** Close and clear: the grouped list returns. */
		close() { cancel(); asked++; set({ open: false, text: '', q: null, phase: 'idle', result: null, message: '' }); },
		type(text: string) { set({ text }); schedule(); },
		/** The list's filter changed: a search under way runs again for it. */
		filter(next: Filter) { if (next === filter) return; filter = next; if (state.open && searchText(state.text) !== null) schedule(); },
		/** Try again after a failure, at once. */
		retry() { const q = searchText(state.text); if (q === null || timers.now() < state.waitUntil) return; cancel(); void run(q); }
	};
}
export type Search = ReturnType<typeof createSearch>;
