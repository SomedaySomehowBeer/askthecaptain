/** The scrollable schedule range and its bounded occupancy chunks (D24). Pure: no React, no API.
 *  The range runs from one calendar month before the anchor date to six calendar months after it.
 *  Each chunk is at most `chunkDays` civil days, well inside the API's 93-day read limit. */
import type { Scale } from './geometry.ts';
import { shiftDate, todayInZone, zonedDay } from './time.ts';

export const DAY = 86_400_000;
export const chunkDays = 28;
export const monthsBefore = 1, monthsAfter = 6;
/** The API refuses instants before 1900 and from 2200; zoned midnights near those limits can fall
 *  outside them, so the scrollable range stays a day inside. */
const firstDate = '1900-01-02', lastDate = '2199-12-31';

export type Chunk = { from: string; to: string; fromDate: string; toDate: string };
export type ScheduleRange = {
 anchor: string; anchorAt: string; startDate: string; endDate: string; start: string; end: string;
 chunks: Chunk[]; anchorChunk: number;
};

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
/** The same day of the month `months` calendar months away, clamped to that month's last day. */
export function addMonths(date: string, months: number): string {
 const match = datePattern.exec(date); if (!match) throw new Error('Choose a valid date.');
 const total = Number(match[1]) * 12 + Number(match[2]) - 1 + months, year = Math.floor(total / 12), month = total % 12;
 const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
 return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(Math.min(Number(match[3]), last)).padStart(2, '0')}`;
}
const clampDate = (date: string) => date < firstDate ? firstDate : date > lastDate ? lastDate : date;
/** `shiftDate`, or null outside 1900–2200. */
function shifted(date: string, days: number): string | null { try { return shiftDate(date, days); } catch { return null; } }

const starts = new Map<string, string | null>();
/** The first instant of a civil day in the zone, or null when a clock change skips the whole day. */
export function dayStart(date: string, zone: string): string | null {
 const key = zone + ' ' + date;
 if (!starts.has(key)) {
  let value: string | null;
  try { value = zonedDay(date, zone); } catch (error) { if (error instanceof Error && /clock change/.test(error.message)) value = null; else throw error; }
  if (starts.size > 5000) starts.clear();
  starts.set(key, value);
 }
 return starts.get(key)!;
}
/** A boundary at `date`, or at the next day that exists when that date is skipped. */
function boundary(date: string, zone: string): string {
 const next = shifted(date, 1), at = dayStart(date, zone) ?? (next ? dayStart(next, zone) : null);
 if (!at) throw new Error('These dates are skipped by a clock change. Choose another date.');
 return at;
}

/** Throws for an invalid date or zone; callers show a designed refusal. */
export function scheduleRange(anchor: string, zone: string): ScheduleRange {
 const anchorAt = zonedDay(anchor, zone);
 if (anchor < firstDate || anchor >= lastDate) throw new Error('Choose a date between 1900 and 2200.');
 const after = clampDate(addMonths(anchor, monthsAfter));
 const startDate = clampDate(addMonths(anchor, -monthsBefore)), endDate = after === lastDate ? lastDate : shiftDate(after, 1);
 // Chunks are aligned to the anchor, so the first read covers the dates the person opened.
 const dates = new Set([startDate, endDate, anchor]);
 for (let d: string | null = anchor; d && d > startDate; d = shifted(d, -chunkDays)) dates.add(d);
 for (let d: string | null = anchor; d && d < endDate; d = shifted(d, chunkDays)) dates.add(d);
 const ordered = [...dates].filter(d => d >= startDate && d <= endDate).sort();
 const chunks: Chunk[] = [];
 for (let i = 0; i + 1 < ordered.length; i++) {
  const from = boundary(ordered[i]!, zone), to = boundary(ordered[i + 1]!, zone);
  if (Date.parse(to) > Date.parse(from)) chunks.push({ from, to, fromDate: ordered[i]!, toDate: ordered[i + 1]! });
 }
 return { anchor, anchorAt, startDate, endDate, start: chunks[0]!.from, end: chunks.at(-1)!.to, chunks, anchorChunk: Math.max(0, chunks.findIndex(c => c.fromDate === anchor)) };
}

/** Indices of chunks intersecting [low, high), nearest to the middle first. */
export function chunksBetween(chunks: readonly Chunk[], low: number, high: number): number[] {
 const middle = (low + high) / 2, result: number[] = [];
 chunks.forEach((chunk, i) => { if (Date.parse(chunk.from) < high && Date.parse(chunk.to) > low) result.push(i); });
 const distance = (i: number) => Math.max(0, Date.parse(chunks[i]!.from) - middle, middle - Date.parse(chunks[i]!.to));
 return result.sort((a, b) => distance(a) - distance(b));
}

/** The instants rendered into the DOM: the visible time plus overscan. It changes only when the
 *  visible time leaves the inner margin, so scrolling re-renders the timeline rarely. */
export type TimeWindow = { low: number; high: number };
export function renderWindow(current: TimeWindow | null, viewLow: number, viewHigh: number, start: number, end: number): TimeWindow {
 const span = Math.max(viewHigh - viewLow, 3_600_000);
 if (current && current.low <= Math.max(start, viewLow - span / 2) && current.high >= Math.min(end, viewHigh + span / 2)) return current;
 return { low: Math.max(start, viewLow - span * 1.5), high: Math.min(end, viewHigh + span * 1.5) };
}

const labelFormats = new Map<string, Intl.DateTimeFormat>();
function labelFormat(zone: string, hours: boolean) {
 const key = zone + (hours ? ' h' : ' d');
 let value = labelFormats.get(key);
 if (!value) { value = new Intl.DateTimeFormat('en-AU', hours ? { timeZone: zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' }); labelFormats.set(key, value); }
 return value;
}
/** Axis ticks inside [low, high) only: hourly from the range start, or daily/weekly civil midnights
 *  counted from the anchor. A skipped civil date has no midnight and no tick. */
export function ticks(scale: Scale, range: Pick<ScheduleRange, 'anchor' | 'anchorAt' | 'start' | 'end'>, zone: string, low: number, high: number) {
 const result: { at: number; label: string }[] = [], start = Date.parse(range.start), end = Date.parse(range.end);
 low = Math.max(low, start); high = Math.min(high, end);
 if (high <= low) return result;
 if (scale === 'hours') {
  const format = labelFormat(zone, true);
  for (let at = start + Math.ceil((low - start) / 3_600_000) * 3_600_000; at < high; at += 3_600_000) result.push({ at, label: format.format(at) });
  return result;
 }
 const step = scale === 'weeks' ? 7 : 1, format = labelFormat(zone, false), anchorAt = Date.parse(range.anchorAt);
 const first = Math.floor((low - anchorAt) / (step * DAY)) - 1, last = Math.ceil((high - anchorAt) / (step * DAY)) + 1;
 for (let k = first; k <= last; k++) {
  const date = shifted(range.anchor, k * step), instant = date ? dayStart(date, zone) : null; if (!instant) continue;
  const at = Date.parse(instant); if (at >= low && at < high) result.push({ at, label: format.format(at) });
 }
 return result;
}

/** The civil date shown at an instant, in the organisation zone. */
export const dateAt = (at: number, zone: string) => todayInZone(zone, new Date(at));
