import type { Wait } from '../account/clock.ts';
import type { ReadOutcome } from '../account/contracts.ts';
import type { StockGroup, StockList } from './stock.ts';

/** The Inventory list's state and rules (docs/plans/expo-mobile-inventory-read-2026-09.md §5, §6). Pure, so node tests
 *  cover every rule; `useStock` only holds it and performs the reads it asks for.
 *
 *  - One read in flight per screen. Every read has a sequence number, and only the latest one's answer is applied.
 *  - `first` reads on mount; `refresh` reads again once loaded. There is no paging. Nothing retries by itself: Try
 *    again repeats the failed operation only when the person asks.
 *  - A read's own server wait blocks every control until exactly its end. It is separate from the account's `/v1/me`
 *    wait.
 *  - A failed refresh keeps the groups already loaded; a failed first read is never shown as an empty list. */

export type StockOp = 'first' | 'refresh';
/** Why the latest read did not apply: `unavailable` (network, 429, 5xx, a body that could not be read or was too large;
 *  with its own wait), `access` (403/404), or `list` (another refusal, or a client bug). */
export type StockProblem = { readonly op: StockOp; readonly kind: 'unavailable' | 'access' | 'list'; readonly wait: Wait | null };

export type StockListState = {
	/** The last list read successfully, or null if none has been (a failed first read is never shown as empty). */
	readonly list: StockList | null;
	readonly inFlight: { readonly seq: number; readonly op: StockOp } | null;
	readonly problem: StockProblem | null;
	readonly seq: number;
};

export const initialStockList: StockListState = Object.freeze({ list: null, inFlight: null, problem: null, seq: 0 });

/** Whether this screen's own server wait still holds at `now` (exactly at `until`, it no longer does). */
export const stockWaiting = (state: StockListState, now: number): boolean =>
	state.problem?.wait != null && now < state.problem.wait.until;

/** Why a control is disabled right now, or null. */
export function stockBlocked(state: StockListState, now: number): 'loading' | 'waiting' | null {
	if (state.inFlight !== null) return 'loading';
	if (stockWaiting(state, now)) return 'waiting';
	return null;
}

/** Starts `op` if allowed: nothing in flight, no server wait, `first` only before a successful read (or to retry a
 *  failed first read), `refresh` only once loaded. Returns the next state and the read's number, or null when nothing
 *  may be sent. */
export function beginStockRead(state: StockListState, op: StockOp, now: number): { readonly state: StockListState; readonly seq: number } | null {
	if (stockBlocked(state, now) !== null) return null;
	if (op === 'first' && (state.list !== null || state.seq !== 0) && state.problem?.op !== 'first') return null;
	if (op === 'refresh' && state.list === null) return null;
	const seq = state.seq + 1;
	return { state: { ...state, seq, inFlight: { seq, op } }, seq };
}

/** Applies the answer to read `seq`. An answer that is not for the latest read, or that is `superseded`, changes nothing
 *  (the caller has already dropped answers for another scope or an unmounted screen). */
export function finishStockRead(state: StockListState, seq: number, outcome: ReadOutcome<StockList>): StockListState {
	const flight = state.inFlight;
	if (flight === null || flight.seq !== seq || outcome.kind === 'superseded') return state;
	const settled = { ...state, inFlight: null };
	if (outcome.kind === 'ok') return { ...settled, list: outcome.value, problem: null };
	const kind = outcome.kind === 'unavailable' ? 'unavailable'
		: outcome.kind === 'refused' && (outcome.status === 403 || outcome.status === 404) ? 'access' : 'list';
	return { ...settled, problem: { op: flight.op, kind, wait: outcome.kind === 'unavailable' ? outcome.wait : null } };
}

/** The operation Try again repeats: the one that failed. */
export const stockRetryOp = (state: StockListState): StockOp | null => state.problem?.op ?? null;

/** What the screen shows, decided here so every rule is tested:
 *  - `loading`: inert (the account moved to another scope; the tabs are about to reset), or no answer yet. It claims
 *    nothing about stock.
 *  - `failed`: the first read failed; never shown as empty.
 *  - `empty`: a successful answer with no active items. The only state that says no stock is listed.
 *  - `list`: the groups, with a failed refresh's problem shown above them (the rows are kept). */
export type StockScreen =
	| { readonly kind: 'loading' }
	| { readonly kind: 'failed'; readonly problem: StockProblem }
	| { readonly kind: 'empty'; readonly problem: StockProblem | null }
	| { readonly kind: 'list'; readonly groups: readonly StockGroup[]; readonly problem: StockProblem | null };

export function stockScreen(state: StockListState, inert: boolean): StockScreen {
	if (inert) return { kind: 'loading' };
	if (state.list === null) return state.problem === null || state.inFlight !== null ? { kind: 'loading' } : { kind: 'failed', problem: state.problem };
	if (state.list.groups.length === 0) return { kind: 'empty', problem: state.problem };
	return { kind: 'list', groups: state.list.groups, problem: state.problem };
}
