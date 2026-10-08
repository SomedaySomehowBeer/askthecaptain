/** The scrollable schedule range and its bounded occupancy chunks (contract §4.2): ported from the retired
 *  Next.js schedule, preserving the `Chunk` and `ScheduleRange` shapes.
 *
 *  The range runs from one calendar month before the anchor date to six calendar months after it. Each chunk is at
 *  most `chunkDays` civil days, aligned to the anchor, far inside the API's 93-day read limit. Every boundary is the
 *  zoned start of a civil date, as a canonical `…Z` instant. Pure: no React, no native module and no API. */
import type { Scale } from './geometry.ts';
import { DAY, ZoneError, shiftDate, todayInZone, zonedDay } from './zone.ts';

export { DAY };
export const chunkDays = 28;
export const monthsBefore = 1, monthsAfter = 6;
/** The API refuses instants before 1900 and from 2200. Zoned midnights near those limits can fall outside them, so
 *  the scrollable range stays a day inside. */
const firstDate = '1900-01-02', lastDate = '2199-12-31';

export type Chunk = { from: string; to: string; fromDate: string; toDate: string };
export type ScheduleRange = {
	anchor: string; anchorAt: string; startDate: string; endDate: string; start: string; end: string;
	chunks: Chunk[]; anchorChunk: number;
};

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A real calendar date in `YYYY-MM-DD` form, or `invalid`. */
function calendarDate(date: string): [number, number, number] {
	const match = datePattern.exec(date);
	if (!match) throw new ZoneError('invalid');
	const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
	const at = new Date(Date.UTC(year, month - 1, day));
	if (month < 1 || month > 12 || at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day)
		throw new ZoneError('invalid');
	return [year, month, day];
}
/** The same day of the month `months` calendar months away, clamped to that month's last day. */
export function addMonths(date: string, months: number): string {
	const [year, month, day] = calendarDate(date);
	const total = year * 12 + month - 1 + months, y = Math.floor(total / 12), m = total - y * 12;
	const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
	return `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}
const clampDate = (date: string) => date < firstDate ? firstDate : date > lastDate ? lastDate : date;
/** `shiftDate`, or null outside 1900–2200. */
function shifted(date: string, days: number): string | null {
	try {
		return shiftDate(date, days);
	} catch {
		return null;
	}
}

const starts = new Map<string, string | null>();
/** The first instant of a civil date in the zone, or null when a clock change skips the whole date. */
export function dayStart(date: string, zone: string): string | null {
	const key = zone + ' ' + date;
	if (!starts.has(key)) {
		let value: string | null;
		try {
			value = zonedDay(date, zone);
		} catch (error) {
			if (error instanceof ZoneError && error.reason === 'skipped') value = null;
			else throw error;
		}
		if (starts.size > 5000) starts.clear();
		starts.set(key, value);
	}
	return starts.get(key)!;
}
/** A boundary at `date`, or at the next date that exists when `date` is skipped. */
function boundary(date: string, zone: string): string {
	const next = shifted(date, 1), at = dayStart(date, zone) ?? (next ? dayStart(next, zone) : null);
	if (!at) throw new ZoneError('skipped');
	return at;
}

/** Throws `ZoneError`: `invalid` for a malformed date or one outside the range limits, `skipped` for an anchor a clock
 *  change removes, and `unsupported` for a zone the engine can't format. Callers show a designed refusal. */
export function scheduleRange(anchor: string, zone: string): ScheduleRange {
	calendarDate(anchor);
	if (anchor < firstDate || anchor >= lastDate) throw new ZoneError('invalid');
	const anchorAt = zonedDay(anchor, zone);
	const after = clampDate(addMonths(anchor, monthsAfter));
	const startDate = clampDate(addMonths(anchor, -monthsBefore)), endDate = after === lastDate ? lastDate : shiftDate(after, 1);
	// Chunks are aligned to the anchor, so the first read covers the dates the person opened.
	const dates = new Set([startDate, endDate, anchor]);
	for (let d: string | null = anchor; d && d > startDate; d = shifted(d, -chunkDays)) dates.add(d);
	for (let d: string | null = anchor; d && d < endDate; d = shifted(d, chunkDays)) dates.add(d);
	const ordered = [...dates].filter((d) => d >= startDate && d <= endDate).sort();
	const chunks: Chunk[] = [];
	for (let i = 0; i + 1 < ordered.length; i++) {
		const from = boundary(ordered[i]!, zone), to = boundary(ordered[i + 1]!, zone);
		if (Date.parse(to) > Date.parse(from)) chunks.push({ from, to, fromDate: ordered[i]!, toDate: ordered[i + 1]! });
	}
	return {
		anchor, anchorAt, startDate, endDate, start: chunks[0]!.from, end: chunks[chunks.length - 1]!.to, chunks,
		anchorChunk: Math.max(0, chunks.findIndex((c) => c.fromDate === anchor)),
	};
}

/** Whether an instant is inside the range, for example "now" when Today is pressed. */
export function inRange(range: Pick<ScheduleRange, 'start' | 'end'>, at: number): boolean {
	return at >= Date.parse(range.start) && at < Date.parse(range.end);
}

/** The anchor for "Earlier dates" or "Later dates": the selected edge date of the range, or the nearest existing
 *  date inside it when a clock change skips the edge. Null when the range already reaches the 1900–2200 limit in
 *  that direction, so no control is offered there. */
export function edgeAnchor(range: Pick<ScheduleRange, 'startDate' | 'endDate'>, zone: string, direction: 'earlier' | 'later'): string | null {
	const earlier = direction === 'earlier';
	if (earlier ? range.startDate <= firstDate : range.endDate >= lastDate) return null;
	let date: string | null = earlier ? range.startDate : range.endDate;
	for (let tries = 0; date && tries < 3; tries++) {
		if (dayStart(date, zone) !== null) return date;
		date = shifted(date, earlier ? 1 : -1);
	}
	return null;
}

/** Indices of chunks intersecting [low, high), nearest to the middle first. */
export function chunksBetween(chunks: readonly Chunk[], low: number, high: number): number[] {
	const middle = (low + high) / 2, result: number[] = [];
	chunks.forEach((chunk, i) => {
		if (Date.parse(chunk.from) < high && Date.parse(chunk.to) > low) result.push(i);
	});
	const distance = (i: number) => Math.max(0, Date.parse(chunks[i]!.from) - middle, middle - Date.parse(chunks[i]!.to));
	return result.sort((a, b) => distance(a) - distance(b));
}

/** The instants rendered: the visible time plus overscan. It changes only when the visible time leaves the inner
 *  margin, so scrolling re-renders the timeline rarely. */
export type TimeWindow = { low: number; high: number };
export function renderWindow(current: TimeWindow | null, viewLow: number, viewHigh: number, start: number, end: number): TimeWindow {
	const span = Math.max(viewHigh - viewLow, 3_600_000);
	if (current && current.low <= Math.max(start, viewLow - span / 2) && current.high >= Math.min(end, viewHigh + span / 2)) return current;
	return { low: Math.max(start, viewLow - span * 1.5), high: Math.min(end, viewHigh + span * 1.5) };
}

const labelFormats = new Map<string, Intl.DateTimeFormat>();
function labelFormat(zone: string, hours: boolean): Intl.DateTimeFormat {
	const key = zone + (hours ? ' h' : ' d');
	let value = labelFormats.get(key);
	if (!value) {
		value = new Intl.DateTimeFormat('en-AU', hours
			// Frame 5's axis: "6 am", "2 pm". A day's first tick names the day instead (below).
			? { timeZone: zone, hour: 'numeric', hourCycle: 'h12' }
			: { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' });
		if (labelFormats.size >= 64) labelFormats.clear();
		labelFormats.set(key, value);
	}
	return value;
}
/** Whether both axis label formatters build afresh and format in `zone` on this engine. The screen calls it once, right
 *  after the zone gate passes, so rendering only ever uses formatters already proven (E-2 review N3). */
export function labelFormatsOk(zone: string): boolean {
	try {
		labelFormats.delete(zone + ' h');
		labelFormats.delete(zone + ' d');
		return typeof labelFormat(zone, true).format(0) === 'string' && typeof labelFormat(zone, false).format(0) === 'string';
	} catch {
		return false;
	}
}
/** Axis ticks inside [low, high) only: hourly from the range start, or daily/weekly civil starts counted from the
 *  anchor. A skipped civil date has no start and no tick. */
export function ticks(scale: Scale, range: Pick<ScheduleRange, 'anchor' | 'anchorAt' | 'start' | 'end'>, zone: string, low: number, high: number): { at: number; label: string }[] {
	const result: { at: number; label: string }[] = [], start = Date.parse(range.start), end = Date.parse(range.end);
	low = Math.max(low, start);
	high = Math.min(high, end);
	if (high <= low) return result;
	if (scale === 'hours') {
		const format = labelFormat(zone, true), days = labelFormat(zone, false);
		for (let at = start + Math.ceil((low - start) / 3_600_000) * 3_600_000; at < high; at += 3_600_000)
			result.push({ at, label: dateAt(at, zone) !== dateAt(at - 3_600_000, zone) ? days.format(at).replace(',', '') : format.format(at) });
		return result;
	}
	const step = scale === 'weeks' ? 7 : 1, format = labelFormat(zone, false), anchorAt = Date.parse(range.anchorAt);
	const first = Math.floor((low - anchorAt) / (step * DAY)) - 1, last = Math.ceil((high - anchorAt) / (step * DAY)) + 1;
	for (let k = first; k <= last; k++) {
		const date = shifted(range.anchor, k * step), instant = date ? dayStart(date, zone) : null;
		if (!instant) continue;
		const at = Date.parse(instant);
		if (at >= low && at < high) result.push({ at, label: format.format(at).replace(',', '') });
	}
	return result;
}

/** The civil date shown at an instant, in the organisation zone. */
export const dateAt = (at: number, zone: string): string => todayInZone(zone, new Date(at));
