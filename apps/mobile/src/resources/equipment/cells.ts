/** Occupancy cells and queue decisions for the read-only equipment schedule (contract §4.4): ported from the retired
 *  Next.js schedule, adapted to one read per (equipment, chunk). Pure: no React, no
 *  native module, no timers and no reads. The hook sends reads only through the screen coordinator (`coordinator.ts`).
 *
 *  - A cell is keyed by its equipment and its chunk's exact instants, never a chunk index, so a new anchor can never
 *    move old bars onto other dates.
 *  - Only a `complete` cell may leave time undrawn. Every other state stripes its gaps.
 *  - `plan` proposes only unread cells, and stale cells not yet re-read after Refresh. Failed, partial, conflict and
 *    marker cells are never read again automatically: only Try again (failed cells) or Refresh re-reads them.
 *  - An answer applies only to the cell still waiting on that exact request identity (the coordinator's ticket). */
import type { Wait } from '../../account/clock.ts';
import type { ReadOutcome } from '../../account/contracts.ts';
import type { OccupancyAnswer, OccupancyRead, Reservation } from './data.ts';
import { chunksBetween, type Chunk } from './range.ts';

/** At most this many cells keep reservation rows (§4.4 "Retained data is bounded"). */
export const maxPayloadCells = 64;

/** One occupancy read: one equipment and one chunk's exact instants. */
export type Slot = { readonly equipmentId: string; readonly from: string; readonly to: string };
/** `unavailable`: no answer (with or without a server wait). `access`: 403/404, which only Refresh after the runner's
 *  membership check lifts. `unreadable`: any other refusal, a client bug or a refused body. */
export type FailureReason = 'unavailable' | 'access' | 'unreadable';
export type Failure = { readonly reason: FailureReason; readonly wait: Wait | null };
type Rows = readonly Reservation[];
/** A request identity is opaque and compared by identity: the hook passes the coordinator's `ScheduleTicket`. */
export type RequestId = object;

export type Cell = Slot & (
	| { readonly state: 'loading'; readonly request: RequestId }
	/** Holds no rows from the start: a failed cell is already a compact terminal marker. */
	| { readonly state: 'failed'; readonly failure: Failure }
	| { readonly state: 'complete' | 'partial' | 'conflict'; readonly reservations: Rows }
	/** The previous rows after Refresh or a zone change. `request` is set while its re-read is outstanding, and
	 *  `failure` when that re-read failed. */
	| { readonly state: 'stale'; readonly previous: Rows; readonly failure: Failure | null; readonly request: RequestId | null }
	/** An evicted partial, conflict or stale payload: the key, the state and any failure, with no rows. */
	| { readonly state: 'marker'; readonly of: 'partial' | 'conflict' | 'stale'; readonly failure: Failure | null }
);
/** Every cell the screen has touched, and the reservation IDs received with contradictory details, which are drawn
 *  from no cell until Refresh. A missing key is unread. */
export type Occupancy = { readonly cells: Readonly<Record<string, Cell>>; readonly conflicted: readonly string[] };
export type CellState = 'unread' | 'loading' | 'failed' | 'partial' | 'complete' | 'conflict' | 'stale';

export const emptyOccupancy: Occupancy = Object.freeze({ cells: Object.freeze({}), conflicted: Object.freeze([]) });
export const cellKey = (slot: Slot): string => `${slot.equipmentId} ${slot.from} ${slot.to}`;
export const slotOf = (equipmentId: string, chunk: Pick<Chunk, 'from' | 'to'>): Slot => ({ equipmentId, from: chunk.from, to: chunk.to });
export const cellOf = (occupancy: Occupancy, slot: Slot): Cell | undefined => occupancy.cells[cellKey(slot)];
const bare = (cell: Slot): Slot => ({ equipmentId: cell.equipmentId, from: cell.from, to: cell.to });

export function stateOf(cell: Cell | undefined): CellState {
	if (!cell) return 'unread';
	return cell.state === 'marker' ? cell.of : cell.state;
}
/** Only a complete cell may leave a gap undrawn, as "no confirmed reservations when read". */
export const mayShowFree = (state: CellState): boolean => state === 'complete';
/** The rows a cell retains, or null for a cell with none. */
export function rowsOf(cell: Cell | undefined): Rows | null {
	if (!cell) return null;
	if (cell.state === 'complete' || cell.state === 'partial' || cell.state === 'conflict') return cell.reservations;
	return cell.state === 'stale' ? cell.previous : null;
}
/** A cell's own read failure: a failed cell, a stale cell whose re-read failed, or a marker of one. */
export function failureOf(cell: Cell | undefined): Failure | null {
	if (!cell) return null;
	if (cell.state === 'failed') return cell.failure;
	return cell.state === 'stale' || cell.state === 'marker' ? cell.failure : null;
}

function put(occupancy: Occupancy, key: string, cell: Cell | undefined): Occupancy {
	const cells = { ...occupancy.cells };
	if (cell) cells[key] = cell;
	else delete cells[key];
	return { cells, conflicted: occupancy.conflicted };
}

/** What the view shows: the visible equipment in display order, the partly visible next column, the range's chunks,
 *  and the visible instants [low, high). */
export type View = {
	readonly visible: readonly string[]; readonly next: string | null;
	readonly chunks: readonly Chunk[]; readonly low: number; readonly high: number;
};
/** The cells worth reading: the visible columns plus the partly visible next one, for the visible chunks, then the
 *  chunks either side. Chunks nearest the middle of the view come first; within a chunk, the columns nearest the
 *  centre column, and the partly visible column last. Nothing else is ever wanted. */
export function wanted(view: View): Slot[] {
	const visible = [...new Set(view.visible)];
	if (!visible.length || !(view.high > view.low)) return [];
	const middle = (visible.length - 1) / 2;
	const columns = visible.map((id, i) => ({ id, i })).sort((a, b) => Math.abs(a.i - middle) - Math.abs(b.i - middle) || a.i - b.i).map((c) => c.id);
	if (view.next !== null && !columns.includes(view.next)) columns.push(view.next);
	const shown = chunksBetween(view.chunks, view.low, view.high);
	if (!shown.length) return [];
	const centre = (view.low + view.high) / 2;
	const distance = (i: number) => Math.max(0, Date.parse(view.chunks[i]!.from) - centre, centre - Date.parse(view.chunks[i]!.to));
	const sides = [Math.min(...shown) - 1, Math.max(...shown) + 1].filter((i) => i >= 0 && i < view.chunks.length).sort((a, b) => distance(a) - distance(b));
	return [...shown, ...sides].flatMap((i) => columns.map((id) => slotOf(id, view.chunks[i]!)));
}

/** Whether `plan` may propose this cell: never read in this generation. A stale cell qualifies only while its re-read
 *  has neither been sent nor failed. */
function readable(cell: Cell | undefined): boolean {
	return !cell || (cell.state === 'stale' && cell.request === null && cell.failure === null);
}
/** The single next read, in the wanted order, or null. The hook calls it only when the view settles, and only sends
 *  what the coordinator admits (`scheduleReadBlock`): planning never bypasses a flight, wait, budget or stop. It
 *  doesn't check stops itself; after a zone change or a conflict it may still propose a cell, and the coordinator's
 *  `zone` or `conflict` stop is what refuses it. */
export function plan(occupancy: Occupancy, want: readonly Slot[]): Slot | null {
	for (const slot of want) if (readable(occupancy.cells[cellKey(slot)])) return bare(slot);
	return null;
}
/** Marks a planned cell as waiting on `request`. Any other cell is left unchanged. */
export function start(occupancy: Occupancy, slot: Slot, request: RequestId): Occupancy {
	const key = cellKey(slot), cell = occupancy.cells[key];
	if (!readable(cell)) return occupancy;
	return put(occupancy, key, cell?.state === 'stale' ? { ...cell, request } : { ...bare(slot), state: 'loading', request });
}

/** Whether a cell offers Try again: a failed cell, or a stale cell whose re-read failed (or their markers), except an
 *  access refusal, which only Refresh after the membership check lifts. Partial, conflict, complete and unread cells
 *  never do: re-reading a partial cell gives the same truncation. The coordinator still disables the button during
 *  any screen-wide wait. */
export function canTryAgain(cell: Cell | undefined): boolean {
	const failure = failureOf(cell);
	return failure !== null && failure.reason !== 'access';
}
/** Try again on one cell, with a retry ticket. A stale cell keeps its previous rows while it is re-read. */
export function tryAgain(occupancy: Occupancy, slot: Slot, request: RequestId): Occupancy {
	const key = cellKey(slot), cell = occupancy.cells[key];
	if (!cell || !canTryAgain(cell)) return occupancy;
	return put(occupancy, key, cell.state === 'stale' ? { ...cell, failure: null, request } : { ...bare(cell), state: 'loading', request });
}

export type Finished = {
	readonly occupancy: Occupancy;
	/** Whether the answer reached a cell waiting on this exact request. */
	readonly applied: boolean;
	/** `conflict` or `zone`: the hook calls the coordinator's `stopSchedule` with it. */
	readonly stop: 'conflict' | 'zone' | null;
};
function failure(outcome: ReadOutcome<OccupancyAnswer>): Failure {
	if (outcome.kind === 'unavailable') return { reason: 'unavailable', wait: outcome.wait };
	if (outcome.kind === 'refused' && (outcome.status === 403 || outcome.status === 404)) return { reason: 'access', wait: null };
	return { reason: 'unreadable', wait: null };
}
/** Applies one answer to the cell still waiting on exactly `request`; any other answer is dropped unchanged. Call it
 *  only when the coordinator's `finishScheduleRead` returned `apply: true`.
 *  - A read becomes complete or partial, unless it contradicts a retained row or carries an already contradicted ID
 *    (`conflict`, and so does every other cell holding a contradicted ID).
 *  - A zone change applies nothing: every retained payload becomes stale, and the queue must stop (`zone`).
 *  - A failure fails the cell, or keeps a stale cell's rows with the failure.
 *  - Superseded applies nothing; the cell returns to its state before the read (the tabs reset follows). */
export function finish(occupancy: Occupancy, slot: Slot, request: RequestId, outcome: ReadOutcome<OccupancyAnswer>): Finished {
	const key = cellKey(slot), cell = occupancy.cells[key];
	if (!cell || (cell.state !== 'loading' && cell.state !== 'stale') || cell.request !== request) return { occupancy, applied: false, stop: null };
	const waiting = cell.state === 'stale' ? { ...cell, request: null } : undefined;
	if (outcome.kind === 'superseded') return { occupancy: put(occupancy, key, waiting), applied: false, stop: null };
	if (outcome.kind === 'ok') {
		if (outcome.value.kind === 'zone-changed')
			return { occupancy: staleAll(put(occupancy, key, waiting), false), applied: true, stop: 'zone' };
		return applyRead(occupancy, key, bare(cell), outcome.value);
	}
	const failed: Cell = cell.state === 'stale' ? { ...cell, request: null, failure: failure(outcome) } : { ...bare(cell), state: 'failed', failure: failure(outcome) };
	return { occupancy: put(occupancy, key, failed), applied: true, stop: null };
}

/** Whether two copies of one reservation ID contradict each other:
 *  - read under different equipment, at any revision (the API never moves a reservation between equipment:
 *    `apps/api/src/equipment/service.ts` updates `where id = … and equipment_id = …`);
 *  - or at the same revision with any kept field different. */
function contradicts(a: Reservation, aEquipment: string, b: Reservation, bEquipment: string): boolean {
	if (aEquipment !== bEquipment) return true;
	return a.revision === b.revision && !(a.title === b.title && a.kind === b.kind && a.startsAt === b.startsAt && a.endsAt === b.endsAt &&
		a.occupiedStartsAt === b.occupiedStartsAt && a.occupiedEndsAt === b.occupiedEndsAt &&
		a.setupMinutes === b.setupMinutes && a.cleanupMinutes === b.cleanupMinutes);
}
/** A read, checked against every retained payload (markers hold no rows). A contradiction is never resolved silently:
 *  its ID joins `conflicted` and is drawn from no cell until Refresh. Then **every** cell whose rows hold any
 *  contradicted ID becomes `conflict`, including this read and cells holding it at another revision, so no cell can
 *  show free time under a reservation that isn't drawn. Different revisions under one equipment are not a
 *  contradiction: the highest is drawn. */
function applyRead(occupancy: Occupancy, key: string, slot: Slot, read: OccupancyRead): Finished {
	const incoming = new Map(read.reservations.map((r) => [r.id, r]));
	const conflicted = new Set(occupancy.conflicted);
	for (const [other, cell] of Object.entries(occupancy.cells)) {
		if (other === key) continue;
		for (const row of rowsOf(cell) ?? []) {
			const mine = incoming.get(row.id);
			if (mine && contradicts(mine, slot.equipmentId, row, cell.equipmentId)) conflicted.add(row.id);
		}
	}
	const cells: Record<string, Cell> = { ...occupancy.cells, [key]: { ...slot, state: read.coverage, reservations: read.reservations } };
	let stop: 'conflict' | null = null;
	for (const [other, cell] of Object.entries(cells)) {
		const rows = rowsOf(cell);
		if (!rows || cell.state === 'conflict' || !rows.some((r) => conflicted.has(r.id))) continue;
		cells[other] = { ...bare(cell), state: 'conflict', reservations: rows };
		stop = 'conflict';
	}
	return { occupancy: { cells, conflicted: [...conflicted] }, applied: true, stop };
}

/** Every retained payload becomes stale (rows from a conflict cell lose their contradicted reservations), and any
 *  outstanding request is forgotten. `clear` also drops failed cells and markers (Refresh); a zone change keeps them.
 *  After a zone change these stale cells are plannable again in the same generation. Only the coordinator's `zone`
 *  stop (from `finish`'s `stop`) keeps them from being sent until Refresh; the hook must never send past a stop. */
function staleAll(occupancy: Occupancy, clear: boolean): Occupancy {
	const contradicted = new Set(occupancy.conflicted), cells: Record<string, Cell> = {};
	for (const [key, cell] of Object.entries(occupancy.cells)) {
		const rows = rowsOf(cell);
		if (rows) cells[key] = { ...bare(cell), state: 'stale', previous: cell.state === 'conflict' ? rows.filter((r) => !contradicted.has(r.id)) : rows, failure: null, request: null };
		else if (cell.state !== 'loading' && !clear) cells[key] = cell;
	}
	return { cells, conflicted: clear ? [] : occupancy.conflicted };
}
/** Refresh (§4.4): every payload becomes `stale(previous)` awaiting its re-read, failed cells and markers are cleared,
 *  in-flight requests are forgotten (the coordinator's new generation drops their answers), and conflicts clear. */
export const refresh = (occupancy: Occupancy): Occupancy => staleAll(occupancy, true);

/** Re-anchoring keeps only cells whose instants are exactly a chunk of the new range. A request of the old generation
 *  is forgotten: a loading cell becomes unread again, and a stale cell waits for its re-read. Conflicts stay until
 *  Refresh, as the coordinator's conflict stop does. */
export function reanchor(occupancy: Occupancy, chunks: readonly Pick<Chunk, 'from' | 'to'>[]): Occupancy {
	const spans = new Set(chunks.map((c) => `${c.from} ${c.to}`)), cells: Record<string, Cell> = {};
	for (const [key, cell] of Object.entries(occupancy.cells)) {
		if (!spans.has(`${cell.from} ${cell.to}`) || cell.state === 'loading') continue;
		cells[key] = cell.state === 'stale' ? { ...cell, request: null } : cell;
	}
	return { cells, conflicted: occupancy.conflicted };
}
/** After the catalogue is replaced, cells for equipment no longer listed are dropped. */
export function keepEquipment(occupancy: Occupancy, listed: Iterable<string>): Occupancy {
	const ids = new Set(listed), cells: Record<string, Cell> = {};
	for (const [key, cell] of Object.entries(occupancy.cells)) if (ids.has(cell.equipmentId)) cells[key] = cell;
	return { cells, conflicted: occupancy.conflicted };
}

/** Where the view is centred, for eviction: every loaded column in display order, the centre column's index, the
 *  range's chunks, and the instant at the centre. */
export type Centre = { readonly columns: readonly string[]; readonly column: number; readonly chunks: readonly Chunk[]; readonly at: number };
/** Keeps at most `limit` payloads, evicting the cells farthest from the centre first (in columns or chunks, whichever
 *  is farther; cells off the loaded columns or chunks are farthest). Eviction never weakens honesty: only a complete
 *  payload becomes unread (and may be read again when wanted); partial, conflict and stale payloads leave a marker
 *  that is never read again automatically. A cell whose re-read is outstanding is not evicted. */
export function bound(occupancy: Occupancy, centre: Centre, limit = maxPayloadCells): Occupancy {
	const held = Object.entries(occupancy.cells).filter(([, cell]) => rowsOf(cell) !== null);
	if (held.length <= limit) return occupancy;
	const column = new Map(centre.columns.map((id, i) => [id, i]));
	const chunk = new Map(centre.chunks.map((c, i) => [`${c.from} ${c.to}`, i]));
	let middle = centre.chunks.findIndex((c) => Date.parse(c.from) <= centre.at && centre.at < Date.parse(c.to));
	if (middle < 0) middle = centre.at < Date.parse(centre.chunks[0]?.from ?? '') ? 0 : centre.chunks.length - 1;
	const distance = (cell: Cell) => {
		const c = column.get(cell.equipmentId), k = chunk.get(`${cell.from} ${cell.to}`);
		return c === undefined || k === undefined ? Infinity : Math.max(Math.abs(c - centre.column), Math.abs(k - middle));
	};
	const evictable = held.filter(([, cell]) => !(cell.state === 'stale' && cell.request !== null)).sort(([, a], [, b]) => distance(b) - distance(a));
	const cells = { ...occupancy.cells };
	for (let i = 0, count = held.length; count > limit && i < evictable.length; i++, count--) {
		const [key, cell] = evictable[i]!;
		if (cell.state === 'complete') delete cells[key];
		else if (cell.state === 'partial' || cell.state === 'conflict' || cell.state === 'stale')
			cells[key] = { ...bare(cell), state: 'marker', of: cell.state, failure: cell.state === 'stale' ? cell.failure : null };
	}
	return { cells, conflicted: occupancy.conflicted };
}

const weakest = ['failed', 'conflict', 'stale', 'unread', 'loading', 'partial'] as const;
/** The weakest state across cells: a failure, then conflict, stale, unread, loading and partial. No cells means
 *  nothing was read, never complete. */
export function combined(states: readonly CellState[]): CellState {
	if (!states.length) return 'unread';
	for (const state of weakest) if (states.includes(state)) return state;
	return 'complete';
}
/** The combined state of one equipment over [low, high). Time outside the range's chunks is unread. */
export function stateBetween(occupancy: Occupancy, equipmentId: string, chunks: readonly Chunk[], low: number, high: number): CellState {
	if (!(high > low) || !chunks.length) return 'unread';
	const states = chunksBetween(chunks, low, high).map((i) => stateOf(cellOf(occupancy, slotOf(equipmentId, chunks[i]!))));
	if (low < Date.parse(chunks[0]!.from) || high > Date.parse(chunks[chunks.length - 1]!.to)) states.push('unread');
	return combined(states);
}

/** Retained reservations for one equipment, one per ID at its highest revision, that occupy time inside [low, high),
 *  in occupied-start order. Contradicted IDs are drawn from no cell. Only retained payloads are considered. */
export function reservationsBetween(occupancy: Occupancy, equipmentId: string, low: number, high: number): Reservation[] {
	const contradicted = new Set(occupancy.conflicted), byId = new Map<string, Reservation>();
	for (const cell of Object.values(occupancy.cells)) {
		if (cell.equipmentId !== equipmentId) continue;
		for (const r of rowsOf(cell) ?? []) {
			if (contradicted.has(r.id)) continue;
			const seen = byId.get(r.id);
			if (!seen || r.revision > seen.revision) byId.set(r.id, r);
		}
	}
	return [...byId.values()].filter((r) => Date.parse(r.occupiedStartsAt) < high && Date.parse(r.occupiedEndsAt) > low)
		.sort((a, b) => a.occupiedStartsAt.localeCompare(b.occupiedStartsAt) || a.id.localeCompare(b.id));
}

/** The only way out of a coordinator stop, for the cells shown: `try-again` while a `retry` stop has a shown cell that
 *  offers Try again; otherwise `refresh` for any stop but superseded (whose account reset recreates the screen). After
 *  a re-anchor under a `retry` stop the failed cell may be gone, so Refresh must then be offered (A's C3). Null when
 *  the queue is not stopped. */
export function wayOut(occupancy: Occupancy, shown: readonly Slot[], stop: 'retry' | 'access' | 'conflict' | 'zone' | 'superseded' | null): 'try-again' | 'refresh' | null {
	if (stop === null || stop === 'superseded') return null;
	if (stop === 'retry' && shown.some((slot) => canTryAgain(cellOf(occupancy, slot)))) return 'try-again';
	return 'refresh';
}
