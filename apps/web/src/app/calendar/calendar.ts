export type Event = { id: string; summary: string; status: string; location: string; calendarName: string; startsAt: string; endsAt: string;
 allDay: boolean; startDate: string | null; endDate: string | null; attendeeCount: number; attendeesOmitted: boolean; preparationNote: string | null; preparedAt: string | null };
export type CalendarList = { connection: { status: string; accountEmail: string; scopes: string[] } | null; timezone: string; automaticSyncEnabled: boolean; preparationNotice: string | null;
 calendars: { id: string; name: string; isPrimary: boolean; selected: boolean; syncedAt: string | null; syncedFrom: string | null; syncedTo: string | null }[];
 lastSync: { at: string; detail: { success: boolean; error?: string } } | null };
export type CalendarWeek = CalendarList & { events: Event[]; covered: boolean };
export const localDate = (value: string | Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
export const addDays = (date: string, days: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
export function weekStart(value: string | undefined, timeZone: string) {
 const today = localDate(new Date(), timeZone); const date = value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : today;
 const weekday = new Date(`${date}T12:00:00Z`).getUTCDay(); return addDays(date, -((weekday + 6) % 7));
}
export const dayLabel = (day: string) => new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' }).format(new Date(`${day}T12:00:00Z`));
export function onDay(event: Event, day: string, zone: string) {
 return event.allDay ? event.startDate! <= day && event.endDate! > day : localDate(event.startsAt, zone) <= day && localDate(new Date(Date.parse(event.endsAt) - 1), zone) >= day;
}
export function eventTime(event: Event, zone: string) {
 if (event.allDay) return 'All day';
 const format = (value: string) => new Intl.DateTimeFormat('en-AU', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(new Date(value));
 const acrossDays = localDate(event.startsAt, zone) !== localDate(event.endsAt, zone);
 return `${acrossDays ? `${dayLabel(localDate(event.startsAt, zone))}, ` : ''}${format(event.startsAt)} – ${acrossDays ? `${dayLabel(localDate(event.endsAt, zone))}, ` : ''}${format(event.endsAt)}`;
}
