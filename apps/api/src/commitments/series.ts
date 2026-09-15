/** Period arithmetic for task series (plan §5, D7). Pure functions over calendar dates written as
 *  `YYYY-MM-DD`; no timezones here, the caller decides what "today" is in the organisation's zone. */

export type Recurrence = 'monthly' | 'quarterly' | 'yearly' | 'weekdays' | 'custom';
export type SeriesRule = { recurrence: Recurrence; everyMonths: number | null; anchor: string; dueOffsetDays: number };
export type Period = { start: string; end: string; label: string };

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const utc = (date: string): Date => {
	if (!isoDate.test(date)) throw new TypeError(`${date} is not a YYYY-MM-DD date`);
	const value = new Date(`${date}T00:00:00Z`);
	if (Number.isNaN(value.getTime()) || value.toISOString().slice(0, 10) !== date) throw new TypeError(`${date} is not a calendar date`);
	return value;
};
const iso = (value: Date): string => value.toISOString().slice(0, 10);
export const addDays = (date: string, days: number): string => { const value = utc(date); value.setUTCDate(value.getUTCDate() + days); return iso(value); };
/** Adds months keeping the day of month where it exists, else the last day of the target month. */
export const addMonths = (date: string, months: number): string => {
	const value = utc(date); const day = value.getUTCDate();
	value.setUTCDate(1); value.setUTCMonth(value.getUTCMonth() + months);
	const last = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
	value.setUTCDate(Math.min(day, last));
	return iso(value);
};

export const monthsPerPeriod = (rule: Pick<SeriesRule, 'recurrence' | 'everyMonths'>): number | null => {
	switch (rule.recurrence) {
		case 'monthly': return 1;
		case 'quarterly': return 3;
		case 'yearly': return 12;
		case 'custom': if (!rule.everyMonths || rule.everyMonths < 1) throw new TypeError('a custom series needs everyMonths'); return rule.everyMonths;
		case 'weekdays': return null;
	}
};

// Labels are formatted here rather than by Intl so they read the same on every runtime.
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (date: string) => `${months[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
export const shortDate = (date: string) => `${Number(date.slice(8, 10))} ${months[Number(date.slice(5, 7)) - 1]!.slice(0, 3)} ${date.slice(0, 4)}`;
const label = (start: string, end: string, months: number | null): string => {
	if (months === null) return shortDate(start);
	if (months === 1 && start.endsWith('-01')) return monthName(start);
	if (months === 12 && start.endsWith('-01-01')) return start.slice(0, 4);
	return `${shortDate(start)} – ${shortDate(end)}`;
};

/** The period that contains `date`, or null when the series has not started (date before anchor).
 *  Month-based periods are counted from the anchor; a weekdays series has one period per weekday. */
export function periodContaining(rule: SeriesRule, date: string): Period | null {
	utc(date);
	if (date < rule.anchor) return null;
	const months = monthsPerPeriod(rule);
	if (months === null) {
		const weekday = utc(date).getUTCDay();
		if (weekday === 0 || weekday === 6) return null;
		return { start: date, end: date, label: label(date, date, null) };
	}
	// Walk forward from the anchor; series are years long at most, so this is a handful of steps.
	let start = rule.anchor;
	for (;;) {
		const next = addMonths(start, months);
		if (date < next) return { start, end: addDays(next, -1), label: label(start, addDays(next, -1), months) };
		start = next;
	}
}

/** The first period on or after `date`: today's period, or the next weekday for a weekdays series. */
export function nextPeriod(rule: SeriesRule, date: string): Period {
	let day = date < rule.anchor ? rule.anchor : date;
	for (let i = 0; i < 7; i += 1) { const period = periodContaining(rule, day); if (period) return period; day = addDays(day, 1); }
	throw new Error('no period found within a week');
};

export const dueFor = (rule: Pick<SeriesRule, 'dueOffsetDays'>, period: Period): string => addDays(period.end, rule.dueOffsetDays);
export const titleFor = (template: string, period: Period): string => template.includes('{period}') ? template.replaceAll('{period}', period.label) : `${template} — ${period.label}`;

/** Today's date in a timezone, as `YYYY-MM-DD`. */
export const todayIn = (timeZone: string, now: Date = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
