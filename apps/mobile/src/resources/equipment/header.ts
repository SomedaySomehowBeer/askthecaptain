/** The schedule's header (H4 contract §3; prototype frame 5): the day in view, the date stepper's next day, and the
 *  words "Thursday 1 October" and "Today is Tue 29 Sep". Pure: dates are the organisation's calendar dates, instants come
 *  from the settled view; no React Native import. */
import type { Scale } from './geometry.ts';
import { dayStart, inRange, type ScheduleRange } from './range.ts';
import { shiftDate, todayInZone } from './zone.ts';

/** The calendar date at the middle of the settled view, in the zone; today before anything settles. */
export function dayInView(settled: { readonly low: number; readonly high: number } | null, zone: string, now: Date): string {
	if (settled === null || !(settled.high > settled.low)) return todayInZone(zone, now);
	return todayInZone(zone, new Date((settled.low + settled.high) / 2));
}
/** How far one press of ‹ or › moves: a day on Hours and Days, a week on Weeks. */
export const stepDays = (scale: Scale) => scale === 'weeks' ? 7 : 1;
/** Where a press of ‹ (-1) or › (1) puts the middle of the view: midday of the next day, in the zone (on Hours that shows
 *  the working day, as frame 5 draws it). Null when that day is outside the schedule's range (Earlier or Later dates
 *  moves the range) or does not exist in the zone. */
export function stepTo(day: string, scale: Scale, direction: -1 | 1, zone: string, range: Pick<ScheduleRange, 'start' | 'end'>): { date: string; at: number } | null {
	const date = shiftDate(day, direction * stepDays(scale));
	const start = dayStart(date, zone), next = dayStart(shiftDate(date, 1), zone);
	if (start === null || next === null) return null;
	const at = (Date.parse(start) + Date.parse(next)) / 2;
	return inRange(range, at) ? { date, at } : null;
}
const longDay = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const shortDay = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const words = (format: Intl.DateTimeFormat, date: string, short = false) => {
	const parts = format.formatToParts(new Date(`${date}T00:00:00Z`)), part = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
	// Some runtimes write September short as "Sept"; the design writes three letters.
	return `${part('weekday')} ${part('day')} ${short ? part('month').slice(0, 3) : part('month')}`;
};
/** "Thursday 1 October". */
export const dayHeading = (date: string) => words(longDay, date);
/** "Today is Tue 29 Sep". */
export const todayLine = (date: string) => `Today is ${words(shortDay, date, true)}`;
