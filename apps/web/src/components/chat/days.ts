/** Day separators and message times in the organisation's timezone (plan §1). Pure, so the thread, the item panel and
 *  the browser script all agree on where a day starts. */

const dayKeyFormat = (timezone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });

/** `YYYY-MM-DD` of the instant in that timezone. */
export function dayKey(iso: string, timezone: string): string {
	return dayKeyFormat(timezone).format(new Date(iso));
}

/** "Tuesday 22 September", with the year when it is not the current year there. */
export function dayLabel(iso: string, timezone: string, now = new Date()): string {
	const when = new Date(iso);
	const sameYear = dayKey(iso, timezone).slice(0, 4) === dayKeyFormat(timezone).format(now).slice(0, 4);
	const parts = new Intl.DateTimeFormat('en-AU', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) })
		.formatToParts(when);
	const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
	return `${part('weekday')} ${part('day')} ${part('month')}${sameYear ? '' : ` ${part('year')}`}`;
}

/** "09:05", 24-hour, in that timezone. */
export function timeLabel(iso: string, timezone: string): string {
	return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

/** Rows interleaved with a separator wherever the day changes. */
export type Dated<T> = { kind: 'day'; key: string; label: string } | { kind: 'row'; row: T };
export function withDays<T extends { createdAt: string }>(rows: T[], timezone: string, now = new Date()): Dated<T>[] {
	const out: Dated<T>[] = [];
	let last: string | null = null;
	for (const row of rows) {
		const key = dayKey(row.createdAt, timezone);
		if (key !== last) { out.push({ kind: 'day', key, label: dayLabel(row.createdAt, timezone, now) }); last = key; }
		out.push({ kind: 'row', row });
	}
	return out;
}
