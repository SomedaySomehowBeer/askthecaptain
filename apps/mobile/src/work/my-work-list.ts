import { maxWorkPages } from '../api/paths.ts';
import type { Wait } from '../account/clock.ts';
import type { ReadOutcome, ReadScope } from '../account/contracts.ts';
import type { WorkPage, WorkRow } from './my-work.ts';

/** The My work list's state and rules (docs/plans/expo-mobile-my-work-read-2026-09.md §3.5). Pure, so node tests cover
 *  every rule; `useWorkList` (My work and All tasks alike) only holds it and performs the reads it asks for.
 *
 *  - One read in flight per screen. Every read has a sequence number, and only the latest one's answer is applied.
 *  - `first` reads page 0 on mount; `refresh` reads page 0 again; `more` reads `nextOffset`. None retries by itself:
 *    Try again repeats the failed operation only when the person asks.
 *  - A read's own server wait blocks every control until it ends. It is separate from the account's `/v1/me` wait.
 *  - More stops at 10 pages loaded or 500 rows held; rows already shown are dropped from a later page by ID. */

export const maxWorkRows = 500;
export type WorkOp = 'first' | 'refresh' | 'more';
/** Why the latest read did not apply: `unavailable` (with its own wait), `access` (403/404), or `list` (another refusal,
 *  or a client bug). */
export type WorkProblem = { readonly op: WorkOp; readonly kind: 'unavailable' | 'access' | 'list'; readonly wait: Wait | null };

export type WorkListState = {
	/** Whether page 0 has ever been read successfully (a failed first read is never shown as empty). */
	readonly loaded: boolean;
	readonly rows: readonly WorkRow[];
	readonly pages: number;
	readonly nextOffset: number | null;
	readonly inFlight: { readonly seq: number; readonly op: WorkOp; readonly offset: number } | null;
	readonly problem: WorkProblem | null;
	readonly seq: number;
};

export const initialWorkList: WorkListState = Object.freeze({ loaded: false, rows: Object.freeze([]), pages: 0, nextOffset: null, inFlight: null, problem: null, seq: 0 });

/** Whether this screen's own server wait still holds at `now` (exactly at `until`, it no longer does). */
export const waiting = (state: WorkListState, now: number): boolean =>
	state.problem?.wait != null && now < state.problem.wait.until;

/** Whether More may be offered: another page exists and neither cap has been reached. */
export const moreAvailable = (state: WorkListState): boolean =>
	state.loaded && state.nextOffset !== null && state.pages < maxWorkPages && state.rows.length < maxWorkRows;

/** Whether the website notice is shown: the API said there is more, and a cap stopped More. */
export const capReached = (state: WorkListState): boolean =>
	state.loaded && state.nextOffset !== null && !moreAvailable(state);

/** Why a control is disabled right now, or null. */
export function blockedReason(state: WorkListState, now: number): 'loading' | 'waiting' | null {
	if (state.inFlight !== null) return 'loading';
	if (waiting(state, now)) return 'waiting';
	return null;
}

/** Starts `op` if allowed: nothing in flight, no server wait, and (for More) another page within the caps. Returns the
 *  next state and the offset to read, or null when nothing may be sent. */
export function beginRead(state: WorkListState, op: WorkOp, now: number): { readonly state: WorkListState; readonly seq: number; readonly offset: number } | null {
	if (blockedReason(state, now) !== null) return null;
	if (op === 'first' && (state.loaded || state.seq !== 0) && state.problem?.op !== 'first') return null;
	if (op === 'refresh' && !state.loaded) return null;
	if (op === 'more' && !moreAvailable(state)) return null;
	const offset = op === 'more' ? state.nextOffset! : 0;
	const seq = state.seq + 1;
	return { state: { ...state, seq, inFlight: { seq, op, offset } }, seq, offset };
}

/** Applies the answer to read `seq`. An answer that is not for the latest read, or that is `superseded`, changes
 *  nothing (the caller has already dropped answers for another scope or an unmounted screen). */
export function finishRead(state: WorkListState, seq: number, outcome: ReadOutcome<WorkPage>): WorkListState {
	const flight = state.inFlight;
	if (flight === null || flight.seq !== seq || outcome.kind === 'superseded') return state;
	const settled = { ...state, inFlight: null };
	if (outcome.kind === 'ok') {
		const page = outcome.value;
		if (flight.op !== 'more') {
			const rows = page.rows.slice(0, maxWorkRows);
			return { ...settled, loaded: true, rows, pages: 1, nextOffset: page.nextOffset, problem: null };
		}
		const seen = new Set(state.rows.map((row) => row.id));
		const added = page.rows.filter((row) => !seen.has(row.id));
		const rows = [...state.rows, ...added].slice(0, maxWorkRows);
		return { ...settled, rows, pages: state.pages + 1, nextOffset: page.nextOffset, problem: null };
	}
	const kind = outcome.kind === 'unavailable' ? 'unavailable'
		: outcome.kind === 'refused' && (outcome.status === 403 || outcome.status === 404) ? 'access' : 'list';
	return { ...settled, problem: { op: flight.op, kind, wait: outcome.kind === 'unavailable' ? outcome.wait : null } };
}

/** Whether a list bound to `bound` (the ready scope its screen first rendered with) is inert under `current`, the scope
 *  rendered now. `AccountStack` resets the tabs in an effect, after the new account has rendered once, so for that
 *  render the old screen sees a new scope while still holding the old rows. An inert list shows no rows or controls,
 *  starts no read, and applies no answer, until its screen remounts under the new scope. It never becomes live again:
 *  epochs never repeat. */
export const listInert = (bound: ReadScope | null, current: ReadScope | null): boolean =>
	bound === null || current === null || current.epoch !== bound.epoch
	|| current.userId !== bound.userId || current.organisationId !== bound.organisationId;

/** The operation Try again repeats: the one that failed. */
export const retryOp = (state: WorkListState): WorkOp | null => state.problem?.op ?? null;
