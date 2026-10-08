/** "New booking" (bookings contract §3): where the schedule's button sends the person, the form's prefill from that link,
 *  the one write it makes and how the new booking's thread is found. Pure: no React Native import, so Node tests import it.
 *
 *  - The schedule prefills from what is on screen: the equipment column in view (the first when nothing has settled) and
 *    the day in view (the organisation's today when nothing has settled), as `/equipment/new?equipment=<id>&day=<date>`.
 *  - The form reads those parameters strictly: an id that is not active equipment in the loaded list, or a day that is
 *    not a real calendar date, is ignored and said so; nothing prefilled is also fine.
 *  - The write is `POST …/equipment/:id/reservations` with the booking's client id and a client change set id, both kept
 *    for an explicit retry with the exact same body (the saver's rules). */
import type { ReadScope } from '../../account/contracts.ts';
import { isCanonicalUuid, organisationPath } from '../../api/paths.ts';
import type { Row, ThreadList } from '../../threads/contracts.ts';
import { bookingPlan, type BookingForm, type BookingPlan } from '../../threads/cards/forms.ts';
import { parseBooking, type Booking, type Write } from '../../threads/cards/records.ts';
import { uuid } from '../../threads/parse.ts';
import { dateAt } from './range.ts';
import type { Equipment } from './data.ts';
import type { SettledView } from './schedule.ts';

const DAY = 86_400_000;
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** The route the schedule's "New booking" opens. */
export function newBookingHref(prefill: { equipment: string | null; day: string | null }): string {
	const query = [prefill.equipment && isCanonicalUuid(prefill.equipment) ? `equipment=${prefill.equipment}` : null, prefill.day && isDate(prefill.day) ? `day=${prefill.day}` : null]
		.filter(Boolean).join('&');
	return query ? `/equipment/new?${query}` : '/equipment/new';
}

/** What the schedule shows: the column at the left edge of the view (the first when nothing has settled) and the first
 *  day mostly in view: the day half a day below the top of the view, below the sticky names row (today in the zone when
 *  nothing has settled). A view shorter than a day (the Hours scale) uses its middle, so the day is the one the screen shows. */
export function schedulePrefill(view: { columns: readonly Equipment[]; settled: SettledView | null; zone: string | null; now: number }): { equipment: string | null; day: string | null } {
	const { columns, settled, zone } = view;
	let index = 0;
	if (settled && settled.columnWidth > 0) index = Math.min(columns.length - 1, Math.max(0, Math.round(settled.x / settled.columnWidth)));
	const equipment = columns[index]?.id ?? null;
	if (!zone) return { equipment, day: null };
	const at = settled && settled.high > settled.low ? settled.low + Math.min(DAY / 2, (settled.high - settled.low) / 2) : view.now;
	try { return { equipment, day: dateAt(at, zone) }; } catch { return { equipment, day: null }; }
}

/** One query parameter as Expo Router gives it. */
type Param = string | string[] | undefined;
const one = (p: Param): string | null => typeof p === 'string' ? p : null;
export type Prefill = { equipmentId: string | null; date: string; notes: ('equipment' | 'day')[] };
/** The form's starting equipment and date from the link: the named equipment when it is in the active list, else the
 *  first; the named day when it is a real date, else today. `notes` names what was asked for and could not be used. */
export function readPrefill(params: { equipment?: Param; day?: Param }, equipment: readonly Pick<Equipment, 'id'>[], today: string): Prefill {
	const notes: Prefill['notes'] = [];
	const asked = one(params.equipment), day = one(params.day);
	const found = asked && isCanonicalUuid(asked) ? equipment.find((e) => e.id === asked) : undefined;
	if (params.equipment !== undefined && !found) notes.push('equipment');
	if (params.day !== undefined && !(day && isDate(day))) notes.push('day');
	return { equipmentId: found?.id ?? equipment[0]?.id ?? null, date: day && isDate(day) ? day : today, notes };
}
export const prefillWords = { equipment: 'The equipment in the link is not available, so the first is chosen.', day: 'The day in the link could not be read, so today is chosen.' } as const;

/** The form a new booking opens with: no title, 9 to 10 am on the day, no setup or cleanup. */
export function newBookingForm(date: string): BookingForm {
	return { title: '', date, start: '09:00', endDate: date, end: '10:00', setup: 0, cleanup: 0 };
}
const fresh = { kind: 'booking' as const, taskId: null, ownerId: null };
/** The write a new booking form asks for, or what is wrong with it. A new booking is kind `booking` with no task or owner. */
export function newBookingPlan(form: BookingForm, zone: string, multiDay: boolean): BookingPlan {
	return bookingPlan(fresh, form, zone, multiDay);
}

export type NewBookingTime = { title: string; startsAt: string; endsAt: string; setupMinutes: number; cleanupMinutes: number };
/** `POST …/equipment/:id/reservations` with the booking's id and the change set id; the answer is that booking. */
export function newBookingWrite(scope: ReadScope, equipmentId: string, bookingId: string, changeSetId: string, time: NewBookingTime): Write<Booking & { changeSetId: string }> {
	return {
		method: 'POST', path: organisationPath(scope.organisationId, 'equipment', uuid(equipmentId), 'reservations'),
		body: { id: uuid(bookingId), changeSetId, title: time.title, kind: 'booking', startsAt: time.startsAt, endsAt: time.endsAt, setupMinutes: time.setupMinutes,
			cleanupMinutes: time.cleanupMinutes, taskId: null, ownerId: null, tagIds: [] },
		parse: (v) => ({ ...parseBooking(v, { id: bookingId, equipmentId, changeSetId }), changeSetId })
	};
}

/** The new booking's thread in a page of the Bookings filter: its creation is the thread's latest activity, so it is on
 *  the first page unless fifty other bookings moved since. Null when it is not there. */
export function bookingThread(list: Pick<ThreadList, 'threads'>, bookingId: string): string | null {
	return list.threads.find((row: Row) => row.kind === 'record' && row.record?.kind === 'booking' && row.record.id === bookingId)?.id ?? null;
}
