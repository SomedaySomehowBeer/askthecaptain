'use server';
import { api, ApiError } from '../../../lib/api.ts';
import { actionSession } from '../../../lib/session.ts';
import { validRead, type LaneRead } from './loads.ts';
import type { ReservationRange } from './types.ts';

export type OccupancyRead = { ok: true; timezone: string | null; lanes: Record<string, LaneRead> } | { ok: false; error: string };
const sessionWords = {
 'signed-out': 'Your session has ended. Sign in again to read the schedule.',
 unavailable: 'Captain could not check your session just now.',
 'no-organisation': 'Choose an organisation first.',
} as const;

/** One bounded occupancy read for one page of equipment (D24): at most eight equipment and one
 *  window of at most 93 days, each read once through the API as the signed-in person. The browser
 *  never holds the token; the API still applies membership, RLS and its own limits. Only the first
 *  page of each read is fetched, so a truncated read stays `partial` rather than looking free. */
export async function readOccupancy(equipmentIds: string[], from: string, to: string): Promise<OccupancyRead> {
 const input = validRead(equipmentIds, from, to);
 if (!input) return { ok: false, error: 'That schedule read was not valid. Refresh the schedule.' };
 const s = await actionSession();
 if (!s.ok) return { ok: false, error: sessionWords[s.reason] };
 const params = new URLSearchParams({ from: input.from, to: input.to });
 let timezone: string | null = null;
 const reads = await Promise.all(input.equipmentIds.map(async (id): Promise<[string, LaneRead]> => {
  try {
   const range = await api<ReservationRange>(`/v1/organisations/${s.org}/equipment/${id}/reservations?${params}`, { token: s.token });
   timezone ??= range.timezone;
   return [id, { ok: true, reservations: range.reservations, coverage: range.coverage === 'complete' && range.nextOffset === null ? 'complete' : 'partial' }];
  } catch (error) {
   return [id, { ok: false, message: error instanceof ApiError ? error.message : 'Reservations could not be read.' }];
  }
 }));
 return { ok: true, timezone, lanes: Object.fromEntries(reads) };
}
