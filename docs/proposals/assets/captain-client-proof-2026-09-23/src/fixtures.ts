import { DAY, HOUR, type Booking, type Message } from './model.ts';
export const timezone = 'Australia/Perth';
export const start = Date.parse('2026-09-28T00:00:00+08:00');
export const range = { start, end: start + 28 * DAY };
export const resources = ['Packaging line', 'Fermenter 1', 'Fermenter 2', 'Bright tank', 'Keg washer', 'Cold room']
  .map((name, i) => ({ id: `equipment-${i}`, name }));
export const bookings: Booking[] = [
  { id: 'pale-ale', resourceId: 'equipment-0', title: 'Pale ale packaging', start: start + 3 * DAY + 9 * HOUR, end: start + 3 * DAY + 12 * HOUR, kind: 'booked' },
  { id: 'cleaning', resourceId: 'equipment-0', title: 'Cleaning', start: start + 3 * DAY + 12 * HOUR, end: start + 3 * DAY + 13 * HOUR, kind: 'maintenance' },
  { id: 'request', resourceId: 'equipment-0', title: 'Summer lager · unconfirmed', start: start + 3 * DAY + 10 * HOUR, end: start + 3 * DAY + 11 * HOUR, kind: 'request' },
  { id: 'fermentation', resourceId: 'equipment-1', title: 'Summer lager fermentation', start: start + DAY / 2, end: start + 11 * DAY + 8 * HOUR, kind: 'booked' },
  { id: 'long-maintenance', resourceId: 'equipment-2', title: 'Service and inspection', start: start - DAY, end: start + 2 * DAY, kind: 'maintenance' },
  ...Array.from({ length: 72 }, (_, i): Booking => ({
    id: `sample-${i}`, resourceId: `equipment-${3 + i % 3}`, title: i % 4 === 0 ? 'Cleaning' : `Batch ${i + 1}`,
    start: start + Math.floor(i / 3) * DAY + 8 * HOUR,
    end: start + Math.floor(i / 3) * DAY + (i % 4 === 0 ? 9 : 16) * HOUR,
    kind: i % 4 === 0 ? 'maintenance' : 'booked',
  })),
];
const texts = [
  'The sample pack needs the reviewed artwork before we package it.',
  'Please allow time for cleaning after the current booking.',
  'The morning slot is occupied. Can we look at the afternoon?',
  'I can help with the samples after lunch.',
  'Keep the equipment request unconfirmed until we resolve the clash.',
  'The latest artwork is linked to the project for review.',
];
export const messages: Message[] = Array.from({ length: 180 }, (_, i) => ({
  id: `message-${i + 1}`, author: ['Sam Hughes', 'Ryan White', 'Jess Carter'][i % 3]!,
  at: start + i * 60_000, text: texts[i % texts.length]!, pinned: i === 2,
}));
export function dateTime(at: number) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: timezone, day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}
export function dayLabel(at: number) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: timezone, day: 'numeric', month: 'short' }).format(at);
}
