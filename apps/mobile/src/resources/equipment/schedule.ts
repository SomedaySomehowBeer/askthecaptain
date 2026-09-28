/** The equipment schedule screen's whole state and every decision (contract docs/plans/expo-mobile-equipment-read-2026-09.md
 *  §4.1, §4.4, §4.5, §5; design note equipment-e2-design-B.md revision 2). Pure: no React, timers or reads. The hook
 *  (`useEquipmentSchedule.ts`) carries only effects: it asks `beginRead` for the one read to send, sends it through the
 *  runner, and hands the outcome to `receive`.
 *
 *  - **One flight.** Every read (organisation, catalogue page, occupancy) goes through the screen's one coordinator.
 *  - **Mount order (§4.1).** The organisation read first; a catalogue page only after the zone gate passes; occupancy
 *    only after page 0 and a settled view.
 *  - **Settle only.** Occupancy is planned from the last *settled* geometry, never per scroll frame. The geometry holds
 *    no equipment IDs: columns are derived from the current catalogue each time, so a replaced list can never be read
 *    for equipment it no longer lists (design E1).
 *  - **Never free.** This file decides what is read; `cells.ts` decides what may look free (only `complete`). */
import type { Parse } from '../../auth/contracts.ts';
import type { ReadOutcome, ReadScope } from '../../account/contracts.ts';
import { equipmentCopy, equipmentWaitText } from '../../account/copy.ts';
import { equipmentPagePath, occupancyPath, organisationPath, type OrganisationPath } from '../../api/paths.ts';
import {
	abandonCatalogueRead, catalogueAnswer, catalogueReplaced, catalogueView, createCatalogue, finishCatalogueRead, planCatalogueRead,
	refreshCatalogue, startCatalogueRead, type CatalogueRequest, type CatalogueState
} from './catalogue.ts';
import {
	bound, canTryAgain, cellKey, cellOf, emptyOccupancy, finish, keepEquipment, plan, reanchor as reanchorCells, refresh as refreshCells,
	reservationsBetween, slotOf, start, tryAgain, wanted, wayOut, type Centre, type Occupancy, type Slot
} from './cells.ts';
import {
	beginScheduleRead, createScheduleCoordinator, finishScheduleRead, restartSchedule, scheduleReadBlock, scheduleReadLimit, stopSchedule,
	type ScheduleCoordinator, type ScheduleReadKind, type ScheduleTicket
} from './coordinator.ts';
import {
	equipmentPageParser, occupancyParser, organisationZoneParser, type EquipmentPage, type OccupancyAnswer, type OrganisationZone,
	type Reservation
} from './data.ts';
import { clampScroll, defaultScale, instantAt, pixelsAt, scales, type Scale } from './geometry.ts';
import { chunksBetween, edgeAnchor, inRange, labelFormatsOk, scheduleRange, type ScheduleRange } from './range.ts';
import { ZoneError, shiftDate, todayInZone, zoneGate } from './zone.ts';

const minute = 60_000;

export type Bootstrap =
	| { readonly kind: 'owed' }
	| { readonly kind: 'pending' }
	| { readonly kind: 'failed'; readonly reason: 'unavailable' | 'access' }
	| { readonly kind: 'done' };
/** `unsupported`: the zone gate refused; no catalogue or occupancy read, and Refresh bootstraps again. `changed`: an
 *  occupancy answer came back in another zone; cells are stale and only Refresh continues. */
export type ZoneState =
	| { readonly kind: 'unknown' }
	| { readonly kind: 'ok'; readonly zone: string }
	| { readonly kind: 'unsupported' }
	| { readonly kind: 'changed'; readonly zone: string };
/** The one read in flight, with what its answer applies to. */
export type InFlight =
	| { readonly kind: 'organisation'; readonly ticket: ScheduleTicket; readonly organisationId: string }
	| { readonly kind: 'catalogue'; readonly ticket: ScheduleTicket; readonly request: CatalogueRequest }
	/** `batch`: the rest of a "dates shown" batch left queued when this read was sent (compared by identity), or null. */
	| { readonly kind: 'occupancy'; readonly ticket: ScheduleTicket; readonly slot: Slot; readonly zone: string; readonly batch: Intent | null };
/** The latest explicit press, queued until it can be sent. `cell-retry` is one cell's Try again or "Try again for the
 *  dates shown": one slot is sent at a time, and any answer but a success drops the rest (design E3). */
export type Intent =
	| { readonly kind: 'more' }
	| { readonly kind: 'catalogue-retry' }
	| { readonly kind: 'organisation-retry' }
	| { readonly kind: 'cell-retry'; readonly slots: readonly Slot[] };
/** The last settled geometry (design E1): horizontal offset and widths, and the visible instants. No equipment IDs. */
export type SettledView = { readonly x: number; readonly width: number; readonly columnWidth: number; readonly low: number; readonly high: number };

export type ScheduleState = {
	readonly scope: ReadScope;
	readonly gate: ScheduleCoordinator;
	readonly bootstrap: Bootstrap;
	readonly zone: ZoneState;
	readonly catalogue: CatalogueState;
	readonly occupancy: Occupancy;
	readonly range: ScheduleRange | null;
	readonly scale: Scale;
	readonly settled: SettledView | null;
	readonly inFlight: InFlight | null;
	readonly intent: Intent | null;
	/** A Refresh is between its press and its page-0 success. */
	readonly refreshing: boolean;
	/** The bootstrap or page 0 failed during a Refresh (§4.4 step 7). */
	readonly refreshFailed: boolean;
};

export function createSchedule(scope: ReadScope): ScheduleState {
	return {
		scope, gate: createScheduleCoordinator(scope), bootstrap: { kind: 'owed' }, zone: { kind: 'unknown' }, catalogue: createCatalogue(),
		occupancy: emptyOccupancy, range: null, scale: defaultScale, settled: null, inFlight: null, intent: null, refreshing: false,
		refreshFailed: false
	};
}

/** The zone occupancy is read and shown in: the bootstrapped one, also while a zone change is waiting for Refresh. */
export const zoneOf = (state: ScheduleState): string | null =>
	state.zone.kind === 'ok' || state.zone.kind === 'changed' ? state.zone.zone : null;

// ---- Geometry ------------------------------------------------------------------------------------------------------

/** About two and a half columns per viewport, so the next one is always partly visible; never narrower than 112. */
export const columnWidthFor = (columnsViewport: number): number => Math.max(112, Math.floor(columnsViewport / 2.4));

/** The columns a settled view shows, from the **current** list: the ones overlapping the viewport, the partly visible
 *  next one, and the index (in `columns`) of the one under the centre. */
export function columnsAt(settled: SettledView, columns: readonly { readonly id: string }[]): { visible: string[]; next: string | null; centre: number } {
	const w = settled.columnWidth;
	if (!columns.length || !(w > 0)) return { visible: [], next: null, centre: 0 };
	const visible: string[] = [];
	let last = -1;
	columns.forEach((column, i) => {
		if (i * w < settled.x + settled.width && (i + 1) * w > settled.x) { visible.push(column.id); last = i; }
	});
	const next = last >= 0 && last + 1 < columns.length ? columns[last + 1]!.id : null;
	const centre = Math.min(columns.length - 1, Math.max(0, Math.floor((settled.x + settled.width / 2) / w)));
	return { visible, next, centre };
}

/** What the screen measured at a settle. `bodyTop` is the body row's measured top within the vertical content, and the
 *  sticky names row overlays the top of the viewport, so the first visible instant sits below it (should-fix 5). */
export type Layout = {
	readonly x: number; readonly y: number; readonly columnsWidth: number; readonly columnWidth: number;
	readonly viewportHeight: number; readonly bodyTop: number; readonly stickyHeight: number;
};
export function settledFrom(layout: Layout, range: Pick<ScheduleRange, 'start' | 'end'>, scale: Scale): SettledView {
	const start = Date.parse(range.start), end = Date.parse(range.end), ppd = scales[scale];
	const low = Math.min(end, Math.max(start, instantAt(Math.max(0, layout.y + layout.stickyHeight - layout.bodyTop), start, ppd)));
	const high = Math.min(end, Math.max(start, instantAt(layout.y + layout.viewportHeight - layout.bodyTop, start, ppd)));
	return { x: layout.x, width: layout.columnsWidth, columnWidth: layout.columnWidth, low, high };
}

/** The vertical offset that puts `at` at the centre, just below the sticky row (`top`), or at the bottom. */
export function offsetFor(at: number, where: 'centre' | 'top' | 'bottom', range: Pick<ScheduleRange, 'start'>, scale: Scale,
	frame: { readonly bodyTop: number; readonly stickyHeight: number; readonly viewportHeight: number; readonly contentHeight: number }): number {
	const y = frame.bodyTop + pixelsAt(at, Date.parse(range.start), scales[scale]);
	const target = where === 'centre' ? y - (frame.viewportHeight + frame.stickyHeight) / 2 : where === 'top' ? y - frame.stickyHeight : y - frame.viewportHeight;
	return clampScroll(target, frame.contentHeight, frame.viewportHeight);
}

// ---- Choosing the next read ------------------------------------------------------------------------------------------

type ReadPlan =
	| { readonly kind: 'organisation' }
	| { readonly kind: 'catalogue'; readonly request: CatalogueRequest }
	| { readonly kind: 'occupancy'; readonly slot: Slot; readonly zone: string };
type Candidate = { readonly plan: ReadPlan; readonly kind: ScheduleReadKind; readonly key: string; readonly retry: boolean };

const zoneOk = (state: ScheduleState): state is ScheduleState & { zone: { kind: 'ok'; zone: string } } => state.zone.kind === 'ok';
const listCurrent = (state: ScheduleState) => state.catalogue.list === 'current';

/** Every (shown column × chunk intersecting the shown time), from the settled geometry and the current list. */
export function shownSlots(state: ScheduleState): Slot[] {
	const { settled, range } = state;
	if (!settled || !range || !(settled.high > settled.low)) return [];
	const { visible } = columnsAt(settled, state.catalogue.columns);
	const chunks = chunksBetween(range.chunks, settled.low, settled.high).map((i) => range.chunks[i]!);
	return visible.flatMap((id) => chunks.map((chunk) => slotOf(id, chunk)));
}

/** The shown cells that offer Try again, in shown order. */
export const retryableSlots = (state: ScheduleState): Slot[] => shownSlots(state).filter((slot) => canTryAgain(cellOf(state.occupancy, slot)));

function intentCandidate(state: ScheduleState, intent: Intent): Candidate | null {
	switch (intent.kind) {
	case 'organisation-retry':
		return state.bootstrap.kind === 'failed' && state.bootstrap.reason === 'unavailable'
			? { plan: { kind: 'organisation' }, kind: 'organisation', key: 'organisation', retry: true } : null;
	case 'catalogue-retry':
	case 'more': {
		if (state.zone.kind === 'unknown' || state.zone.kind === 'unsupported') return null;
		const request = planCatalogueRead(state.catalogue, intent.kind === 'more' ? 'more' : 'retry');
		return request === null ? null : { plan: { kind: 'catalogue', request }, kind: 'catalogue', key: request.key, retry: request.retry };
	}
	case 'cell-retry': {
		// The same guards as automatic occupancy (should-fix 4): this file is safe without relying on the gate's stops.
		if (!zoneOk(state) || !listCurrent(state) || state.range === null) return null;
		const slot = intent.slots.find((s) => canTryAgain(cellOf(state.occupancy, s)));
		return slot === undefined ? null
			: { plan: { kind: 'occupancy', slot, zone: state.zone.zone }, kind: 'occupancy', key: cellKey(slot), retry: true };
	}
	}
}

function automaticCandidate(state: ScheduleState): Candidate | null {
	if (state.bootstrap.kind === 'owed') return { plan: { kind: 'organisation' }, kind: 'organisation', key: 'organisation', retry: false };
	if (!zoneOk(state) || state.bootstrap.kind !== 'done') return null;
	const owed = state.catalogue.owed;
	if (owed !== null) {
		const request = planCatalogueRead(state.catalogue, owed);
		if (request !== null) return { plan: { kind: 'catalogue', request }, kind: 'catalogue', key: request.key, retry: false };
	}
	const { settled, range } = state;
	if (!listCurrent(state) || settled === null || range === null) return null;
	const { visible, next } = columnsAt(settled, state.catalogue.columns);
	const slot = plan(state.occupancy, wanted({ visible, next, chunks: range.chunks, low: settled.low, high: settled.high }));
	return slot === null ? null
		: { plan: { kind: 'occupancy', slot, zone: state.zone.zone }, kind: 'occupancy', key: cellKey(slot), retry: false };
}

function launch(state: ScheduleState, candidate: Candidate, now: number, fromIntent: boolean): { state: ScheduleState; read: InFlight | null } {
	const begun = beginScheduleRead(state.gate, state.scope, candidate.kind, candidate.key, now, candidate.retry);
	if (begun === null) return { state, read: null };
	const { ticket } = begun;
	// A press is used up by its read; a batch keeps the slots not yet sent (design E3).
	let intent = fromIntent ? null : state.intent;
	if (fromIntent && state.intent?.kind === 'cell-retry' && candidate.plan.kind === 'occupancy') {
		const sent = cellKey(candidate.plan.slot);
		const rest = state.intent.slots.filter((s) => cellKey(s) !== sent);
		intent = rest.length ? { kind: 'cell-retry', slots: rest } : null;
	}
	let next: ScheduleState = { ...state, gate: begun.state, intent };
	let read: InFlight;
	const p = candidate.plan;
	if (p.kind === 'organisation') {
		next = { ...next, bootstrap: { kind: 'pending' } };
		read = { kind: 'organisation', ticket, organisationId: state.scope.organisationId };
	} else if (p.kind === 'catalogue') {
		const started = startCatalogueRead(state.catalogue, p.request);
		if (started === null) return { state, read: null };
		next = { ...next, catalogue: started };
		read = { kind: 'catalogue', ticket, request: p.request };
	} else {
		next = { ...next, occupancy: candidate.retry ? tryAgain(state.occupancy, p.slot, ticket) : start(state.occupancy, p.slot, ticket) };
		read = { kind: 'occupancy', ticket, slot: p.slot, zone: p.zone, batch: fromIntent && intent?.kind === 'cell-retry' ? intent : null };
	}
	return { state: { ...next, inFlight: read }, read };
}

/** The one read to send now, or none, and the state to commit either way (a dead intent is dropped even when nothing
 *  is sent). Priority: the queued press, then an owed bootstrap, then an owed page 0, then occupancy from the settled
 *  view. The intent lifecycle (should-fix 1): the latest press wins; an intent with nothing to send, or refused by the
 *  gate as `stopped` or `scope`, is dropped; one blocked by `busy`, `wait` or `budget` stays queued. */
export function beginRead(state: ScheduleState, now: number): { state: ScheduleState; read: InFlight | null } {
	if (state.inFlight !== null) return { state, read: null };
	let current = state;
	if (current.intent !== null) {
		const candidate = intentCandidate(current, current.intent);
		if (candidate === null) current = { ...current, intent: null };
		else {
			const block = scheduleReadBlock(current.gate, current.scope, candidate.kind, now, candidate.retry);
			if (block === null) return launch(current, candidate, now, true);
			if (block === 'stopped' || block === 'scope') current = { ...current, intent: null };
			else return { state: current, read: null };
		}
	}
	const candidate = automaticCandidate(current);
	if (candidate === null) return { state: current, read: null };
	return launch(current, candidate, now, false);
}

/** The path, built from the runner's own scope, and the parser bound to this exact request. */
export type ReadRequest = { readonly path: (scope: ReadScope) => OrganisationPath; readonly parse: Parse<unknown> };
export function readRequest(read: InFlight): ReadRequest {
	switch (read.kind) {
	case 'organisation': return { path: (scope) => organisationPath(scope.organisationId), parse: organisationZoneParser(read.organisationId) };
	case 'catalogue': {
		const { offset, limit } = read.request;
		return { path: (scope) => equipmentPagePath(scope, offset), parse: equipmentPageParser({ offset, limit }) };
	}
	case 'occupancy': {
		const { slot, zone } = read;
		return { path: (scope) => occupancyPath(scope, slot.equipmentId, slot), parse: occupancyParser({ ...slot, zone }) };
	}
	}
}

// ---- Applying one answer ---------------------------------------------------------------------------------------------

/** A range for `anchor`, or for the next existing date when a clock change skips it; null for an unusable zone. */
function rangeFor(anchor: string, zone: string): ScheduleRange | null {
	let date = anchor;
	for (let tries = 0; tries < 3; tries++) {
		try {
			return scheduleRange(date, zone);
		} catch (error) {
			if (!(error instanceof ZoneError && error.reason === 'skipped')) return null;
			try { date = shiftDate(date, 1); } catch { return null; }
		}
	}
	return null;
}
function todayIn(zone: string, wall: Date): string | null {
	try { return todayInZone(zone, wall); } catch { return null; }
}
function centreOf(state: ScheduleState): Centre | null {
	const { settled, range } = state;
	if (!settled || !range) return null;
	return { columns: state.catalogue.columns.map((c) => c.id), column: columnsAt(settled, state.catalogue.columns).centre, chunks: range.chunks,
		at: (settled.low + settled.high) / 2 };
}

function receiveOrganisation(state: ScheduleState, outcome: ReadOutcome<unknown>, wall: Date): ScheduleState {
	if (outcome.kind !== 'ok') {
		const reason = outcome.kind === 'refused' && (outcome.status === 403 || outcome.status === 404) ? 'access' : 'unavailable';
		return { ...state, bootstrap: { kind: 'failed', reason }, refreshFailed: state.refreshing || state.refreshFailed };
	}
	const zone = (outcome.value as OrganisationZone).timezone;
	const unsupported: ScheduleState = { ...state, bootstrap: { kind: 'done' }, zone: { kind: 'unsupported' }, refreshing: false, refreshFailed: false };
	// The zone gate, then both axis label formatters, built here and never first in render (review N3).
	if (!zoneGate(zone).ok || !labelFormatsOk(zone)) return unsupported;
	const previous = zoneOf(state);
	if (state.range !== null && previous === zone && state.zone.kind !== 'unsupported')
		return { ...state, bootstrap: { kind: 'done' }, zone: { kind: 'ok', zone } };
	// The first pass, or a different zone: build the range on the current civil anchor (today on mount). Every old key
	// has other instants in another zone, so re-anchoring the cells drops them.
	const anchor = state.range?.anchor ?? todayIn(zone, wall);
	const range = anchor === null ? null : rangeFor(anchor, zone);
	if (range === null) return unsupported;
	return { ...state, bootstrap: { kind: 'done' }, zone: { kind: 'ok', zone }, range, occupancy: reanchorCells(state.occupancy, range.chunks), settled: null };
}

/** Applies the answer to the read in flight, then everything that follows from it. `wall` supplies today's date for
 *  the first range. Any other read's answer returns `state` unchanged. */
export function receive(state: ScheduleState, read: InFlight, outcome: ReadOutcome<unknown>, wall: Date): ScheduleState {
	if (state.inFlight !== read) return state;
	const finished = finishScheduleRead(state.gate, read.ticket, outcome);
	let next: ScheduleState = { ...state, gate: finished.state, inFlight: null };
	// A batch continues only while its reads succeed: offline, one failing read ends it (design E3). Only that batch is
	// dropped, by identity: a press made meanwhile (More, a catalogue Try again) replaced it and survives (review N2).
	if (read.kind === 'occupancy' && read.batch !== null && !(finished.apply && outcome.kind === 'ok') && next.intent === read.batch)
		next = { ...next, intent: null };
	if (!finished.apply) {
		if (outcome.kind === 'superseded') return next;
		if (read.kind === 'catalogue') return { ...next, catalogue: abandonCatalogueRead(next.catalogue, read.request) };
		if (read.kind === 'organisation' && next.bootstrap.kind === 'pending') return { ...next, bootstrap: { kind: 'owed' } };
		return next;
	}
	if (read.kind === 'organisation') return receiveOrganisation(next, outcome, wall);
	if (read.kind === 'catalogue') {
		const answer = catalogueAnswer(outcome as ReadOutcome<EquipmentPage>);
		if (answer === null) return next;
		const before = next.catalogue, after = finishCatalogueRead(before, read.request, answer);
		next = { ...next, catalogue: after };
		if (catalogueReplaced(before, after)) next = { ...next, occupancy: keepEquipment(next.occupancy, after.columns.map((c) => c.id)) };
		if (read.request.offset === 0 && next.refreshing) {
			if (after.list === 'current') next = { ...next, refreshing: false, refreshFailed: false };
			else if (after.failure !== null) next = { ...next, refreshFailed: true };
		}
		return next;
	}
	const done = finish(next.occupancy, read.slot, read.ticket, outcome as ReadOutcome<OccupancyAnswer>);
	if (done.stop !== null) next = { ...next, gate: stopSchedule(next.gate, done.stop) };
	if (done.stop === 'zone') next = { ...next, zone: { kind: 'changed', zone: read.zone } };
	const centre = centreOf(next);
	return { ...next, occupancy: centre === null ? done.occupancy : bound(done.occupancy, centre) };
}

// ---- Presses -----------------------------------------------------------------------------------------------------

/** The latest press replaces any queued one; `beginRead` sends it when the gate allows. */
export const press = (state: ScheduleState, intent: Intent): ScheduleState => ({ ...state, intent });

/** The last settled geometry; occupancy is planned from it at the next `beginRead`. */
export const settle = (state: ScheduleState, view: SettledView): ScheduleState => ({ ...state, settled: view });

/** A scale button: only the scale changes; planning waits for the zoomed view to settle. */
export const setScale = (state: ScheduleState, scale: Scale): ScheduleState =>
	scale === state.scale ? state : { ...state, scale, settled: null };

/** Refresh (§4.4 steps 1–7). Null when the gate refuses (a wait, the rate budget, an access stop before the membership
 *  check, or a superseded scope): then nothing changes at all (W1). `membershipChecked` is the account's signed-in view
 *  with `refreshing` false at the press, scope unchanged (design E2). */
export function pressRefresh(state: ScheduleState, now: number, membershipChecked: boolean): ScheduleState | null {
	const gate = restartSchedule(state.gate, state.scope, now, 'refresh', membershipChecked);
	if (gate === null) return null;
	return {
		...state, gate, bootstrap: { kind: 'owed' }, catalogue: refreshCatalogue(state.catalogue), occupancy: refreshCells(state.occupancy),
		zone: state.zone.kind === 'changed' ? { kind: 'ok', zone: state.zone.zone } : state.zone, refreshing: true, refreshFailed: false, intent: null
	};
}

function reanchorOn(state: ScheduleState, anchor: string, now: number): ScheduleState | null {
	const zone = zoneOf(state);
	if (zone === null || state.zone.kind !== 'ok') return null;
	const gate = restartSchedule(state.gate, state.scope, now, 'reanchor');
	if (gate === null) return null;
	const range = rangeFor(anchor, zone);
	if (range === null) return null;
	return { ...state, gate, range, occupancy: reanchorCells(state.occupancy, range.chunks), intent: null, settled: null };
}

/** "Earlier dates" or "Later dates" (§4.2): re-anchor on the selected edge date. The catalogue is kept; an in-flight
 *  catalogue answer is abandoned when it lands. Null when refused or at the 1900–2200 limit. */
export function pressEdge(state: ScheduleState, direction: 'earlier' | 'later', now: number): { state: ScheduleState; edge: string } | null {
	const zone = zoneOf(state);
	if (zone === null || state.range === null) return null;
	const edge = edgeAnchor(state.range, zone, direction);
	if (edge === null) return null;
	const next = reanchorOn(state, edge, now);
	return next === null ? null : { state: next, edge };
}

/** Today: scroll to now; re-anchor on today only when now is outside the range. Null when that re-anchor is refused. */
export function pressToday(state: ScheduleState, now: number, wall: Date): { state: ScheduleState; reanchored: boolean } | null {
	const zone = zoneOf(state);
	if (zone === null || state.range === null) return null;
	if (inRange(state.range, wall.getTime())) return { state, reanchored: false };
	const today = todayIn(zone, wall);
	const next = today === null ? null : reanchorOn(state, today, now);
	return next === null ? null : { state: next, reanchored: true };
}

// ---- What the screen shows ---------------------------------------------------------------------------------------

/** The row a detail panel may show for a tapped reservation: the copy still drawn for that equipment (at its highest
 *  retained revision), or null once it is no longer returned or has been contradicted. The panel closes on null, so
 *  it never keeps showing a reservation Captain has refused to choose (review S2). */
export function panelRow(state: ScheduleState, equipmentId: string, reservationId: string): Reservation | null {
	if (state.occupancy.conflicted.includes(reservationId)) return null;
	return reservationsBetween(state.occupancy, equipmentId, -8.64e15, 8.64e15).find((r) => r.id === reservationId) ?? null;
}

/** Milliseconds until a screen-wide wait or the rolling budget stops blocking, for a timer that only wakes the pump
 *  and re-renders; null when neither blocks. Exactly at the deadline the gate admits the read. */
export function wakeDelay(state: ScheduleState, now: number): number | null {
	const deadlines: number[] = [];
	if (state.gate.wait !== null && now < state.gate.wait.until) deadlines.push(state.gate.wait.until);
	const recent = state.gate.starts.filter((at) => at > now - minute);
	if (recent.length >= scheduleReadLimit) deadlines.push(recent[0]! + minute);
	return deadlines.length ? Math.max(0, Math.min(...deadlines) - now) : null;
}

/** Why a read control is disabled, or null when a press may be made (a press while busy is queued, not refused). */
export function blockReason(state: ScheduleState, kind: ScheduleReadKind, now: number, retry = false): string | null {
	const block = scheduleReadBlock(state.gate, state.scope, kind, now, retry);
	switch (block) {
	case null: case 'busy': return null;
	case 'scope': return equipmentCopy.loading;
	case 'wait': return state.gate.wait === null ? equipmentCopy.busy : equipmentWaitText(state.gate.wait);
	case 'budget': return equipmentCopy.pacing;
	case 'stopped':
		switch (state.gate.stop) {
		case 'retry': return equipmentCopy.tryAgainFirst;
		case 'access': return equipmentCopy.access;
		case 'conflict': return equipmentCopy.conflict;
		case 'zone': return equipmentCopy.zoneChanged;
		default: return equipmentCopy.loading;
		}
	}
}

/** Why a restart (Refresh or a re-anchor) is refused, or null when it would be accepted. */
function restartReason(state: ScheduleState, now: number, mode: 'refresh' | 'reanchor', membershipChecked: boolean): string | null {
	if (restartSchedule(state.gate, state.scope, now, mode, membershipChecked) !== null) return null;
	if (state.gate.stop === 'superseded') return equipmentCopy.loading;
	if (mode === 'refresh' && state.gate.stop === 'access' && !membershipChecked) return equipmentCopy.checkingAccess;
	return blockReason({ ...state, gate: { ...state.gate, inFlight: null, stop: null } }, 'organisation', now) ?? equipmentCopy.busy;
}

/** The way out of a stopped queue (W3, C3): Try again while a failed bootstrap, the catalogue or a shown cell offers
 *  it, otherwise Refresh; null when not stopped or superseded. */
export function wayOutAll(state: ScheduleState): 'try-again' | 'refresh' | null {
	const stop = state.gate.stop;
	if (stop === 'retry') {
		if (state.bootstrap.kind === 'failed' && state.bootstrap.reason === 'unavailable') return 'try-again';
		if (catalogueView(state.catalogue).tryAgain !== null) return 'try-again';
		if (wayOut(state.occupancy, shownSlots(state), 'retry') === 'try-again') return 'try-again';
		return 'refresh';
	}
	return wayOut(state.occupancy, shownSlots(state), stop);
}

/** A control: disabled with the reason shown under it, never hidden (the account pattern). `queued` marks the press
 *  waiting for the flight. */
export type Control = { readonly disabled: boolean; readonly reason: string | null; readonly queued: boolean };
const control = (reason: string | null, queued = false): Control =>
	({ disabled: reason !== null || queued, reason: queued ? equipmentCopy.busy : reason, queued });

export type ScreenBody = 'loading' | 'bootstrap-failed' | 'zone-unsupported' | 'catalogue-failed' | 'empty' | 'timeline';
export type ScheduleScreen = {
	readonly body: ScreenBody;
	/** The body's own wording for the failed and refusal bodies. */
	readonly bodyText: string | null;
	readonly zone: string | null;
	/** One screen-level line: access, a zone change, a conflict, a failed Refresh, or "Refresh to read again". */
	readonly problem: string | null;
	/** The catalogue's notices, worded. */
	readonly notices: readonly string[];
	readonly refresh: Control | null;
	/** The body's Try again (the organisation read or page 0), or null. */
	readonly tryAgain: (Control & { readonly intent: Intent }) | null;
	readonly more:
		| { readonly kind: 'offered' | 'try-again'; readonly control: Control; readonly intent: Intent }
		| { readonly kind: 'loading' | 'website' }
		| null;
	/** Try again for the shown failed cells: one ("Try again") or several ("Try again for the dates shown"). */
	readonly cellRetry: (Control & { readonly label: string; readonly intent: Intent }) | null;
	readonly earlier: Control | null;
	readonly later: Control | null;
};

const noticeText = {
	stale: equipmentCopy.stale, 'more-not-loaded': equipmentCopy.moreNotLoaded, 'listed-on-website': equipmentCopy.onWebsite,
	incomplete: equipmentCopy.incomplete, 'list-changed': equipmentCopy.listChanged
} as const;

export function scheduleScreen(state: ScheduleState, now: number, membershipChecked: boolean): ScheduleScreen {
	const view = catalogueView(state.catalogue);
	const { bootstrap, zone, gate } = state;
	const access = gate.stop === 'access' || (bootstrap.kind === 'failed' && bootstrap.reason === 'access') || view.access;
	let body: ScreenBody, bodyText: string | null = null;
	if (zone.kind === 'unsupported') { body = 'zone-unsupported'; bodyText = equipmentCopy.zoneUnsupported; }
	else if (zone.kind === 'unknown') {
		if (bootstrap.kind === 'failed') { body = 'bootstrap-failed'; bodyText = bootstrap.reason === 'access' ? equipmentCopy.access : equipmentCopy.failedFirst; }
		else body = 'loading';
	}
	else if (view.status === 'loading') body = 'loading';
	else if (view.status === 'failed') { body = 'catalogue-failed'; bodyText = view.access ? equipmentCopy.access : equipmentCopy.failedFirst; }
	else body = view.status === 'empty' ? 'empty' : 'timeline';

	const shown = body === 'empty' || body === 'timeline';
	let problem: string | null = null;
	if (shown) {
		if (access) problem = equipmentCopy.access;
		else if (zone.kind === 'changed') problem = equipmentCopy.zoneChanged;
		else if (gate.stop === 'conflict') problem = equipmentCopy.conflict;
		else if (state.refreshFailed) problem = equipmentCopy.failedRefresh;
		else if (gate.stop === 'retry' && wayOutAll(state) === 'refresh') problem = equipmentCopy.stoppedRefresh;
	}
	const notices = shown ? view.notices.flatMap((n) => (n === 'refresh-failed' ? [] : [noticeText[n]])) : [];

	const refreshOffered = shown || body === 'zone-unsupported' || ((body === 'bootstrap-failed' || body === 'catalogue-failed') && access);
	const refresh = refreshOffered ? control(restartReason(state, now, 'refresh', membershipChecked)) : null;

	const queued = (kind: Intent['kind']) => state.intent?.kind === kind;
	let tryAgain: ScheduleScreen['tryAgain'] = null;
	if (bootstrap.kind === 'failed' && bootstrap.reason === 'unavailable')
		tryAgain = { ...control(blockReason(state, 'organisation', now, true), queued('organisation-retry')), intent: { kind: 'organisation-retry' } };
	else if (view.tryAgain === 'catalogue' || view.tryAgain === 'refresh')
		tryAgain = { ...control(blockReason(state, 'catalogue', now, true), queued('catalogue-retry')), intent: { kind: 'catalogue-retry' } };

	let more: ScheduleScreen['more'] = null;
	if (body === 'timeline') {
		if (view.more === 'offered') more = { kind: 'offered', control: control(blockReason(state, 'catalogue', now), queued('more')), intent: { kind: 'more' } };
		else if (view.more === 'try-again')
			more = { kind: 'try-again', control: control(blockReason(state, 'catalogue', now, true), queued('catalogue-retry')), intent: { kind: 'catalogue-retry' } };
		else if (view.more === 'loading' || view.more === 'website') more = { kind: view.more };
	}

	let cellRetry: ScheduleScreen['cellRetry'] = null;
	const failed = body === 'timeline' && zone.kind === 'ok' && view.stale === false ? retryableSlots(state) : [];
	if (failed.length)
		cellRetry = { ...control(blockReason(state, 'occupancy', now, true), queued('cell-retry')), label: failed.length > 1 ? equipmentCopy.tryAgainShown : equipmentCopy.tryAgain,
			intent: { kind: 'cell-retry', slots: failed } };

	let earlier: Control | null = null, later: Control | null = null;
	const z = zoneOf(state);
	if (body === 'timeline' && state.range !== null && z !== null) {
		const reason = zone.kind === 'ok' ? restartReason(state, now, 'reanchor', membershipChecked) : equipmentCopy.zoneChanged;
		if (edgeAnchor(state.range, z, 'earlier') !== null) earlier = control(reason);
		if (edgeAnchor(state.range, z, 'later') !== null) later = control(reason);
	}
	return { body, bodyText, zone: z, problem, notices, refresh, tryAgain, more, cellRetry, earlier, later };
}
