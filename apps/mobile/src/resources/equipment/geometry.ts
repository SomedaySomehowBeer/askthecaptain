/** Continuous time geometry for the equipment schedule (contract §5): ported from the retired
 *  Next.js schedule. Pixels are proportional to elapsed time, so a 23- or 25-hour
 *  day is drawn at its true length and a reservation is one continuous interval across day boundaries.
 *  Pure: no React or native modules. */
import { DAY } from './zone.ts';

/** Pixels per day. */
export const scales = { hours: 576, days: 84, weeks: 24 } as const;
export type Scale = keyof typeof scales;
export const defaultScale: Scale = 'days';
export const isScale = (value: string): value is Scale => Object.prototype.hasOwnProperty.call(scales, value);

/** The part of [start, end) inside [from, to), placed relative to `from`; null when they don't overlap.
 *  A short interval keeps its true height and is never enlarged. */
export function interval(start: string, end: string, from: string, to: string, pixelsPerDay: number): { top: number; height: number } | null {
	const low = Date.parse(from), high = Date.parse(to), a = Math.max(low, Date.parse(start)), b = Math.min(high, Date.parse(end));
	if (!(b > a)) return null;
	return { top: (a - low) / DAY * pixelsPerDay, height: (b - a) / DAY * pixelsPerDay };
}

/** The distance of instant `at` from `origin`, in pixels. */
export const pixelsAt = (at: number, origin: number, pixelsPerDay: number): number => (at - origin) / DAY * pixelsPerDay;
/** The instant `pixels` from `origin`: the inverse of `pixelsAt`. */
export const instantAt = (pixels: number, origin: number, pixelsPerDay: number): number => origin + pixels / pixelsPerDay * DAY;

/** The scroll offset after a scale change that keeps the instant under `focal` (a point in the viewport, usually its
 *  centre) in place. `header` is any content before time zero; the web passes its 52 px header, mobile's geometry
 *  is settled in implementation review. */
export function zoomScroll(offset: number, focal: number, oldScale: number, newScale: number, header = 0): number {
	return Math.max(0, (offset + focal - header) / oldScale * newScale - focal + header);
}

/** A scroll offset kept inside the content, for example after zooming out near the end of the range. */
export function clampScroll(offset: number, content: number, viewport: number): number {
	return Math.min(Math.max(0, offset), Math.max(0, content - viewport));
}
