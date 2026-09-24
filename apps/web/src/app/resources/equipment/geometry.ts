export const scales = { hours: 576, days: 84, weeks: 24 } as const;
export type Scale = keyof typeof scales;
export const isScale = (value: string): value is Scale => Object.hasOwn(scales, value);
export function interval(start: string, end: string, from: string, to: string, pixelsPerDay: number) {
 const low = Date.parse(from), high = Date.parse(to), a = Math.max(low, Date.parse(start)), b = Math.min(high, Date.parse(end));
 if (b <= a) return null;
 return { top: (a - low) / 86_400_000 * pixelsPerDay, height: (b - a) / 86_400_000 * pixelsPerDay };
}
export function zoomScroll(scrollTop: number, anchorY: number, oldScale: number, newScale: number, header = 52) {
 return Math.max(0, (scrollTop + anchorY - header) / oldScale * newScale - anchorY + header);
}
