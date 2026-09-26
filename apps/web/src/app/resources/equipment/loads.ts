/** Occupancy read state for each (chunk, equipment) cell of the schedule. Pure and browser-safe.
 *  Only a loaded, complete cell can show free time. Idle, loading, failed and partial cells stay
 *  unknown. A failed cell is never re-requested automatically: only an explicit retry reloads it,
 *  so a failing boundary cannot loop. A response is applied only to the cells still waiting on
 *  that exact request, so a stale or superseded response is ignored. */
import { uuid, type Reservation } from './types.ts';

export const pageSize = 8, maxReadDays = 93;
export type LaneRead = { ok: true; reservations: Reservation[]; coverage: 'complete' | 'partial' } | { ok: false; message: string };
export type Cell = { status: 'idle' } | { status: 'loading'; request: number } | { status: 'failed'; message: string } | { status: 'loaded'; reservations: Reservation[]; coverage: 'complete' | 'partial' };
export type Cells = Readonly<Record<string, Cell>>;
export type CellState = 'complete' | 'partial' | 'loading' | 'failed' | 'unloaded';

const idle: Cell = { status: 'idle' };
export const cellKey = (chunk: number, equipmentId: string) => `${chunk}:${equipmentId}`;
export const cellOf = (cells: Cells, chunk: number, equipmentId: string): Cell => cells[cellKey(chunk, equipmentId)] ?? idle;
export function stateOf(cell: Cell): CellState {
 return cell.status === 'loaded' ? cell.coverage : cell.status === 'idle' ? 'unloaded' : cell.status;
}
const fromRead = (read: LaneRead): Cell => read.ok ? { status: 'loaded', reservations: read.reservations, coverage: read.coverage } : { status: 'failed', message: read.message };

export function seed(chunk: number, reads: Readonly<Record<string, LaneRead>>): Cells {
 return Object.fromEntries(Object.entries(reads).map(([id, read]) => [cellKey(chunk, id), fromRead(read)]));
}

/** The next single read to send: the first wanted chunk (callers order them nearest-first) with
 *  never-requested cells, for just those equipment. Nothing while another read is in flight. */
export function plan(cells: Cells, wanted: readonly number[], equipmentIds: readonly string[], busy: boolean): { chunk: number; equipmentIds: string[] } | null {
 if (busy) return null;
 for (const chunk of wanted) {
  const pending = equipmentIds.filter(id => cellOf(cells, chunk, id).status === 'idle');
  if (pending.length) return { chunk, equipmentIds: pending };
 }
 return null;
}
export function start(cells: Cells, chunk: number, equipmentIds: readonly string[], request: number): Cells {
 const next = { ...cells };
 for (const id of equipmentIds) if (cellOf(cells, chunk, id).status === 'idle') next[cellKey(chunk, id)] = { status: 'loading', request };
 return next;
}
/** Apply a response. Equipment the response does not mention fails rather than looking free. */
export function finish(cells: Cells, chunk: number, equipmentIds: readonly string[], request: number, reads: Readonly<Record<string, LaneRead>> | { error: string }): Cells {
 let next: Record<string, Cell> | null = null;
 for (const id of equipmentIds) {
  const current = cellOf(cells, chunk, id);
  if (current.status !== 'loading' || current.request !== request) continue;
  const read = 'error' in reads && typeof reads.error === 'string' ? { ok: false as const, message: reads.error }
   : (reads as Record<string, LaneRead>)[id] ?? { ok: false as const, message: 'This equipment was not read.' };
  (next ??= { ...cells })[cellKey(chunk, id)] = fromRead(read);
 }
 return next ?? cells;
}
export function retry(cells: Cells, chunk: number, equipmentId: string): Cells {
 return cellOf(cells, chunk, equipmentId).status === 'failed' ? { ...cells, [cellKey(chunk, equipmentId)]: idle } : cells;
}

/** The weakest state across chunks: any failure, then loading/unloaded, then partial. No chunks
 *  means nothing was read, never complete. */
export function combined(states: readonly CellState[]): CellState {
 if (!states.length) return 'unloaded';
 for (const state of ['failed', 'unloaded', 'loading', 'partial'] as const) if (states.includes(state)) return state;
 return 'complete';
}

/** Loaded reservations for one equipment, one per ID (the highest revision seen), that occupy
 *  time inside [low, high). */
export function reservationsBetween(cells: Cells, chunks: readonly number[], equipmentId: string, low: number, high: number): Reservation[] {
 const byId = new Map<string, Reservation>();
 for (const chunk of chunks) {
  const cell = cellOf(cells, chunk, equipmentId); if (cell.status !== 'loaded') continue;
  for (const r of cell.reservations) { const seen = byId.get(r.id); if (!seen || r.revision > seen.revision) byId.set(r.id, r); }
 }
 return [...byId.values()].filter(r => Date.parse(r.occupiedStartsAt) < high && Date.parse(r.occupiedEndsAt) > low)
  .sort((a, b) => a.occupiedStartsAt.localeCompare(b.occupiedStartsAt) || a.id.localeCompare(b.id));
}

const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
/** Server action input is untrusted: one page of distinct equipment and one bounded window. */
export function validRead(equipmentIds: unknown, from: unknown, to: unknown): { equipmentIds: string[]; from: string; to: string } | null {
 if (!Array.isArray(equipmentIds) || !equipmentIds.length || equipmentIds.length > pageSize) return null;
 if (!equipmentIds.every(id => typeof id === 'string' && uuid.test(id)) || new Set(equipmentIds).size !== equipmentIds.length) return null;
 if (typeof from !== 'string' || typeof to !== 'string' || !instant.test(from) || !instant.test(to)) return null;
 const a = Date.parse(from), b = Date.parse(to);
 if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || b - a > maxReadDays * 86_400_000) return null;
 return { equipmentIds: equipmentIds as string[], from, to };
}
