/** The card editors' forms: values from the record, the changes a save sends, and what is wrong with them. Pure. */
import { localChoices, ZoneError } from '../../resources/equipment/zone.ts';
import { wordInstant, wordMinutes } from '../wording.ts';
import type { Booking, BookingTime, Task, TaskChanges, TaskStatus } from './records.ts';

export type TaskForm = { title: string; status: TaskStatus; ownerId: string; due: string };
export const taskForm = (t: Task): TaskForm => ({ title: t.title, status: t.status, ownerId: t.ownerId ?? '', due: t.due ?? '' });
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** Only what changed, so one save is one change set naming exactly the fields the person touched; null when nothing did. */
export function taskChanges(task: Task, form: TaskForm): TaskChanges | null {
	const changes: TaskChanges = {};
	if (form.title.trim() !== task.title) changes.title = form.title.trim();
	if (form.status !== task.status) changes.status = form.status;
	if ((form.ownerId || null) !== task.ownerId) changes.ownerId = form.ownerId || null;
	if ((form.due || null) !== task.due) changes.due = form.due || null;
	return Object.keys(changes).length ? changes : null;
}
export function validTaskForm(form: TaskForm): string | null {
	if (!form.title.trim()) return 'A task needs a title.';
	if ([...form.title.trim()].length > 200) return 'A title is at most 200 characters.';
	if (form.due && !isDate(form.due)) return 'Enter the due date as a date, or leave it empty.';
	return null;
}

export type BookingForm = { title: string; date: string; start: string; endDate: string; end: string; setup: number; cleanup: number };
const civil = (instant: string, zone: string) => {
	const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(Date.parse(instant));
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
	return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
};
export function bookingForm(b: Booking, zone: string): BookingForm {
	const s = civil(b.startsAt, zone), e = civil(b.endsAt, zone);
	return { title: b.title, date: s.date, start: s.time, endDate: e.date, end: e.time, setup: b.setupMinutes, cleanup: b.cleanupMinutes };
}
/** A booking that ends on a later day than it starts shows its end date as its own field. */
export const spansDays = (form: BookingForm) => form.endDate !== form.date;
/** The form a booking's card opens with, and whether it shows the end date: a booking that spans days is read as one,
 *  whether the record was loaded before or after the card unfolded. */
export function bookingStart(b: Booking, zone: string): { form: BookingForm; multiDay: boolean } {
	const form = bookingForm(b, zone);
	return { form, multiDay: spansDays(form) };
}

/** The instant of a civil date and time in the zone; the earlier one in a repeated hour; null in a clock-change gap. */
export function instantIn(date: string, time: string, zone: string): string | null {
	if (!isDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
	try { return localChoices(`${date}T${time}`, zone)[0]?.instant ?? null; } catch (e) { if (e instanceof ZoneError) return null; throw e; }
}
export type BookingPlan = { time: BookingTime; occupiedFrom: string; occupiedTo: string } | { error: string };
/** The write a booking form asks for, or what is wrong with it. Kind, task and owner are kept as they are. */
export function bookingPlan(b: Pick<Booking, 'kind' | 'taskId' | 'ownerId'>, form: BookingForm, zone: string, multiDay: boolean): BookingPlan {
	const title = form.title.trim();
	if (!title) return { error: 'A booking needs a title.' };
	if ([...title].length > 200) return { error: 'A title is at most 200 characters.' };
	const startsAt = instantIn(form.date, form.start, zone), endsAt = instantIn(multiDay ? form.endDate : form.date, form.end, zone);
	if (!startsAt || !endsAt) return { error: 'Enter a real date, start and end. A time skipped by a clock change cannot be booked.' };
	const span = Date.parse(endsAt) - Date.parse(startsAt);
	if (span <= 0) return { error: multiDay ? 'The end must be after the start.' : 'The end must be after the start on the same day.' };
	if (span > 366 * 86_400_000) return { error: 'A booking is at most 366 days long.' };
	const occupiedFrom = new Date(Date.parse(startsAt) - form.setup * 60_000).toISOString(), occupiedTo = new Date(Date.parse(endsAt) + form.cleanup * 60_000).toISOString();
	return { time: { title, kind: b.kind, startsAt, endsAt, setupMinutes: form.setup, cleanupMinutes: form.cleanup, taskId: b.taskId, ownerId: b.ownerId }, occupiedFrom, occupiedTo };
}
/** What the equipment's schedule says about the time asked for. Only `taken` is a refusal: the others are cautions,
 *  and the server checks the time again on save. */
export type Availability = { kind: 'idle' | 'checking' | 'free' | 'partial' | 'unchecked' } | { kind: 'taken'; holders: string[] };
export type BookingControls = {
	/** The fields can be changed. */
	editable: boolean;
	/** The warning shown above the actions that says a save would be refused, if any. */
	warning: 'invalid' | 'taken' | null;
	save: boolean; discard: boolean; cancel: boolean; confirmCancel: boolean;
};
/** Which booking card actions can succeed now. A control is enabled only when its action can succeed: never while a
 *  warning says the save will be refused, a write is in flight or uncertain, a wait stands, or the last refusal still
 *  holds; never disabled for any other reason. */
export function bookingControls(s: {
	locked: boolean; cancelled: boolean; waiting: boolean; changed: boolean; plan: BookingPlan | null; free: Availability;
	save: { busy: boolean; uncertain: boolean; refusal: string | null }; cancel: { busy: boolean; uncertain: boolean; refusal: string | null };
}): BookingControls {
	const busy = s.save.busy || s.cancel.busy, uncertain = s.save.uncertain || s.cancel.uncertain;
	const editable = !s.locked && !busy && !uncertain && !s.cancelled;
	const warning = s.cancelled ? null : s.plan && 'error' in s.plan ? 'invalid' : s.free.kind === 'taken' ? 'taken' : null;
	return {
		editable, warning,
		save: editable && !s.waiting && s.changed && Boolean(s.plan && 'time' in s.plan) && warning === null && !refusedForGood(s.save.refusal),
		discard: !busy && s.changed,
		cancel: editable && !s.waiting && !refusedForGood(s.cancel.refusal),
		confirmCancel: !s.locked && !busy && !s.save.uncertain && !s.cancelled && !s.waiting && !refusedForGood(s.cancel.refusal)
	};
}
/** Refusals that hold until something changes: the same write would be refused again. */
export const refusedForGood = (code: string | null) => code !== null && ['forbidden', 'reservation_cancelled', 'equipment_archived', 'stock_archived', 'thread_is_record', 'thread_not_topic'].includes(code);
export const bookingChanged = (b: Booking, t: BookingTime) => t.title !== b.title || Date.parse(t.startsAt) !== Date.parse(b.startsAt) || Date.parse(t.endsAt) !== Date.parse(b.endsAt)
	|| t.setupMinutes !== b.setupMinutes || t.cleanupMinutes !== b.cleanupMinutes;

/** "7:30 am to 12:30 pm", with the day when the two differ. */
export function occupancyWords(from: string, to: string, zone: string, year?: number): string {
	const a = wordInstant(from, zone, year), b = wordInstant(to, zone, year);
	if (!a || !b) return '';
	return a.day === b.day ? `${a.time} to ${b.time}` : `${a.day}, ${a.time} to ${b.day}, ${b.time}`;
}
export const minuteChoices = (current: number) => [...new Set([0, 15, 30, 45, 60, 90, 120, current])].sort((a, b) => a - b)
	.map((m) => ({ value: String(m), label: wordMinutes(m).replace(/^n/, 'N') }));

/** A count as the API takes it: a decimal of zero or more, at most 80 characters. */
export function validCount(value: string): string | null {
	const v = value.trim();
	if (!v) return 'Enter the count.';
	if (v.length > 80 || !/^\d+(?:\.\d+)?$/.test(v)) return 'Enter a count of zero or more, using digits and an optional decimal point.';
	return null;
}
