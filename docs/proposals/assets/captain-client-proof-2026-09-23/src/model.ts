/** Client-only geometry and identity. No booking write or authorisation logic. */
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const scales = { Hours: 52 / HOUR, Days: 84 / DAY, Weeks: 18 / DAY } as const;
export type Scale = keyof typeof scales;
export type Interval = { start: number; end: number };
export type Booking = Interval & {
  id: string; resourceId: string; title: string; kind: 'booked' | 'maintenance' | 'request';
};
export type Message = { id: string; author: string; text: string; at: number; pinned: boolean };
export type DataState = 'ready' | 'loading' | 'empty' | 'failed' | 'disabled';
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}
export function geometry(interval: Interval, range: Interval, pixelsPerMs: number) {
  if (interval.end <= interval.start || !overlaps(interval, range)) return null;
  const start = Math.max(interval.start, range.start);
  const end = Math.min(interval.end, range.end);
  return { top: (start - range.start) * pixelsPerMs,
    height: (end - start) * pixelsPerMs, clipped: start !== interval.start || end !== interval.end };
}
export function zoomOffset(offset: number, anchor: number, previous: number, next: number,
  contentDuration: number, viewportHeight: number): number {
  return Math.max(0, Math.min((offset + anchor) / previous * next - anchor,
    Math.max(0, contentDuration * next - viewportHeight)));
}
/** Pending requests are inspectable even when too short to carry text. */
export function conflicts(bookings: readonly Booking[]): ReadonlySet<string> {
  return new Set(bookings.filter(a => a.kind === 'request' && bookings.some(b =>
    b.id !== a.id && b.resourceId === a.resourceId && b.kind !== 'request' && overlaps(a, b)
  )).map(b => b.id));
}
export function mergeMessages(current: readonly Message[], incoming: readonly Message[]): Message[] {
  const byId = new Map(current.map(m => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}
export function recentMessages(messages: readonly Message[]): Message[] {
  return mergeMessages([], messages).slice(-6);
}
export function pinnedMessages(messages: readonly Message[]): Message[] {
  return mergeMessages([], messages).filter(m => m.pinned);
}
