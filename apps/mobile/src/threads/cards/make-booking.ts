/** "Make this a booking" (bookings contract §2, §3): the request body and the answer's check. Pure, so Node tests import it. */
import type { Detail } from '../contracts.ts';
import { parseDetail } from '../parse.ts';

/** The answer is this thread's detail, now a record thread on a booking. */
export function parseMadeBooking(raw: unknown, threadId: string): Detail {
	const d = parseDetail(raw);
	if (d.thread.id !== threadId || d.thread.kind !== 'record' || d.card.record?.kind !== 'booking') throw new TypeError('make booking: unexpected response');
	return d;
}
export type MadeBookingTime = { startsAt: string; endsAt: string; setupMinutes: number; cleanupMinutes: number };
export function makeBookingBody(changeSetId: string, expectedRevision: number, equipmentId: string, time: MadeBookingTime) {
	return { changeSetId, expectedRevision, equipmentId, startsAt: time.startsAt, endsAt: time.endsAt, setupMinutes: time.setupMinutes, cleanupMinutes: time.cleanupMinutes };
}
