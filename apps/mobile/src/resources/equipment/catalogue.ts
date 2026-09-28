/** The equipment catalogue list for the schedule (contract §4.5). Pure: no timers, I/O, React or effects.
 *
 *  This module decides which catalogue page is read next and applies answers. It does not decide *when* a read may
 *  start: the screen's read gate (`coordinator.ts`: one in flight, 30 a minute, waits, stops) does. The caller plans a
 *  request, asks the gate for a ticket, starts the request here, runs it, then finishes it here and in the gate.
 *
 *  - Pages are read only explicitly: the first page after the zone gate, then More, Try again or Refresh. There is no
 *    cap other than the API's maximum `offset`; past it the list says the rest is on the website.
 *  - Columns keep the API's order and are never re-sorted. An ID already shown is dropped from a later page, with the
 *    "list changed" notice.
 *  - Every request carries an identity (`id`, `generation`). An answer applies only to the exact outstanding request;
 *    Refresh bumps the generation and forgets the outstanding request, so an answer from before it applies nothing. */
import type { ReadOutcome } from '../../account/contracts.ts';
import { equipmentPageSize, maxEquipmentOffset } from '../../api/paths.ts';
import type { Equipment, EquipmentPage } from './data.ts';

/** `first`: page 0 on mount. `more`: the next page. `retry`: the failed page again. `refresh`: page 0 after Refresh. */
export type CatalogueIntent = 'first' | 'more' | 'retry' | 'refresh';
/** One planned catalogue read. `key` names it to the read gate; `retry` is the gate's explicit-retry flag. */
export type CatalogueRequest = {
	readonly id: number; readonly generation: number; readonly intent: CatalogueIntent;
	readonly offset: number; readonly limit: number; readonly key: string; readonly retry: boolean;
};
/** `access`: refused 403/404; only Refresh (after the runner's membership check) reads again. `unavailable`: any other
 *  failure, repeated by Try again once the gate allows it. */
export type CatalogueFailureReason = 'unavailable' | 'access';
export type CatalogueAnswer =
	| { readonly kind: 'page'; readonly page: EquipmentPage }
	| { readonly kind: 'failed'; readonly reason: CatalogueFailureReason };

/** `none`: no page 0 has succeeded yet. `current`: the columns are this generation's. `stale`: they are from before
 *  a Refresh whose page 0 hasn't succeeded; their `nextOffset` is no longer used. */
export type CatalogueList = 'none' | 'current' | 'stale';
export type CatalogueState = {
	readonly generation: number;
	/** The last request id handed out. Ids never repeat, across Refreshes too. */
	readonly sequence: number;
	readonly list: CatalogueList;
	readonly columns: readonly Equipment[];
	/** The API's `nextOffset` for the loaded columns. Read only while `list` is `current`. */
	readonly nextOffset: number | null;
	/** Page 0 is still owed for this generation, by mount or by Refresh. */
	readonly owed: 'first' | 'refresh' | null;
	readonly pending: CatalogueRequest | null;
	/** The page Try again repeats. */
	readonly failure: { readonly offset: number; readonly reason: CatalogueFailureReason } | null;
	/** A later page repeated an ID already shown. */
	readonly changed: boolean;
};

const noColumns: readonly Equipment[] = Object.freeze([]);
/** Whether `offset` is a page the API accepts. Past it, the rest of the list is on the website. */
const readable = (offset: number | null): offset is number => offset !== null && offset <= maxEquipmentOffset;

export function createCatalogue(): CatalogueState {
	return { generation: 1, sequence: 0, list: 'none', columns: noColumns, nextOffset: null, owed: 'first',
		pending: null, failure: null, changed: false };
}

/** The read `intent` asks for, or null when it isn't the next catalogue read. Pure: the state is unchanged until
 *  `startCatalogueRead`. */
export function planCatalogueRead(state: CatalogueState, intent: CatalogueIntent): CatalogueRequest | null {
	if (state.pending !== null) return null;
	let offset: number;
	if (intent === 'first' || intent === 'refresh') {
		if (state.owed !== intent || state.failure !== null) return null;
		offset = 0;
	} else if (intent === 'retry') {
		if (state.failure === null || state.failure.reason === 'access') return null;
		offset = state.failure.offset;
	} else if (intent === 'more') {
		if (state.list !== 'current' || state.owed !== null || state.failure !== null || !readable(state.nextOffset)) return null;
		offset = state.nextOffset;
	} else {
		return null;
	}
	return Object.freeze({
		id: state.sequence + 1, generation: state.generation, intent, offset, limit: equipmentPageSize,
		key: `catalogue:${state.generation}:${offset}`, retry: intent === 'retry',
	});
}

/** Marks `request` outstanding once the gate has issued its ticket. Null when it is no longer the planned read (for
 *  example after a Refresh), in which case nothing may be sent. */
export function startCatalogueRead(state: CatalogueState, request: CatalogueRequest): CatalogueState | null {
	const planned = planCatalogueRead(state, request.intent);
	if (planned === null || planned.id !== request.id || planned.generation !== request.generation || planned.offset !== request.offset)
		return null;
	return { ...state, sequence: request.id, pending: request };
}

/** Applies the answer to the exact outstanding request. Any other answer (after a Refresh, or repeated) returns
 *  `state` itself, unchanged. */
export function finishCatalogueRead(state: CatalogueState, request: CatalogueRequest, answer: CatalogueAnswer): CatalogueState {
	const pending = state.pending;
	if (pending === null || pending.id !== request.id || pending.generation !== request.generation || pending.generation !== state.generation)
		return state;
	const settled: CatalogueState = { ...state, pending: null };
	const failed = (reason: CatalogueFailureReason): CatalogueState => ({ ...settled,
		owed: pending.offset === 0 ? null : state.owed, failure: Object.freeze({ offset: pending.offset, reason }) });
	if (answer.kind === 'failed') return failed(answer.reason);
	const page = answer.page;
	// The parser was bound to this request; a page that doesn't fit it is refused like any unusable answer.
	if (page.equipment.length > pending.limit || (page.nextOffset !== null && page.nextOffset !== pending.offset + pending.limit))
		return failed('unavailable');
	if (pending.offset === 0) return { ...settled, list: 'current', columns: Object.freeze([...page.equipment]),
		nextOffset: page.nextOffset, owed: null, failure: null, changed: false };
	const shown = new Set(state.columns.map((column) => column.id));
	const fresh = page.equipment.filter((column) => !shown.has(column.id));
	return { ...settled, columns: Object.freeze([...state.columns, ...fresh]), nextOffset: page.nextOffset, failure: null,
		changed: state.changed || fresh.length < page.equipment.length };
}

/** Refresh: a new generation that owes page 0. Columns already shown stay, labelled stale, until page 0 succeeds; the
 *  outstanding request and any failure are forgotten, so an answer still in flight applies nothing. */
export function refreshCatalogue(state: CatalogueState): CatalogueState {
	return { ...state, generation: state.generation + 1, list: state.list === 'none' ? 'none' : 'stale', owed: 'refresh',
		pending: null, failure: null };
}

/** The runner's outcome as a catalogue answer; null for `superseded`, which applies nothing (the screen resets). */
export function catalogueAnswer(outcome: ReadOutcome<EquipmentPage>): CatalogueAnswer | null {
	switch (outcome.kind) {
	case 'ok': return { kind: 'page', page: outcome.value };
	case 'superseded': return null;
	case 'refused': return { kind: 'failed', reason: outcome.status === 403 || outcome.status === 404 ? 'access' : 'unavailable' };
	default: return { kind: 'failed', reason: 'unavailable' };
	}
}

// ---- Selectors for the screen -----------------------------------------------------------------------------------

/** `loading`: no list yet. `failed`: the first page failed ("Couldn't load the schedule."). `empty`: page 0 succeeded
 *  with no equipment ("No equipment is listed yet."). `listed`: columns to draw. */
export type CatalogueStatus = 'loading' | 'failed' | 'empty' | 'listed';
/** The control at the end of the columns: More offered, a More read outstanding, the failed page's own Try again,
 *  the website link past the API's maximum offset, or nothing. */
export type CatalogueMore = 'offered' | 'loading' | 'try-again' | 'website' | 'none';
/** - `stale`: a Refresh's page 0 hasn't succeeded; the columns may be out of date.
 *  - `refresh-failed`: "Couldn't refresh. The schedule may be out of date."
 *  - `more-not-loaded`: "More equipment not loaded yet".
 *  - `listed-on-website`: "More equipment is listed on the website".
 *  - `incomplete`: a later page failed; the loaded columns aren't the whole list.
 *  - `list-changed`: "The equipment list changed while loading. Refresh for the current list." */
export type CatalogueNotice = 'stale' | 'refresh-failed' | 'more-not-loaded' | 'listed-on-website' | 'incomplete' | 'list-changed';
/** Which failed read Try again repeats: the first page, a later page, or a Refresh's page 0. */
export type CatalogueTryAgain = 'catalogue' | 'more' | 'refresh' | null;
export type CatalogueView = {
	readonly status: CatalogueStatus;
	readonly columns: readonly Equipment[];
	readonly stale: boolean;
	readonly more: CatalogueMore;
	readonly notices: readonly CatalogueNotice[];
	/** Offered only for an `unavailable` failure; the caller disables it while the gate has a wait. */
	readonly tryAgain: CatalogueTryAgain;
	/** The last catalogue read was refused 403/404: show the access wording; only Refresh reads again. */
	readonly access: boolean;
};

export function catalogueView(state: CatalogueState): CatalogueView {
	const { list, failure, nextOffset } = state;
	const status: CatalogueStatus = list === 'none' ? (failure !== null ? 'failed' : 'loading')
		: state.columns.length === 0 ? 'empty' : 'listed';
	const laterFailure = failure !== null && failure.offset > 0;
	let more: CatalogueMore = 'none';
	if (list === 'current') {
		if (failure !== null && failure.offset > 0) more = failure.reason === 'access' ? 'none' : 'try-again';
		else if (state.pending !== null && state.pending.offset > 0) more = 'loading';
		else if (nextOffset !== null) more = readable(nextOffset) ? 'offered' : 'website';
	}
	const notices: CatalogueNotice[] = [];
	if (list === 'stale') notices.push(failure !== null ? 'refresh-failed' : 'stale');
	if (list !== 'none' && nextOffset !== null) notices.push(readable(nextOffset) ? 'more-not-loaded' : 'listed-on-website');
	if (list === 'current' && laterFailure) notices.push('incomplete');
	if (list !== 'none' && state.changed) notices.push('list-changed');
	let tryAgain: CatalogueTryAgain = null;
	if (failure !== null && failure.reason !== 'access')
		tryAgain = list === 'none' ? 'catalogue' : list === 'stale' ? 'refresh' : 'more';
	return Object.freeze({ status, columns: state.columns, stale: list === 'stale', more, notices: Object.freeze(notices),
		tryAgain, access: failure?.reason === 'access' });
}
